// The workspace's Runs API: read-only run history over HTTP.
//
//   npm test
//
// The real host server and a real SQLite history over a temporary artifact root
// with archived runs. Proves the browser can browse history, cannot name a path
// or SQL, and cannot change anything.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-runs-api-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');

const { createUiServer } = await import('../src/ui-server/server.ts');
const { FileReviewStore } = await import('../src/review/review-store.ts');
const { artifactWorkspace, REVIEWS_DIR } = await import('../src/review/workspace.ts');
const service = await import('../src/history/service.ts');
const { importArchives } = await import('../src/history/importer.ts');

const OLD = '2026-09-24T19-41-08-042Z';
const NEW = '2026-09-26T14-33-36-698Z';
const FAILED = '2026-09-25T10-00-00-000Z';

function archive(id: string, meta: Record<string, unknown>, copy: string[], extra: Record<string, unknown> = {}) {
  const dir = join(ROOT, 'runs', id);
  mkdirSync(join(dir, 'bugs'), { recursive: true });
  for (const f of copy) copyFileSync(join(FIXTURES, f), join(dir, f));
  writeFileSync(join(dir, 'run-metadata.json'), JSON.stringify({ runId: id, ...meta }));
  for (const [f, v] of Object.entries(extra)) writeFileSync(join(dir, f), JSON.stringify(v));
}
archive(OLD, { model: 'ollama/gpt-oss-20b-q5-49k', target: 'http://localhost:4444/', outcome: 'completed', startedAt: '2026-09-24T19:41:08.042Z', durationMs: 247680 }, ['test-cases.json']);
archive(FAILED, { model: 'ollama/gpt-oss-20b-q5-49k', target: 'http://localhost:4444/', outcome: 'failed', startedAt: '2026-09-25T10:00:00.000Z' }, [], {
  'phase1-run.json': { phase: 1, result: 'FAILED', failedStage: 'analysis', stages: [{ stage: 'discovery', passed: true, attempts: [{ passed: true, durationMs: 5 }] }, { stage: 'analysis', passed: false, attempts: [{ passed: false, problem: 'x' }] }] },
});
archive(NEW, { model: 'openrouter/deepseek/deepseek-v4-flash-0731', target: 'http://localhost:4444/', outcome: 'completed', startedAt: '2026-09-26T14:33:36.698Z' },
  ['discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json', 'automation-prioritization.json'], {
    'defect-analysis.json': { findings: [{ id: 'DEF-001', classification: 'CONFIRMED_DEFECT', bugReportId: 'BUG-001' }] },
    'bugs/BUG-001.json': { id: 'BUG-001', status: 'CONFIRMED', title: 'Notes editable too early', severity: 'MAJOR', priority: 'UNASSIGNED', sourceTestCaseIds: ['TC-1', 'TC-404'], evidence: [{ type: 'behavior', sourceId: 'BEH-3' }], review: { decision: 'PENDING' }, steps: ['Log in'], expected: 'e', actual: 'a' },
  });

let server: Server;
let base = '';
const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any };
};

