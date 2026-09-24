#!/usr/bin/env node
// PHASE 2 — Automation Engineering. Entry gate, then Repo Analyzer, then STOP.
//
//   npm run qa:automation
//
//   [entry gate]     Phase 1 complete, valid, approved by a person, unchanged
//   Repo Analyzer -> repo-analysis.json
//   STOP
//
// Refuses to start unless Phase 1 is approved and unchanged since that
// approval. The gate is unchanged from before; what follows it is one stage,
// sequenced here in trusted code exactly as Phase 1 sequences its four — no
// model decides what runs next.
//
// The rest of the Phase 2 pipeline (UI Explorer, Automation Generator, Test
// Runner, Failure Analyzer) is deliberately NOT wired in yet. UI Explorer and
// Automation Generator exist in src/agents/ but this command will not start
// them: PHASE2_AGENTS is a closed allowlist checked at startup.
//
// Options:
//   --from <stage>   start at: repo-analyzer  (the only stage today)
//   --attempts <n>   attempts per stage (default 4, or QA_STAGE_ATTEMPTS)
//   --gate-only      run the entry gate and stop, without starting any agent

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT, createObservabilityOrExit } from './lib/runtime.mjs';
import { gitCommit } from './lib/run-record.mjs';
import { makeArtifactProblem, runStage } from './lib/stage.mjs';
import { assertWiredStages, NOT_YET_WIRED, PHASE2_AGENTS, PHASE2_STAGES, UNWIRED_ARTIFACTS } from './lib/phase2-stages.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { checkPhase2Gate } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const { TARGET_REPO_ROOT } = await import(resolve(ROOT, 'src/lib/trusted-roots.ts'));
const { stageMetrics } = await import(resolve(ROOT, 'src/observability/qa-metrics.ts'));

// ---------------------------------------------------------------------------
// The Phase 2 stage list — a closed allowlist
// ---------------------------------------------------------------------------

const STAGES = PHASE2_STAGES;

// Fails loudly at startup if a stage ever names an agent Phase 2 may not start
// — including UI Explorer and Automation Generator, which are built but unwired.
try {
  assertWiredStages(STAGES);
} catch (error) {
  console.error(`Refusing to run: ${error.message}`);
  process.exit(EXIT.BAD_CONFIG);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split('=')[1];
}

const gateOnly = process.argv.includes('--gate-only');
const from = option('from') ?? STAGES[0].key;
const startIndex = STAGES.findIndex((s) => s.key === from);
if (startIndex < 0) {
  console.error(`Unknown --from stage "${from}". Use one of: ${STAGES.map((s) => s.key).join(', ')}.`);
  process.exit(EXIT.BAD_CONFIG);
}
const attempts = Math.max(1, Number(option('attempts') ?? process.env.QA_STAGE_ATTEMPTS ?? 4));
const plan = STAGES.slice(startIndex);

// ---------------------------------------------------------------------------
// 1-2. The entry gate — unchanged. Nothing below it runs if it refuses.
// ---------------------------------------------------------------------------

const gate = checkPhase2Gate();

if (!gate.ok) {
  console.error(`\n${gate.message}\n`);
  process.exit(EXIT.GATE_REFUSED);
}

const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const selected = [...gate.automationCases].sort((a, b) => order[a.automationPriority] - order[b.automationPriority]);

console.log('\n==============================================================');
console.log(' PHASE 2 GATE: OPEN');
console.log('==============================================================');
console.log(`Approved by     : ${gate.approval.approvedBy} at ${gate.approval.approvedAt}`);
console.log('Integrity       : all approved artifacts unchanged since approval');
console.log(`Selected        : ${selected.length} AUTOMATION case(s); ${gate.approval.counts.manual} MANUAL case(s) stay in the manual suite`);
for (const c of selected) console.log(`  ${c.automationPriority.padEnd(6)} ${c.testCaseId}  ${c.reason}`);

