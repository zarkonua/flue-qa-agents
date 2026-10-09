// Run history, as the orchestrators use it: register the run when it starts,
// record each stage as it runs, and close the run — with metrics and the
// artifact index derived from its archive — when it ends.
//
// History is an index, not a dependency of QA execution. The boundary:
//
//   - the database cannot be opened or migrated  -> one loud WARNING at start;
//     the run continues unrecorded (npm run qa:history:verify shows it later)
//   - a stage update fails                        -> WARNING; the run continues
//   - the final index fails                       -> the archive is kept; the run
//     is still closed with error code HISTORY_INDEX_FAILED, and
//     npm run qa:history:import rebuilds its index from the archive
//   - the process exits without closing the run  -> an exit handler closes it
//     (INTERRUPTED on Ctrl-C, FAILED otherwise); a killed process is caught by
//     reconciliation the next time history is opened

import { resolve } from 'node:path';
import { ROOT } from './runtime.mjs';
import { gitCommit } from './run-record.mjs';
import { cancellation } from './cancellation.mjs';

const NOOP_STAGE = { attempts() {}, complete() {}, fail() {}, cancel() {} };
const NOOP = { recorded: false, stage: () => NOOP_STAGE, setTraceId() {}, markRunning() {}, setMetrics() {}, finish() {} };

/**
 * Register a run. Returns a recorder whose methods never throw.
 *
 * `holdsRunLock`: the caller took the run lock under this same id — lets
 * reconciliation tell this run from a dead one after a reused pid.
 */
export async function startRunHistory({ kind, runId, model, target, startedAt, holdsRunLock = false, status = 'RUNNING', coverageMode = null, apiDocsUrl = null, log = console.log }) {
  let store;
  let svc;
  let archive;
  try {
    svc = await import(resolve(ROOT, 'src/history/service.ts'));
    archive = await import(resolve(ROOT, 'src/history/archive.ts'));
    store = svc.runHistory();
    const interrupted = svc.reconcileInterrupted(store);
    if (interrupted.length > 0) log(`Run history     : ${interrupted.length} earlier run(s) marked INTERRUPTED (their process is gone)`);
    store.startRun({
      id: runId, kind, status, model, target, startedAt: new Date(startedAt).toISOString(),
      gitCommit: gitCommit(ROOT) ?? null, ownerPid: process.pid, holdsRunLock, coverageMode, apiDocsUrl,
    });
  } catch (error) {
    log(`WARNING         : run history is unavailable, so this run will not appear under Runs in the workspace ` +
      `(${String(error?.message ?? error).split('\n')[0]}). The QA run continues and is archived as usual.`);
    return NOOP;
  }

  const warned = new Set();
  const safe = (what, fn) => {
    try {
      return fn();
    } catch (error) {
      if (!warned.has(what)) {
        warned.add(what);
        log(`WARNING         : run history could not record ${what} (${String(error?.message ?? error).split('\n')[0]}); the QA run continues.`);
      }
      return undefined;
    }
  };

  let finished = false;
  const onExit = (code) => {
    if (finished) return;
    finished = true;
    try {
      // A cancel the workspace asked for is CANCELLED however the process ended; Ctrl-C is INTERRUPTED.
      const status = cancellation.requested ? 'CANCELLED' : code === 130 ? 'INTERRUPTED' : 'FAILED';
      store.finishRun(runId, {
        status,
        finishedAt: new Date().toISOString(),
        errorCode: status === 'FAILED' ? 'PROCESS_EXIT' : status,
        errorSummary: status === 'FAILED' ? `The process exited with code ${code} before the run recorded a result.` : 'Stopped by the operator.',
      });
    } catch { /* the process is ending; reconciliation covers what this cannot */ }
  };
  process.once('exit', onExit);
  // Without a SIGINT listener Node dies without 'exit'. The run lock installs
  // one that exits with 130; a command without the lock gets the same here.
  if (process.listenerCount('SIGINT') === 0) process.once('SIGINT', () => process.exit(130));

  let ordinal = 0;
  return {
    recorded: true,

    /** Record a stage starting; returns its attempt/complete/fail handles. */
    stage(stage) {
      ordinal += 1;
      const id = safe('a stage start', () => store.startStage(runId, { stageName: stage.key, label: stage.label, ordinal, startedAt: new Date().toISOString() }));
      if (id === undefined) return NOOP_STAGE;
      return {
        attempts: (n) => safe('stage progress', () => store.setStageAttempts(id, n)),
        complete: (n) => safe('a stage result', () => store.completeStage(id, { finishedAt: new Date().toISOString(), attemptCount: n })),
        fail: (n, errorCode, errorSummary) => safe('a stage result', () => store.failStage(id, { finishedAt: new Date().toISOString(), attemptCount: n, errorCode, errorSummary })),
        cancel: (n) => safe('a stage result', () => store.cancelStage(id, { finishedAt: new Date().toISOString(), attemptCount: n })),
      };
    },

    /** STARTING -> RUNNING: preflight is done. */
    markRunning() {
      safe('the run state', () => store.markRunning(runId));
    },

    /** Counts known so far; the final set is derived from the archive when the run closes. */
    setMetrics(metrics) {
      if (metrics && Object.keys(metrics).length > 0) safe('live metrics', () => store.setMetrics(runId, metrics));
    },

    setTraceId(traceId) {
      if (traceId) safe('the trace id', () => store.setTraceId(runId, traceId));
    },

    /**
     * Close the run. With `archiveDir`, its metrics and artifact index are
     * derived from the archive and committed in the same transaction. The
     * archive is already on disk: an index failure never touches it.
     */
    finish({ status, errorCode = null, errorSummary = null, archiveDir, langfuseTraceId }) {
      if (finished) return;
      finished = true;
      process.off('exit', onExit);
      const finishedAt = new Date().toISOString();
      const archiveRelPath = archiveDir ? `runs/${runId}` : null;
      try {
        const metrics = archiveDir ? archive.metricsFromArchive(archiveDir) : {};
        const artifacts = archiveDir ? archive.indexArchive(archiveDir) : [];
        store.finishRun(runId, { status, finishedAt, errorCode, errorSummary, archiveRelPath, metrics, artifacts, langfuseTraceId });
        return;
      } catch (error) {
        log(`WARNING         : run history could not index this run (${String(error?.message ?? error).split('\n')[0]}). ` +
          `The archive is intact${archiveDir ? ` at ${archiveDir}` : ''}; rebuild the index with: npm run qa:history:import`);
      }
      safe('the run result', () => store.finishRun(runId, {
        status, finishedAt, archiveRelPath, langfuseTraceId,
        errorCode: archiveDir ? 'HISTORY_INDEX_FAILED' : errorCode,
        errorSummary: archiveDir ? 'Artifacts were archived, but their index could not be written.' : errorSummary,
      }));
    },
  };
}
