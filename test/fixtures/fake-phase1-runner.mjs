#!/usr/bin/env node
// A deterministic stand-in for scripts/qa-manual.mjs, for the RunController
// tests and the browser tests. Same contract — `--run-id`, `--fresh-browser`,
// TARGET_URL / QA_MODEL / QA_COVERAGE_MODE / QA_API_DOCS_URL from the environment,
// cancel over IPC — and the same
// shared host modules: the run lock, the run history recorder, the event log,
// cancellation and the run archive. Only the model and the browser are
// replaced: each stage copies a fixture artifact after a short delay.
//
//   FAKE_RUN_SCENARIO = complete | fail | slow | ignore-cancel | crash
//   FAKE_STAGE_MS     = delay per stage (default 400)

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT } from '../../scripts/lib/runtime.mjs';
import { acquireRunLock } from '../../scripts/lib/run-lock.mjs';
import { startRunHistory } from '../../scripts/lib/history.mjs';
import { cancellation, reportOwned } from '../../scripts/lib/cancellation.mjs';
import { spawn } from 'node:child_process';
import { preserveRun } from '../../scripts/lib/run-record.mjs';
import { STAGES } from '../../scripts/lib/phase1-stages.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { EventLogWriter } = await import(resolve(ROOT, 'src/run-control/events.ts'));
const { metricsFromArchive } = await import(resolve(ROOT, 'src/history/archive.ts'));
const coverageLib = await import(resolve(ROOT, 'src/lib/coverage-mode.ts'));
const apiLib = await import(resolve(ROOT, 'src/lib/api-discovery.ts'));
const liveLib = await import(resolve(ROOT, 'src/lib/api-validation.ts'));

// The scenario comes from the model name — `ollama/fake-slow` — so tests drive it through the real config validation.
const scenario = process.env.FAKE_RUN_SCENARIO ?? /fake-([a-z-]+)$/.exec(process.env.QA_MODEL ?? '')?.[1] ?? 'complete';
const stageMs = Number(process.env.FAKE_STAGE_MS ?? 400);
const i = process.argv.indexOf('--run-id');
const runId = i > 0 ? process.argv[i + 1] : new Date().toISOString().replace(/[:.]/g, '-');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'phase1-approved');
// A runner that does not honour the cancel message — the controller must escalate.
if (scenario === 'ignore-cancel') process.removeAllListeners('message');

const lock = acquireRunLock(qa.QA_ARTIFACT_ROOT, { runId, model: process.env.QA_MODEL, command: 'qa:manual' });
if (!lock.ok) {
  console.error(lock.message);
  process.exit(EXIT.BAD_CONFIG);
}
const startedAt = new Date();
// The run's configuration, as the real runner takes it: fixed environment keys set by the controller.
const coverageMode = coverageLib.parseCoverageMode(process.env.QA_COVERAGE_MODE) ?? coverageLib.DEFAULT_COVERAGE_MODE;
const apiDocsUrl = coverageLib.usesApiDocs(coverageMode) ? coverageLib.displayApiDocsUrl(process.env.QA_API_DOCS_URL) : undefined;
const history = await startRunHistory({ kind: 'PHASE1_MANUAL', runId, model: process.env.QA_MODEL, target: process.env.TARGET_URL, startedAt, holdsRunLock: true, status: 'STARTING', coverageMode, apiDocsUrl: apiDocsUrl ?? null, log: () => {} });
const events = new EventLogWriter(join(qa.QA_ARTIFACT_ROOT, 'runs', runId, 'events.jsonl'), runId);
const emit = (e) => events.emit(e);
const browserless = /^API_ONLY$/.test(process.env.QA_COVERAGE_MODE ?? '') || !process.env.TARGET_URL?.trim();
emit({ type: 'RUN_STARTED', status: 'STARTING', plan: [...(process.env.QA_API_DOCS_URL?.trim() ? [{ key: 'api-discovery', label: 'API Discovery' }] : []), ...STAGES.filter((s) => !(browserless && s.browser))].map((s) => ({ key: s.key, label: s.label })), message: 'Phase 1 started (fake runner)' });
if (!browserless) emit({ type: 'LOG', category: 'BROWSER', message: `Playwright MCP ready${process.argv.includes('--fresh-browser') ? ' (fresh browser)' : ''}` });
// A secret that must never reach the log: the event layer redacts it.
emit({ type: 'LOG', message: `Visited http://localhost:4444/confirm?confirm_code=987654 with key sk-or-v1-0123456789abcdef0123456789abcdef` });
history.markRunning();
emit({ type: 'RUN_RUNNING', status: 'RUNNING', message: 'Preflight done; stages starting' });

