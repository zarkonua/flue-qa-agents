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
//   STOP  (then: review, edit, `npm run qa:approve`)
//
// The sequence is fixed here, in trusted code; no model decides whether the
// next stage runs. Each agent runs as its own root process with only its own
// tools, and hands off through `.qa/` exactly as before. A stage passes only if
// its artifact was freshly written during this attempt AND re-validates from
// disk (schema + semantic). A failed stage is retried, then the run stops.
//
// Options:
//   --from <stage>   start at discovery | analysis | design | prioritization
//                    (earlier artifacts are kept — e.g. after hand-editing test
//                    cases, `--from prioritization` re-prioritizes only)
//   --attempts <n>   attempts per stage (default 4, or QA_STAGE_ATTEMPTS)

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT, ensureMcp, preflightTarget, requireTarget, stopMcpAndWait } from './lib/runtime.mjs';
import { makeArtifactProblem, runStage } from './lib/stage.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { summarize, coverageSummary } = await import(resolve(ROOT, 'src/lib/semantic-validate.ts'));
const { APPROVAL_PATH } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const surfaceLib = await import(resolve(ROOT, 'src/lib/discovery-surface.ts'));
const ledgerLib = await import(resolve(ROOT, 'src/lib/observation-ledger.ts'));

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
      `Account for every one before you write — visit it, or record it UNREACHABLE/SKIPPED with a reason.` +
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

function archive(path) {
  if (!existsSync(path)) return;
  mkdirSync(archiveDir, { recursive: true });
  renameSync(path, join(archiveDir, path.split('/').pop()));
}

// Regenerating any stage invalidates the review and the approval of the old result.
for (const stage of plan) archive(qa.qaArtifactPath(stage.artifact));
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
if (existsSync(archiveDir)) console.log(`Archived        : previous artifacts moved to ${archiveDir}`);

const record = { phase: 1, target: target ?? null, startedAt: runStarted.toISOString(), from, attempts, stages: [] };
const recordPath = join(qa.QA_ARTIFACT_ROOT, 'phase1-run.json');
const saveRecord = () => {
  mkdirSync(qa.QA_ARTIFACT_ROOT, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
};

let browserStarted = false;
if (plan.some((s) => s.browser)) {
  await ensureMcp();
  browserStarted = true;
  // The preflight snapshot is what establishes the product surface: the
  // same-origin links the browser actually rendered. Written fresh for this
  // run, so a retry can never inherit a stale queue.
  // One ledger per run: evidence from an earlier session is not evidence about
  // this one, and a retry within this run legitimately builds on what it saw.
  ledgerLib.resetLedger(stamp);
  const entrySnapshot = await preflightTarget(target);
  if (entrySnapshot) {
    try {
      const surface = surfaceLib.buildSurface(target, entrySnapshot);
      surfaceLib.writeSurface(surface);
      record.surface = {
        discovered: surface.locations.length,
        preSkipped: surface.locations.filter((l) => l.status === 'SKIPPED').length,
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

for (const stage of plan) {
  const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
  record.stages.push(entry);

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
if (discovery?.locations) {
  const by = (st) => discovery.locations.filter((l) => l.status === st).length;
  record.discoveryCoverage = {
    reported: discovery.locations.length,
    visited: by('VISITED'),
    unreachable: by('UNREACHABLE'),
    skipped: by('SKIPPED'),
    behaviors: discovery.behaviors?.length ?? 0,
    areas: discovery.areas?.length ?? 0,
  };
}

const requirements = qa.readQaArtifact('requirements-analysis');
const suite = qa.readQaArtifact('test-cases');
const coverage = requirements && suite ? coverageSummary(requirements, suite) : undefined;
if (coverage) record.coverage = coverage;
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
console.log(`Test cases      : ${counts.total}  (${counts.manual} MANUAL, ${counts.automation} AUTOMATION)`);
if (coverage) {
  const pct = coverage.testable === 0 ? 100 : Math.round((coverage.covered / coverage.testable) * 100);
  console.log(`Coverage        : ${coverage.covered}/${coverage.testable} testable requirements (${pct}%)` +
    `${coverage.exempt > 0 ? `, ${coverage.exempt} marked not testable` : ''}`);
  if (coverage.uncovered > 0) console.log(`WARNING         : uncovered: ${coverage.uncoveredIds.join(', ')}`);
}
console.log(`Automation      : ${counts.automationHigh} HIGH, ${counts.automationMedium} MEDIUM, ${counts.automationLow} LOW`);
if (leaked.length > 0) console.log(`WARNING         : Phase 2 artifacts appeared during this run: ${leaked.join(', ')}`);
console.log('\nNext:');
console.log(`  jq . ${qa.qaArtifactPath('test-cases')}`);
console.log(`  jq . ${qa.qaArtifactPath('automation-prioritization')}`);
console.log('  npm run qa:review      # optional AI review — proposes changes, edits nothing');
console.log('  npm run qa:approve     # your approval; required before Phase 2');
console.log('  (edited test cases?  npm run qa:manual -- --from prioritization)\n');
process.exit(EXIT.OK);