before(async () => {
  importArchives(service.runHistory(), ROOT, { stageLabels: { discovery: 'Product Discovery', analysis: 'Behavior Analyst' } });
  server = await createUiServer({
    store: new FileReviewStore(REVIEWS_DIR),
    workspace: artifactWorkspace,
    runReviewAgent: async () => {},
    refresh: { start: async () => {}, status: () => ({ status: 'IDLE' as const }) },
    history: () => service.runHistory(),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
  service.closeRunHistory();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('GET /api/runs', () => {
  it('lists newest first with headline metrics, facets, and where a failed run stopped', async () => {
    const { status, body } = await get('/api/runs');
    assert.equal(status, 200);
    assert.deepEqual(body.runs.map((r: any) => r.id), [NEW, FAILED, OLD]);
    assert.equal(body.total, 3);
    assert.ok(body.runs[0].metrics.test_cases_total > 0);
    assert.equal(body.runs[1].status, 'FAILED');
    assert.equal(body.runs[1].failedStage, 'Behavior Analyst');
    assert.deepEqual(body.facets.models, ['ollama/gpt-oss-20b-q5-49k', 'openrouter/deepseek/deepseek-v4-flash-0731']);
    assert.deepEqual(body.active, []);
  });

  it('filters and pages', async () => {
    assert.deepEqual((await get('/api/runs?model=ollama%2Fgpt-oss-20b-q5-49k&status=COMPLETED')).body.runs.map((r: any) => r.id), [OLD]);
    assert.deepEqual((await get('/api/runs?provider=openrouter')).body.runs.map((r: any) => r.id), [NEW]);
    assert.deepEqual((await get('/api/runs?from=2026-09-25&to=2026-09-25')).body.runs.map((r: any) => r.id), [FAILED]);
    const page = (await get('/api/runs?limit=1&offset=1')).body;
    assert.deepEqual([page.runs.map((r: any) => r.id), page.total], [[FAILED], 3]);
  });

  it('refuses unknown parameters and malformed values; injection-shaped values are data', async () => {
    for (const q of ['sql=1', 'status=DROPPED', 'kind=anything', 'limit=-1', 'limit=abc', 'from=yesterday', 'status=COMPLETED&status=FAILED', 'path=/etc/passwd']) {
      assert.equal((await get(`/api/runs?${q}`)).status, 400, q);
    }
    const r = await get(`/api/runs?model=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
  });
});

describe('GET /api/runs/:runId and its snapshot', () => {
  it('returns metadata, stages, metrics and artifact types — never a path', async () => {
    const { status, body } = await get(`/api/runs/${NEW}`);
    assert.equal(status, 200);
    assert.equal(body.run.model, 'openrouter/deepseek/deepseek-v4-flash-0731');
    assert.ok(body.artifacts.includes('TEST_CASES'));
    assert.deepEqual(body.bugIds, ['BUG-001']);
    assert.equal(body.metrics.defects_confirmed, 1);
    assert.doesNotMatch(JSON.stringify(body.artifacts), /\.json|\//);
    const failed = (await get(`/api/runs/${FAILED}`)).body;
    assert.deepEqual(failed.stages.map((s: any) => [s.label, s.status]), [['Product Discovery', 'COMPLETED'], ['Behavior Analyst', 'FAILED']]);
  });

  it('serves the archived test cases, bugs and artifacts', async () => {
    const tc = (await get(`/api/runs/${NEW}/test-cases`)).body;
    assert.ok(tc.testCases.length > 0);
    assert.ok(Object.keys(tc.prioritization).length > 0);
    assert.equal((await get(`/api/runs/${OLD}/test-cases`)).body.testCases.length > 0, true, 'an old run with only test cases');
    const bugs = (await get(`/api/runs/${NEW}/bugs`)).body.bugs;
    assert.deepEqual(bugs.map((b: any) => [b.id, b.severity]), [['BUG-001', 'MAJOR']]);
    const bug = (await get(`/api/runs/${NEW}/bugs/BUG-001`)).body;
    assert.equal(bug.classification, 'CONFIRMED_DEFECT');
    assert.deepEqual(bug.relatedTestCases, [{ id: 'TC-1', inSnapshot: true }, { id: 'TC-404', inSnapshot: false }]);
    const req = await get(`/api/runs/${NEW}/artifacts/REQUIREMENTS_ANALYSIS`);
    assert.equal(req.status, 200);
    assert.ok(req.body.artifact.acceptancePoints);
  });

  it('refuses paths, unknown types, other runs\' files and unarchived artifacts', async () => {
    const cases: [string, number][] = [
      [`/api/runs/..%2F..%2Fetc`, 400],
      [`/api/runs/${encodeURIComponent('../../etc/passwd')}/test-cases`, 400],
      [`/api/runs/2030-01-01T00-00-00-000Z`, 404],
      [`/api/runs/${NEW}/artifacts/RUN_METADATA`, 400],
      [`/api/runs/${NEW}/artifacts/PHASE1_APPROVAL`, 400],
      [`/api/runs/${NEW}/artifacts/passwd`, 404],
      [`/api/runs/${NEW}/bugs/${encodeURIComponent('../BUG-001')}`, 400],
      [`/api/runs/${OLD}/bugs/BUG-001`, 404],
      [`/api/runs/${FAILED}/test-cases`, 404],
      [`/api/runs/${OLD}/artifacts/DEFECT_ANALYSIS`, 404],
    ];
    for (const [path, status] of cases) assert.equal((await get(path)).status, status, path);
  });

  it('is read-only: no method but GET reaches a recorded run', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of [`/api/runs/${NEW}`, `/api/runs/${NEW}/bugs/BUG-001`, `/api/runs/${NEW}/test-cases`]) {
        const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    }
    // POST /api/runs starts a NEW run (run control) — never touches history; this server has no controller.
    const valid = { pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/x', freshBrowser: false };
    const start = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) });
    assert.equal(start.status, 503);
    assert.equal((await get('/api/runs')).body.total, 3, 'the history is unchanged');
  });

  it('settles a RUNNING row whose process is gone when the list is read', async () => {
    const store = service.runHistory();
    store.startRun({ id: '2026-09-27T00-00-00-000Z', kind: 'PHASE1_MANUAL', startedAt: '2026-09-27T00:00:00.000Z', ownerPid: 99_999_999 });
    store.startRun({ id: '2026-09-27T00-00-01-000Z', kind: 'PHASE1_MANUAL', startedAt: '2026-09-27T00:00:01.000Z', ownerPid: process.pid });
    store.startStage('2026-09-27T00-00-01-000Z', { stageName: 'design', label: 'Test Designer', ordinal: 1, startedAt: '2026-09-27T00:00:02.000Z' });
    const body = (await get('/api/runs')).body;
    assert.equal(body.runs.find((r: any) => r.id === '2026-09-27T00-00-00-000Z').status, 'INTERRUPTED');
    assert.deepEqual(body.active.map((a: any) => [a.id, a.currentStage]), [['2026-09-27T00-00-01-000Z', 'design']]);
  });
});

describe('without a history', () => {
  it('answers 503 with a reason instead of failing the server', async () => {
    const s = await createUiServer({
      store: new FileReviewStore(REVIEWS_DIR), workspace: artifactWorkspace, runReviewAgent: async () => {},
      refresh: { start: async () => {}, status: () => ({ status: 'IDLE' as const }) },
      history: () => { throw new Error('database disk image is malformed'); },
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/runs`);
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as any).error, /Run history is unavailable: database disk image is malformed/);
    s.closeAllConnections?.();
    await new Promise<void>((done) => s.close(() => done()));
  });
});