const wait = (ms) => new Promise((done) => {
  const t = setTimeout(done, ms);
  cancellation.onRequest(() => { clearTimeout(t); done(); });
});
const files = () => ['discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json', 'automation-prioritization.json', 'defect-analysis.json', 'run-config.json', 'api-discovery.json', 'api-validation.json', ...qa.listBugReportIds().map((b) => `bugs/${b}.json`)];
const TYPE = { 'discovered-behavior': 'DISCOVERED_BEHAVIOR', 'requirements-analysis': 'REQUIREMENTS_ANALYSIS', 'test-cases': 'TEST_CASES', 'automation-prioritization': 'AUTOMATION_PRIORITIZATION', 'defect-analysis': 'DEFECT_ANALYSIS' };

async function end(status, stage) {
  const archive = preserveRun({ artifactRoot: qa.QA_ARTIFACT_ROOT, projectRoot: ROOT, runId, model: process.env.QA_MODEL, target: process.env.TARGET_URL, startedAt, files: files(), outcome: status.toLowerCase(), extra: { coverageMode, apiDocsUrl: apiDocsUrl ?? null } });
  const summary = status === 'CANCELLED' ? `Stopped by the operator during ${stage.label}.` : status === 'FAILED' ? `${stage.label} did not produce a valid artifact: Model response could not be parsed.` : 'Phase 1 complete';
  emit({ type: `RUN_${status}`, status, stage: stage?.key, stageLabel: stage?.label, level: status === 'COMPLETED' ? 'info' : status === 'CANCELLED' ? 'warn' : 'error', message: summary });
  history.finish({ status, errorCode: status === 'COMPLETED' ? null : status === 'CANCELLED' ? 'CANCELLED' : 'STAGE_FAILED', errorSummary: status === 'COMPLETED' ? null : summary, archiveDir: archive.dir });
  process.exit(status === 'COMPLETED' ? EXIT.OK : status === 'CANCELLED' ? EXIT.CANCELLED : EXIT.FAILED);
}

