// Run history: the SQLite catalog of QA runs, its backfill from archives, and
// the host-side rules around it (liveness, redaction, safe artifact reads).
//
//   npm test
//
// Real better-sqlite3 over a temporary artifact root; nothing is mocked but time.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-history-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');

const { openHistoryDatabase, historyDbPath } = await import('../src/history/database.ts');
const { migrate, MIGRATIONS, HistorySchemaError } = await import('../src/history/migrations.ts');
const store_ = await import('../src/history/run-history-store.ts');
const { SqliteRunHistoryStore, DuplicateRunError, HistoryInputError, safeTarget, sanitizeText } = store_;
const { importArchives, verifyHistory, startedAtFromRunId } = await import('../src/history/importer.ts');
const { indexArchive, metricsFromArchive } = await import('../src/history/archive.ts');
const service = await import('../src/history/service.ts');

after(() => {
  service.closeRunHistory();
  rmSync(ROOT, { recursive: true, force: true });
});

let clock = Date.parse('2026-09-27T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
const memory = () => new SqliteRunHistoryStore(openHistoryDatabase(':memory:'), { now: tick });
const RID = (n: number) => `2026-09-${String(10 + n).padStart(2, '0')}T10-00-00-000Z`;
const newRun = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'PHASE1_MANUAL' as const, model: 'ollama/model-a', target: 'http://localhost:4444/', startedAt: startedAtFromRunId(id)!, gitCommit: 'abc1234-dirty', ownerPid: 123, ...extra,
});

