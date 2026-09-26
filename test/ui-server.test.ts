// The QA Review Workspace host API, in process, over a temporary artifact
// root. The review agent is replaced at its boundary by a function that
// submits through the real `submitAgentProposal`; everything else is real.

import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-ui-server-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');

const { createUiServer, MAX_BODY_BYTES } = await import('../src/ui-server/server.ts');
const { FileReviewStore } = await import('../src/review/review-store.ts');
const { submitAgentProposal } = await import('../src/review/test-case-changes.ts');
const { artifactWorkspace, REVIEWS_DIR } = await import('../src/review/workspace.ts');
const qa = await import('../src/lib/qa-artifacts.ts');
const gate = await import('../src/lib/phase1-gate.ts');
type ChangeRequest = import('../src/review/review-store.ts').ChangeRequest;

after(() => rmSync(ROOT, { recursive: true, force: true }));

let server: Server;
let base = '';
let agentCalls = 0;

async function start() {
  const store = new FileReviewStore(REVIEWS_DIR);
  server = await createUiServer({
    store,
    workspace: artifactWorkspace,
    runReviewAgent: async (request: ChangeRequest) => {
      agentCalls += 1;
      const current = (qa.readQaArtifact('test-cases') as { testCases: Record<string, unknown>[] }).testCases.find((tc) => tc.id === request.targetTestCaseId);
      await submitAgentProposal(store, artifactWorkspace, request, {
        cases: [{ ...current, expectedResult: 'Error message shown for invalid credentials, and the form stays open.' }],
        rationale: 'Made the expected result specific.',
        evidenceRefs: ['AC-2'],
        unresolvedIssues: [],
      });
    },
    refreshPrioritization: async () => ({ ok: true, output: 'fake' }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const stop = () => new Promise<void>((done) => {
  server.closeAllConnections?.();
  server.close(() => done());
});

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
    copyFileSync(join(FIXTURES, `${name}.json`), join(ROOT, `${name}.json`));
  }
}

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

async function until(check: () => Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

beforeEach(async () => {
  seed();
  agentCalls = 0;
  await start();
});
// Teardown never depends on a test reaching its last line.
afterEach(async () => {
  if (server.listening) await stop();
});

describe('review workflow over the API', () => {
  it('request -> process -> proposal -> apply; prioritization and Phase 1 go stale', async () => {
    const approved = gate.approvePhase1({ acceptFindings: true });
    assert.equal(approved.ok, true);
    const before = readFileSync(qa.qaArtifactPath('test-cases'), 'utf8');

    const created = await post('/api/reviews', { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'Make the expected result specific.' });
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    assert.equal((await post(`/api/reviews/${id}/process`)).status, 202);
    await until(async () => (await get(`/api/reviews/${id}`)).body.request.status === 'PROPOSAL_READY');

    const review = (await get(`/api/reviews/${id}`)).body;
    assert.equal(review.proposals.at(-1).validation.status, 'VALID');
    assert.equal(review.currentCase.expectedResult, 'Error message shown for invalid credentials');
    assert.equal(readFileSync(qa.qaArtifactPath('test-cases'), 'utf8'), before, 'nothing changed before apply');
    assert.equal((await get('/api/test-cases')).body.testCases[0].pendingReview.status, 'PROPOSAL_READY');

    // Test-case writes land a little later than the prioritization file's mtime.
    await new Promise((r) => setTimeout(r, 20));
    const applied = await post(`/api/proposals/${review.request.latestProposalId}/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((await get('/api/test-cases/TC-1')).body.testCase.expectedResult, 'Error message shown for invalid credentials, and the form stays open.');
    const overview = (await get('/api/overview')).body;
    assert.equal(overview.phase1.state, 'STALE');
    assert.deepEqual(overview.phase1.changed, ['test-cases.json']);
    assert.equal(overview.prioritization.state, 'STALE');
  });

  it('pending work survives a restart', async () => {
    const created = await post('/api/reviews', { operation: 'update', targetTestCaseId: 'TC-2', humanComment: 'Add a boundary.' });
    await stop();
    await start();
    const reviews = (await get('/api/reviews')).body.reviews;
    assert.deepEqual(reviews.map((r: any) => [r.id, r.status]), [[created.body.request.id, 'PENDING']]);
  });

  it('delete: stays active, Keep keeps it, Apply Deletion removes it', async () => {
    const d = await post('/api/reviews', { operation: 'delete', targetTestCaseId: 'TC-2', humanComment: 'Redundant.' });
    assert.equal(d.body.request.status, 'PROPOSAL_READY');
    assert.equal((await get('/api/test-cases/TC-2')).status, 200);
    const detail = (await get(`/api/reviews/${d.body.request.id}`)).body;
    assert.deepEqual(detail.proposals[0].validation.impact.wouldBecomeUncovered, ['AC-1']);
    assert.equal((await post(`/api/proposals/${detail.request.latestProposalId}/reject`)).status, 200);
    assert.equal((await get('/api/test-cases/TC-2')).status, 200);
    const again = await post('/api/reviews', { operation: 'delete', targetTestCaseId: 'TC-2' });
    assert.equal((await post(`/api/proposals/${again.body.request.latestProposalId}/apply`)).status, 200);
    assert.equal((await get('/api/test-cases/TC-2')).status, 404);
  });

  it('acting on a superseded or stale proposal conflicts', async () => {
    const d = await post('/api/reviews', { operation: 'delete', targetTestCaseId: 'TC-2' });
    const u = await post('/api/reviews', { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await post(`/api/reviews/${u.body.request.id}/process`);
    await until(async () => (await get(`/api/reviews/${u.body.request.id}`)).body.request.status === 'PROPOSAL_READY');
    assert.equal((await post(`/api/proposals/${d.body.request.latestProposalId}/apply`)).status, 200);
    const stale = await post(`/api/proposals/${(await get(`/api/reviews/${u.body.request.id}`)).body.request.latestProposalId}/apply`);
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /older version of the test suite/);
    assert.equal((await post(`/api/proposals/${d.body.request.latestProposalId}/apply`)).status, 409, 'an applied proposal cannot be applied twice');
  });

  it('a tampered proposal file is refused over the API too', async () => {
    const d = await post('/api/reviews', { operation: 'delete', targetTestCaseId: 'TC-2' });
    const file = join(REVIEWS_DIR, 'proposals', `${d.body.request.latestProposalId}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), removedTestCaseIds: ['TC-1', 'TC-2'], author: 'system' }));
    const res = await post(`/api/proposals/${d.body.request.latestProposalId}/apply`);
    assert.equal(res.status, 409);
    assert.equal((await get('/api/test-cases')).body.testCases.length, 2);
  });
});

