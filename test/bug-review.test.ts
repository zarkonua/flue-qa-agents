// Human bug decisions in the review workspace — the same trusted service as
// `npm run qa:defects`, reached through the host API.
//
//   npm test

import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-bug-review-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
delete process.env.QA_DISCOVERY_AUX_ORIGINS;
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');

const qa = await import('../src/lib/qa-artifacts.ts');
const gate = await import('../src/lib/phase1-gate.ts');
const deps = await import('../src/lib/phase1-dependencies.ts');
const { createUiServer } = await import('../src/ui-server/server.ts');
const { artifactWorkspace, defaultStore } = await import('../src/review/workspace.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const FINDINGS = [
  {
    id: 'DEF-001', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-2'], sourceTestCaseIds: ['TC-1'],
    reason: 'The message may not say which credential is wrong.', title: 'Invalid-credentials error is generic', severity: 'MINOR',
    steps: ['Submit the login form with INVALID_PASSWORD'], expected: 'The message says which credential is wrong.',
    actual: 'An error message is shown for invalid credentials.',
  },
  {
    id: 'DEF-002', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: ['BEH-3'], sourceAcceptancePointIds: ['AC-1'],
    reason: 'Editing is possible although the login button rule says otherwise.', title: 'Notes editable too early', severity: 'MAJOR',
    steps: ['Log in', 'Open the notes area'], expected: 'With no credentials the login button is disabled and nothing is editable.',
    actual: 'The notes area becomes editable after a successful login.',
  },
];

function seed(root: string) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization']) {
    copyFileSync(join(FIXTURES, `${name}.json`), join(root, `${name}.json`));
  }
}

let server: Server;
let base = '';
const events: { bugId: string; action: string }[] = [];

