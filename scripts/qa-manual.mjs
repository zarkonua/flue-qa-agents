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
import { EXIT, ROOT, ensureMcp, preflightTarget, requireTarget, runAgent, stopMcp, stopMcpAndWait } from './lib/runtime.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { summarize } = await import(resolve(ROOT, 'src/lib/semantic-validate.ts'));
const { APPROVAL_PATH } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));

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

/** The corrective message for a retry, naming exactly what the last attempt got wrong. */
function retryMessage(stage, problem) {
  if (problem && /was not written/.test(problem)) {
    return (
      `Nothing was saved: your last turn ended without a successful write_qa_artifact call, so ` +
      `"${stage.artifact}" does not exist. Call write_qa_artifact now with name "${stage.artifact}" ` +
      'and the complete object. Do not reply in prose until the tool reports success.'
    );
  }
  return (
    `The "${stage.artifact}" artifact you wrote failed host validation: ${problem}. ` +
    `Fix it and call write_qa_artifact again with name "${stage.artifact}" and the complete object.`
  );
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

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

/** Why an artifact is not usable, or undefined if it is: exists, schema-valid, (optionally) semantically valid. */
function artifactProblem(name, { semantic: checkSemantic = true } = {}) {
  let data;
  try {
    data = qa.readQaArtifact(name);
  } catch (error) {
    return `${name}.json is not valid JSON (${error.message}).`;
  }
  if (data === undefined) return `${name}.json does not exist.`;
  const schema = qa.schemaErrorsFor(name, data);
  if (schema.length > 0) return `${name}.json fails its schema: ${schema[0]}`;
  if (!checkSemantic) return undefined;
  const semantic = qa.semanticErrorsFor(name, data);
  if (semantic.length > 0) return `${name}.json fails semantic validation: ${semantic[0].code} at ${semantic[0].path}`;
  return undefined;
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
  await preflightTarget(target);
}

for (const stage of plan) {
  const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
  record.stages.push(entry);
  let passed = false;
  let lastProblem;
  // Retry style alternates. Even attempts CONTINUE the previous conversation
  // with a nudge naming exactly what went wrong, keeping what the agent already
  // read. Odd attempts start FRESH: back-to-back failures were observed within
  // one conversation, so a clean start breaks that correlation.
  let id;
  entry.conversationIds = [];

  for (let attempt = 1; attempt <= attempts && !passed; attempt += 1) {
    const resume = attempt % 2 === 0;
    if (!resume) {
      id = `p1-${stage.key}-${stamp}-${attempt}`;
      entry.conversationIds.push(id);
    }
    console.log(`\n=== ${stage.label} — attempt ${attempt}/${attempts}${resume ? ' (continuing, with correction)' : attempt > 1 ? ' (fresh conversation)' : ''} ===\n`);
    const started = Date.now();
    const message = resume ? retryMessage(stage, lastProblem) : stage.message;
    const exitCode = await runAgent(stage.agent, message, id, { resume });

    const path = qa.qaArtifactPath(stage.artifact);
    // Fresh = written during this attempt. A file from before cannot pass.
    const fresh = existsSync(path) && statSync(path).mtimeMs >= started - 1000;
    const problem = fresh ? artifactProblem(stage.artifact) : `${stage.artifact}.json was not written by this attempt.`;
    passed = fresh && problem === undefined;
    lastProblem = problem;

    entry.attempts.push({ attempt, resumed: resume, conversationId: id, agentExitCode: exitCode, seconds: Math.round((Date.now() - started) / 1000), passed, problem: problem ?? null });
    saveRecord();
    console.log(`\n--- ${stage.label}: ${passed ? 'artifact written and valid' : `FAILED — ${problem}`}`);
  }

  entry.passed = passed;
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
record.result = 'COMPLETE';
record.finishedAt = new Date().toISOString();
saveRecord();

if (browserStarted) await stopMcpAndWait();

console.log('\n==============================================================');
console.log(' PHASE 1 COMPLETE — stopped before any automation');
console.log('==============================================================');
console.log(`Test cases      : ${counts.total}  (${counts.manual} MANUAL, ${counts.automation} AUTOMATION)`);
console.log(`Automation      : ${counts.automationHigh} HIGH, ${counts.automationMedium} MEDIUM, ${counts.automationLow} LOW`);
if (leaked.length > 0) console.log(`WARNING         : Phase 2 artifacts appeared during this run: ${leaked.join(', ')}`);
console.log('\nNext:');
console.log(`  jq . ${qa.qaArtifactPath('test-cases')}`);
console.log(`  jq . ${qa.qaArtifactPath('automation-prioritization')}`);
console.log('  npm run qa:review      # optional AI review — proposes changes, edits nothing');
console.log('  npm run qa:approve     # your approval; required before Phase 2');
console.log('  (edited test cases?  npm run qa:manual -- --from prioritization)\n');
process.exit(EXIT.OK);