describe('bugs', () => {
  it('lists bug reports and links them to test cases only through explicit references', async () => {
    qa.writeQaArtifact('defect-analysis', {
      findings: [
        {
          id: 'DEF-001', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-2'], sourceTestCaseIds: ['TC-1'],
          reason: 'The message may not name the field.', title: 'Invalid-credentials error is generic', severity: 'MINOR',
          steps: ['Submit the login form with INVALID_PASSWORD'], expected: 'The message says which credential is wrong.',
          actual: 'An error message is shown for invalid credentials.',
        },
        {
          id: 'DEF-002', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-3'],
          reason: 'Unclear when notes become editable.', title: 'Notes editable state is not announced', severity: 'TRIVIAL',
          steps: ['Log in', 'Open the notes area'], expected: 'The page announces that notes can be edited.',
          actual: 'The notes area becomes editable after a successful login.',
        },
      ],
    });
    const list = (await get('/api/bugs')).body.bugs;
    assert.deepEqual(list.map((b: any) => [b.id, b.status, b.severity, b.priority, b.relatedTestCaseIds]), [
      ['BUG-001', 'POTENTIAL', 'MINOR', 'UNASSIGNED', ['TC-1']],
      ['BUG-002', 'POTENTIAL', 'TRIVIAL', 'UNASSIGNED', []],
    ]);
    const detail = (await get('/api/bugs/BUG-001')).body;
    assert.equal(detail.bug.expected, 'The message says which credential is wrong.');
    assert.deepEqual(detail.relatedTestCases, [{ id: 'TC-1', active: true }]);
    assert.deepEqual(detail.behaviors.map((b: any) => b.id), ['BEH-2']);
    assert.deepEqual((await get('/api/test-cases/TC-1')).body.relatedBugIds, ['BUG-001']);
    // TC-2 shares the Authentication area with BUG-002's neighbour, but no report names it.
    assert.deepEqual((await get('/api/test-cases/TC-2')).body.relatedBugIds, []);
    assert.equal((await get('/api/bugs/BUG-404')).status, 404);
  });
});

describe('API input security', () => {
  it('bounds, types and validates every request', async () => {
    const big = await fetch(`${base}/api/reviews`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'create', humanComment: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    assert.equal(big.status, 413);
    const broken = await fetch(`${base}/api/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":' });
    assert.equal(broken.status, 400);
    const form = await fetch(`${base}/api/reviews`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    for (const bad of ['../../etc/passwd', 'REQ-1', 'REQ-0001;rm']) {
      assert.equal((await get(`/api/reviews/${encodeURIComponent(bad)}`)).status, 400, bad);
    }
    assert.equal((await post('/api/proposals/..%2F..%2Ftest-cases/apply')).status, 400);
    assert.equal((await get('/api/test-cases/..%2F..%2F.env')).status, 400);
  });

  it('refuses a path, command, artifact name or unknown operation in a body', async () => {
    for (const body of [
      { operation: 'create', humanComment: 'x', path: '/etc/passwd' },
      { operation: 'create', humanComment: 'x', command: 'rm -rf /' },
      { operation: 'create', humanComment: 'x', artifact: 'phase1-approval' },
      { operation: 'overwrite', targetTestCaseId: 'TC-1' },
      { operation: 'update', targetTestCaseId: 'TC-1', manualEdits: { id: 'TC-9' } },
      { operation: 'update', targetTestCaseId: 'TC-1', manualEdits: { covers: ['AC-9'] } },
      { operation: 'update', targetTestCaseId: '../x', humanComment: 'x' },
    ]) {
      const res = await post('/api/reviews', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await post('/api/reviews/REQ-0001/process', { agent: 'repo-analyzer' })).status, 400);
    assert.equal((await post('/api/phase1/approve', { acceptFindings: true })).status, 400);
    assert.equal(agentCalls, 0, 'no refused request reached the agent');
  });

  it('a request about a case that does not exist is a 400, not a proposal', async () => {
    assert.equal((await post('/api/reviews', { operation: 'delete', targetTestCaseId: 'TC-404' })).status, 400);
    assert.equal((await post('/api/reviews', { operation: 'update', targetTestCaseId: 'TC-1' })).status, 400, 'nothing to change');
  });
});

