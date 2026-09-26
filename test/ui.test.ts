// The local review UI: its read model, its two write actions, and its limits.
//
//   npm test
//
// The server is started as a real child process against a temporary artifact
// root, so these exercise the same code path `npm run qa:ui` does.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
const PHASE1 = ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis'];

/** A workspace holding a complete, approvable Phase 1. */
function completeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'qa-ui-'));
  for (const name of PHASE1) copyFileSync(join(FIXTURES, `${name}.json`), join(root, `${name}.json`));
  return root;
}

const servers: { kill: () => void }[] = [];
after(() => servers.forEach((s) => s.kill()));

/** Start the real UI server on an ephemeral port, against `root`. */
async function startUi(root: string, extraEnv: Record<string, string> = {}) {
  const port = 14500 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [join(PROJECT, 'scripts', 'qa-ui.mjs')], {
    cwd: PROJECT,
    env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_UI_PORT: String(port), QA_ENV_FILE: join(tmpdir(), 'no-env-here'), ...extraEnv },
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  servers.push({ kill: () => child.kill('SIGKILL') });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/review`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { base, port, child, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`UI did not start:\n${log}`);
}

const getJson = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>;
/** Approve Phase 1 through the workspace API — the same call `npm run qa:approve` makes. */
const approve = (base: string) => fetch(`${base}/api/phase1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

// ---------------------------------------------------------------------------

describe('review endpoint', () => {
  it('serves a merged model: cases, prioritization, coverage and approval state', async () => {
    const { base } = await startUi(completeWorkspace());
    const body = (await getJson(`${base}/api/review`)) as { ok: boolean; model: Record<string, never> };
    assert.equal(body.ok, true);
    const m = body.model as unknown as {
      hasPhase1: boolean; testCases: { id: string; executionMode?: string; covers: { id: string }[] }[];
      counts?: { total: number }; coverage?: { testable: number; covered: number }; approval: { state: string };
    };
    assert.equal(m.hasPhase1, true);
    assert.ok(m.testCases.length >= 2);
    // the merge: prioritization data appears on the case itself
    assert.ok(m.testCases.every((tc) => tc.executionMode !== undefined), 'each case carries its execution mode');
    // and coverage came from requirements-analysis
    assert.ok(m.coverage && m.coverage.testable > 0);
    assert.equal(m.approval.state, 'NONE');
  });

  it('works when the optional AI review is absent', async () => {
    const { base } = await startUi(completeWorkspace());
    const { model } = (await getJson(`${base}/api/review`)) as { model: { review?: unknown; testCases: unknown[] } };
    assert.equal(model.review, undefined);
    assert.ok(model.testCases.length > 0, 'the rest of the model still renders');
  });

  it('includes the optional AI review when it exists', async () => {
    const root = completeWorkspace();
    const cases = JSON.parse(readFileSync(join(root, 'test-cases.json'), 'utf8')) as { testCases: { id: string }[] };
    writeFileSync(
      join(root, 'test-cases-review.json'),
      JSON.stringify({
        status: 'CHANGES_REQUESTED',
        issues: [{ testCaseId: cases.testCases[0].id, severity: 'MINOR', category: 'clarity', message: 'Be specific' }],
        suggestedChanges: [],
        summary: { total: cases.testCases.length, manual: 0, automation: cases.testCases.length, automationHigh: 1, automationMedium: 1, automationLow: 0 },
      }),
    );
    const { base } = await startUi(root);
    const { model } = (await getJson(`${base}/api/review`)) as {
      model: { review?: { status: string; issues: unknown[] }; testCases: { reviewIssues: unknown[] }[] };
    };
    assert.equal(model.review?.status, 'CHANGES_REQUESTED');
    assert.equal(model.review?.issues.length, 1);
    // and the issue is attached to its case, not only listed separately
    assert.equal(model.testCases[0].reviewIssues.length, 1);
  });

  it('returns a useful state, not a crash, when there are no artifacts', async () => {
    const { base } = await startUi(mkdtempSync(join(tmpdir(), 'qa-ui-empty-')));
    const res = await fetch(`${base}/api/review`);
    assert.equal(res.status, 200);
    const { model } = (await res.json()) as { model: { hasPhase1: boolean; missing: string[]; testCases: unknown[] } };
    assert.equal(model.hasPhase1, false);
    assert.ok(model.missing.includes('test-cases.json'));
    assert.deepEqual(model.testCases, []);
  });

  it('reports schema problems instead of serving invalid data as valid', async () => {
    const root = completeWorkspace();
    writeFileSync(join(root, 'test-cases.json'), JSON.stringify({ feature: 'x', testCases: [{ id: 'TC-1' }], openQuestions: [] }));
    const { base } = await startUi(root);
    const { model } = (await getJson(`${base}/api/review`)) as {
      model: { schemaErrors: { artifact: string }[]; testCases: unknown[] };
    };
    assert.ok(model.schemaErrors.some((s) => s.artifact === 'test-cases'));
    assert.deepEqual(model.testCases, [], 'invalid artifacts are not rendered as cases');
  });
});

// ---------------------------------------------------------------------------

describe('approval through the UI', () => {
  it('approves by calling the same host logic, and the CLI gate accepts the result', async () => {
    const root = completeWorkspace();
    const { base } = await startUi(root);

    const res = await approve(base);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; approval: { status: string; approvedBy: string; testCasesSha256: string } };
    assert.equal(body.ok, true);
    assert.equal(body.approval.status, 'APPROVED');

    // The artifact is byte-identical in shape to what qa:approve writes, and
    // the Phase 2 gate — which the UI does not touch — opens on it.
    const gate = spawnSync(process.execPath, [join(PROJECT, 'scripts', 'qa-automation.mjs'), '--gate-only'], {
      cwd: PROJECT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_TARGET_REPO_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env-here') },
    });
    assert.equal(gate.status, 0, `the CLI gate rejected a UI approval:\n${gate.stdout}\n${gate.stderr}`);
    assert.match(gate.stdout, /PHASE 2 GATE: OPEN/);
  });

  it('reflects the approval in the next review load', async () => {
    const root = completeWorkspace();
    const { base } = await startUi(root);
    assert.equal(((await getJson(`${base}/api/review`)) as { model: { approval: { state: string } } }).model.approval.state, 'NONE');
    await approve(base);
    const { model } = (await getJson(`${base}/api/review`)) as { model: { approval: { state: string; approvedAt?: string } } };
    assert.equal(model.approval.state, 'APPROVED');
    assert.ok(model.approval.approvedAt);
  });

  it('represents a stale approval, naming what changed', async () => {
    const root = completeWorkspace();
    const { base } = await startUi(root);
    await approve(base);
    // Touch an approved artifact — whitespace is enough, as the gate hashes bytes.
    const p = join(root, 'test-cases.json');
    writeFileSync(p, readFileSync(p, 'utf8') + '\n');
    const { model } = (await getJson(`${base}/api/review`)) as { model: { approval: { state: string; changed: string[] } } };
    assert.equal(model.approval.state, 'STALE');
    assert.deepEqual(model.approval.changed, ['test-cases.json']);
  });

  it('returns the real validation problems when approval is refused', async () => {
    const root = completeWorkspace();
    // Remove a case's prioritization: a structural problem that can never be approved.
    const p = join(root, 'automation-prioritization.json');
    const prio = JSON.parse(readFileSync(p, 'utf8')) as { cases: unknown[] };
    prio.cases.pop();
    writeFileSync(p, JSON.stringify(prio));

    const { base } = await startUi(root);
    const res = await approve(base);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; reason: string; blocking: { code: string }[] };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'INVALID');
    assert.ok(body.blocking.some((f) => f.code === 'MISSING_PRIORITIZATION'));
  });

  it('does not expose --accept-findings', async () => {
    const source = readFileSync(join(PROJECT, 'scripts', 'qa-ui.mjs'), 'utf8');
    assert.ok(!/acceptFindings:\s*true/.test(source), 'the UI must never approve over findings');
    const server = readFileSync(join(PROJECT, 'src', 'ui-server', 'server.ts'), 'utf8');
    assert.ok(!/acceptFindings:\s*true/.test(server), 'the API must never approve over findings');
    const client = readFileSync(join(PROJECT, 'ui', 'src', 'api', 'client.ts'), 'utf8');
    assert.ok(!/acceptFindings/.test(client), 'the browser must not be able to ask for the override');
  });
});

