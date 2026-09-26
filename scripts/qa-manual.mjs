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

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT, createObservabilityOrExit, ensureMcp, mcpUrl, preflightTarget, requireAuthBootstrap, requireTarget, stopMcpAndWait } from './lib/runtime.mjs';
import { makeArtifactProblem, runStage } from './lib/stage.mjs';
import { acquireRunLock } from './lib/run-lock.mjs';
import { gitCommit, preserveRun } from './lib/run-record.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { summarize, coverageSummary, analysisCoverageSummary, strategySummary, scenarioDiversityDiagnostic } = await import(resolve(ROOT, 'src/lib/semantic-validate.ts'));
const { APPROVAL_PATH } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const surfaceLib = await import(resolve(ROOT, 'src/lib/discovery-surface.ts'));
const auxLib = await import(resolve(ROOT, 'src/config/auxiliary-origins.ts'));
const authLib = await import(resolve(ROOT, 'src/config/auth-bootstrap.ts'));
const ledgerLib = await import(resolve(ROOT, 'src/lib/observation-ledger.ts'));
const { completionMetrics, runFunnel, stageMetrics } = await import(resolve(ROOT, 'src/observability/qa-metrics.ts'));
const { defectMetrics } = await import(resolve(ROOT, 'src/lib/defects.ts'));

// ---------------------------------------------------------------------------
// The Phase 1 stage list — a closed allowlist
// ---------------------------------------------------------------------------

const STAGES = [
  {
    key: 'discovery',
    label: 'Product Discovery',
    agent: 'src/agents/product-discovery.ts',
    artifact: 'discovered-behavior',
    browser: true,
    message: 'Begin.',
    // Replaced at run time with the surface briefing, when there is one.
    withSurface: (brief, count) =>
      `Begin.\n\nThe browser found these same-origin locations on the entry page:\n\n${brief}\n\n` +
      `Account for every one before you write — visit it, or record it BLOCKED/SKIPPED_WITH_REASON with a reason. ` +
      `The list grows as you go: a page you reach that is not on it, and the links that page renders, are ` +
      `added to it.` +
      (count <= 1
        ? ` This list is short because the entry page exposes few links; most of this application's ` +
          `surface is reached by USING it — signing in, submitting forms, opening panels. Accounting for ` +
          `this one location is the start of your job, not the end of it: work through the controls you ` +
          `can see and record what each one actually does.`
        : ''),
  },
  {
    key: 'analysis',
    label: 'Behavior Analyst',
    agent: 'src/agents/behavior-analyst.ts',
    artifact: 'requirements-analysis',
    message: 'Read the discovered-behavior artifact and write the requirements-analysis artifact.',
  },
  {
    key: 'design',
    label: 'Test Designer',
    agent: 'src/agents/test-designer.ts',
    artifact: 'test-cases',
    message: 'Read the requirements-analysis and discovered-behavior artifacts and write the test-cases artifact.',
  },
  {
    key: 'prioritization',
    label: 'Automation Prioritizer',
    agent: 'src/agents/automation-prioritizer.ts',
    artifact: 'automation-prioritization',
    message: 'Read the test-cases artifact and write the automation-prioritization artifact.',
  },
  {
    key: 'defects',
    label: 'Defect Analyzer',
    agent: 'src/agents/defect-analyzer.ts',
    artifact: 'defect-analysis',
    message:
      'Read the discovered-behavior, requirements-analysis and test-cases artifacts and write the defect-analysis artifact.',
  },
];

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
const plan = STAGES.slice(startIndex);

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

const artifactProblem = makeArtifactProblem(qa);

const target = plan.some((s) => s.browser) ? requireTarget() : process.env.TARGET_URL;
// The state the browser starts in: signed out (default), a configured test
// account, or a stored session. Validated here, before the lock or any
// browser work — a missing storage-state file or credential is a config error.
const auth = plan.some((s) => s.browser) ? requireAuthBootstrap() : { mode: 'none' };

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
const stamp = runStarted.toISOString().replace(/[:.]/g, '-');
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

