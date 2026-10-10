// Run control: the RunController, the run event log, and the SSE stream.
//
//   npm test
//
// The real controller forks a real runner process — test/fixtures/fake-phase1-runner.mjs,
// which follows the same contract as scripts/qa-manual.mjs and uses the same
// run lock, history recorder, event log and cancellation — over a temporary
// artifact root. The real host server serves the API and the stream.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-run-control-'));
Object.assign(process.env, {
  QA_ARTIFACT_ROOT: ROOT,
  QA_ENV_FILE: '/nonexistent',
  LANGFUSE_ENABLED: 'false',
  TARGET_URL: 'http://localhost:4444/',
  QA_UI_TARGETS: 'http://localhost:5555/',
  QA_MODEL: 'ollama/fake-complete',
  QA_UI_MODELS: 'ollama/fake-fail,ollama/fake-slow,ollama/fake-ignore-cancel,ollama/fake-crash,openrouter/vendor/model',
  FAKE_STAGE_MS: '150',
});
delete process.env.OPENROUTER_API_KEY;
delete process.env.FAKE_RUN_SCENARIO;
delete process.env.QA_DISCOVERY_AUX_ORIGINS;
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { RunController, RunConflictError, runnerArgs, runnerEnv, PHASE1_RUNNER } = await import('../src/run-control/run-controller.ts');
const { readRunConfig, validateStartRequest, RunConfigError } = await import('../src/run-control/run-config.ts');
const { EventLogWriter, readEventLog, normalizeEvent, MAX_EVENTS_PER_RUN } = await import('../src/run-control/events.ts');
const service = await import('../src/history/service.ts');
const { createUiServer } = await import('../src/ui-server/server.ts');
const { FileReviewStore } = await import('../src/review/review-store.ts');
const { artifactWorkspace, REVIEWS_DIR } = await import('../src/review/workspace.ts');
const { REPLAY_LIMIT } = await import('../src/ui-server/run-control-api.ts');

const history = () => service.runHistory();
const controller = new RunController({
  artifactRoot: ROOT, projectRoot: PROJECT, history, runnerScript: 'test/fixtures/fake-phase1-runner.mjs',
  graceMs: { cancel: 1500, term: 1500 }, log: () => {},
});
const start = (model = 'ollama/fake-complete', extra: Record<string, unknown> = {}) =>
  controller.start({ pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model, freshBrowser: false, ...extra } as never);
