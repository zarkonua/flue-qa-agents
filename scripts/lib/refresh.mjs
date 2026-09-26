// Dependency refresh: re-derive what the current test suite invalidated —
// Automation Prioritizer, then Defect Analyzer — and nothing else.
//
// All or nothing. The artifacts it may replace (automation-prioritization,
// defect-analysis and bugs/) are snapshotted first; if either stage fails, the
// snapshot is put back and no dependency stamp is written, so the old artifacts
// stay exactly as they were: valid files, still STALE. Only when both stages
// pass are the new stamps recorded and the artifacts CURRENT.
//
// A regenerated defect analysis gets fresh bug ids and PENDING decisions; the
// earlier human reviews are then reconciled onto it (src/lib/bug-reconciliation.ts):
// materially unchanged reports keep their decision and edits, changed ones go
// back to PENDING, and the previous reports and their histories are archived.
//
// It never touches the Phase 1 approval. The approval hashes the artifacts this
// replaces, so it stays STALE until a person approves again.
//
// Neither stage uses a browser; no Playwright MCP server is started. It takes
// the run lock, so it never overlaps a QA run or a review agent.
//
// Trusted host code. Started by `npm run qa:refresh` or the workspace's
// "Refresh dependent analysis" (which runs that same command).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './runtime.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { makeArtifactProblem, runStage } from './stage.mjs';
import { STAGES } from './phase1-stages.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const depLib = await import(resolve(ROOT, 'src/lib/phase1-dependencies.ts'));
const { atomicWriteFile } = await import(resolve(ROOT, 'src/lib/atomic-write.ts'));
const { QA_MODEL } = await import(resolve(ROOT, 'src/config/env.ts'));
const reconcileLib = await import(resolve(ROOT, 'src/lib/bug-reconciliation.ts'));
const { defaultStore, REVIEWS_DIR } = await import(resolve(ROOT, 'src/review/workspace.ts'));

/** The stages a changed test suite invalidates, in dependency order. */
export const REFRESH_STAGES = STAGES.filter((s) => s.key === 'prioritization' || s.key === 'defects');

export const STATUS_PATH = join(qa.QA_ARTIFACT_ROOT, 'phase1-refresh.json');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The last refresh, as recorded. A RUNNING one whose process is gone reads as FAILED. */
export function readRefreshStatus() {
  let status;
  try {
    status = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return { status: 'IDLE' };
  }
  if (status.status === 'RUNNING' && !(status.pid && alive(status.pid))) {
    return { ...status, status: 'FAILED', error: 'The refresh was interrupted. Run it again.' };
  }
  return status;
}

function writeStatus(status) {
  atomicWriteFile(STATUS_PATH, JSON.stringify(status, null, 2));
}

function snapshot(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['automation-prioritization', 'defect-analysis']) {
    const path = qa.qaArtifactPath(name);
    if (existsSync(path)) cpSync(path, join(dir, `${name}.json`));
  }
  if (existsSync(qa.BUGS_DIR)) cpSync(qa.BUGS_DIR, join(dir, 'bugs'), { recursive: true });
  const history = join(REVIEWS_DIR, 'bugs');
  if (existsSync(history)) cpSync(history, join(dir, 'review-history'), { recursive: true });
}

/** Put the snapshot back exactly: files atomically, and bugs/ as it was. */
function restore(dir) {
  for (const name of ['automation-prioritization', 'defect-analysis']) {
    const saved = join(dir, `${name}.json`);
    if (existsSync(saved)) atomicWriteFile(qa.qaArtifactPath(name), readFileSync(saved, 'utf8'));
    else rmSync(qa.qaArtifactPath(name), { force: true });
  }
  rmSync(qa.BUGS_DIR, { recursive: true, force: true });
  if (existsSync(join(dir, 'bugs'))) cpSync(join(dir, 'bugs'), qa.BUGS_DIR, { recursive: true });
  const history = join(REVIEWS_DIR, 'bugs');
  rmSync(history, { recursive: true, force: true });
  if (existsSync(join(dir, 'review-history'))) cpSync(join(dir, 'review-history'), history, { recursive: true });
}

const stateOf = (b) => ({ status: b.status, decision: b.review.decision, severity: b.severity, priority: b.priority });

/**
 * Carry earlier human reviews onto the regenerated bug reports, and move their
 * histories to the new ids. Every carried report is re-validated through
 * writeBugReport; if a person's edits no longer hold against the new evidence,
 * only the decision carries; if even that fails, the report stays PENDING.
 */
