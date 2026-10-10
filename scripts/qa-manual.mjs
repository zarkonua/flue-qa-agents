#!/usr/bin/env node
// PHASE 1 — Manual QA Design. Deterministic host orchestration.
//
//   export TARGET_URL="https://..."
//   npm run qa:manual
//
//   Product Discovery      -> discovered-behavior.json
//   Behavior Analyst       -> requirements-analysis.json
//   Test Designer          -> test-cases.json
//   Automation Prioritizer -> automation-prioritization.json
//   Defect Analyzer        -> defect-analysis.json + bugs/<id>.json
//   STOP  (then: `npm run qa:review`, `npm run qa:defects`, `npm run qa:approve`)
//
// The sequence is fixed here, in trusted code; no model decides whether the
// next stage runs. Each agent runs as its own root process with only its own
// tools, and hands off through `.qa/` exactly as before. A stage passes only if
// its artifact was freshly written during this attempt AND re-validates from
// disk (schema + semantic). A failed stage is retried, then the run stops.
//
// Options:
//   --from <stage>   start at discovery | analysis | design | prioritization | defects
//                    (earlier artifacts are kept — e.g. after hand-editing test
//                    cases, `--from prioritization` re-prioritizes only)
//   --attempts <n>   attempts per stage (default 4, or QA_STAGE_ATTEMPTS)
//   --coverage-mode <automatic|ui|api>
//                    at which level test cases are designed (default automatic, or
//                    QA_COVERAGE_MODE): automatic picks UI or API per scenario
//   --api-docs <url> the product's OpenAPI/Swagger document — JSON, YAML or a Swagger UI
//                    page (or QA_API_DOCS_URL). Read by the host before any agent runs;
//                    ignored in ui mode, required in api mode
//   --api-live <on|off>
//                    call the documented API and compare its real responses with the
//                    documentation (default on, or QA_API_LIVE_VALIDATION). Read-only by default
//   --api-base-url <url>
//                    where the API is, when not where its documentation says (or QA_API_BASE_URL)
//   --api-approve "<METHOD /path>, ..."
//                    state-changing operations a person approves for this run — POST, PUT, PATCH,
//                    DELETE, or a GET named like an action (or QA_API_APPROVED_OPERATIONS).
//                    Nothing state-changing is ever sent without it
//
// In api mode there is no browser stage: discovery is skipped and the host records that
// nothing was observed in the interface.

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT, createObservabilityOrExit, ensureMcp, mcpUrl, preflightTarget, requireTarget, startedMcpPid, stopMcpAndWait } from './lib/runtime.mjs';
import { cancellation, reportOwned } from './lib/cancellation.mjs';
import { makeArtifactProblem, runStage } from './lib/stage.mjs';
import { STAGES } from './lib/phase1-stages.mjs';
import { acquireRunLock } from './lib/run-lock.mjs';
import { gitCommit, preserveRun } from './lib/run-record.mjs';
import { startRunHistory } from './lib/history.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { summarize, coverageSummary, analysisCoverageSummary, strategySummary, scenarioDiversityDiagnostic } = await import(resolve(ROOT, 'src/lib/semantic-validate.ts'));
const { APPROVAL_PATH } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const surfaceLib = await import(resolve(ROOT, 'src/lib/discovery-surface.ts'));
const auxLib = await import(resolve(ROOT, 'src/config/auxiliary-origins.ts'));
const ledgerLib = await import(resolve(ROOT, 'src/lib/observation-ledger.ts'));
const { completionMetrics, runFunnel, stageMetrics } = await import(resolve(ROOT, 'src/observability/qa-metrics.ts'));
const { defectMetrics } = await import(resolve(ROOT, 'src/lib/defects.ts'));
const depLib = await import(resolve(ROOT, 'src/lib/phase1-dependencies.ts'));
const { EventLogWriter } = await import(resolve(ROOT, 'src/run-control/events.ts'));
const { metricsFromArchive } = await import(resolve(ROOT, 'src/history/archive.ts'));
const { RUN_ID } = await import(resolve(ROOT, 'src/history/types.ts'));
const coverageLib = await import(resolve(ROOT, 'src/lib/coverage-mode.ts'));
const apiLib = await import(resolve(ROOT, 'src/lib/api-discovery.ts'));
const liveLib = await import(resolve(ROOT, 'src/lib/api-validation.ts'));

// ---------------------------------------------------------------------------
// The Phase 1 stage list — a closed allowlist
// ---------------------------------------------------------------------------


/**
 * The only agent modules Phase 1 may ever start. Checked at startup, so an
 * edit that slips a Phase 2 agent into STAGES fails loudly instead of running.
 */
const PHASE1_AGENTS = new Set([
  'src/agents/product-discovery.ts',
  'src/agents/behavior-analyst.ts',
  'src/agents/test-designer.ts',
  'src/agents/automation-prioritizer.ts',
  'src/agents/defect-analyzer.ts',
]);
for (const stage of STAGES) {
  if (!PHASE1_AGENTS.has(stage.agent)) {
    console.error(`Refusing to run: ${stage.agent} is not a Phase 1 agent.`);
    process.exit(EXIT.BAD_CONFIG);
  }
}

/** Phase 2 outputs. If any appears during a Phase 1 run, something is badly wrong. */
const PHASE2_ARTIFACTS = ['ui-exploration', 'automation-plan'];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split('=')[1];
}

const from = option('from') ?? 'discovery';
const startIndex = STAGES.findIndex((s) => s.key === from);
if (startIndex < 0) {
  console.error(`Unknown --from stage "${from}". Use one of: ${STAGES.map((s) => s.key).join(', ')}.`);
  process.exit(EXIT.BAD_CONFIG);
}
// Measured across 10 trials (44 attempts): 18% of attempts end with the model
// stopping after its reasoning, without the tool call; a retry recovers ~2/3.
// A failed attempt costs only ~20s, so 4 attempts is cheap — ~98% of runs
// complete under the measured rates, versus ~83% with 2.
const attempts = Math.max(1, Number(option('attempts') ?? process.env.QA_STAGE_ATTEMPTS ?? 4));
let plan = STAGES.slice(startIndex);

// A run started from the workspace is given its id by the RunController, so the
// page can follow it from the first moment. From the terminal the id is the start time.
const requestedRunId = option('run-id');
if (requestedRunId !== undefined && !RUN_ID.test(requestedRunId)) {
  console.error(`--run-id must look like 2026-09-27T18-07-17-457Z; got "${String(requestedRunId).slice(0, 40)}".`);
  process.exit(EXIT.BAD_CONFIG);
}

// ---------------------------------------------------------------------------
// Coverage mode and API documentation
// ---------------------------------------------------------------------------