const events = (runId: string) => readEventLog(join(ROOT, 'runs', runId, 'events.jsonl'));
async function until<T>(fn: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let server: Server;
let base = '';
before(async () => {
  server = await createUiServer({
    store: new FileReviewStore(REVIEWS_DIR), workspace: artifactWorkspace, runReviewAgent: async () => {},
    refresh: { start: async () => {}, status: () => ({ status: 'IDLE' as const }) },
    history, runController: controller,
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

// ---------------------------------------------------------------------------

describe('run configuration', () => {
  it('offers host-configured choices only, and never a secret', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-supersecretvalue0000000000000000';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-secret';
    const view = readRunConfig();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    assert.deepEqual(view.targets.map((t) => t.url), ['http://localhost:4444/', 'http://localhost:5555/']);
    assert.equal(view.models[0].id, 'ollama/fake-complete');
    assert.equal(view.models.find((m) => m.id === 'openrouter/vendor/model')!.available, true);
    const json = JSON.stringify(view);
    assert.doesNotMatch(json, /supersecret|sk-lf-secret|sk-or-v1/);
    assert.ok(!('authModes' in view), 'there is no auth bootstrap to choose');
    // Coverage: three modes, Automatic by default, and no API documentation unless the host configures one.
    assert.deepEqual(view.coverageModes, [{ id: 'AUTOMATIC', default: true }, { id: 'UI_ONLY', default: false }, { id: 'API_ONLY', default: false }]);
    assert.deepEqual(view.apiDocs, { default: null });
  });

  it('takes its coverage defaults from the host: QA_COVERAGE_MODE and QA_API_DOCS_URL', () => {
    const view = readRunConfig({ ...process.env, QA_COVERAGE_MODE: 'api', QA_API_DOCS_URL: 'http://localhost:4444/api/doc' });
    assert.equal(view.coverageModes.find((m) => m.default)!.id, 'API_ONLY');
    assert.equal(view.apiDocs.default, 'http://localhost:4444/api/doc');
    // A value that is not a mode, or not a fetchable URL, is not offered as a default.
    const bad = readRunConfig({ ...process.env, QA_COVERAGE_MODE: 'everything', QA_API_DOCS_URL: 'file:///etc/passwd' });
    assert.equal(bad.coverageModes.find((m) => m.default)!.id, 'AUTOMATIC');
    assert.equal(bad.apiDocs.default, null);
  });

  it('validates the coverage mode and the API documentation URL — the one typed value', () => {
    const config = readRunConfig();
    const ok = { pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/fake-complete', freshBrowser: false } as const;
    // Backward compatible: a request that names no mode is an Automatic run with no API documentation.
    assert.deepEqual(validateStartRequest(ok, config), { ...ok, coverageMode: 'AUTOMATIC' });
    assert.deepEqual(
      validateStartRequest({ ...ok, coverageMode: 'AUTOMATIC', apiDocsUrl: ' http://localhost:4444/api/doc#top ' }, config),
      { ...ok, coverageMode: 'AUTOMATIC', apiDocsUrl: 'http://localhost:4444/api/doc', liveValidation: true, approvedOperations: [] },
    );
    // Automatic with an empty field: no documentation, and that is fine.
    assert.equal(validateStartRequest({ ...ok, coverageMode: 'AUTOMATIC', apiDocsUrl: '' }, config).apiDocsUrl, undefined);
    // UI only reads no API documentation: a URL sent with it is dropped, not used.
    assert.deepEqual(validateStartRequest({ ...ok, coverageMode: 'UI_ONLY', apiDocsUrl: 'http://localhost:4444/api/doc' }, config), { ...ok, coverageMode: 'UI_ONLY' });
    // API only cannot run without it.
    assert.throws(() => validateStartRequest({ ...ok, coverageMode: 'API_ONLY' }, config), /API only needs an API documentation URL/);
    assert.throws(() => validateStartRequest({ ...ok, coverageMode: 'API_ONLY', apiDocsUrl: '  ' }, config), /API only needs/);
    assert.equal(validateStartRequest({ ...ok, coverageMode: 'API_ONLY', apiDocsUrl: 'https://example.test/openapi.yaml' }, config).apiDocsUrl, 'https://example.test/openapi.yaml');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.test/doc', 'localhost:4444/api/doc', 'http://exa mple.test/']) {
      assert.throws(() => validateStartRequest({ ...ok, coverageMode: 'AUTOMATIC', apiDocsUrl: bad }, config), RunConfigError, bad);
    }
    assert.throws(() => validateStartRequest({ ...ok, coverageMode: 'EVERYTHING' } as never, config), /coverage mode/);
    // A host default applies only when the request does not mention the field at all.
    const withDefault = readRunConfig({ ...process.env, QA_API_DOCS_URL: 'http://localhost:4444/api/doc' });
    assert.equal(validateStartRequest({ ...ok, coverageMode: 'API_ONLY' }, withDefault).apiDocsUrl, 'http://localhost:4444/api/doc');
    assert.equal(validateStartRequest({ ...ok, coverageMode: 'AUTOMATIC', apiDocsUrl: '' }, withDefault).apiDocsUrl, undefined, 'cleared in the form means none');
  });

  it('lets a run start without an application URL when it has API documentation — and never a UI-only one', () => {
    const config = readRunConfig();
    const base = { pipeline: 'PHASE1_MANUAL', model: 'ollama/fake-complete', freshBrowser: false } as const;
    const apiOnly = validateStartRequest({ ...base, coverageMode: 'API_ONLY', apiDocsUrl: 'http://127.0.0.1:9/openapi.json' }, config);
    assert.ok(!('target' in apiOnly), 'no target is part of the run');
    assert.equal(apiOnly.coverageMode, 'API_ONLY');
    assert.ok(!('target' in validateStartRequest({ ...base, target: '', coverageMode: 'AUTOMATIC', apiDocsUrl: 'http://127.0.0.1:9/openapi.json' }, config)));
    assert.throws(() => validateStartRequest({ ...base, coverageMode: 'UI_ONLY' }, config), /UI only needs a target/);
    assert.throws(() => validateStartRequest({ ...base, coverageMode: 'AUTOMATIC' }, config), /needs an API documentation URL: there would be nothing to discover/);
    assert.throws(() => validateStartRequest({ ...base, target: 'http://evil.example/', coverageMode: 'API_ONLY', apiDocsUrl: 'http://127.0.0.1:9/openapi.json' }, config), /not configured for this workspace/, 'a target that is given is still checked');
    // A workspace with no application URL configured at all can still offer API runs.
    const { TARGET_URL: _t, ...noTarget } = process.env;
    const extra = process.env.QA_UI_TARGETS;
    delete process.env.QA_UI_TARGETS; // read from the process itself, not the argument
    const bare = readRunConfig(noTarget);
    process.env.QA_UI_TARGETS = extra;
    assert.deepEqual(bare.targets, []);
    assert.equal(validateStartRequest({ ...base, coverageMode: 'API_ONLY', apiDocsUrl: 'http://127.0.0.1:9/openapi.json' }, bare).coverageMode, 'API_ONLY');
    // The runner is told there is no interface — the server's own TARGET_URL does not put a browser back.
    assert.equal(runnerEnv({ ...apiOnly } as never, { TARGET_URL: 'http://localhost:4444/' }).TARGET_URL, '');
  });

  it('validates live API validation: the switch, the base URL, and each approved operation', () => {
    const config = readRunConfig();
    const ok = { pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/fake-complete', freshBrowser: false, coverageMode: 'AUTOMATIC', apiDocsUrl: 'http://localhost:4444/api/doc' } as const;
    assert.deepEqual(config.apiValidation, { default: true, baseUrl: null, environment: 'test', protectedEnvironment: false, credentialsConfigured: false, extraAllowedHosts: [] });
    // On by default beside documentation; nothing state-changing approved unless a person names it.
    assert.equal(validateStartRequest(ok, config).liveValidation, true);
    assert.deepEqual(validateStartRequest(ok, config).approvedOperations, []);
    assert.equal(validateStartRequest({ ...ok, liveValidation: false }, config).liveValidation, false);
    const approved = validateStartRequest({ ...ok, apiBaseUrl: ' http://localhost:4444/base/?x=1 ', approvedOperations: ['POST /api/notes', 'POST /api/notes', 'DELETE /api/notes/{id}'] }, config);
    assert.equal(approved.apiBaseUrl, 'http://localhost:4444/base');
    assert.deepEqual(approved.approvedOperations, ['POST /api/notes', 'DELETE /api/notes/{id}']);
    for (const bad of [
      { ...ok, apiBaseUrl: 'file:///etc/passwd' },
      { ...ok, apiBaseUrl: 'http://user:pw@localhost:4444' },
      { ...ok, approvedOperations: ['*'] },
      { ...ok, approvedOperations: ['POST'] },
      { ...ok, approvedOperations: ['post /api/notes'] },
      { ...ok, approvedOperations: ['POST /api/notes; rm -rf /'] },
      { ...ok, approvedOperations: ['DELETE http://evil.example/x'] },
      { ...ok, liveValidation: false, approvedOperations: ['POST /api/notes'] },
      { ...ok, liveValidation: 'yes' },
    ]) assert.throws(() => validateStartRequest(bad as never, config), RunConfigError, JSON.stringify(bad));
    // Without documentation there is nothing to validate: the live options are simply not part of the run.
    const none = validateStartRequest({ ...ok, apiDocsUrl: '', liveValidation: true, approvedOperations: ['POST /api/notes'] }, config);
    assert.ok(!('liveValidation' in none) && !('approvedOperations' in none));
    // Production: nothing state-changing can be approved, whoever asks.
    const prod = readRunConfig({ ...process.env, QA_API_ENVIRONMENT: 'production', QA_API_AUTH_TOKEN: 'secret-token-value', QA_API_ALLOWED_HOSTS: 'api.example.test, 10.0.0.5:8080' });
    assert.equal(prod.apiValidation.protectedEnvironment, true);
    assert.equal(prod.apiValidation.credentialsConfigured, true);
    assert.deepEqual(prod.apiValidation.extraAllowedHosts, ['api.example.test', '10.0.0.5:8080']);
    assert.doesNotMatch(JSON.stringify(prod), /secret-token-value/, 'whether credentials exist, never what they are');
    assert.throws(() => validateStartRequest({ ...ok, approvedOperations: ['POST /api/notes'] }, prod), /Nothing state-changing is sent in the "production" environment/);
    assert.equal(validateStartRequest(ok, prod).liveValidation, true, 'read-only validation is still allowed there');
  });

  it('refuses a target, model or pipeline the host did not configure', () => {
    const config = readRunConfig();
    const ok = { pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444', model: 'ollama/fake-complete', freshBrowser: true } as const;
    assert.equal(validateStartRequest(ok, config).target, 'http://localhost:4444/', 'the host value, not the browser string');
    for (const bad of [
      { ...ok, target: 'http://evil.example/' },
      { ...ok, target: 'file:///etc/passwd' },
      { ...ok, model: 'ollama/not-configured' },
      { ...ok, model: 'openrouter/vendor/model' }, // configured, but no key
      { ...ok, pipeline: 'PHASE2_AUTOMATION' },
    ]) assert.throws(() => validateStartRequest(bad as never, config), RunConfigError, JSON.stringify(bad));
  });

  it('builds the runner command from fixed flags and fixed environment keys — the same runner as the CLI', () => {
    assert.equal(PHASE1_RUNNER, 'scripts/qa-manual.mjs');
    const run = { pipeline: 'PHASE1_MANUAL' as const, target: 'http://localhost:4444/', model: 'ollama/x' as const, freshBrowser: true, coverageMode: 'AUTOMATIC' as const };
    assert.deepEqual(runnerArgs('2026-09-27T18-07-17-457Z', run), ['--run-id', '2026-09-27T18-07-17-457Z', '--fresh-browser']);
    assert.throws(() => runnerArgs('--help; rm -rf /', run));
    const env = runnerEnv(run, { PATH: '/bin', QA_MODEL: 'other', QA_API_DOCS_URL: 'http://leftover.example/doc' });
    // No API documentation chosen: the key is set empty, so the server's own environment cannot supply one.
    const noApi = { QA_API_LIVE_VALIDATION: 'false', QA_API_BASE_URL: '', QA_API_APPROVED_OPERATIONS: '' };
    assert.deepEqual(env, { PATH: '/bin', QA_MODEL: 'ollama/x', TARGET_URL: 'http://localhost:4444/', QA_FRESH_BROWSER: 'true', QA_COVERAGE_MODE: 'AUTOMATIC', QA_API_DOCS_URL: '', ...noApi });
    assert.deepEqual(
      runnerEnv({ ...run, coverageMode: 'API_ONLY', apiDocsUrl: 'http://localhost:4444/api/doc' }, {}),
      { QA_MODEL: 'ollama/x', TARGET_URL: 'http://localhost:4444/', QA_FRESH_BROWSER: 'true', QA_COVERAGE_MODE: 'API_ONLY', QA_API_DOCS_URL: 'http://localhost:4444/api/doc', ...noApi },
    );
    // Live validation and approvals reach the runner only as this run's own choices — an approval
    // left in the server's environment is overwritten, never inherited.
    assert.deepEqual(
      runnerEnv({ ...run, apiDocsUrl: 'http://localhost:4444/api/doc', liveValidation: true, apiBaseUrl: 'http://localhost:4444', approvedOperations: ['POST /api/notes', 'DELETE /api/notes/{id}'] },
        { QA_API_APPROVED_OPERATIONS: 'DELETE /everything', QA_API_AUTH_TOKEN: 'host-secret' }),
      { QA_MODEL: 'ollama/x', TARGET_URL: 'http://localhost:4444/', QA_FRESH_BROWSER: 'true', QA_COVERAGE_MODE: 'AUTOMATIC', QA_API_DOCS_URL: 'http://localhost:4444/api/doc',
        QA_API_LIVE_VALIDATION: 'true', QA_API_BASE_URL: 'http://localhost:4444', QA_API_APPROVED_OPERATIONS: 'POST /api/notes,DELETE /api/notes/{id}', QA_API_AUTH_TOKEN: 'host-secret' },
    );
    // The real runner implements the same contract: it validates --run-id before doing anything else.
    const r = spawnSync(process.execPath, [join(PROJECT, 'scripts', 'qa-manual.mjs'), '--run-id', 'not-an-id', '--from', 'defects'], { cwd: PROJECT, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--run-id must look like/);
  });
});

describe('the event log', () => {
  it('normalises, orders and redacts; refuses unknown types', () => {
    const path = join(ROOT, 'unit-events', 'events.jsonl');
    const w = new EventLogWriter(path, '2026-01-01T00-00-00-000Z');
    w.emit({ type: 'STAGE_STARTED', stage: 'design', stageLabel: 'Test Designer', message: 'Test Designer started' });
    w.emit({ type: 'TOOL_STARTED', tool: 'mcp__playwright__browser_click', message: 'browser_click started' });
    w.emit({ type: 'LOG', message: 'typed password: hunter2 at http://x/confirm?code=123456\n    at stack (/secret.js:1)', ...({ raw: { cookie: 'a=b' } } as object) } as never);
    const [a, b, c] = readEventLog(path);
    assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
    assert.equal(a.category, 'STAGE');
    assert.equal(b.tool, 'browser_click');
    assert.equal(b.category, 'BROWSER');
    assert.doesNotMatch(c.message, /hunter2|123456|secret\.js/);
    assert.ok(!('raw' in c), 'unknown fields never pass through');
    assert.throws(() => normalizeEvent('x', 1, { type: 'SHELL_EXEC' as never, message: 'x' }));
    // A second writer continues the numbering.
    new EventLogWriter(path, '2026-01-01T00-00-00-000Z').emit({ type: 'LOG', message: 'again' });
    assert.equal(readEventLog(path).at(-1)!.id, 4);
  });

  it('is bounded: past the ceiling, only the run outline is kept', () => {
    const path = join(ROOT, 'big-events', 'events.jsonl');
    const w = new EventLogWriter(path, '2026-01-01T00-00-01-000Z');
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 50; i += 1) w.emit({ type: 'TOOL_STARTED', tool: 'browser_snapshot', message: 'x' });
    w.emit({ type: 'RUN_COMPLETED', message: 'done' });
    const all = readEventLog(path);
    assert.equal(all.length, MAX_EVENTS_PER_RUN + 2);
    assert.equal(all.at(-2)!.type, 'LOG');
    assert.equal(all.at(-1)!.type, 'RUN_COMPLETED');
  });
});

describe('RunController', () => {
  it('runs to COMPLETED: history, stages, metrics, archive, ordered redacted events, lock released', async () => {
    const run = start();
    assert.equal(run.status, 'STARTING');
    await controller.waitForExit(run.runId);
    const row = history().getRun(run.runId)!;
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.model, 'ollama/fake-complete');
    assert.deepEqual(history().getStages(run.runId).map((s) => s.status), Array(5).fill('COMPLETED'));
    assert.ok(history().getMetrics(run.runId).test_cases_total > 0);
    assert.ok(history().getArtifacts(run.runId).some((a) => a.artifactType === 'EVENT_LOG'));
    const e = events(run.runId);
    assert.deepEqual(e.map((x) => x.id), e.map((_, i) => i + 1));
    assert.equal(e[0].type, 'RUN_STARTED');
    assert.equal(e.at(-1)!.type, 'RUN_COMPLETED');
    assert.ok(e.some((x) => x.type === 'ARTIFACT_CREATED' && x.artifactType === 'TEST_CASES'));
    assert.ok(e.some((x) => x.type === 'METRIC_UPDATED' && x.metrics?.test_cases_total));
    const text = readFileSync(join(ROOT, 'runs', run.runId, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(text, /987654|sk-or-v1-0123/);
    assert.equal(existsSync(join(ROOT, 'run.lock')), false);
    assert.equal(controller.activeRun(), undefined);
    // A request that names no coverage mode is recorded as what it was: Automatic.
    assert.equal(row.coverageMode, 'AUTOMATIC');
    assert.equal(row.apiDocsUrl, null);
  });

  it('carries the chosen coverage mode and API documentation URL to the runner, the history and the archive', async () => {
    const run = start('ollama/fake-complete', { coverageMode: 'API_ONLY', apiDocsUrl: 'http://127.0.0.1:9/api/doc?api_key=s3cr3t' });
    assert.equal(run.coverageMode, 'API_ONLY');
    assert.equal(run.apiDocsUrl, 'http://127.0.0.1:9/api/doc', 'shown without its query');
    await controller.waitForExit(run.runId);
    const row = history().getRun(run.runId)!;
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.coverageMode, 'API_ONLY');
    assert.equal(row.apiDocsUrl, 'http://127.0.0.1:9/api/doc');
    // The configuration is written beside the artifacts — what every later validation reads — and archived with the run.
    const live = JSON.parse(readFileSync(join(ROOT, 'run-config.json'), 'utf8'));
    assert.equal(live.coverageMode, 'API_ONLY');
    assert.equal(live.runId, run.runId);
    const meta = JSON.parse(readFileSync(join(ROOT, 'runs', run.runId, 'run-metadata.json'), 'utf8'));
    assert.equal(meta.coverageMode, 'API_ONLY');
    assert.ok(history().getArtifacts(run.runId).some((a) => a.artifactType === 'RUN_CONFIG'));
    assert.doesNotMatch(JSON.stringify([row, live, meta]), /s3cr3t/);
    // And the workspace API reports it on the run.
    const view = (await (await fetch(`${base}/api/runs/${run.runId}`)).json()) as any;
    assert.equal(view.run.coverageMode, 'API_ONLY');
    assert.equal(view.run.apiDocsUrl, 'http://127.0.0.1:9/api/doc');

    // UI only: no API documentation reaches the runner, whatever the form held.
    const ui = start('ollama/fake-complete', { coverageMode: 'UI_ONLY', apiDocsUrl: 'http://127.0.0.1:9/api/doc' });
    await controller.waitForExit(ui.runId);
    assert.equal(history().getRun(ui.runId)!.coverageMode, 'UI_ONLY');
    assert.equal(history().getRun(ui.runId)!.apiDocsUrl, null);
  });

  it('runs API only with no application URL: API Discovery is its own stage, no browser stage or event, and it completes', async () => {
    const { startFakeApi } = await import('./fixtures/fake-api-server.mjs');
    const fake = await startFakeApi();
    try {
      const run = controller.start({ pipeline: 'PHASE1_MANUAL', model: 'ollama/fake-complete', freshBrowser: false, coverageMode: 'API_ONLY', apiDocsUrl: fake.docsUrl } as never);
      assert.equal(run.target, undefined);
      await controller.waitForExit(run.runId);
      const row = history().getRun(run.runId)!;
      assert.equal(row.status, 'COMPLETED');
      assert.equal(row.target, null, 'no application URL is recorded, because there was none');
      assert.equal(row.coverageMode, 'API_ONLY');
      assert.deepEqual(history().getStages(run.runId).map((s) => `${s.stageName}:${s.status}`), ['api-discovery:COMPLETED', 'analysis:COMPLETED', 'design:COMPLETED', 'prioritization:COMPLETED', 'defects:COMPLETED']);
      const e = events(run.runId);
      assert.deepEqual(e[0].plan!.map((s) => s.key), ['api-discovery', 'analysis', 'design', 'prioritization', 'defects']);
      assert.ok(!e.some((x) => x.category === 'BROWSER' || x.stage === 'discovery'), 'nothing browser-related happened');
      assert.equal(e.at(-1)!.type, 'RUN_COMPLETED');
      // What the workspace shows for it: the plan it really had, and how it discovered the product.
      const view = (await (await fetch(`${base}/api/runs/${run.runId}`)).json()) as any;
      assert.deepEqual(view.plannedStages.map((s: any) => s.key), ['api-discovery', 'analysis', 'design', 'prioritization', 'defects']);
      assert.deepEqual(view.discovery.methods, ['API']);
      assert.equal(view.discovery.ui.status, 'SKIPPED');
      assert.deepEqual([view.discovery.api.status, view.discovery.api.evidence], ['COMPLETE', 'LIVE']);
      const config = JSON.parse(readFileSync(join(ROOT, 'run-config.json'), 'utf8'));
      assert.deepEqual(config.discovery.methods, ['API']);
      assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'discovered-behavior.json'), 'utf8')).behaviors, []);
      assert.ok(fake.apiRequests().every((r: { method: string }) => r.method === 'GET'), 'read-only requests only');
      // The API page and the overview say how the product was discovered.
      const apiPage = (await (await fetch(`${base}/api/api-validation`)).json()) as any;
      assert.deepEqual(apiPage.discovery.methods, ['API']);
      assert.equal(apiPage.endpoints.length, 8);
      const overview = (await (await fetch(`${base}/api/overview`)).json()) as any;
      assert.deepEqual(overview.coverageMode.discovery.methods, ['API']);
    } finally {
      await fake.close();
    }
    // Starting without a target is refused over the API when the run would have nothing to discover.
    const refused = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pipeline: 'PHASE1_MANUAL', model: 'ollama/fake-complete', freshBrowser: false, coverageMode: 'UI_ONLY' }) });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as any).error, /UI only needs a target/);
  });

  it('refuses a second run while one is active, and a run while another process holds the lock', async () => {
    const run = start('ollama/fake-slow');
    await until(() => history().getStages(run.runId).find((s) => s.stageName === 'design' && s.status === 'RUNNING'));
    assert.throws(() => start(), RunConflictError);
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/fake-complete', freshBrowser: false }) });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as any).error, new RegExp(run.runId));
    // Changing the workspace's artifacts is refused while a run regenerates them.
    const approve = await fetch(`${base}/api/phase1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(approve.status, 409);
    controller.cancel(run.runId);
    await controller.waitForExit(run.runId);

    writeFileSync(join(ROOT, 'run.lock'), JSON.stringify({ pid: process.ppid, runId: '2026-01-01T00-00-00-000Z', command: 'qa:manual', model: 'ollama/other' }));
    assert.throws(() => start(), (e: InstanceType<typeof RunConflictError>) => e instanceof RunConflictError && e.holder?.model === 'ollama/other');
    rmSync(join(ROOT, 'run.lock'));
  });

  it('records a failed stage as FAILED, with a sanitised reason', async () => {
    const run = start('ollama/fake-fail');
    await controller.waitForExit(run.runId);
    assert.equal(history().getRun(run.runId)!.status, 'FAILED');
    const design = history().getStages(run.runId).find((s) => s.stageName === 'design')!;
    assert.deepEqual([design.status, design.attemptCount], ['FAILED', 4]);
    const failed = events(run.runId).find((e) => e.type === 'STAGE_FAILED')!;
    assert.match(failed.message, /Model response could not be parsed/);
    assert.doesNotMatch(failed.message, /abc123secret/);
    assert.equal(events(run.runId).at(-1)!.type, 'RUN_FAILED');
  });

  it('cancels gracefully: CANCELLED (not FAILED), stage CANCELLED, archive kept, lock released, next run starts', async () => {
    const run = start('ollama/fake-slow');
    await until(() => history().getStages(run.runId).find((s) => s.stageName === 'design' && s.status === 'RUNNING'));
    assert.equal(controller.cancel(run.runId), true);
    await controller.waitForExit(run.runId);
    const row = history().getRun(run.runId)!;
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.errorCode, 'CANCELLED');
    assert.equal(history().getStages(run.runId).find((s) => s.stageName === 'design')!.status, 'CANCELLED');
    assert.ok(history().getArtifacts(run.runId).some((a) => a.artifactType === 'DISCOVERED_BEHAVIOR'), 'completed artifacts are kept');
    assert.equal(events(run.runId).at(-1)!.type, 'RUN_CANCELLED');
    assert.equal(existsSync(join(ROOT, 'run.lock')), false);
    const next = start();
    await controller.waitForExit(next.runId);
    assert.equal(history().getRun(next.runId)!.status, 'COMPLETED');
  });

  it('escalates when the runner ignores the cancel: TERM, and the run is still CANCELLED with its lock gone', async () => {
    const run = start('ollama/fake-ignore-cancel');
    await until(() => history().getStages(run.runId).find((s) => s.stageName === 'design' && s.status === 'RUNNING'));
    controller.cancel(run.runId);
    await controller.waitForExit(run.runId);
    assert.equal(history().getRun(run.runId)!.status, 'CANCELLED');
    assert.equal(existsSync(join(ROOT, 'run.lock')), false);
    assert.equal(events(run.runId).at(-1)!.type, 'RUN_CANCELLED');
  });

  it('cleans up after a runner that died outright: history FAILED, final event, owned browser stopped, lock removed', async () => {
    const run = start('ollama/fake-crash');
    await controller.waitForExit(run.runId);
    const row = history().getRun(run.runId)!;
    assert.equal(row.status, 'FAILED');
    assert.equal(row.errorCode, 'PROCESS_EXIT');
    assert.equal(events(run.runId).at(-1)!.type, 'RUN_FAILED');
    assert.equal(existsSync(join(ROOT, 'run.lock')), false);
    const browserPid = Number(readFileSync(join(ROOT, 'fake-browser.pid'), 'utf8'));
    await until(() => !alive(browserPid) || undefined, 8000);
  });
});

// ---------------------------------------------------------------------------

/** Read an SSE stream until it ends (or `stopAfter` events), returning the events and the raw text. */
async function readSse(path: string, headers: Record<string, string> = {}, stopAfter?: number) {
  const controllerAbort = new AbortController();
  const res = await fetch(base + path, { headers, signal: controllerAbort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const decoder = new TextDecoder();
  let buffer = '';
  const out: any[] = [];
  let ended = false;
  const reader = res.body!.getReader();
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (/^event: end/m.test(block)) ended = true;
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data && !/^event:/m.test(block)) out.push(JSON.parse(data));
      if (stopAfter && out.length >= stopAfter) {
        controllerAbort.abort();
        return out;
      }
    }
  }
  return out;
}

describe('Server-Sent Events', () => {
  it('streams a run in order — stages, artifacts, metrics — and ends after the final event', async () => {
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/fake-complete', freshBrowser: true }) });
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    await until(() => existsSync(join(ROOT, 'runs', runId, 'events.jsonl')) || undefined);
    const streamed = await readSse(`/api/runs/${runId}/events`);
    assert.deepEqual(streamed.map((e) => e.id), streamed.map((_, i) => i + 1));
    const types = streamed.map((e) => e.type);
    assert.equal(types[0], 'RUN_STARTED');
    assert.equal(types.at(-1), 'RUN_COMPLETED');
    assert.ok(types.indexOf('STAGE_STARTED') < types.indexOf('STAGE_COMPLETED'));
    assert.ok(types.includes('ARTIFACT_CREATED') && types.includes('METRIC_UPDATED') && types.includes('TOOL_STARTED'));
    assert.ok(streamed.some((e) => e.message.includes('fresh browser')));
    assert.doesNotMatch(JSON.stringify(streamed), /987654|sk-or-v1-0123/);
    await controller.waitForExit(runId);
  });

  it('resumes after Last-Event-ID, replaying only what came later', async () => {
    const runId = history().listRuns({ status: 'COMPLETED', limit: 1 }).runs[0].id;
    const all = events(runId);
    const later = await readSse(`/api/runs/${runId}/events`, { 'last-event-id': String(all.length - 3) });
    assert.deepEqual(later.map((e) => e.id), [all.length - 2, all.length - 1, all.length]);
  });

  it('replays a bounded window to a fresh client', async () => {
    const id = '2026-01-02T00-00-00-000Z';
    history().startRun({ id, kind: 'PHASE1_MANUAL', startedAt: '2026-01-02T00:00:00.000Z' });
    history().finishRun(id, { status: 'COMPLETED', finishedAt: '2026-01-02T00:01:00.000Z' });
    const w = new EventLogWriter(join(ROOT, 'runs', id, 'events.jsonl'), id);
    for (let i = 0; i < REPLAY_LIMIT + 200; i += 1) w.emit({ type: 'TOOL_STARTED', tool: 'browser_snapshot', message: 'x' });
    w.emit({ type: 'RUN_COMPLETED', message: 'done' });
    const got = await readSse(`/api/runs/${id}/events`);
    assert.equal(got.length, REPLAY_LIMIT);
    assert.equal(got.at(-1).type, 'RUN_COMPLETED');
  });

  it('a client leaving does not stop the run', async () => {
    const run = start('ollama/fake-slow');
    await until(() => existsSync(join(ROOT, 'runs', run.runId, 'events.jsonl')) || undefined);
    await readSse(`/api/runs/${run.runId}/events`, {}, 2); // read two events, then disconnect
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(['STARTING', 'RUNNING'].includes(history().getRun(run.runId)!.status));
    assert.equal(controller.activeRun()?.runId, run.runId);
    controller.cancel(run.runId);
    await controller.waitForExit(run.runId);
  });

  it('validates what it is asked for', async () => {
    assert.equal((await fetch(`${base}/api/runs/${encodeURIComponent('../../etc')}/events`)).status, 400);
    assert.equal((await fetch(`${base}/api/runs/2030-01-01T00-00-00-000Z/events`)).status, 404);
    const known = history().listRuns({ limit: 1 }).runs[0].id;
    assert.equal((await fetch(`${base}/api/runs/${known}/events`, { headers: { 'last-event-id': '1; DROP' } })).status, 400);
  });
});

describe('the run-control API is privileged and narrow', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const good = { pipeline: 'PHASE1_MANUAL', target: 'http://localhost:4444/', model: 'ollama/fake-complete', freshBrowser: false };

  it('refuses extra fields, commands, env and cross-origin requests', async () => {
    for (const body of [
      { ...good, env: { QA_MODEL: 'x' } },
      { ...good, command: 'npm run qa:manual -- --from defects' },
      { ...good, path: '/etc/passwd' },
      { ...good, freshBrowser: 'yes' },
      { ...good, pipeline: 'PHASE2_AUTOMATION' },
      { ...good, authMode: 'storage_state' },
      { ...good, coverageMode: 'EVERYTHING' },
      { ...good, coverageMode: 'automatic' },
      { ...good, coverageMode: 'AUTOMATIC', apiDocsUrl: 'file:///etc/passwd' },
      { ...good, coverageMode: 'AUTOMATIC', apiDocsUrl: `http://localhost/${'a'.repeat(600)}` },
      { ...good, coverageMode: 'AUTOMATIC', apiDocsUrl: ['http://localhost:4444/api/doc'] },
      { ...good, coverageMode: 'API_ONLY' },
    ]) assert.equal((await post('/api/runs', body)).status, 400, JSON.stringify(body));
    const refused = (await (await post('/api/runs', { ...good, coverageMode: 'API_ONLY' })).json()) as any;
    assert.match(refused.error, /API only needs an API documentation URL/);
    assert.equal((await post('/api/runs', good, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/runs/2030-01-01T00-00-00-000Z/cancel', {})).status, 404);
    assert.equal((await post(`/api/runs/${encodeURIComponent('1; kill -9 1')}/cancel`, {})).status, 400);
    assert.equal((await post('/api/runs/2030-01-01T00-00-00-000Z/cancel', { pid: 1 })).status, 400);
  });

  it('GET /api/run-config exposes choices and the lock holder — no pid, no secret', async () => {
    const body = (await (await fetch(`${base}/api/run-config`)).json()) as any;
    assert.ok(body.config.models.length > 0);
    assert.doesNotMatch(JSON.stringify(body), /"pid"|sk-or|OPENROUTER_API_KEY=/);
    assert.deepEqual(body.config.coverageModes.map((m: any) => m.id), ['AUTOMATIC', 'UI_ONLY', 'API_ONLY']);
    assert.equal(body.config.apiDocs.default, null);
  });

  it('GET /api/runs/:id tells the page the plan, whether it is live, and whether it can cancel', async () => {
    // A file left by an earlier run is not this run's artifact, however it is named.
    writeFileSync(join(ROOT, 'discovery-evidence.json'), JSON.stringify({ stale: true }));
    await new Promise((r) => setTimeout(r, 20));
    const run = start('ollama/fake-slow');
    await until(() => history().getStages(run.runId).length > 0 || undefined);
    const view = (await (await fetch(`${base}/api/runs/${run.runId}`)).json()) as any;
    assert.equal(view.live, true);
    assert.equal(view.cancellable, true);
    assert.deepEqual(view.plannedStages.map((s: any) => s.key), ['discovery', 'analysis', 'design', 'prioritization', 'defects']);
    // Artifacts already written can be read while the run goes on — read-only.
    await until(() => history().getStages(run.runId).find((s) => s.stageName === 'design' && s.status === 'RUNNING'));
    const live = await fetch(`${base}/api/runs/${run.runId}/artifacts/DISCOVERED_BEHAVIOR`);
    assert.equal(live.status, 200);
    assert.equal((await fetch(`${base}/api/runs/${run.runId}/artifacts/TEST_CASES`)).status, 404, 'not written yet');
    assert.equal((await fetch(`${base}/api/runs/${run.runId}/artifacts/DISCOVERY_EVIDENCE`)).status, 404, 'left over from before this run');
    const during = (await (await fetch(`${base}/api/runs/${run.runId}`)).json()) as any;
    assert.ok(during.artifacts.includes('DISCOVERED_BEHAVIOR') && !during.artifacts.includes('DISCOVERY_EVIDENCE'));
    assert.equal((await post(`/api/runs/${run.runId}/cancel`, {})).status, 202);
    await controller.waitForExit(run.runId);
    const done = (await (await fetch(`${base}/api/runs/${run.runId}`)).json()) as any;
    assert.deepEqual([done.run.status, done.live, done.cancellable], ['CANCELLED', false, false]);
  });
});