mkdirSync(qa.QA_ARTIFACT_ROOT, { recursive: true });
// Like the real runner, a run starts from its own outputs: the previous ones are moved aside.
for (const stage of STAGES) rmSync(qa.qaArtifactPath(stage.artifact), { force: true });
rmSync(qa.BUGS_DIR, { recursive: true, force: true });
// API discovery and live validation are host code with no model in them, so this stand-in runs the
// real thing — the same modules, the same environment keys — against whatever documentation it was given.
const liveChoice = {
  enabled: liveLib.parseSwitch(process.env.QA_API_LIVE_VALIDATION) ?? true,
  baseUrl: liveLib.normalizeBaseUrl(process.env.QA_API_BASE_URL),
  approvedOperations: liveLib.parseApprovals(process.env.QA_API_APPROVED_OPERATIONS ?? ''),
};
let apiValidationWritten = false;
if (coverageLib.usesApiDocs(coverageMode) && process.env.QA_API_DOCS_URL?.trim()) {
  const docsUrl = coverageLib.normalizeApiDocsUrl(process.env.QA_API_DOCS_URL);
  const { discovery, spec } = await apiLib.discoverApiDocument(docsUrl);
  const validation = apiLib.hasApi(discovery) && liveChoice.enabled
    ? await liveLib.validateApi(spec, discovery, { ...liveLib.liveValidationOptions(liveChoice, { docsUrl, targetUrl: process.env.TARGET_URL }), delayMs: 0 })
    : liveLib.validationNotRequested('live API validation was switched off for this run; the documentation is used alone');
  qa.writeQaArtifact('api-discovery', discovery);
  qa.writeQaArtifact('api-validation', validation);
  apiValidationWritten = true;
  emit({ type: 'ARTIFACT_CREATED', artifactType: 'API_VALIDATION', count: validation.summary.requests, message: 'api-validation.json created' });
} else {
  rmSync(qa.qaArtifactPath('api-discovery'), { force: true });
  rmSync(qa.qaArtifactPath('api-validation'), { force: true });
}
// Like the real runner: no interface to explore means no browser stage, and the host says so.
const uiSkipped = coverageMode === 'API_ONLY' ? 'API only: the interface is not explored' : !process.env.TARGET_URL?.trim() ? 'no application URL (TARGET_URL) was given' : undefined;
const apiContext = qa.readCoverageContext();
const discoveryRecord = {
  methods: [...(uiSkipped ? [] : ['UI']), ...(apiValidationWritten && apiLib.hasApi(apiContext.api) ? ['API'] : [])],
  ui: uiSkipped ? { status: 'SKIPPED', reason: uiSkipped } : { status: 'PLANNED' },
  api: apiValidationWritten ? liveLib.apiDiscoveryCompletion(apiContext.api, qa.readQaArtifact('api-validation')) : { status: 'NOT_REQUESTED', evidence: 'NONE', criteria: [] },
};
if (apiValidationWritten) {
  const h = history.stage({ key: 'api-discovery', label: 'API Discovery' });
  emit({ type: 'STAGE_STARTED', stage: 'api-discovery', stageLabel: 'API Discovery', message: 'API Discovery started' });
  h.complete(1);
  emit({ type: 'STAGE_COMPLETED', stage: 'api-discovery', stageLabel: 'API Discovery', attempt: 1, message: 'API Discovery completed' });
}
const PLAN = STAGES.filter((s) => !(uiSkipped && s.browser));
qa.writeQaArtifact('run-config', {
  coverageMode, ...(apiDocsUrl ? { apiDocsUrl } : {}), runId, writtenAt: startedAt.toISOString(),
  discovery: discoveryRecord,
  ...(apiValidationWritten ? { apiValidation: { enabled: liveChoice.enabled, ...(liveChoice.baseUrl ? { baseUrl: liveChoice.baseUrl } : {}), environment: process.env.QA_API_ENVIRONMENT?.trim() || 'test', approvedOperations: liveChoice.approvedOperations } } : {}),
});
if (uiSkipped) {
  qa.writeQaArtifact('discovered-behavior', { product: 'API (the interface was not explored)', locations: [], areas: [], behaviors: [], openQuestions: [], conflicts: [] });
  emit({ type: 'LOG', message: `Product Discovery skipped — no browser is started: ${uiSkipped}` });
}
for (const stage of PLAN) {
  if (cancellation.requested) await end('CANCELLED', stage);
  const h = history.stage(stage);
  emit({ type: 'STAGE_STARTED', stage: stage.key, stageLabel: stage.label, message: `${stage.label} started` });
  emit({ type: 'ATTEMPT_STARTED', stage: stage.key, stageLabel: stage.label, attempt: 1, message: `${stage.label}: attempt 1 of 4` });
  if (stage.browser) {
    emit({ type: 'TOOL_STARTED', stage: stage.key, tool: 'mcp__playwright__browser_navigate', message: 'browser_navigate started' });
    emit({ type: 'TOOL_COMPLETED', stage: stage.key, tool: 'browser_navigate', message: 'browser_navigate completed' });
  }
  emit({ type: 'TOOL_STARTED', stage: stage.key, tool: 'write_qa_artifact', message: 'write_qa_artifact started' });
  h.attempts(1);
  if (scenario === 'crash' && stage.key === 'analysis') {
    // A stand-in browser server this run "owns", reported the way the real runner reports its MCP server.
    const browser = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    browser.unref();
    reportOwned({ mcpPid: browser.pid });
    writeFileSync(join(qa.QA_ARTIFACT_ROOT, 'fake-browser.pid'), String(browser.pid));
    await new Promise((r) => setTimeout(r, 200));
    process.kill(process.pid, 'SIGKILL');
  }
  await wait(scenario === 'slow' || scenario === 'ignore-cancel' ? (stage.key === 'design' ? 120_000 : stageMs) : stageMs);
  if (cancellation.requested) {
    h.cancel(1);
    emit({ type: 'STAGE_CANCELLED', stage: stage.key, stageLabel: stage.label, message: `${stage.label} stopped by the operator` });
    await end('CANCELLED', stage);
  }
  if (scenario === 'fail' && stage.key === 'design') {
    h.fail(4, 'STAGE_FAILED', 'Model response could not be parsed.');
    emit({ type: 'STAGE_FAILED', stage: stage.key, stageLabel: stage.label, attempt: 4, errorCode: 'STAGE_FAILED', message: `${stage.label} failed after 4 attempt(s): Model response could not be parsed. token=abc123secret` });
    await end('FAILED', stage);
  }
  if (stage.key === 'defects') {
    writeFileSync(qa.qaArtifactPath('defect-analysis'), JSON.stringify({ findings: [{ id: 'DEF-001', classification: 'POTENTIAL_DEFECT' }] }));
  } else {
    copyFileSync(join(FIXTURES, `${stage.artifact}.json`), qa.qaArtifactPath(stage.artifact));
  }
  emit({ type: 'TOOL_COMPLETED', stage: stage.key, tool: 'write_qa_artifact', message: 'write_qa_artifact completed' });
  h.complete(1);
  emit({ type: 'STAGE_COMPLETED', stage: stage.key, stageLabel: stage.label, attempt: 1, message: `${stage.label} completed` });
  emit({ type: 'ARTIFACT_CREATED', stage: stage.key, artifactType: TYPE[stage.artifact], message: `${stage.artifact}.json created` });
  const metrics = metricsFromArchive(qa.QA_ARTIFACT_ROOT);
  history.setMetrics(metrics);
  emit({ type: 'METRIC_UPDATED', metrics, message: 'Metrics updated' });
}
await end('COMPLETED');