export async function reconcileBugDecisions(previousDir, store = defaultStore()) {
  const previous = existsSync(previousDir)
    ? readdirSync(previousDir).filter((f) => /^BUG-[0-9]{3,}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(previousDir, f), 'utf8')))
    : [];
  const regenerated = qa.listBugReportIds().map((id) => qa.readBugReport(id));
  const plan = reconcileLib.planReconciliation(previous, regenerated);
  const oldHistory = Object.fromEntries(await Promise.all(previous.map(async (b) => [b.id, await store.listBugReviewEvents(b.id)])));
  const histories = {};
  const summary = { preserved: [], reset: [], added: plan.added.map((b) => b.id), removed: plan.removed.map((b) => ({ id: b.id, previousDecision: b.review.decision })) };
  const at = new Date().toISOString();

  for (const { from, to } of plan.preserved) {
    let written;
    let editsCarried = false;
    for (const withEdits of [true, false]) {
      const next = reconcileLib.carryOver(from, to, { withEdits });
      try {
        qa.writeBugReport(next);
        written = next;
        editsCarried = withEdits && (from.review.editedFields ?? []).length > 0;
        break;
      } catch {
        // The edits no longer hold against the regenerated evidence; try the decision alone.
      }
    }
    if (!written) {
      summary.reset.push({ from: from.id, to: to.id, previousDecision: from.review.decision });
      continue;
    }
    summary.preserved.push({ from: from.id, to: to.id, decision: written.review.decision, editsCarried });
    histories[to.id] = [
      ...(oldHistory[from.id] ?? []),
      {
        at,
        action: 'reconcile',
        by: 'host',
        note: `Carried over from ${from.id}: the regenerated report is materially the same defect${editsCarried ? ', with the earlier edits' : ''}.`,
        before: stateOf(to),
        after: stateOf(written),
      },
    ];
  }
  for (const { from, to } of plan.reset) {
    summary.reset.push({ from: from.id, to: to.id, previousDecision: from.review.decision });
  }
  // Only carried reviews keep a history under their new id; the rest are in the archive.
  await store.replaceBugReviewHistories(histories);
  return summary;
}

/**
 * Run the refresh. `runStageFn` is the real stage runner; tests pass a fake
 * that writes (or fails to write) artifacts, exactly where the model would.
 *
 * Resolves with { ok, reason?, message?, stages }.
 */
export async function refreshDependents({ runStageFn = runStage, attempts = 4, observability, log = console.log, store = defaultStore() } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const lock = acquireRunLock(qa.QA_ARTIFACT_ROOT, { runId: stamp, model: QA_MODEL, command: 'qa:refresh' });
  if (!lock.ok) {
    const message = lock.message.split('\n')[0];
    writeStatus({ status: 'FAILED', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: message });
    return { ok: false, reason: 'LOCKED', message, stages: [] };
  }

  const status = { status: 'RUNNING', pid: process.pid, startedAt: new Date().toISOString(), stages: [] };
  writeStatus(status);
  const backup = join(qa.QA_ARTIFACT_ROOT, 'archive', `${stamp}-refresh`);
  snapshot(backup);
  const artifactProblem = makeArtifactProblem(qa);
  observability?.startRun({
    command: 'phase1-refresh',
    runId: stamp,
    model: QA_MODEL,
    input: { stages: REFRESH_STAGES.map((s) => s.key) },
    metadata: { event: 'phase1_refresh_started', stages: REFRESH_STAGES.map((s) => s.key).join(',') },
  });

  let failed;
  try {
    for (const stage of REFRESH_STAGES) {
      log(`\nRefresh: ${stage.label}`);
      const entry = { stage: stage.key, agent: stage.agent, artifact: stage.artifact, attempts: [] };
      const trace = observability?.startStage(stage);
      let passed = false;
      try {
        passed = await runStageFn({ stage, entry, attempts, idPrefix: 'refresh', stamp, artifactProblem, qaArtifactPath: qa.qaArtifactPath, trace });
      } catch (error) {
        entry.error = error.message;
      }
      await trace?.end({ passed });
      status.stages.push({ stage: stage.key, passed, attempts: entry.attempts.length });
      writeStatus(status);
      if (!passed) {
        failed = `${stage.label} did not produce a valid ${stage.artifact}.json${entry.attempts.at(-1)?.problem ? `: ${entry.attempts.at(-1).problem}` : entry.error ? `: ${entry.error}` : ''}`;
        break;
      }
    }

    if (failed) {
      restore(backup);
      Object.assign(status, { status: 'FAILED', finishedAt: new Date().toISOString(), error: failed.slice(0, 1000) });
      writeStatus(status);
      await observability?.endRun({ outcome: 'FAILED', failedStage: status.stages.at(-1)?.stage });
      log(`\nRefresh FAILED — ${failed}\nThe previous artifacts were restored and remain STALE.`);
      return { ok: false, reason: 'STAGE_FAILED', message: failed, stages: status.stages };
    }

    // Earlier human reviews onto the regenerated reports — part of the same all-or-nothing unit.
    status.reconciliation = await reconcileBugDecisions(join(backup, 'bugs'), store);
    writeStatus(status);

    // Both stages passed against the current suite: now, and only now, current.
    for (const stage of REFRESH_STAGES) depLib.stampDependency(stage.artifact);
    Object.assign(status, { status: 'COMPLETED', finishedAt: new Date().toISOString() });
    writeStatus(status);
    await observability?.endRun({ outcome: 'COMPLETE', output: () => ({ bugsPreserved: status.reconciliation.preserved.length, bugsReset: status.reconciliation.reset.length, bugsNew: status.reconciliation.added.length, bugsRemoved: status.reconciliation.removed.length }) });
    const r = status.reconciliation;
    log(`\nBug reviews: ${r.preserved.length} preserved, ${r.reset.length} reset to PENDING, ${r.added.length} new, ${r.removed.length} removed (archived in ${backup}).`);
    log('Refresh complete. Prioritization and defect analysis are current. Phase 1 approval is NOT restored — approve again.');
    return { ok: true, stages: status.stages };
  } catch (error) {
    restore(backup);
    Object.assign(status, { status: 'FAILED', finishedAt: new Date().toISOString(), error: String(error.message).slice(0, 1000) });
    writeStatus(status);
    await observability?.endRun({ outcome: 'FAILED' });
    throw error;
  } finally {
    lock.release();
  }
}