/** `--name value` or `--name=value`, keeping every `=` after the first — a URL has its own. */
function rawOption(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

// A run that starts at discovery is configured afresh. One that starts later
// continues the suite already on disk, so it keeps that suite's mode and the
// API documentation read for it — unless a flag on this command line says otherwise.
const cliCoverageMode = rawOption('coverage-mode');
const cliApiDocs = rawOption('api-docs');
const cliApiLive = rawOption('api-live');
const cliApiBaseUrl = rawOption('api-base-url');
const cliApiApprove = rawOption('api-approve');
const configuresCoverage = startIndex === 0 || [cliCoverageMode, cliApiDocs, cliApiLive, cliApiBaseUrl, cliApiApprove].some((v) => v !== undefined);
const previousConfig = qa.readRunConfig();
let coverageMode = previousConfig?.coverageMode ?? coverageLib.DEFAULT_COVERAGE_MODE;
let apiDocsUrl;
if (configuresCoverage) {
  const rawMode = cliCoverageMode ?? (startIndex === 0 ? process.env.QA_COVERAGE_MODE?.trim() || undefined : undefined);
  if (rawMode !== undefined) {
    const parsed = coverageLib.parseCoverageMode(rawMode);
    if (!parsed) {
      console.error(`Unknown coverage mode "${String(rawMode).slice(0, 40)}". Use one of: automatic, ui, api.`);
      process.exit(EXIT.BAD_CONFIG);
    }
    coverageMode = parsed;
  } else if (startIndex === 0) {
    coverageMode = coverageLib.DEFAULT_COVERAGE_MODE;
  }
  if (coverageLib.usesApiDocs(coverageMode)) {
    const rawDocs = cliApiDocs ?? (startIndex === 0 ? process.env.QA_API_DOCS_URL?.trim() || undefined : undefined);
    if (rawDocs !== undefined) {
      apiDocsUrl = coverageLib.normalizeApiDocsUrl(rawDocs);
      if (!apiDocsUrl) {
        console.error('The API documentation URL must be an http(s) URL without embedded credentials.');
        process.exit(EXIT.BAD_CONFIG);
      }
    } else if (startIndex !== 0 && previousConfig?.apiDocsUrl) {
      // Changing a live-validation option on a later stage re-reads the documentation the suite already uses.
      apiDocsUrl = coverageLib.normalizeApiDocsUrl(previousConfig.apiDocsUrl);
    }
  }
}

// Live API validation: what a person chose for this run. Everything else about it —
// credentials, extra hosts, the environment, limits — is host configuration (see liveValidationOptions).
const fromEnv = (name) => (startIndex === 0 ? process.env[name]?.trim() || undefined : undefined);
const liveChoice = { enabled: false, approvedOperations: [] };
if (configuresCoverage && coverageLib.usesApiDocs(coverageMode)) {
  const rawLive = cliApiLive ?? fromEnv('QA_API_LIVE_VALIDATION');
  const enabled = rawLive === undefined ? true : liveLib.parseSwitch(rawLive);
  if (enabled === undefined) {
    console.error(`--api-live takes on or off; got "${String(rawLive).slice(0, 20)}".`);
    process.exit(EXIT.BAD_CONFIG);
  }
  liveChoice.enabled = enabled;
  const rawBase = cliApiBaseUrl ?? fromEnv('QA_API_BASE_URL');
  if (rawBase !== undefined) {
    liveChoice.baseUrl = liveLib.normalizeBaseUrl(rawBase);
    if (!liveChoice.baseUrl) {
      console.error('The API base URL must be an http(s) URL without embedded credentials.');
      process.exit(EXIT.BAD_CONFIG);
    }
  }
  const rawApprove = cliApiApprove ?? fromEnv('QA_API_APPROVED_OPERATIONS');
  if (rawApprove !== undefined) {
    liveChoice.approvedOperations = liveLib.parseApprovals(rawApprove);
    const given = rawApprove.split(/[,\n]/).map((a) => a.trim()).filter(Boolean);
    if (liveChoice.approvedOperations.length !== given.length) {
      console.error('Each approved operation must look like "POST /path" — a method, a space, and the documented path.');
      process.exit(EXIT.BAD_CONFIG);
    }
  }
}

// UI discovery and API discovery are separate workflows, each started only when its own
// source exists and judged by its own criteria. Which of them this run has:
//
//   API only    never the interface — no browser, no Playwright MCP, no TARGET_URL needed
//   UI only     never the API
//   Automatic   the interface when there is an application URL that answers, the API when
//               there is documentation; either can be missing, not both
/** Why the interface is not explored in this run, when it is not. */
let uiSkipped;
const applicationUrl = process.env.TARGET_URL?.trim() || undefined;
if (coverageMode === 'API_ONLY') {
  uiSkipped = 'API only: the interface is not explored';
} else if (coverageMode === 'AUTOMATIC' && plan.some((s) => s.browser) && apiDocsUrl) {
  if (!applicationUrl) {
    uiSkipped = 'no application URL (TARGET_URL) was given';
  } else {
    // A frontend that is down must not take API discovery with it. One plain request, by the
    // host, to the configured URL: any answer at all means the interface is there to explore.
    try {
      await fetch(applicationUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch (error) {
      uiSkipped = `the application at ${applicationUrl} did not answer (${error?.cause?.code ?? error?.name ?? 'no response'})`;
    }
  }
}
if (uiSkipped) plan = plan.filter((s) => !s.browser);
/** The host's own discovery step, shown beside the agent stages. Present whenever the API is this run's to discover. */
const API_STAGE = { key: 'api-discovery', label: 'API Discovery' };
const apiDiscoveryPlanned = configuresCoverage && coverageLib.usesApiDocs(coverageMode) && (apiDocsUrl !== undefined || coverageMode === 'API_ONLY');

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

const artifactProblem = makeArtifactProblem(qa);

// Only a run that explores the interface needs an application URL.
const target = plan.some((s) => s.browser) ? requireTarget() : applicationUrl;

// Langfuse tracing, when LANGFUSE_ENABLED=true; a no-op otherwise. Validated
// here, before the lock, the archive or any browser work.
const observability = await createObservabilityOrExit();

// Starting part-way through needs every earlier artifact present and
// schema-valid. Semantic findings there are only warnings: those files may hold
// the operator's own hand edits, and the operator is the authority on facts.
for (const stage of STAGES.slice(0, startIndex)) {
  const problem = artifactProblem(stage.artifact, { semantic: false });
  const warning = problem ? undefined : artifactProblem(stage.artifact);
  if (warning) console.log(`Note: ${warning} (kept as-is; the approval step will list it)`);
  if (problem) {
    console.error(`\nCannot start at "${from}": ${problem}\nRun the earlier stages first, e.g. npm run qa:manual -- --from ${stage.key}\n`);
    process.exit(EXIT.BAD_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Archive what this run will replace — never delete
// ---------------------------------------------------------------------------

const runStarted = new Date();
const stamp = requestedRunId ?? runStarted.toISOString().replace(/[:.]/g, '-');
const archiveDir = join(qa.QA_ARTIFACT_ROOT, 'archive', stamp);

// One run at a time. Two concurrent runs share Flue's conversation store, this
// artifact root and one browser: they corrupt each other instead of queueing,
// and the surviving artifacts belong to neither. Taken before the archive step,
// so a refused run never moves the previous run's output aside.
const envForLock = await import(resolve(ROOT, 'src/config/env.ts'));
const lock = acquireRunLock(qa.QA_ARTIFACT_ROOT, {
  runId: stamp,
  model: envForLock.QA_MODEL,
  command: 'qa:manual',
});
if (!lock.ok) {
  console.error(`\n${lock.message}\n`);
  process.exit(EXIT.BAD_CONFIG);
}

// Registered now, while it is still RUNNING — a run that fails or is stopped
// part-way stays in the history. Never fatal: see scripts/lib/history.mjs.
const history = await startRunHistory({
  kind: 'PHASE1_MANUAL', runId: stamp, model: envForLock.QA_MODEL, target, startedAt: runStarted, holdsRunLock: true, status: 'STARTING',
  coverageMode, apiDocsUrl: apiDocsUrl ?? (configuresCoverage ? null : previousConfig?.apiDocsUrl ?? null),
});

// The run's structured event log — what the workspace's Live Run page shows.
// Written the same way from the terminal and from the workspace; redacted on the way in.
const events = new EventLogWriter(join(qa.QA_ARTIFACT_ROOT, 'runs', stamp, 'events.jsonl'), stamp);
const emit = (event) => events.emit(event);
emit({
  type: 'RUN_STARTED', status: 'STARTING', plan: [...(apiDiscoveryPlanned ? [API_STAGE] : []), ...plan].map((s) => ({ key: s.key, label: s.label })),
  message: `Phase 1 started: ${[...(apiDiscoveryPlanned ? [API_STAGE] : []), ...plan].map((s) => s.label).join(' → ')}`,
});

/** Artifact types, as the history and the workspace name them. */
const ARTIFACT_TYPE = {
  'discovered-behavior': 'DISCOVERED_BEHAVIOR', 'requirements-analysis': 'REQUIREMENTS_ANALYSIS', 'test-cases': 'TEST_CASES',
  'automation-prioritization': 'AUTOMATION_PRIORITIZATION', 'defect-analysis': 'DEFECT_ANALYSIS',
};
let lastMetrics = {};
/** The counts the artifacts written so far support — sent as they change, recorded in the history. */
function publishMetrics() {
  let metrics;
  try {
    metrics = metricsFromArchive(qa.QA_ARTIFACT_ROOT);
  } catch {
    return;
  }
  const changed = Object.fromEntries(Object.entries(metrics).filter(([k, v]) => lastMetrics[k] !== v));
  lastMetrics = metrics;
  if (Object.keys(changed).length === 0) return;
  history.setMetrics(changed);
  emit({ type: 'METRIC_UPDATED', metrics: changed, message: `Metrics: ${Object.entries(changed).slice(0, 6).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}` });
}

/**
 * End the run as CANCELLED — the operator asked, from the workspace. What the
 * run produced so far is archived and kept; the browser it started is stopped;
 * the lock is released on the way out.
 */
async function endCancelled(stage) {
  record.result = 'CANCELLED';
  if (stage) record.cancelledStage = stage.key;
  record.finishedAt = new Date().toISOString();
  saveRecord();
  if (browserStarted) record.mcpStoppedCleanly = await stopMcpAndWait();
  const cancelled = preserveRun({
    artifactRoot: qa.QA_ARTIFACT_ROOT, projectRoot: ROOT, runId: stamp, model: env.QA_MODEL, target, startedAt: runStarted,
    files: runFiles(), outcome: 'cancelled', onlyWrittenSince: runStarted, extra: { cancelledStage: stage?.key ?? null, auxiliaryOrigins: auxLib.auxiliaryOrigins(), coverageMode, apiDocsUrl: coverageRecord.apiDocsUrl },
  });
  const summary = `Stopped by the operator${stage ? ` during ${stage.label}` : ' before the first stage'}.`;
  // The final event is written before the archive is indexed, so the index hashes the complete log.
  emit({ type: 'RUN_CANCELLED', status: 'CANCELLED', stage: stage?.key, stageLabel: stage?.label, level: 'warn', message: `${summary} Completed artifacts are kept.` });
  history.finish({ status: 'CANCELLED', errorCode: 'CANCELLED', errorSummary: summary, archiveDir: cancelled.dir });
  console.error(`\nPhase 1 CANCELLED — ${summary}\nRun preserved   : ${cancelled.dir}\n`);
  await observability.endRun({ outcome: 'CANCELLED', failedStage: stage?.key });
  process.exit(EXIT.CANCELLED);
}

function archive(path) {
  if (!existsSync(path)) return;
  mkdirSync(archiveDir, { recursive: true });
  renameSync(path, join(archiveDir, path.split('/').pop()));
}

// API discovery: host code reads the documentation before anything is archived
// or any agent runs. It is optional and may be unreachable — that is recorded,
// not fatal — except in API-only mode, where without it there is nothing a
// test could rest on and the honest result is to stop here, with the previous
// run's output still in place.
let apiDiscovery = configuresCoverage ? undefined : qa.readCoverageContext().api;
let apiValidation = configuresCoverage ? undefined : qa.readCoverageContext().validation;
// API discovery is a stage of its own in the run's history and live view — the host's, not an agent's.
const apiStageHistory = apiDiscoveryPlanned ? history.stage(API_STAGE) : undefined;
const apiStageStarted = Date.now();
if (apiDiscoveryPlanned) emit({ type: 'STAGE_STARTED', stage: API_STAGE.key, stageLabel: API_STAGE.label, message: 'API Discovery started: reading the documentation' });
if (configuresCoverage) {
  let apiSpec;
  if (!coverageLib.usesApiDocs(coverageMode)) {
    apiDiscovery = apiLib.notRequested('UI only: API documentation is not read in this mode');
  } else {
    if (apiDocsUrl) console.log(`\nAPI documentation: reading ${coverageLib.displayApiDocsUrl(apiDocsUrl)}`);
    ({ discovery: apiDiscovery, spec: apiSpec } = await apiLib.discoverApiDocument(apiDocsUrl));
  }
  const summary = apiLib.apiDiscoverySummary(apiDiscovery);
  if (summary.status === 'AVAILABLE') {
    emit({ type: 'LOG', message: `API documentation read: ${summary.endpoints} operation(s), ${summary.schemas} schema(s), ${summary.authentication} authentication scheme(s)` });
  } else if (summary.status === 'UNAVAILABLE') {
    emit({ type: 'LOG', level: 'warn', message: `API documentation is unavailable: ${summary.reason}` });
  }
  // A run with no interface to explore has only the API. Without its documentation there is no
  // discovery source left — and the answer to that is a clear configuration error, never a
  // quiet fall back to a browser.
  if (uiSkipped && !apiLib.hasApi(apiDiscovery)) {
    const why = apiDocsUrl
      ? `the API documentation is unavailable (${summary.reason ?? 'no operations found'})`
      : 'no API documentation URL was given (--api-docs <url>, or QA_API_DOCS_URL)';
    const message = coverageMode === 'API_ONLY'
      ? `API-only coverage needs API documentation, and ${why}.`
      : `Nothing can be discovered: the interface is not available (${uiSkipped}) and ${why}.`;
    apiStageHistory?.fail(1, 'API_DOCS_UNAVAILABLE', message);
    emit({ type: 'STAGE_FAILED', stage: API_STAGE.key, stageLabel: API_STAGE.label, errorCode: 'API_DOCS_UNAVAILABLE', message });
    emit({ type: 'RUN_FAILED', status: 'FAILED', stage: API_STAGE.key, stageLabel: API_STAGE.label, errorCode: 'API_DOCS_UNAVAILABLE', message });
    history.finish({ status: 'FAILED', errorCode: 'API_DOCS_UNAVAILABLE', errorSummary: message });
    console.error(`\nPhase 1 not started: ${message}\nNothing was archived or changed, and no browser was started. Fix the API documentation URL${coverageMode === 'API_ONLY' ? ', or start the run in automatic or ui mode' : ''}.\n`);
    process.exit(EXIT.FAILED);
  }

  // Live validation: the host calls the documented API and compares what comes back with the
  // documentation. It never stops a run — whatever cannot be called stays documentation-only.
  if (!coverageLib.usesApiDocs(coverageMode)) {
    apiValidation = liveLib.validationNotRequested('UI only: the API is neither read nor called in this mode');
  } else if (!apiLib.hasApi(apiDiscovery)) {
    apiValidation = liveLib.validationNotRequested('there is no API documentation to validate against');
  } else if (!liveChoice.enabled) {
    apiValidation = liveLib.validationNotRequested('live API validation was switched off for this run; the documentation is used alone');
  } else {
    console.log('API validation  : calling the documented API (read-only unless an operation was approved)…');
    try {
      apiValidation = await liveLib.validateApi(apiSpec, apiDiscovery, liveLib.liveValidationOptions(liveChoice, { docsUrl: apiDocsUrl, targetUrl: target }));
    } catch (error) {
      // Defensive: a bug in the prober must not take the run down with it.
      apiValidation = { ...liveLib.validationNotRequested(''), status: 'UNAVAILABLE', reason: `live validation failed unexpectedly (${String(error?.message ?? error).split('\n')[0].slice(0, 160)})` };
    }
    const live = liveLib.apiValidationSummary(apiValidation);
    emit({
      type: 'LOG', level: live.status === 'COMPLETED' ? 'info' : 'warn',
      message: live.status === 'UNAVAILABLE'
        ? `Live API validation unavailable: ${live.reason}. Continuing with the documentation alone.`
        : `Live API validation: ${live.requests} request(s) — ${live.validated} validated, ${live.observed} observed, ${live.documented} documented only; ` +
          `${live.contractViolations} contract violation(s), ${live.potentialIssues} potential issue(s)${live.status === 'PARTIAL' ? ` (partial: ${live.reason})` : ''}`,
    });
  }
}
const apiSummary = apiLib.apiDiscoverySummary(apiDiscovery);
const liveSummary = liveLib.apiValidationSummary(apiValidation);
// API discovery's own completion criteria. None of them is about a browser.
const apiCompletion = liveLib.apiDiscoveryCompletion(apiDiscovery, apiValidation);
if (apiDiscoveryPlanned) {
  const seconds = Math.round((Date.now() - apiStageStarted) / 1000);
  if (apiCompletion.status === 'COMPLETE') {
    apiStageHistory?.complete(1);
    emit({ type: 'STAGE_COMPLETED', stage: API_STAGE.key, stageLabel: API_STAGE.label, attempt: 1, message: `API Discovery completed in ${seconds}s: ${apiSummary.endpoints} operation(s), ${apiCompletion.evidence === 'LIVE' ? 'observed live' : 'documentation only'}` });
  } else {
    // Automatic with an interface to explore: the API part found nothing usable, and the run goes on.
    // The stage ended, so it is recorded as ended — its outcome (BLOCKED) is in run-config.json and here.
    apiStageHistory?.complete(1);
    emit({ type: 'STAGE_COMPLETED', stage: API_STAGE.key, stageLabel: API_STAGE.label, attempt: 1, level: 'warn', message: `API Discovery found nothing usable (${apiCompletion.reason}). The run continues with the interface alone.` });
  }
}
/** How this run discovers the product — what its record, its configuration and the workspace show. */
const discoveryRecord = configuresCoverage || !previousConfig?.discovery
  ? {
    methods: [...(plan.some((s) => s.browser) || (startIndex > 0 && !uiSkipped) ? ['UI'] : []), ...(apiLib.hasApi(apiDiscovery) && coverageLib.usesApiDocs(coverageMode) ? ['API'] : [])],
    ui: uiSkipped ? { status: 'SKIPPED', reason: uiSkipped } : { status: 'PLANNED' },
    api: coverageLib.usesApiDocs(coverageMode) && apiSummary.status !== 'NOT_REQUESTED'
      ? apiCompletion
      : { status: 'NOT_REQUESTED', evidence: 'NONE', criteria: [], reason: coverageMode === 'UI_ONLY' ? 'UI only: the API is not discovered' : 'no API documentation was given' },
  }
  : previousConfig.discovery;

// Regenerating any stage invalidates the review and the approval of the old result.
for (const stage of plan) archive(qa.qaArtifactPath(stage.artifact));
// Bug reports belong to the defect analysis that produced them.
if (plan.some((s) => s.key === 'defects')) archive(qa.BUGS_DIR);
archive(qa.qaArtifactPath('test-cases-review'));
archive(APPROVAL_PATH);
// This run's own configuration, API discovery and live results replace the previous run's.
if (configuresCoverage) {
  archive(qa.qaArtifactPath('api-discovery'));
  archive(qa.qaArtifactPath('api-validation'));
  archive(qa.qaArtifactPath('run-config'));
  qa.writeQaArtifact('api-discovery', apiDiscovery);
  qa.writeQaArtifact('api-validation', apiValidation);
  qa.writeQaArtifact('run-config', {
    coverageMode,
    ...(apiDocsUrl ? { apiDocsUrl: coverageLib.displayApiDocsUrl(apiDocsUrl) } : {}),
    runId: stamp,
    writtenAt: runStarted.toISOString(),
    apiValidation: {
      enabled: liveChoice.enabled,
      ...(liveChoice.baseUrl ? { baseUrl: liveChoice.baseUrl } : {}),
      environment: process.env.QA_API_ENVIRONMENT?.trim() || 'test',
      // What a person approved AND the documentation declares — the list the prober actually honoured.
      approvedOperations: apiValidation?.policy?.approvedOperations ?? [],
    },
    discovery: discoveryRecord,
  });
  if (apiSummary.status === 'AVAILABLE') emit({ type: 'ARTIFACT_CREATED', artifactType: 'API_DISCOVERY', count: apiSummary.endpoints, message: 'api-discovery.json created' });
  if (liveSummary.status !== 'NOT_REQUESTED') emit({ type: 'ARTIFACT_CREATED', artifactType: 'API_VALIDATION', count: liveSummary.requests, message: 'api-validation.json created' });
}

// API only: no browser stage runs. What the interface would have shown is recorded as what it
// is — nothing — by host code, so every later stage has the artifact it reads and nobody has to
// guess. The previous run's browser evidence is moved aside with the rest: it is not this run's.
if (uiSkipped && startIndex === 0) {
  for (const path of [qa.qaArtifactPath('discovered-behavior'), qa.qaArtifactPath('discovery-evidence'), surfaceLib.surfacePath(), ledgerLib.ledgerPath()]) archive(path);
  qa.writeQaArtifact('discovered-behavior', {
    product: `${apiDiscovery?.title ?? 'API'} (${coverageMode === 'API_ONLY' ? 'API only: the interface was not explored' : `the interface was not explored: ${uiSkipped}`})`,
    locations: [], areas: [], behaviors: [], openQuestions: [], conflicts: [],
  });
  emit({ type: 'LOG', level: coverageMode === 'API_ONLY' ? 'info' : 'warn', message: `Product Discovery skipped — no browser is started: ${uiSkipped}` });
}
/** The run's configuration, as its record and its archive state it. */
const coverageRecord = {
  coverageMode,
  apiDocsUrl: (configuresCoverage ? coverageLib.displayApiDocsUrl(apiDocsUrl) : previousConfig?.apiDocsUrl) ?? null,
  apiDiscovery: apiSummary,
  apiValidation: liveSummary,
  discovery: discoveryRecord,
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('\nPHASE 1 — Manual QA Design (deterministic sequencing)');
console.log(`Target          : ${target ?? '(not needed for this plan)'}`);
console.log(`Artifacts       : ${qa.QA_ARTIFACT_ROOT}`);
console.log(`Stages          : ${plan.map((s) => s.label).join(' -> ')} -> STOP`);
console.log(`Attempts/stage  : ${attempts}`);
console.log(`Coverage mode   : ${coverageLib.COVERAGE_MODE_LABEL[coverageMode]}${configuresCoverage ? '' : ' (kept from the suite on disk)'}`);
console.log(`Discovery       : ${discoveryRecord.methods.length ? discoveryRecord.methods.map((m) => (m === 'UI' ? 'UI (browser)' : `API (${discoveryRecord.api?.evidence === 'LIVE' ? 'documentation + live requests' : 'documentation only'})`)).join(' + ') : 'none'}` +
  `${discoveryRecord.ui?.status === 'SKIPPED' ? ` — no browser: ${discoveryRecord.ui.reason}` : ''}`);
console.log(`API docs        : ${apiSummary.status === 'AVAILABLE'
  ? `${apiSummary.endpoints} operation(s), ${apiSummary.schemas} schema(s), ${apiSummary.authentication} auth scheme(s)${coverageRecord.apiDocsUrl ? ` — ${coverageRecord.apiDocsUrl}` : ''}`
  : apiSummary.status === 'UNAVAILABLE'
    ? `UNAVAILABLE — ${apiSummary.reason}. The run continues without API-level tests.`
    : coverageMode === 'UI_ONLY' ? 'not read (UI only)' : 'none given — test cases will be UI level'}`);
if (coverageLib.usesApiDocs(coverageMode) && apiSummary.status === 'AVAILABLE') {
  console.log(`API validation  : ${liveSummary.status === 'NOT_REQUESTED'
    ? `off — ${apiValidation?.reason ?? 'documentation only'}`
    : liveSummary.status === 'UNAVAILABLE'
      ? `UNAVAILABLE — ${liveSummary.reason}. The run continues with the documentation alone.`
      : `${liveSummary.requests} request(s) to ${liveSummary.baseUrl}: ${liveSummary.validated} validated, ${liveSummary.observed} observed, ` +
        `${liveSummary.documented} documented only (${liveSummary.skipped} not called); ${liveSummary.contractViolations} contract violation(s), ` +
        `${liveSummary.potentialIssues} potential issue(s)${liveSummary.status === 'PARTIAL' ? ` — PARTIAL: ${liveSummary.reason}` : ''}`}`);
  if (liveSummary.status !== 'NOT_REQUESTED' && liveSummary.status !== 'UNAVAILABLE') {
    console.log(`API credentials : ${apiValidation.authentication.status === 'READY' ? `configured (${apiValidation.authentication.method})`
      : apiValidation.authentication.status === 'FAILED' ? `NOT USABLE — ${apiValidation.authentication.detail}`
        : 'none configured — secured operations were only checked for refusing a request without credentials'}`);
  }
}
if (existsSync(archiveDir)) console.log(`Archived        : previous artifacts moved to ${archiveDir}`);

/** The files a run's archive keeps — whichever of them exist when it ends. */
function runFiles() {
  return [
    'discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json',
    'automation-prioritization.json', 'discovery-surface.json', 'discovery-observations.json',
    'discovery-evidence.json', 'phase1-run.json', 'defect-analysis.json',
    'api-discovery.json', 'api-validation.json', 'run-config.json',
    ...qa.listBugReportIds().map((id) => `bugs/${id}.json`),
  ];
}

/**
 * Which locations the evidence collector replays: the ones discovery reported
 * actually reaching, falling back to the host-built surface when the artifact
 * has none. Never the model's free text — these are URLs the host records.
 */
function evidenceLocations() {
  const discovered = qa.readQaArtifact('discovered-behavior');
  const visited = (discovered?.locations ?? [])
    .filter((l) => l?.status === 'EXPLORED' && typeof l.url === 'string')
    .map((l) => l.url);
  if (visited.length > 0) return [...new Set(visited)];
  const surface = surfaceLib.readSurface();
  return surface ? surface.locations.filter((l) => l.status !== 'SKIPPED_WITH_REASON').map((l) => l.url) : [];
}

// Which model produced this run. Without it every artifact on disk is
// unattributable, and a local-vs-hosted comparison is guesswork — the archive
// this project already holds cannot say which model wrote any of it.
const env = envForLock;
// Bug reports carry the run they came from.
process.env.QA_RUN_ID = stamp;
const record = {
  phase: 1,
  target: target ?? null,
  model: env.QA_MODEL,
  startedAt: runStarted.toISOString(),
  from,
  attempts,
  ...coverageRecord,
  stages: [],
};
const recordPath = join(qa.QA_ARTIFACT_ROOT, 'phase1-run.json');
const saveRecord = () => {
  mkdirSync(qa.QA_ARTIFACT_ROOT, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
};

let browserStarted = false;
if (plan.some((s) => s.browser)) {
  // `--fresh-browser` (or QA_FRESH_BROWSER=true) restarts the MCP server so this
  // run owns its browser. Required for an A/B trial: otherwise the second model
  // inherits the first one's cookies and sign-in.
  const freshBrowser = process.argv.includes('--fresh-browser') || process.env.QA_FRESH_BROWSER === 'true';
  await ensureMcp({ fresh: freshBrowser });
  browserStarted = true;
  // If this run cannot stop its own browser (killed outright), the controller that started it will.
  if (startedMcpPid()) reportOwned({ mcpPid: startedMcpPid() });
  emit({ type: 'LOG', category: 'BROWSER', message: `Playwright MCP ready${freshBrowser ? ' (fresh browser)' : ''}` });
  // The preflight snapshot is what establishes the product surface: the
  // same-origin links the browser actually rendered. Written fresh for this
  // run, so a retry can never inherit a stale queue.
  // One ledger per run: evidence from an earlier session is not evidence about
  // this one, and a retry within this run legitimately builds on what it saw.
  ledgerLib.resetLedger(stamp);
  const entrySnapshot = await preflightTarget(target);
  if (entrySnapshot) {
    try {
      // Tracked: every state-changing browser action and snapshot is recorded,
      // and Product Discovery's finalization is gated on them.
      const surface = surfaceLib.buildSurface(target, entrySnapshot, new Date(), { trackCompletion: true });
      surfaceLib.writeSurface(surface);
      record.surface = {
        discovered: surface.locations.length,
        preSkipped: surface.locations.filter((l) => l.status === 'SKIPPED_WITH_REASON').length,
        overflow: surface.overflow,
        externalOrigins: surface.externalOrigins,
      };
      emit({ type: 'LOG', category: 'BROWSER', message: `Product surface: ${surface.locations.length} location(s) on the entry page` });
      console.log(`Product surface : ${surface.locations.length} location(s) from the entry page` +
        `${surface.overflow ? `, ${surface.overflow} beyond the cap` : ''}` +
        `${surface.externalOrigins.length ? `, ${surface.externalOrigins.length} external origin(s) ignored` : ''}`);
    } catch (error) {
      console.log(`Product surface : could not be established (${error.message}) — discovery will run unbounded`);
    }
  }
}

// One QA run, one trace. Started only now, after every exit path of the
// preflight, so a trace always has an end.
observability.startRun({
  command: 'qa-manual',
  runId: stamp,
  model: env.QA_MODEL,
  input: { target: target ?? null, from, stages: plan.map((s) => s.key), attemptsPerStage: attempts, coverageMode },
  metadata: { from, attemptsPerStage: attempts, target: target ?? null, gitCommit: gitCommit(ROOT) ?? null, coverageMode, apiEndpoints: apiSummary.endpoints },
});
history.setTraceId(observability.traceId?.());
if (!cancellation.requested) {
  history.markRunning();
  emit({ type: 'RUN_RUNNING', status: 'RUNNING', message: 'Preflight done; stages starting' });
}

for (const stage of plan) {
  // A cancel between stages (or during preflight or evidence collection) ends the run here.
  if (cancellation.requested) await endCancelled(undefined);
  const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
  record.stages.push(entry);
  const stageTrace = observability.startStage(stage);
  const stageHistory = history.stage(stage);
  const stageStarted = Date.now();
  emit({ type: 'STAGE_STARTED', stage: stage.key, stageLabel: stage.label, message: `${stage.label} started` });

  // Give the discovery stage the surface the host just established.
  if (stage.withSurface) {
    const surface = surfaceLib.readSurface();
    if (surface) stage.message = stage.withSurface(surfaceLib.surfaceBriefing(surface), surface.locations.length);
  }
  const passed = await runStage({
    // Every stage is told the run's coverage mode and what API documentation there is.
    stage: { ...stage, message: apiLib.briefStage(stage.key, stage.message, coverageMode, apiDiscovery, liveSummary) },
    entry,
    attempts,
    idPrefix: 'p1',
    stamp,
    artifactProblem,
    qaArtifactPath: qa.qaArtifactPath,
    onProgress: () => {
      saveRecord();
      stageHistory.attempts(entry.attempts.length);
    },
    trace: stageTrace,
    onEvent: emit,
    isCancelled: () => cancellation.requested,
  });
  if (cancellation.requested) {
    stageHistory.cancel(entry.attempts.length);
    emit({ type: 'STAGE_CANCELLED', stage: stage.key, stageLabel: stage.label, level: 'warn', message: `${stage.label} stopped by the operator` });
    await stageTrace.end({ passed: false });
    await endCancelled(stage);
  }
  const stageSeconds = Math.round((Date.now() - stageStarted) / 1000);
  if (passed) {
    emit({ type: 'STAGE_COMPLETED', stage: stage.key, stageLabel: stage.label, attempt: entry.attempts.length, message: `${stage.label} completed in ${stageSeconds}s (${entry.attempts.length} attempt${entry.attempts.length === 1 ? '' : 's'})` });
    emit({ type: 'ARTIFACT_CREATED', stage: stage.key, artifactType: ARTIFACT_TYPE[stage.artifact], message: `${stage.artifact}.json created` });
    if (stage.key === 'defects') {
      const bugCount = qa.listBugReportIds().length;
      emit({ type: 'ARTIFACT_CREATED', stage: stage.key, artifactType: 'BUG_REPORT', count: bugCount, message: `${bugCount} bug report(s) created` });
    }
    publishMetrics();
  } else {
    emit({ type: 'STAGE_FAILED', stage: stage.key, stageLabel: stage.label, attempt: entry.attempts.length, errorCode: 'STAGE_FAILED', message: `${stage.label} failed after ${entry.attempts.length} attempt(s): ${entry.attempts.at(-1)?.problem ?? 'no valid artifact'}` });
  }
  if (passed) stageHistory.complete(entry.attempts.length);
  else stageHistory.fail(entry.attempts.length, 'STAGE_FAILED', entry.attempts.at(-1)?.problem ?? `${stage.artifact}.json was not produced.`);
  // Record what a derived artifact was generated from, so staleness is exact later.
  if (passed && depLib.INPUTS[stage.artifact]) depLib.stampDependency(stage.artifact);

  // Deterministic browser evidence, collected while the browser is still up.
  // This runs on the host, in its own session, and replays the locations the
  // agent reported reaching — see scripts/lib/evidence.mjs for why it cannot
  // read the agent's session instead. Never fatal: evidence enriches the run,
  // and a collector problem must not discard a valid discovery artifact.
  if (stage.key === 'discovery' && passed && target) {
    try {
      const { collectBrowserEvidence } = await import('./lib/evidence.mjs');
      const evidence = await collectBrowserEvidence({
        mcpUrl: mcpUrl(),
        target,
        origin: new URL(target).origin,
        locations: evidenceLocations(),
        runId: stamp,
      });
      if (evidence) {
        const { evidenceSummary } = await import(resolve(ROOT, 'src/lib/browser-evidence.ts'));
        record.evidence = { ...evidence.totals, locations: evidence.locations.length, overflow: evidence.overflow };
        console.log(`Browser evidence: ${evidenceSummary(evidence)}`);
        emit({ type: 'ARTIFACT_CREATED', stage: stage.key, artifactType: 'DISCOVERY_EVIDENCE', message: `Browser evidence collected: ${evidenceSummary(evidence)}` });
      }
    } catch (error) {
      record.evidence = { error: error.message };
      console.log(`Browser evidence: not collected (${error.message})`);
    }
  }

  // What the Discovery Completion Gate decided, attempt by attempt. Recorded
  // whether or not tracing is on: a run that was refused finalization and never
  // wrote is exactly the one worth reading.
  if (stage.key === 'discovery') {
    const finalSurface = surfaceLib.readSurface();
    // The application handed the flow to an origin this run may not visit. That
    // is operator configuration, not something a model may decide: say so.
    const heldBack = [...new Set((finalSurface?.navigation ?? [])
      .filter((t) => t.exposedBy !== undefined && t.scope === 'EXTERNAL')
      .map((t) => t.origin))];
    if (heldBack.length > 0) {
      entry.continuationOriginsNotAllowed = heldBack;
      console.log(`NOTE            : after an action the product showed a link to ${heldBack.join(', ')}, which this run ` +
        'may not visit. If that is test infrastructure the flow needs (a mailbox, say), add it to QA_DISCOVERY_AUX_ORIGINS.');
    }
    const gate = completionMetrics(finalSurface?.completion);
    if (gate.finalizationAttemptCount) {
      entry.completionGate = gate;
      saveRecord();
      console.log(`Completion gate : ${gate.finalizationAttemptCount} finalization attempt(s), ` +
        `${gate.finalizationRejectedCount} rejected` +
        `${gate.rejectionReasonCodes ? ` (${Object.entries(gate.rejectionReasonCodes).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`);
    }
  }

  // QA counts from the artifact just validated — evaluated only when tracing.
  await stageTrace.end({
    passed,
    metrics: () => {
      const ledger = stage.key === 'discovery' ? ledgerLib.readLedger(stamp) : undefined;
      return stageMetrics(stage.key, qa.readQaArtifact, {
        observationCount: ledger ? ledgerLib.ledgerSummary(ledger).recorded : undefined,
        completion: stage.key === 'discovery' ? surfaceLib.readSurface()?.completion : undefined,
      });
    },
  });

  if (stage.browser) {
    // Later stages need no browser; release it now if we started it.
    record.mcpStoppedCleanly = await stopMcpAndWait();
  }

  if (!passed) {
    record.result = 'FAILED';
    record.failedStage = stage.key;
    record.finishedAt = new Date().toISOString();
    saveRecord();
    // A failed run is archived too — what it did produce, and its run record —
    // so its history entry has something to show.
    const failedArchive = preserveRun({
      artifactRoot: qa.QA_ARTIFACT_ROOT, projectRoot: ROOT, runId: stamp, model: env.QA_MODEL, target, startedAt: runStarted,
      files: runFiles(), outcome: 'failed', onlyWrittenSince: runStarted, extra: { failedStage: stage.key, auxiliaryOrigins: auxLib.auxiliaryOrigins(), coverageMode, apiDocsUrl: coverageRecord.apiDocsUrl },
    });
    emit({ type: 'RUN_FAILED', status: 'FAILED', stage: stage.key, stageLabel: stage.label, errorCode: 'STAGE_FAILED', message: `Stopped at ${stage.label}: no valid ${stage.artifact}.json after ${attempts} attempt(s).` });
    history.finish({
      status: 'FAILED', errorCode: 'STAGE_FAILED', archiveDir: failedArchive.dir,
      errorSummary: `${stage.label} did not produce a valid ${stage.artifact}.json after ${attempts} attempt(s).`,
    });
    console.error(`\nPhase 1 stopped: ${stage.label} did not produce a valid ${stage.artifact}.json after ${attempts} attempt(s).`);
    console.error(`Run preserved   : ${failedArchive.dir}`);
    console.error(`Earlier artifacts are kept. Resume from this stage with:\n  npm run qa:manual -- --from ${stage.key}\n`);
    await observability.endRun({ outcome: 'FAILED', failedStage: stage.key, output: () => runFunnel(qa.readQaArtifact) });
    process.exit(EXIT.FAILED);
  }
}

// ---------------------------------------------------------------------------
// STOP — Phase 1 ends here, by construction
// ---------------------------------------------------------------------------

const leaked = PHASE2_ARTIFACTS.filter((name) => {
  const path = qa.qaArtifactPath(name);
  return existsSync(path) && statSync(path).mtimeMs >= runStarted.getTime();
});
record.phase2ArtifactsWritten = leaked;

const prioritization = qa.readQaArtifact('automation-prioritization');
const counts = summarize(prioritization);
record.counts = counts;

// Coverage is computed here from the two artifacts, never taken from a total
// the model reports about itself.
const discovery = qa.readQaArtifact('discovered-behavior');
const ledger = ledgerLib.readLedger(stamp);
if (ledger) record.observations = ledgerLib.ledgerSummary(ledger);

// Per-stage efficiency, all host-derived. Ratios are left to whoever reads
// this rather than stored, so they can never drift from their inputs.
for (const s of record.stages) {
  const byTool = {};
  let total = 0;
  let durationMs = 0;
  for (const a of s.attempts) {
    durationMs += a.durationMs ?? 0;
    for (const [name, n] of Object.entries(a.toolCallsByTool ?? {})) byTool[name] = (byTool[name] ?? 0) + n;
    total += a.toolCallsTotal ?? 0;
  }
  s.efficiency = { toolCallsTotal: total, toolCallsByTool: byTool, durationMs };
}
const discoveryStage = record.stages.find((s) => s.stage === 'discovery');
if (discoveryStage) {
  discoveryStage.efficiency.observationsRecorded = record.observations?.recorded ?? 0;
  discoveryStage.efficiency.behaviorsProduced = discovery?.behaviors?.length ?? 0;
}
if (discovery?.locations) {
  const by = (st) => discovery.locations.filter((l) => l.status === st).length;
  record.discoveryCoverage = {
    reported: discovery.locations.length,
    visited: by('EXPLORED'),
    unreachable: by('BLOCKED'),
    skipped: by('SKIPPED_WITH_REASON'),
    behaviors: discovery.behaviors?.length ?? 0,
    areas: discovery.areas?.length ?? 0,
  };
}

const requirements = qa.readQaArtifact('requirements-analysis');
const suite = qa.readQaArtifact('test-cases');
const coverage = requirements && suite ? coverageSummary(requirements, suite, qa.readCoverageContext()) : undefined;
if (coverage) record.coverage = coverage;
// Analysis coverage: how discovery's behaviors fared on their way into
// requirements. Host-derived from the two artifacts, like every other total.
const analysis = requirements ? analysisCoverageSummary(discovery, requirements) : undefined;
if (analysis) record.analysisCoverage = analysis;
// Defect analysis counts, host-derived from the artifact. Defects are a QA
// result, never a pipeline failure.
const defects = defectMetrics(qa.readQaArtifact('defect-analysis'));
if (Object.keys(defects).length > 0) record.defects = defects;
record.result = 'COMPLETE';
record.finishedAt = new Date().toISOString();
saveRecord();

if (browserStarted) await stopMcpAndWait();

console.log('\n==============================================================');
console.log(' PHASE 1 COMPLETE — stopped before any automation');
console.log('==============================================================');
if (record.discoveryCoverage) {
  const d = record.discoveryCoverage;
  console.log(`Discovery       : ${d.visited} visited, ${d.unreachable} unreachable, ${d.skipped} skipped` +
    ` -> ${d.behaviors} behavior(s) across ${d.areas} area(s)` +
    `${record.observations ? `, from ${record.observations.recorded} recorded observation(s)` : ''}`);
}
if (analysis) {
  const types = Object.entries(analysis.validationTypes).sort((a, b) => b[1] - a[1]);
  console.log(`Analysis        : ${analysis.analyzed}/${analysis.behaviors} behavior(s) analyzed` +
    `${analysis.excluded > 0 ? `, ${analysis.excluded} excluded with a reason` : ''}` +
    ` -> ${analysis.acceptancePoints} acceptance point(s), ${analysis.businessRules} business rule(s), ` +
    `${analysis.openQuestions} open question(s)`);
  if (types.length > 0) {
    console.log(`Validation types: ${types.map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  if (analysis.unaccounted > 0) {
    console.log(`WARNING         : unanalyzed behavior(s): ${analysis.unaccountedIds.join(', ')}`);
  }
}
console.log(`Test cases      : ${counts.total}  (${counts.manual} MANUAL, ${counts.automation} AUTOMATION)`);
if (coverage) {
  const pct = coverage.testable === 0 ? 100 : Math.round((coverage.covered / coverage.testable) * 100);
  console.log(`Coverage        : ${coverage.covered}/${coverage.testable} testable requirements (${pct}%)` +
    `${coverage.exempt > 0 ? `, ${coverage.exempt} marked not testable` : ''}`);
  const scenarios = Object.entries(coverage.scenarioTypes).sort((a, b) => b[1] - a[1]);
  if (scenarios.length > 0) {
    console.log(`Scenario types  : ${scenarios.map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  console.log(`Test levels     : ${coverage.testLevels.UI ?? 0} UI, ${coverage.testLevels.API ?? 0} API` +
    `${coverage.outOfScope > 0 ? ` (${coverage.outOfScope} requirement(s) out of scope for ${coverageLib.COVERAGE_MODE_LABEL[coverageMode]})` : ''}`);
  if (coverage.uncovered > 0) console.log(`WARNING         : uncovered: ${coverage.uncoveredIds.join(', ')}`);
  // Coverage can be 100% while the suite classifies itself into two kinds.
  // A diagnostic, not a gate — see scenarioDiversityDiagnostic().
  const diversity = scenarioDiversityDiagnostic(coverage);
  if (diversity) console.log(`NOTE            : ${diversity}`);
}
console.log(`Automation      : ${counts.automationHigh} HIGH, ${counts.automationMedium} MEDIUM, ${counts.automationLow} LOW`);
if (record.defects) {
  const d = record.defects;
  console.log(`Defects         : ${d.defects_confirmed} confirmed, ${d.defects_potential} potential, ` +
    `${d.defects_not_a_defect} not a defect, ${d.defects_insufficient_evidence} insufficient evidence ` +
    `-> ${d.bug_reports_created} bug report(s)`);
}
const strategies = Object.entries(prioritization ? strategySummary(prioritization) : {}).sort((a, b) => b[1] - a[1]);
if (strategies.length > 0) {
  console.log(`Strategy        : ${strategies.map(([k, n]) => `${n} ${k}`).join(', ')}`);
}
if (leaked.length > 0) console.log(`WARNING         : Phase 2 artifacts appeared during this run: ${leaked.join(', ')}`);
// Preserve this run under its own id, with the metadata that makes the numbers
// attributable to a model rather than to "the last run".
const preserved = preserveRun({
  artifactRoot: qa.QA_ARTIFACT_ROOT,
  projectRoot: ROOT,
  runId: stamp,
  model: env.QA_MODEL,
  target,
  startedAt: runStarted,
  files: runFiles(),
  outcome: 'completed',
  extra: { auxiliaryOrigins: auxLib.auxiliaryOrigins(), ...defects, coverageMode, apiDocsUrl: coverageRecord.apiDocsUrl },
});
console.log(`Run preserved   : ${preserved.dir}`);
publishMetrics();
emit({ type: 'RUN_COMPLETED', status: 'COMPLETED', message: `Phase 1 complete: ${counts.total} test case(s)${record.defects ? `, ${record.defects.bug_reports_created} bug report(s)` : ''}` });
history.finish({ status: 'COMPLETED', archiveDir: preserved.dir });

console.log('\nNext:');
console.log(`  jq . ${qa.qaArtifactPath('test-cases')}`);
console.log(`  jq . ${qa.qaArtifactPath('automation-prioritization')}`);
console.log('  npm run qa:review      # AI review — proposes changes, edits nothing');
console.log('  npm run qa:defects     # your decision on each bug report: accept, reject, downgrade, edit');
console.log('  npm run qa:approve     # your approval; required before Phase 2');
console.log('  (edited test cases?  npm run qa:manual -- --from prioritization)\n');
await observability.endRun({ outcome: 'COMPLETE', output: () => runFunnel(qa.readQaArtifact) });
process.exit(EXIT.OK);