if (gateOnly) {
  console.log('\n--gate-only: prerequisites verified; no agent was started.\n');
  process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// Preconditions for the stages themselves
// ---------------------------------------------------------------------------

const artifactProblem = makeArtifactProblem(qa);

// Langfuse tracing, when LANGFUSE_ENABLED=true; a no-op otherwise. Validated
// before anything is archived or any agent starts.
const observability = await createObservabilityOrExit();

// The Repo Analyzer has nothing to analyse without a repository. That is an
// operator configuration problem, so say so here rather than burning four
// attempts on an agent that can only report the same thing back.
if (!existsSync(TARGET_REPO_ROOT)) {
  console.error(`\nNo target repository at ${TARGET_REPO_ROOT}.`);
  console.error('Phase 2 analyses the repository your automated tests will live in.');
  console.error('Clone it there, or point QA_TARGET_REPO_ROOT at it:\n');
  console.error('  export QA_TARGET_REPO_ROOT="/absolute/path/to/your/automation-repo"\n');
  process.exit(EXIT.BAD_CONFIG);
}

// Starting part-way through needs every earlier stage's artifact present and
// schema-valid (there are none today; this keeps `--from` honest as stages land).
for (const stage of STAGES.slice(0, startIndex)) {
  const problem = artifactProblem(stage.artifact, { semantic: false });
  if (problem) {
    console.error(`\nCannot start at "${from}": ${problem}\nRun the earlier stages first.\n`);
    process.exit(EXIT.BAD_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Archive what this run will replace — never delete
// ---------------------------------------------------------------------------

const runStarted = new Date();
const stamp = runStarted.toISOString().replace(/[:.]/g, '-');
const archiveDir = join(qa.QA_ARTIFACT_ROOT, 'archive', stamp);

for (const stage of plan) {
  const path = qa.qaArtifactPath(stage.artifact);
  if (!existsSync(path)) continue;
  mkdirSync(archiveDir, { recursive: true });
  renameSync(path, join(archiveDir, path.split('/').pop()));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('\nPHASE 2 — Automation Engineering (deterministic sequencing)');
console.log(`Repository      : ${TARGET_REPO_ROOT}`);
console.log(`Artifacts       : ${qa.QA_ARTIFACT_ROOT}`);
console.log(`Stages          : ${plan.map((s) => s.label).join(' -> ')} -> STOP`);
console.log(`Attempts/stage  : ${attempts}`);
if (existsSync(archiveDir)) console.log(`Archived        : previous artifacts moved to ${archiveDir}`);

const record = {
  phase: 2,
  repository: TARGET_REPO_ROOT,
  startedAt: runStarted.toISOString(),
  from,
  attempts,
  approvedAt: gate.approval.approvedAt,
  automationCases: selected.length,
  stages: [],
};
const recordPath = join(qa.QA_ARTIFACT_ROOT, 'phase2-run.json');
const saveRecord = () => {
  mkdirSync(qa.QA_ARTIFACT_ROOT, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
};

/**
 * Project the analysis into `automation-project-contract`.
 *
 * Read back from disk rather than taken from the agent's tool call, so what is
 * projected is exactly what was validated and written.
 */
async function buildContract() {
  const analysis = qa.readQaArtifact('repo-analysis');
  if (analysis === undefined) return undefined;
  const { buildAutomationContract, contractGaps, contractSummary, validateAutomationContract } =
    await import(resolve(ROOT, 'src/lib/automation-contract.ts'));
  const { collectRepoEvidence } = await import(resolve(ROOT, 'src/lib/repo-evidence.ts'));
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');

  const evidence = collectRepoEvidence();
  const sourceAnalysisSha256 = createHash('sha256')
    .update(readFileSync(qa.qaArtifactPath('repo-analysis')))
    .digest('hex');

  const contract = buildAutomationContract(analysis, evidence, { sourceAnalysisSha256 });
  // Built from verified facts, so this should always pass; checked anyway,
  // because a contract that quietly disagreed with the repository is worse
  // than none at all.
  const problems = validateAutomationContract(contract, evidence, sourceAnalysisSha256);
  if (problems.length > 0) {
    throw new Error(`contract failed its own validation: ${problems.map((p) => p.code).join(', ')}`);
  }
  qa.writeQaArtifact('automation-project-contract', contract);
  return { summary: contractSummary(contract), gaps: contractGaps(contract) };
}

const { QA_MODEL } = await import(resolve(ROOT, 'src/config/env.ts'));
observability.startRun({
  command: 'qa-automation',
  runId: stamp,
  model: QA_MODEL,
  input: { stages: plan.map((s) => s.key), automationCases: selected.length, attemptsPerStage: attempts },
  metadata: { from, attemptsPerStage: attempts, automationCases: selected.length, gitCommit: gitCommit(ROOT) ?? null },
});

for (const stage of plan) {
  const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
  record.stages.push(entry);
  const stageTrace = observability.startStage(stage);

  const passed = await runStage({
    stage,
    entry,
    attempts,
    idPrefix: 'p2',
    stamp,
    artifactProblem,
    qaArtifactPath: qa.qaArtifactPath,
    onProgress: saveRecord,
    trace: stageTrace,
  });
  await stageTrace.end({ passed, metrics: () => stageMetrics(stage.key, qa.readQaArtifact) });

  // The automation project contract: a deterministic projection of the analysis
  // into what a later agent needs, with every path and script re-checked on
  // disk. Host-written — no agent holds it in a write picklist. Never fatal:
  // a projection problem must not discard a valid repo-analysis.
  if (stage.artifact === 'repo-analysis' && passed) {
    try {
      const built = await buildContract();
      if (built) {
        record.contract = built.summary;
        console.log(`Contract        : ${built.summary}`);
        for (const gap of built.gaps) console.log(`  gap           : ${gap}`);
      }
    } catch (error) {
      record.contract = { error: error.message };
      console.log(`Contract        : not built (${error.message})`);
    }
  }

  if (!passed) {
    record.result = 'FAILED';
    record.failedStage = stage.key;
    record.finishedAt = new Date().toISOString();
    saveRecord();
    console.error(`\nPhase 2 stopped: ${stage.label} did not produce a valid ${stage.artifact}.json after ${attempts} attempt(s).`);
    console.error(`Resume from this stage with:\n  npm run qa:automation -- --from ${stage.key}\n`);
    await observability.endRun({ outcome: 'FAILED', failedStage: stage.key });
    process.exit(EXIT.FAILED);
  }
}

// ---------------------------------------------------------------------------
// STOP — Phase 2 ends here, by construction
// ---------------------------------------------------------------------------

const leaked = UNWIRED_ARTIFACTS.filter((name) => {
  const path = qa.qaArtifactPath(name);
  return existsSync(path) && statSync(path).mtimeMs >= runStarted.getTime();
});
record.unwiredArtifactsWritten = leaked;
record.result = 'COMPLETE';
record.finishedAt = new Date().toISOString();
saveRecord();

const analysis = qa.readQaArtifact('repo-analysis');
const count = (list) => (Array.isArray(list) ? list.length : 0);

console.log('\n==============================================================');
console.log(' PHASE 2 — REPO ANALYSIS COMPLETE (stopped, as designed)');
console.log('==============================================================');
console.log(`Repository      : ${analysis?.repository?.packageManager} · ${analysis?.repository?.language} · ${analysis?.repository?.testRunner}`);
console.log(`Recorded        : ${count(analysis?.layout)} layout entries, ${count(analysis?.conventions)} conventions, ${count(analysis?.keyFiles)} key files`);
console.log(`Unknowns        : ${count(analysis?.unknowns)}   Risks: ${count(analysis?.risks)}`);
if (leaked.length > 0) console.log(`WARNING         : artifacts of unwired stages appeared: ${leaked.join(', ')}`);
console.log('\nNext:');
console.log(`  jq . ${qa.qaArtifactPath('repo-analysis')}`);
console.log('  Read it as a person: does it describe conventions a new test must follow?');
console.log('\nThe rest of Phase 2 (UI Explorer, Automation Generator) is not wired yet — nothing was generated.\n');
await observability.endRun({ outcome: 'COMPLETE', output: () => stageMetrics('repo-analyzer', qa.readQaArtifact) });
process.exit(EXIT.OK);