beforeEach(async () => {
  seed(ROOT);
  qa.writeQaArtifact('defect-analysis', { findings: FINDINGS });
  deps.stampDependency('automation-prioritization');
  deps.stampDependency('defect-analysis');
  events.length = 0;
  server = await createUiServer({
    store: defaultStore(),
    workspace: artifactWorkspace,
    runReviewAgent: async () => {},
    refresh: { start: async () => {}, status: () => ({ status: 'IDLE' as const }) },
    onBugEvent: (e) => { events.push({ bugId: e.bugId, action: e.action }); },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const sha = async (id: string) => (await get(`/api/bugs/${id}`)).body.sha256 as string;

describe('bug decisions through the workspace API', () => {
  it('accept, reject, downgrade; history and metrics recorded; decisions persist', async () => {
    assert.equal((await post('/api/bugs/BUG-001/accept', { baseSha256: await sha('BUG-001'), note: 'Reproduced.' })).body.bug.review.decision, 'ACCEPTED');
    assert.equal((await post('/api/bugs/BUG-001/reject', { baseSha256: await sha('BUG-001') })).body.bug.review.decision, 'REJECTED');
    const down = (await post('/api/bugs/BUG-002/downgrade', { baseSha256: await sha('BUG-002') })).body.bug;
    assert.deepEqual([down.status, down.review.downgradedFrom], ['POTENTIAL', 'CONFIRMED']);
    assert.equal(qa.readBugReport('BUG-002')!.status, 'POTENTIAL', 'persisted');

    const detail = (await get('/api/bugs/BUG-001')).body;
    assert.deepEqual(detail.history.map((h: any) => [h.action, h.via, h.after.decision]), [['accept', 'ui', 'ACCEPTED'], ['reject', 'ui', 'REJECTED']]);
    assert.equal(detail.history[0].note, 'Reproduced.');
    assert.deepEqual(events, [{ bugId: 'BUG-001', action: 'accept' }, { bugId: 'BUG-001', action: 'reject' }, { bugId: 'BUG-002', action: 'downgrade' }]);
  });

  it('downgrade only applies to CONFIRMED; unknown and malformed ids are refused', async () => {
    const res = await post('/api/bugs/BUG-001/downgrade', { baseSha256: await sha('BUG-001') });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /only a CONFIRMED report/);
    assert.equal((await get('/api/bugs/BUG-001')).body.actions.downgrade, false);
    assert.equal((await post('/api/bugs/BUG-404/accept')).status, 400);
    assert.equal((await post('/api/bugs/..%2Ftest-cases/accept')).status, 400);
    assert.equal((await post('/api/bugs/BUG-001/delete')).status, 404, 'no action outside the fixed set');
  });

  it('request changes needs a note, records it, and leaves the report content untouched', async () => {
    assert.equal((await post('/api/bugs/BUG-001/request-changes', {})).status, 400);
    const before = qa.readBugReport('BUG-001')!;
    const res = await post('/api/bugs/BUG-001/request-changes', { note: 'Say which credential.', baseSha256: await sha('BUG-001') });
    assert.equal(res.body.bug.review.decision, 'CHANGES_REQUESTED');
    const after = qa.readBugReport('BUG-001')!;
    const { review: _a, ...contentBefore } = before;
    const { review: _b, ...contentAfter } = after;
    assert.deepEqual(contentAfter, contentBefore);
    assert.equal((await get('/api/bugs/BUG-001')).body.history[0].note, 'Say which credential.');
  });

  it('edit: preview shows the diff and writes nothing; apply writes; priority is human-set', async () => {
    const file = qa.bugReportPath('BUG-001');
    const before = readFileSync(file, 'utf8');
    const preview = (await post('/api/bugs/BUG-001/edit/preview', { changes: { severity: 'MAJOR', priority: 'P1', steps: ['Open the Sign In form', 'Submit INVALID_PASSWORD'], title: 'Generic credentials error' } })).body;
    assert.deepEqual(preview.changedFields.sort(), ['priority', 'severity', 'steps', 'title']);
    assert.deepEqual([preview.current.severity, preview.next.severity], ['MINOR', 'MAJOR']);
    assert.equal(preview.applicable, true, preview.problems.join('\n'));
    assert.equal(readFileSync(file, 'utf8'), before, 'a preview writes nothing');

    const applied = await post('/api/bugs/BUG-001/edit', { changes: { severity: 'MAJOR', priority: 'P1', steps: ['Open the Sign In form', 'Submit INVALID_PASSWORD'], title: 'Generic credentials error' }, baseSha256: preview.baseSha256 });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const bug = qa.readBugReport('BUG-001')!;
    assert.deepEqual([bug.severity, bug.priority, bug.title, bug.steps.length], ['MAJOR', 'P1', 'Generic credentials error', 2]);
    assert.deepEqual(bug.review.editedFields, ['priority', 'severity', 'steps', 'title']);
  });

  it('an edit not supported by the evidence is shown as a problem and refused on apply', async () => {
    const preview = (await post('/api/bugs/BUG-001/edit/preview', { changes: { steps: ['Open /admin/login'] } })).body;
    assert.equal(preview.applicable, false);
    assert.ok(preview.problems.some((p: string) => p.includes('UNSUPPORTED_FACT')));
    const res = await post('/api/bugs/BUG-001/edit', { changes: { steps: ['Open /admin/login'] }, baseSha256: preview.baseSha256 });
    assert.equal(res.status, 400);
    assert.equal(qa.readBugReport('BUG-001')!.steps[0], 'Submit the login form with INVALID_PASSWORD');
  });

  it('ids, evidence, sources and environment cannot be edited at all', async () => {
    for (const changes of [{ id: 'BUG-009' }, { sourceBehaviorIds: ['BEH-1'] }, { evidence: [] }, { environment: { target: 'x' } }, { status: 'CONFIRMED' }, { expected: 'x' }]) {
      assert.equal((await post('/api/bugs/BUG-001/edit/preview', { changes })).status, 400, JSON.stringify(changes));
    }
  });

  it('an edit made against an older version of the report conflicts', async () => {
    const stale = await sha('BUG-001');
    await post('/api/bugs/BUG-001/accept', { baseSha256: stale });
    const res = await post('/api/bugs/BUG-001/edit', { changes: { severity: 'TRIVIAL' }, baseSha256: stale });
    assert.equal(res.status, 409);
    assert.equal(qa.readBugReport('BUG-001')!.severity, 'MINOR');
  });

  it('a bug decision makes the approval stale and nothing else', async () => {
    const approved = gate.approvePhase1({ acceptFindings: true });
    assert.equal(approved.ok, true);
    await post('/api/bugs/BUG-002/downgrade', { baseSha256: await sha('BUG-002') });
    const health = (await get('/api/overview')).body.health;
    assert.equal(health.approval.state, 'STALE');
    assert.deepEqual(health.approval.changed, ['bugs/BUG-002.json']);
    assert.equal(health.prioritization.state, 'CURRENT');
    assert.equal(health.defectAnalysis.state, 'CURRENT');
    assert.equal(health.refreshNeeded, false);
  });

  it('refuses a mutation from another origin', async () => {
    const res = await post('/api/bugs/BUG-001/accept', { baseSha256: await sha('BUG-001') }, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(qa.readBugReport('BUG-001')!.review.decision, 'PENDING');
  });
});

describe('one implementation for the CLI and the workspace', () => {
  it('the same action through qa:defects and through the API gives the same report', async () => {
    // Workspace A: the command line.
    const cliRoot = mkdtempSync(join(tmpdir(), 'qa-bug-cli-'));
    for (const f of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
      copyFileSync(join(ROOT, `${f}.json`), join(cliRoot, `${f}.json`));
    }
    mkdirSync(join(cliRoot, 'bugs'));
    for (const id of ['BUG-001', 'BUG-002']) copyFileSync(qa.bugReportPath(id), join(cliRoot, 'bugs', `${id}.json`));
    const env = { ...process.env, QA_ARTIFACT_ROOT: cliRoot, QA_ENV_FILE: '/nonexistent', LANGFUSE_ENABLED: 'false' };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['scripts/qa-defects.mjs', ...args], { cwd: PROJECT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(cli('downgrade', 'BUG-002', '--note', 'Not reproducible every time.').status, 0);
    assert.equal(cli('edit', 'BUG-002', '--severity', 'MINOR', '--priority', 'P2').status, 0);

    // Workspace B: the API.
    await post('/api/bugs/BUG-002/downgrade', { baseSha256: await sha('BUG-002'), note: 'Not reproducible every time.' });
    await post('/api/bugs/BUG-002/edit', { changes: { severity: 'MINOR', priority: 'P2' }, baseSha256: await sha('BUG-002') });

    const strip = (b: any) => ({ ...b, review: { ...b.review, at: undefined, by: undefined } });
    const fromCli = JSON.parse(readFileSync(join(cliRoot, 'bugs', 'BUG-002.json'), 'utf8'));
    assert.deepEqual(strip(fromCli), strip(qa.readBugReport('BUG-002')));
    const cliHistory = JSON.parse(readFileSync(join(cliRoot, 'reviews', 'bugs', 'BUG-002.json'), 'utf8')).events;
    const apiHistory = await defaultStore().listBugReviewEvents('BUG-002');
    const shape = (e: any) => [e.action, e.note, e.before, e.after, e.editedFields];
    assert.deepEqual(cliHistory.map(shape), apiHistory.map(shape));
    assert.deepEqual([cliHistory[0].via, apiHistory[0].via], ['cli', 'ui']);
    rmSync(cliRoot, { recursive: true, force: true });
  });

  it('both call the shared service; neither writes bug files itself', () => {
    const cli = readFileSync(join(PROJECT, 'scripts', 'qa-defects.mjs'), 'utf8');
    const server = readFileSync(join(PROJECT, 'src', 'ui-server', 'server.ts'), 'utf8');
    for (const [name, source] of [['qa-defects', cli], ['server', server]] as const) {
      assert.ok(!/writeBugReport|writeFileSync|atomicWriteFile/.test(source), `${name} writes bug files itself`);
    }
    assert.match(cli, /review\.decide\(/);
    assert.match(cli, /review\.edit\(/);
    assert.match(server, /from '..\/lib\/defect-review\.ts'/);
  });
});