// ---------------------------------------------------------------------------

describe('the UI is a local, read-mostly surface', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const { base, port } = await startUi(completeWorkspace());
    assert.match(base, /^http:\/\/127\.0\.0\.1:/);
    assert.ok((await fetch(`${base}/api/review`)).ok);

    // Ask the OS what the socket is actually bound to. Connecting to 0.0.0.0
    // would prove nothing: on Linux that is routed to loopback anyway.
    const ss = spawnSync('ss', ['-lntH', `sport = :${port}`], { encoding: 'utf8' });
    if (ss.status === 0 && ss.stdout.trim()) {
      const local = ss.stdout.trim().split(/\s+/)[3] ?? '';
      assert.ok(local.startsWith('127.0.0.1:'), `bound to ${local}, expected 127.0.0.1 only`);
    } else {
      // No `ss` on this platform: fall back to the source contract.
      const source = readFileSync(join(PROJECT, 'scripts', 'qa-ui.mjs'), 'utf8');
      assert.match(source, /envString\('QA_UI_HOST'\) \?\? '127\.0\.0\.1'/);
      assert.match(source, /server\.listen\(PORT, HOST/);
    }
  });

  it('serves only its built files — the URL cannot name a path', async () => {
    const { base } = await startUi(completeWorkspace());
    for (const attempt of [
      '/../.env',
      '/../../.env',
      '/%2e%2e/.env',
      '/src/ui/../../.env',
      '/.env',
      '/package.json',
      '/api/review/../../.env',
    ]) {
      const res = await fetch(base + attempt);
      const text = await res.text();
      assert.ok(!text.includes('OPENROUTER_API_KEY'), `${attempt} must not return .env`);
      assert.ok(!text.includes('"devDependencies"'), `${attempt} must not return package.json`);
      // Unknown extensionless paths are the app's own routes: they get index.html, never a file.
      assert.ok(res.status === 404 || res.status === 400 || text.includes('<div id="root">'), `${attempt} -> ${res.status}`);
    }
  });

  it('never returns a secret in the review model', async () => {
    const root = completeWorkspace();
    const { base } = await startUi(root, { OPENROUTER_API_KEY: 'sk-or-v1-MUST-NOT-APPEAR' });
    const raw = await (await fetch(`${base}/api/review`)).text();
    assert.ok(!raw.includes('MUST-NOT-APPEAR'));
    assert.ok(!raw.includes('OPENROUTER_API_KEY'));
    // The artifact root is disclosed on purpose — it is the directory being
    // reviewed — but nothing else about the filesystem is.
    assert.ok(!raw.includes('/etc/'), 'no unrelated filesystem paths');
  });

  it('accepts no command, path or artifact name from the browser', async () => {
    const source = readFileSync(join(PROJECT, 'scripts', 'qa-ui.mjs'), 'utf8');
    // Every spawn argument is a literal or a project-relative join, never a URL part.
    assert.ok(!/spawn\([^)]*url|spawn\([^)]*req\.|exec\(/.test(source), 'no request data reaches a child process');
    const server = readFileSync(join(PROJECT, 'src', 'ui-server', 'server.ts'), 'utf8');
    assert.ok(!/node:child_process|\bspawn\(|execFile|execSync/.test(server), 'the API server starts no process of its own');

    const { base } = await startUi(completeWorkspace());
    // Not JSON: refused before anything runs.
    assert.equal((await fetch(`${base}/api/phase1/refresh?cmd=rm`, { method: 'POST' })).status, 415);
    // A body naming a command or a path: refused by the strict schema.
    for (const body of [{ command: 'rm -rf /' }, { path: '../../.env' }]) {
      const res = await fetch(`${base}/api/phase1/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 400);
    }
    // The query string is ignored entirely: the route is matched on pathname.
    const res = await fetch(`${base}/api/phase1/approve?acceptFindings=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = (await res.json()) as { ok: boolean; approval?: { acceptedFindings?: unknown[] } };
    if (body.ok) assert.deepEqual(body.approval?.acceptedFindings, [], 'no findings may be accepted via a query string');
  });

  it('rejects unknown routes', async () => {
    const { base } = await startUi(completeWorkspace());
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/phase1/approve`)).status, 404, 'GET must not approve');
    assert.equal((await fetch(`${base}/api/approve`, { method: 'POST' })).status, 404, 'the old approve route is gone');
  });
});