describe('run history database', () => {
  it('creates the schema from an empty file, with the expected settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-hdb-'));
    const db = openHistoryDatabase(join(dir, 'h.sqlite'));
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(db.pragma('synchronous', { simple: true }), 1); // NORMAL
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['runs', 'run_stages', 'run_metrics', 'run_artifacts']) assert.ok(tables.includes(t), t);
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`).all() as { name: string }[]).map((i) => i.name).sort();
    assert.deepEqual(indexes, ['idx_runs_model', 'idx_runs_started_at', 'idx_runs_status']);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates idempotently and refuses a database newer than the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-hdb-'));
    const path = join(dir, 'h.sqlite');
    openHistoryDatabase(path).close();
    const db = openHistoryDatabase(path); // second open: nothing to do, nothing breaks
    assert.equal(migrate(db), MIGRATIONS.length);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openHistoryDatabase(path), HistorySchemaError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a version-1 database with data to the current version without losing a row', async () => {
    const Database = (await import('better-sqlite3')).default;
    const dir = mkdtempSync(join(tmpdir(), 'qa-hdb-v1-'));
    const path = join(dir, 'h.sqlite');
    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    raw.exec(MIGRATIONS[0]);
    raw.pragma('user_version = 1');
    raw.prepare(`INSERT INTO runs (id, run_kind, status, started_at, source, created_at, updated_at) VALUES ('${RID(1)}', 'PHASE1_MANUAL', 'COMPLETED', 'x', 'IMPORTED', 'x', 'x')`).run();
    raw.prepare(`INSERT INTO run_stages (run_id, stage_name, ordinal, status) VALUES ('${RID(1)}', 'discovery', 1, 'COMPLETED')`).run();
    raw.prepare(`INSERT INTO run_metrics (run_id, name, numeric_value) VALUES ('${RID(1)}', 'test_cases_total', 7)`).run();
    raw.close();
    const s = new SqliteRunHistoryStore(openHistoryDatabase(path));
    assert.equal(s.db.pragma('user_version', { simple: true }), 3);
    // A run recorded before coverage modes has none — shown as unknown, never guessed.
    assert.equal(s.getRun(RID(1))!.coverageMode, null);
    assert.equal(s.getRun(RID(1))!.apiDocsUrl, null);
    assert.equal(s.db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys back on after the rebuild');
    assert.equal(s.getRun(RID(1))!.status, 'COMPLETED');
    assert.equal(s.getStages(RID(1)).length, 1, 'the rebuild did not cascade-delete stages');
    assert.deepEqual(s.getMetrics(RID(1)), { test_cases_total: 7 });
    // The new statuses are accepted now.
    s.startRun(newRun(RID(2), { status: 'STARTING' }));
    s.markRunning(RID(2));
    const st = s.startStage(RID(2), { stageName: 'design', ordinal: 1, startedAt: tick() });
    s.cancelStage(st, { finishedAt: tick(), attemptCount: 1 });
    s.finishRun(RID(2), { status: 'CANCELLED', finishedAt: tick() });
    assert.equal(s.getRun(RID(2))!.status, 'CANCELLED');
    assert.equal(s.getStages(RID(2))[0].status, 'CANCELLED');
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a run from start through stages to COMPLETED, with metrics and artifacts', () => {
    const s = memory();
    s.startRun(newRun(RID(1)));
    let run = s.getRun(RID(1))!;
    assert.equal(run.status, 'RUNNING');
    assert.equal(run.gitCommit, 'abc1234');
    assert.equal(run.gitDirty, true);
    assert.equal(run.provider, 'ollama');
    const a = s.startStage(RID(1), { stageName: 'discovery', label: 'Product Discovery', ordinal: 1, startedAt: '2026-09-11T10:00:00.000Z' });
    assert.equal(s.getRun(RID(1))!.currentStage, 'discovery');
    s.setStageAttempts(a, 2);
    s.completeStage(a, { finishedAt: '2026-09-11T10:00:01.000Z', attemptCount: 2 });
    const b = s.startStage(RID(1), { stageName: 'analysis', ordinal: 2, startedAt: tick() });
    s.completeStage(b, { finishedAt: tick(), attemptCount: 1 });
    s.finishRun(RID(1), {
      status: 'COMPLETED', finishedAt: tick(), archiveRelPath: `runs/${RID(1)}`,
      metrics: { test_cases_total: 14, discovered_behaviors: 18 },
      artifacts: [{ artifactType: 'TEST_CASES', relativePath: 'test-cases.json', sha256: 'a'.repeat(64), sizeBytes: 10 }],
    });
    run = s.getRun(RID(1))!;
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.currentStage, null);
    assert.ok((run.durationMs ?? 0) > 0);
    const stages = s.getStages(RID(1));
    assert.deepEqual(stages.map((x) => [x.stageName, x.status, x.attemptCount]), [['discovery', 'COMPLETED', 2], ['analysis', 'COMPLETED', 1]]);
    assert.equal(stages[0].durationMs, 1000);
    assert.deepEqual(s.getMetrics(RID(1)), { discovered_behaviors: 18, test_cases_total: 14 });
    assert.equal(s.getArtifacts(RID(1)).length, 1);
  });

  it('records a FAILED run and its failed stage; the list says where it stopped', () => {
    const s = memory();
    s.startRun(newRun(RID(2)));
    const st = s.startStage(RID(2), { stageName: 'defects', label: 'Defect Analyzer', ordinal: 5, startedAt: tick() });
    s.failStage(st, { finishedAt: tick(), attemptCount: 4, errorCode: 'STAGE_FAILED', errorSummary: 'defect-analysis.json was not written by this attempt.' });
    s.finishRun(RID(2), { status: 'FAILED', finishedAt: tick(), errorCode: 'STAGE_FAILED', errorSummary: 'Defect Analyzer did not produce a valid artifact.' });
    const listed = s.listRuns().runs[0];
    assert.equal(listed.status, 'FAILED');
    assert.equal(listed.failedStage, 'Defect Analyzer');
    assert.equal(s.getStages(RID(2))[0].attemptCount, 4);
  });

  it('closes a stage left RUNNING with its run', () => {
    const s = memory();
    s.startRun(newRun(RID(3)));
    s.startStage(RID(3), { stageName: 'design', ordinal: 1, startedAt: tick() });
    s.finishRun(RID(3), { status: 'INTERRUPTED', finishedAt: tick(), errorCode: 'INTERRUPTED' });
    assert.equal(s.getStages(RID(3))[0].status, 'INTERRUPTED');
  });

  it('refuses a duplicate run id without touching the first', () => {
    const s = memory();
    s.startRun(newRun(RID(4)));
    assert.throws(() => s.startRun(newRun(RID(4), { model: 'other/model' })), DuplicateRunError);
    assert.equal(s.getRun(RID(4))!.model, 'ollama/model-a');
  });

  it('rolls back a finish that fails half way: the run stays RUNNING with nothing half-written', () => {
    const s = memory();
    s.startRun(newRun(RID(5)));
    // A trigger makes the artifact insert — the last step of finishRun — fail.
    s.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON run_artifacts BEGIN SELECT RAISE(ABORT, 'disk said no'); END;`);
    assert.throws(() => s.finishRun(RID(5), {
      status: 'COMPLETED', finishedAt: tick(), metrics: { test_cases_total: 3 },
      artifacts: [{ artifactType: 'TEST_CASES', relativePath: 'test-cases.json', sha256: null, sizeBytes: null }],
    }), /disk said no/);
    assert.equal(s.getRun(RID(5))!.status, 'RUNNING');
    assert.deepEqual(s.getMetrics(RID(5)), {});
  });

  it('refuses closed-vocabulary values the host did not choose', () => {
    const s = memory();
    assert.throws(() => s.startRun(newRun(RID(6), { kind: 'DROP TABLE runs' as never })), HistoryInputError);
    assert.throws(() => s.startRun(newRun('../../etc/passwd')), HistoryInputError);
    s.startRun(newRun(RID(6)));
    assert.throws(() => s.setMetric(RID(6), 'Robert"); DROP TABLE runs;--', 1), HistoryInputError);
    assert.throws(() => s.setMetric(RID(6), 'test_cases_total', Number.NaN), HistoryInputError);
    assert.throws(() => s.indexArtifact(RID(6), { artifactType: 'TEST_CASES', relativePath: '../secret.json', sha256: null, sizeBytes: null }), HistoryInputError);
    assert.throws(() => s.indexArtifact(RID(6), { artifactType: 'SHELL' as never, relativePath: 'x.json', sha256: null, sizeBytes: null }), HistoryInputError);
    // The CHECK constraints hold even for SQL that bypasses the store.
    assert.throws(() => s.db.prepare(`UPDATE runs SET status = 'PWNED'`).run(), /CHECK constraint/);
  });

  it('pages newest first and filters by status, model, provider, kind, target and date', () => {
    const s = memory();
    for (let i = 1; i <= 7; i += 1) {
      s.startRun(newRun(RID(i), { model: i % 2 ? 'ollama/model-a' : 'openrouter/vendor/model-b', kind: i === 7 ? 'DEPENDENCY_REFRESH' : 'PHASE1_MANUAL', target: i === 3 ? 'http://other:1/' : 'http://localhost:4444/' }));
      if (i !== 4) s.finishRun(RID(i), { status: i === 2 ? 'FAILED' : 'COMPLETED', finishedAt: tick(), metrics: { test_cases_total: i } });
    }
    const page1 = s.listRuns({ limit: 3 });
    assert.equal(page1.total, 7);
    assert.deepEqual(page1.runs.map((r) => r.id), [RID(7), RID(6), RID(5)]);
    assert.deepEqual(s.listRuns({ limit: 3, offset: 3 }).runs.map((r) => r.id), [RID(4), RID(3), RID(2)]);
    assert.equal(page1.runs[0].metrics.test_cases_total, 7);
    assert.deepEqual(s.listRuns({ status: 'FAILED' }).runs.map((r) => r.id), [RID(2)]);
    assert.deepEqual(s.listRuns({ status: 'RUNNING' }).runs.map((r) => r.id), [RID(4)]);
    assert.equal(s.listRuns({ model: 'openrouter/vendor/model-b' }).total, 3);
    assert.equal(s.listRuns({ provider: 'ollama' }).total, 4);
    assert.deepEqual(s.listRuns({ kind: 'DEPENDENCY_REFRESH' }).runs.map((r) => r.id), [RID(7)]);
    assert.deepEqual(s.listRuns({ target: 'http://other:1/' }).runs.map((r) => r.id), [RID(3)]);
    assert.deepEqual(s.listRuns({ startedFrom: startedAtFromRunId(RID(5)), startedTo: startedAtFromRunId(RID(6)) }).runs.map((r) => r.id), [RID(6), RID(5)]);
    assert.equal(s.listRuns({ limit: 10_000 }).limit, 100);
    assert.deepEqual(s.facets().models, ['ollama/model-a', 'openrouter/vendor/model-b']);
  });

  it('treats injection-shaped filter values as data', () => {
    const s = memory();
    s.startRun(newRun(RID(1)));
    const evil = `' OR '1'='1`;
    assert.equal(s.listRuns({ model: evil }).total, 0);
    assert.equal(s.listRuns({ target: `x'; DROP TABLE runs; --` }).total, 0);
    assert.equal(s.listRuns().total, 1);
  });

  it('redacts before persisting: targets, error text, stage errors', () => {
    const s = memory();
    s.startRun(newRun(RID(1), { target: 'http://user:pw@localhost:4444/confirm?confirm_code=123456#x' }));
    assert.equal(s.getRun(RID(1))!.target, 'http://localhost:4444/confirm');
    const st = s.startStage(RID(1), { stageName: 'discovery', ordinal: 1, startedAt: tick() });
    s.failStage(st, { finishedAt: tick(), attemptCount: 1, errorCode: 'STAGE_FAILED', errorSummary: 'Visited http://localhost:8025/api/v1/messages/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY/download?token=abc then failed\n    at Object.<anonymous> (/secret/path.js:1:1)' });
    s.finishRun(RID(1), { status: 'FAILED', finishedAt: tick(), errorSummary: 'key sk-or-v1-0123456789abcdef0123456789abcdef leaked?' });
    const stage = s.getStages(RID(1))[0];
    assert.doesNotMatch(stage.errorSummary!, /token=abc|aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY|\/secret\/path/);
    assert.doesNotMatch(s.getRun(RID(1))!.errorSummary!, /sk-or-v1-0123456789abcdef/);
    assert.equal(safeTarget('javascript:alert(1)'), null);
    assert.equal(sanitizeText('line one\n  at stack'), 'line one');
  });

  it('marks RUNNING rows whose owner is gone INTERRUPTED, and leaves a live one alone', () => {
    const s = memory();
    s.startRun(newRun(RID(1), { ownerPid: 99_999_999 }));
    s.startStage(RID(1), { stageName: 'discovery', ordinal: 1, startedAt: tick() });
    s.startRun(newRun(RID(2), { ownerPid: process.pid }));
    const marked = s.reconcileRunning((r) => r.id === RID(2));
    assert.deepEqual(marked, [RID(1)]);
    assert.equal(s.getRun(RID(1))!.status, 'INTERRUPTED');
    assert.equal(s.getStages(RID(1))[0].status, 'INTERRUPTED');
    assert.equal(s.getRun(RID(2))!.status, 'RUNNING');
  });
});

