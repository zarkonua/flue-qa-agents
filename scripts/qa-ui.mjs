#!/usr/bin/env node
// The QA Review Workspace.
//
//   npm run qa:ui          build the UI if its sources changed, then serve it
//                          and the host API at http://127.0.0.1:4445
//   npm run qa:ui:dev      the same host API, plus Vite with hot reload on :5173
//
// Trust model:
//   - the browser talks only to the fixed API in src/ui-server/server.ts; it
//     never reads or writes a file, names a path, or runs a command;
//   - the review agent PROPOSES through its two tools; the host VALIDATES; a
//     person APPLIES; the host WRITES test-cases.json;
//   - approving Phase 1 calls approvePhase1(), the same as `npm run qa:approve`;
//   - bound to 127.0.0.1 unless QA_UI_HOST says otherwise; there is no login.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, ROOT, runAgent } from './lib/runtime.mjs';
import { acquireRunLock } from './lib/run-lock.mjs';

const { envInt, envString, QA_MODEL } = await import(resolve(ROOT, 'src/config/env.ts'));
const { createUiServer } = await import(resolve(ROOT, 'src/ui-server/server.ts'));
const { artifactWorkspace, defaultStore } = await import(resolve(ROOT, 'src/review/workspace.ts'));
const { validateProposal } = await import(resolve(ROOT, 'src/review/test-case-changes.ts'));
const { QA_ARTIFACT_ROOT } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { createRunObservability } = await import(resolve(ROOT, 'src/observability/host.ts'));
const { traceBugEvent } = await import(resolve(ROOT, 'src/observability/workflow-events.ts'));
const { readRefreshStatus } = await import('./lib/refresh.mjs');

const PORT = envInt('QA_UI_PORT', 4445);
const HOST = envString('QA_UI_HOST') ?? '127.0.0.1';
const DEV = process.argv.includes('--dev');
const UI = join(ROOT, 'ui');
const DIST = join(UI, 'dist');

// ---------------------------------------------------------------------------
// Build the UI when its sources are newer than the build
// ---------------------------------------------------------------------------

function newest(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...readdirSync(path).map((f) => newest(join(path, f))));
}

async function ensureBuilt() {
  const built = join(DIST, 'index.html');
  const sources = Math.max(newest(join(UI, 'src')), newest(join(UI, 'index.html')), newest(join(UI, 'vite.config.ts')));
  if (existsSync(built) && statSync(built).mtimeMs >= sources) return;
  console.log('Building the workspace UI…');
  const { build } = await import('vite');
  await build({ root: UI, configFile: join(UI, 'vite.config.ts'), logLevel: 'warn' });
}

// ---------------------------------------------------------------------------
// The focused review agent, one request at a time
// ---------------------------------------------------------------------------

const AGENT = 'src/agents/test-case-change-reviewer.ts';
const ATTEMPTS = 2;

async function runReviewAgent(request) {
  // Review agents share Flue's conversation store with QA runs; never both at once.
  const lock = acquireRunLock(QA_ARTIFACT_ROOT, { runId: request.id, model: QA_MODEL, command: 'qa:ui review' });
  if (!lock.ok) throw new Error(lock.message.split('\n')[0]);
  const store = defaultStore();
  const observability = await createRunObservability();
  // Ids and booleans only — never the comment, the case or a diff.
  observability.startRun({
    command: 'test-case-review',
    runId: request.id,
    model: QA_MODEL,
    input: { requestId: request.id, operation: request.operation },
    metadata: {
      operation: request.operation,
      testCaseId: request.targetTestCaseId ?? null,
      manualEditsPresent: request.manualEdits !== undefined,
      humanCommentPresent: request.humanComment !== undefined,
      verificationRequired: false,
      verificationPerformed: false,
    },
  });
  const stage = observability.startStage({ key: 'generate-proposal', label: 'Focused review', agent: AGENT, artifact: 'review-proposal' });
  let proposal;
  try {
    const before = new Set((await store.listProposals(request.id)).map((p) => p.id));
    const id = `review-${request.id}-${Date.now().toString(36)}`;
    for (let attempt = 1; attempt <= ATTEMPTS && !proposal; attempt += 1) {
      const resume = attempt > 1;
      const message = resume
        ? 'Nothing was submitted. Call submit_test_case_proposal now with the complete proposal.'
        : `Answer change request ${request.id}: call read_change_request, then submit_test_case_proposal.`;
      const started = Date.now();
      const { exitCode, toolCalls } = await runAgent(AGENT, message, id, {
        resume,
        extraEnv: { QA_REVIEW_REQUEST_ID: request.id, ...stage.childEnv({ attempt, resumed: resume }) },
      });
      proposal = (await store.listProposals(request.id)).filter((p) => !before.has(p.id)).at(-1);
      stage.recordAttempt({
        attempt, resumed: resume, agentExitCode: exitCode, durationMs: Date.now() - started,
        toolCallsTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0), toolCallsByTool: toolCalls,
        passed: proposal !== undefined, problem: proposal ? null : 'no proposal submitted',
      });
    }
  } finally {
    const validation = proposal ? validateProposal(artifactWorkspace, proposal) : undefined;
    await stage.end({
      passed: proposal !== undefined,
      metrics: () => ({
        proposalValid: validation?.status === 'VALID',
        validationStatus: validation?.status ?? 'NONE',
        proposedCaseCount: proposal?.proposedCases.length ?? 0,
        unresolvedIssueCount: proposal?.unresolvedIssues.length ?? 0,
      }),
    });
    await observability.endRun({ outcome: proposal ? 'COMPLETE' : 'FAILED' });
    lock.release();
  }
}

/**
 * The dependency refresh, as its own process: `npm run qa:refresh`, fixed argv.
 * It records its progress in phase1-refresh.json, which is what `status` reads —
 * so a refresh survives this server restarting.
 */
const refresh = {
  async start() {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'qa-refresh.mjs')], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Streamed to this terminal, like the review agent's output.
    child.stdout.on('data', (c) => process.stdout.write(c));
    child.stderr.on('data', (c) => process.stderr.write(c));
    // Give it a moment to take the lock and record RUNNING (or fail fast on the lock).
    await new Promise((done) => {
      const deadline = Date.now() + 5000;
      const tick = () => (readRefreshStatus().status !== 'IDLE' && readRefreshStatus().startedAt >= startedAt) || Date.now() > deadline || child.exitCode !== null ? done() : setTimeout(tick, 100);
      const startedAt = new Date().toISOString();
      tick();
    });
  },
  status: () => readRefreshStatus(),
};

// ---------------------------------------------------------------------------

if (!DEV) await ensureBuilt();

const server = await createUiServer({
  store: defaultStore(),
  workspace: artifactWorkspace,
  runReviewAgent,
  refresh,
  onBugEvent: traceBugEvent,
  uiDir: DEV ? undefined : DIST,
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Set QA_UI_PORT to another port.\n`);
    process.exit(EXIT.BAD_CONFIG);
  }
  console.error(error);
  process.exit(EXIT.FAILED);
});

server.listen(PORT, HOST, () => {
  console.log('\nQA Review Workspace');
  console.log(`  http://${HOST}:${PORT}${DEV ? '   (API only — open http://127.0.0.1:5173)' : ''}`);
  console.log(`  artifacts: ${QA_ARTIFACT_ROOT}`);
  console.log('\nProposals change nothing until you apply them. Approving Phase 1 is identical to npm run qa:approve. Ctrl-C to stop.\n');
  if (DEV) {
    const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), UI], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, QA_UI_PORT: String(PORT) } });
    process.on('exit', () => vite.kill());
  }
});

export { server };