function archive(path) {
  if (!existsSync(path)) return;
  mkdirSync(archiveDir, { recursive: true });
  renameSync(path, join(archiveDir, path.split('/').pop()));
}

// Regenerating any stage invalidates the review and the approval of the old result.
for (const stage of plan) archive(qa.qaArtifactPath(stage.artifact));
// Bug reports belong to the defect analysis that produced them.
if (plan.some((s) => s.key === 'defects')) archive(qa.BUGS_DIR);
archive(qa.qaArtifactPath('test-cases-review'));
archive(APPROVAL_PATH);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('\nPHASE 1 — Manual QA Design (deterministic sequencing)');
console.log(`Target          : ${target ?? '(not needed for this plan)'}`);
console.log(`Artifacts       : ${qa.QA_ARTIFACT_ROOT}`);
console.log(`Stages          : ${plan.map((s) => s.label).join(' -> ')} -> STOP`);
console.log(`Attempts/stage  : ${attempts}`);
if (plan.some((s) => s.browser)) console.log(`Auth bootstrap  : ${auth.mode}`);
if (existsSync(archiveDir)) console.log(`Archived        : previous artifacts moved to ${archiveDir}`);

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
  // Mode only — never an account, a path's contents, a cookie or a token.
  // Applied is not the same as signed in: the application decides that.
  auth: { mode: auth.mode, applied: false },
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
  await ensureMcp({ fresh: freshBrowser, auth });
  browserStarted = true;
  record.auth.applied = auth.mode !== 'none';
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
  input: { target: target ?? null, from, stages: plan.map((s) => s.key), attemptsPerStage: attempts },
  metadata: {
    from,
    attemptsPerStage: attempts,
    target: target ?? null,
    gitCommit: gitCommit(ROOT) ?? null,
    ...authLib.authTelemetry(auth),
  },
});

for (const stage of plan) {
  const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
  record.stages.push(entry);
  const stageTrace = observability.startStage(stage);

  // Give the discovery stage the surface the host just established.
  if (stage.withSurface) {
    const surface = surfaceLib.readSurface();
    if (surface) stage.message = stage.withSurface(surfaceLib.surfaceBriefing(surface), surface.locations.length);
  }
  const passed = await runStage({
    stage,
    entry,
    attempts,
    idPrefix: 'p1',
    stamp,
    artifactProblem,
    qaArtifactPath: qa.qaArtifactPath,
    onProgress: saveRecord,
    trace: stageTrace,
  });
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
    console.error(`\nPhase 1 stopped: ${stage.label} did not produce a valid ${stage.artifact}.json after ${attempts} attempt(s).`);
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
const coverage = requirements && suite ? coverageSummary(requirements, suite) : undefined;
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
  files: [
    'discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json',
    'automation-prioritization.json', 'discovery-surface.json', 'discovery-observations.json',
    'discovery-evidence.json', 'phase1-run.json', 'defect-analysis.json',
    ...qa.listBugReportIds().map((id) => `bugs/${id}.json`),
  ],
  outcome: 'completed',
  extra: { auxiliaryOrigins: auxLib.auxiliaryOrigins(), authBootstrapMode: auth.mode, ...defects },
});
console.log(`Run preserved   : ${preserved.dir}`);

console.log('\nNext:');
console.log(`  jq . ${qa.qaArtifactPath('test-cases')}`);
console.log(`  jq . ${qa.qaArtifactPath('automation-prioritization')}`);
console.log('  npm run qa:review      # AI review — proposes changes, edits nothing');
console.log('  npm run qa:defects     # your decision on each bug report: accept, reject, downgrade, edit');
console.log('  npm run qa:approve     # your approval; required before Phase 2');
console.log('  (edited test cases?  npm run qa:manual -- --from prioritization)\n');
await observability.endRun({ outcome: 'COMPLETE', output: () => runFunnel(qa.readQaArtifact) });
process.exit(EXIT.OK);