describe('liveness, from the process table and the run lock', () => {
  it('is alive only while the owner exists and, for a lock-holding run, the lock names that run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-hlock-'));
    const s = memory();
    s.startRun(newRun(RID(1), { ownerPid: process.pid, holdsRunLock: true }));
    s.startRun(newRun(RID(2), { ownerPid: process.pid }));
    s.startRun(newRun(RID(3), { ownerPid: 99_999_999 }));
    const run = (id: string) => s.getRun(id)!;
    assert.equal(service.ownerAlive(run(RID(1)), dir), false, 'no lock file: the lock-holding run is gone');
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, runId: RID(1) }));
    assert.equal(service.ownerAlive(run(RID(1)), dir), true);
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, runId: RID(9) }));
    assert.equal(service.ownerAlive(run(RID(1)), dir), false, 'the lock now belongs to another run: this pid was reused');
    assert.equal(service.ownerAlive(run(RID(2)), dir), true, 'a run without the lock is alive while its process is');
    assert.equal(service.ownerAlive(run(RID(3)), dir), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Archives and backfill
// ---------------------------------------------------------------------------

const RUNS = join(ROOT, 'runs');
function archive(id: string, files: Record<string, unknown>, copy: string[] = []) {
  const dir = join(RUNS, id);
  mkdirSync(join(dir, 'bugs'), { recursive: true });
  for (const name of copy) copyFileSync(join(FIXTURES, name), join(dir, name));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  return dir;
}
const PHASE1 = ['discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json', 'automation-prioritization.json'];
const bug = (id: string) => ({ id, status: 'POTENTIAL', title: `Bug ${id}`, severity: 'MINOR', priority: 'UNASSIGNED' });

const MODERN = '2026-09-24T18-39-10-262Z';
const FAILED = '2026-09-24T19-41-08-042Z';
const OLD = '2026-09-20T08-00-00-000Z';
const WITH_BUGS = '2026-09-26T14-33-36-698Z';
const MALFORMED = '2026-09-25T00-00-00-000Z';

archive(MODERN, {
  'run-metadata.json': { runId: MODERN, model: 'openrouter/deepseek/deepseek-v4-flash-0731', provider: 'openrouter', target: 'http://localhost:4444/', startedAt: '2026-09-24T18:39:10.262Z', finishedAt: '2026-09-24T19:05:34.653Z', durationMs: 1584391, outcome: 'completed', gitCommit: '828b6bb-dirty' },
  'phase1-run.json': { phase: 1, result: 'COMPLETE', stages: [
    { stage: 'discovery', passed: true, attempts: [{ attempt: 1, passed: true, durationMs: 1000, toolCallsByTool: { browser_click: 3, browser_snapshot: 4, write_qa_artifact: 2 }, problem: null }], completionGate: { finalizationRejectedCount: 1 } },
    { stage: 'analysis', passed: true, attempts: [{ attempt: 1, passed: false, durationMs: 500, problem: 'requirements-analysis.json fails semantic validation: UNKNOWN_EVIDENCE_ID at $.x' }, { attempt: 2, passed: true, durationMs: 700, problem: null }] },
  ], observations: { recorded: 6 } },
  'discovery-surface.json': { auxiliaryOrigins: ['http://localhost:8025'], states: [1, 2, 3], observedLocations: ['http://localhost:4444/', 'http://localhost:8025/', 'http://localhost:8025/x'] },
}, PHASE1);
archive(FAILED, {
  'run-metadata.json': { runId: FAILED, kind: 'PHASE1_MANUAL', model: 'ollama/gpt-oss-20b-q5-49k', target: 'http://localhost:4444/', startedAt: '2026-09-24T19:41:08.042Z', finishedAt: '2026-09-24T19:45:15.722Z', durationMs: 247680, outcome: 'failed', failedStage: 'design' },
  'phase1-run.json': { phase: 1, result: 'FAILED', failedStage: 'design', stages: [
    { stage: 'discovery', passed: true, attempts: [{ attempt: 1, passed: true, durationMs: 100 }] },
    { stage: 'analysis', passed: true, attempts: [{ attempt: 1, passed: true, durationMs: 100 }] },
    { stage: 'design', passed: false, attempts: [1, 2, 3, 4].map((n) => ({ attempt: n, passed: false, durationMs: 50, problem: 'test-cases.json was not written by this attempt.' })) },
  ] },
}, ['discovered-behavior.json', 'requirements-analysis.json']);
// An old run: no run-metadata.json, no newer fields — only a run record and one artifact.
archive(OLD, { 'phase1-run.json': { phase: 1, model: 'ollama/qwen3:14b', target: 'http://localhost:4444/', startedAt: '2026-09-20T08:00:00.000Z', result: 'COMPLETE', stages: [] } }, ['test-cases.json']);
archive(WITH_BUGS, {
  'run-metadata.json': { runId: WITH_BUGS, model: 'openrouter/deepseek/deepseek-v4-flash-0731', target: 'http://localhost:4444/', startedAt: '2026-09-26T14:33:36.698Z', outcome: 'completed', authBootstrapMode: 'none' },
  'defect-analysis.json': { findings: [{ classification: 'CONFIRMED_DEFECT' }, { classification: 'POTENTIAL_DEFECT' }, { classification: 'NOT_A_DEFECT' }] },
  'bugs/BUG-001.json': bug('BUG-001'),
  'bugs/BUG-002.json': bug('BUG-002'),
  'notes.txt': 'not an artifact',
}, PHASE1);
archive(MALFORMED, { 'run-metadata.json': '{ this is not json' });
archive('not-a-run-id', { 'run-metadata.json': { runId: 'x' } });

describe('run archives', () => {
  it('a run that stopped early archives only what it wrote — never a leftover of an earlier run', async () => {
    const { preserveRun } = await import('../scripts/lib/run-record.mjs');
    const root = mkdtempSync(join(tmpdir(), 'qa-preserve-'));
    writeFileSync(join(root, 'discovery-evidence.json'), '{"old":true}');
    const started = new Date(Date.now() + 50);
    await new Promise((r) => setTimeout(r, 80));
    writeFileSync(join(root, 'discovered-behavior.json'), '{"new":true}');
    const { metadata } = preserveRun({ artifactRoot: root, projectRoot: PROJECT, runId: RID(1), model: 'm', target: 't', startedAt: started, outcome: 'cancelled', onlyWrittenSince: started, files: ['discovery-evidence.json', 'discovered-behavior.json'] });
    assert.deepEqual(metadata.artifacts, ['discovered-behavior.json']);
    assert.ok(!existsSync(join(root, 'runs', RID(1), 'discovery-evidence.json')));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('archive derivation', () => {
  it('derives only metrics the archive supports — absent is absent, not zero', () => {
    const m = metricsFromArchive(join(RUNS, MODERN));
    assert.equal(m.product_states, 3);
    assert.equal(m.auxiliary_visits, 2);
    assert.equal(m.semantic_rejections, 1);
    assert.equal(m.browser_tool_calls, 7);
    assert.equal(m.stage_attempts_total, 3);
    assert.equal(m.discovery_finalization_rejections, 1);
    assert.equal(m.observations_recorded, 6);
    assert.ok(m.test_cases_total > 0);
    assert.ok(!('defects_confirmed' in m), 'no defect-analysis.json: no defect metrics');
    assert.ok(!('tool_errors' in m) && !('max_context_usage_pct' in m), 'never recorded host-side');
    const old = metricsFromArchive(join(RUNS, OLD));
    // A run record with no stages supports zero attempts — a real count; nothing else is claimed.
    assert.deepEqual(Object.keys(old).sort(), ['artifact_not_written_attempts', 'semantic_rejections', 'stage_attempts_total', 'test_cases_api', 'test_cases_total', 'test_cases_ui']);
    assert.equal(old.stage_attempts_total, 0);
  });

  it('indexes known files and bug reports with hashes; ignores unknown files and symlinks', () => {
    const dir = join(RUNS, WITH_BUGS);
    symlinkSync('/etc/hostname', join(dir, 'discovery-evidence.json'));
    const index = indexArchive(dir);
    const paths = index.map((a) => a.relativePath);
    assert.ok(paths.includes('bugs/BUG-001.json') && paths.includes('bugs/BUG-002.json'));
    assert.ok(!paths.includes('notes.txt'));
    assert.ok(!paths.includes('discovery-evidence.json'), 'a symlink is never indexed');
    assert.ok(index.every((a) => /^[0-9a-f]{64}$/.test(a.sha256!) && a.sizeBytes! > 0));
    rmSync(join(dir, 'discovery-evidence.json'));
  });
});

describe('backfill from .qa/runs', () => {
  const store = service.runHistory();
  const labels = { discovery: 'Product Discovery', analysis: 'Behavior Analyst', design: 'Test Designer' };
  const snapshot = () => Object.fromEntries(readdirSync(RUNS, { recursive: true }).map(String).sort().map((p) => {
    const path = join(RUNS, p);
    return [p, statSync(path).isFile() ? readFileSync(path, 'utf8') : 'dir'];
  }));

  it('imports every well-formed archive, reports malformed ones, and never modifies an archive', () => {
    const before = snapshot();
    const report = importArchives(store, ROOT, { stageLabels: labels });
    assert.equal(report.archivesFound, 6);
    assert.deepEqual(report.imported.sort(), [FAILED, MODERN, OLD, WITH_BUGS].sort());
    assert.deepEqual(report.malformed.map((m) => m.id).sort(), [MALFORMED, 'not-a-run-id'].sort());
    assert.ok(report.metricsRecovered > 10);
    assert.ok(report.artifactsIndexed > 10);
    assert.deepEqual(snapshot(), before, 'the archives are byte-for-byte unchanged');
    assert.ok(existsSync(historyDbPath(ROOT)));
  });

  it('keeps what each archive says: model, status, stages, bugs, legacy fields', () => {
    const modern = store.getRun(MODERN)!;
    assert.equal(modern.status, 'COMPLETED');
    assert.equal(modern.model, 'openrouter/deepseek/deepseek-v4-flash-0731');
    assert.equal(modern.provider, 'openrouter');
    assert.equal(modern.durationMs, 1584391);
    assert.equal(modern.source, 'IMPORTED');
    assert.deepEqual(store.getStages(MODERN).map((s) => [s.stageName, s.status, s.attemptCount, s.durationMs]), [['discovery', 'COMPLETED', 1, 1000], ['analysis', 'COMPLETED', 2, 1200]]);

    const failed = store.getRun(FAILED)!;
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorSummary, 'Stopped at Test Designer.');
    const design = store.getStages(FAILED).at(-1)!;
    assert.deepEqual([design.label, design.status, design.attemptCount], ['Test Designer', 'FAILED', 4]);

    const old = store.getRun(OLD)!;
    assert.equal(old.model, 'ollama/qwen3:14b');
    assert.equal(old.gitCommit, null);
    assert.equal(old.finishedAt, null);

    const withBugs = store.getRun(WITH_BUGS)!;
    assert.equal(withBugs.authMode, 'none');
    const m = store.getMetrics(WITH_BUGS);
    assert.deepEqual([m.defects_confirmed, m.defects_potential, m.defects_not_a_defect, m.bug_reports_created], [1, 1, 1, 2]);
  });

  it('is idempotent: a second import skips everything it already has', () => {
    const report = importArchives(store, ROOT, { stageLabels: labels });
    assert.equal(report.imported.length, 0);
    assert.equal(report.skipped.length, 4);
    assert.equal(store.listRuns().total, 4);
  });

  it('re-indexes a live run whose finishing index failed', () => {
    const id = '2026-09-27T09-00-00-000Z';
    archive(id, { 'run-metadata.json': { runId: id, outcome: 'completed' } }, ['test-cases.json']);
    store.startRun(newRun(id));
    store.finishRun(id, { status: 'COMPLETED', finishedAt: tick(), errorCode: 'HISTORY_INDEX_FAILED', archiveRelPath: `runs/${id}` });
    assert.equal(store.getArtifacts(id).length, 0);
    const report = importArchives(store, ROOT, { stageLabels: labels });
    assert.deepEqual(report.reindexed, [id]);
    assert.equal(store.getRun(id)!.errorCode, null);
    assert.equal(store.getRun(id)!.status, 'COMPLETED');
    assert.ok(store.getArtifacts(id).length >= 2);
  });

  it('verify reports drift between the index and the archive', () => {
    assert.deepEqual(verifyHistory(store, ROOT).problems, []);
    writeFileSync(join(RUNS, MODERN, 'test-cases.json'), '{"tampered":true}');
    writeFileSync(join(RUNS, MODERN, 'phase1-approval.json'), '{}');
    const report = verifyHistory(store, ROOT);
    assert.ok(report.problems.some((p) => p.runId === MODERN && /test-cases.json changed/.test(p.problem)));
    assert.ok(report.problems.some((p) => p.runId === MODERN && /phase1-approval.json is in the archive but not indexed/.test(p.problem)));
    assert.deepEqual(report.archivesNotRecorded.sort(), [MALFORMED, 'not-a-run-id'].sort());
    rmSync(join(RUNS, MODERN, 'phase1-approval.json'));
    copyFileSync(join(FIXTURES, 'test-cases.json'), join(RUNS, MODERN, 'test-cases.json'));
  });
});

describe('historical artifacts are read by domain id only', () => {
  const store = service.runHistory();

  it('reads an indexed artifact and a bug report of a recorded run', () => {
    const suite = service.readHistoricalArtifact(store, MODERN, 'TEST_CASES') as { testCases: unknown[] };
    assert.ok(suite.testCases.length > 0);
    const b = service.readHistoricalArtifact(store, WITH_BUGS, 'BUG_REPORT', 'BUG-002') as { id: string };
    assert.equal(b.id, 'BUG-002');
  });

  it('refuses anything that is not an indexed artifact of a recorded run', () => {
    const err = (fn: () => unknown, status: number) => assert.throws(fn, (e: { status?: number }) => e.status === status);
    err(() => service.readHistoricalArtifact(store, '../../etc', 'TEST_CASES'), 400);
    err(() => service.readHistoricalArtifact(store, '2030-01-01T00-00-00-000Z', 'TEST_CASES'), 404);
    err(() => service.readHistoricalArtifact(store, MODERN, 'PASSWD' as never), 400);
    err(() => service.readHistoricalArtifact(store, WITH_BUGS, 'BUG_REPORT', '../../x'), 400);
    err(() => service.readHistoricalArtifact(store, WITH_BUGS, 'BUG_REPORT', 'BUG-999'), 404);
    err(() => service.readHistoricalArtifact(store, FAILED, 'TEST_CASES'), 404); // the failed run never wrote one
  });
});
