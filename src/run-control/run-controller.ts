// The RunController: how the workspace starts and stops a Phase 1 run.
//
// It does not run Phase 1 itself. It forks the SAME runner the terminal uses —
// `scripts/qa-manual.mjs` — as its own process, with argv and environment it
// builds from a validated configuration: fixed keys, host-configured values.
// The browser's request never becomes a command line, a path or an env var.
//
//   CLI  ── npm run qa:manual ─────────────┐
//                                           ├── scripts/qa-manual.mjs (Phase 1 runner)
//   UI   ── POST /api/runs → RunController ─┘      ├── events  → runs/<id>/events.jsonl → SSE
//                                                   ├── history → history.sqlite
//                                                   ├── archive → runs/<id>/
//                                                   └── traces  → Langfuse
//
// A separate process is the right boundary: the runner holds the run lock with
// signal handlers that exit the process, owns a browser server and agent
// processes, and sets process-wide state. None of that belongs in the server.
//
// Cancellation: an IPC message first (the runner stops its agent and ends as
// CANCELLED, archiving what it has); then TERM to its process group; then KILL.
// Whatever it could not clean up — its browser server, its lock, a history row
// left open — the controller cleans up, because it knows which run it started
// and which resources that run reported owning. Nothing is ever killed by a
// pid the browser sent.

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHistoryStore } from '../history/run-history-store.ts';
import { RUN_ID } from '../history/types.ts';
import { EventLogWriter, isFinal, readEventLog } from './events.ts';
import { readRunConfig, validateStartRequest, type RunConfigView, type StartRequest, type ValidatedRun } from './run-config.ts';
import { displayApiDocsUrl, type CoverageMode } from '../lib/coverage-mode.ts';

export class RunConflictError extends Error {
  name = 'RunConflictError';
  holder?: LockHolder;
  constructor(message: string, holder?: LockHolder) {
    super(message);
    this.holder = holder;
  }
}

export interface LockHolder { runId?: string; pid: number; model?: string; command?: string; startedAt?: string }

export interface ControllerRun {
  runId: string;
  status: 'STARTING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt: string;
  model: string;
  target: string;
  coverageMode: CoverageMode;
  /** As it may be shown: without its query. */
  apiDocsUrl?: string;
  cancelRequested: boolean;
  exitCode?: number | null;
  error?: string;
}

export interface RunControllerOptions {
  artifactRoot: string;
  projectRoot: string;
  history: () => RunHistoryStore;
  /** The runner to fork. Production: scripts/qa-manual.mjs. Tests substitute a deterministic runner with the same contract. */
  runnerScript?: string;
  config?: () => RunConfigView;
  /** Milliseconds to wait after asking the runner to cancel, then after TERM. */
  graceMs?: { cancel: number; term: number };
  log?: (line: string) => void;
  now?: () => Date;
  /** The environment the runner starts from (then TARGET_URL, QA_MODEL, QA_FRESH_BROWSER, QA_COVERAGE_MODE, QA_API_DOCS_URL and the three QA_API_* run choices are set). Default: this process's. */
  env?: NodeJS.ProcessEnv;
}

export const PHASE1_RUNNER = 'scripts/qa-manual.mjs';

/** The runner's argv for a validated configuration — fixed flags only. */
export function runnerArgs(runId: string, run: ValidatedRun): string[] {
  if (!RUN_ID.test(runId)) throw new Error('Invalid run id.');
  return ['--run-id', runId, ...(run.freshBrowser ? ['--fresh-browser'] : [])];
}

/** The runner's environment: the server's own, with exactly these keys set from host values. */
export function runnerEnv(run: ValidatedRun, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    TARGET_URL: run.target,
    QA_MODEL: run.model,
    QA_FRESH_BROWSER: run.freshBrowser ? 'true' : 'false',
    QA_COVERAGE_MODE: run.coverageMode,
    // Always set, so a URL in the server's own environment never leaks into a run that chose none.
    QA_API_DOCS_URL: run.apiDocsUrl ?? '',
    // Likewise always set: what this run may call, and what a person approved for it — nothing inherited.
    QA_API_LIVE_VALIDATION: run.liveValidation ? 'true' : 'false',
    QA_API_BASE_URL: run.apiBaseUrl ?? '',
    QA_API_APPROVED_OPERATIONS: (run.approvedOperations ?? []).join(','),
  };
}

function alive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export class RunController {
  private readonly o: Required<Omit<RunControllerOptions, 'config' | 'runnerScript' | 'graceMs' | 'log' | 'now'>> & RunControllerOptions;
  private active?: { run: ControllerRun; child: ChildProcess; mcpPid?: number; timers: NodeJS.Timeout[] };
  /** Recent runs this controller started — including ones that died before the history saw them. */
  private readonly recent = new Map<string, ControllerRun>();
  private readonly exits = new Map<string, Promise<void>>();

  constructor(options: RunControllerOptions) {
    this.o = options as typeof this.o;
  }

  private get log() {
    return this.o.log ?? ((line: string) => console.log(line));
  }

  config(): RunConfigView {
    return (this.o.config ?? readRunConfig)();
  }

  /** Who holds the run lock right now, if a live process does. */
  lockHolder(): LockHolder | undefined {
    try {
      const lock = JSON.parse(readFileSync(join(this.o.artifactRoot, 'run.lock'), 'utf8')) as LockHolder;
      return alive(lock.pid) ? lock : undefined;
    } catch {
      return undefined;
    }
  }

  activeRun(): ControllerRun | undefined {
    return this.active?.run;
  }

  getRun(runId: string): ControllerRun | undefined {
    return this.recent.get(runId);
  }

  /** Resolves when the given run's process has exited and been cleaned up after. Tests only. */
  waitForExit(runId: string): Promise<void> {
    return this.exits.get(runId) ?? Promise.resolve();
  }

  /** Validate, check the lock, and fork the runner. Returns once the process exists. */
  start(request: StartRequest): ControllerRun {
    const validated = validateStartRequest(request, this.config());
    if (this.active) throw new RunConflictError('A QA run started from this workspace is still active.', { runId: this.active.run.runId, pid: this.active.child.pid ?? 0, model: this.active.run.model, startedAt: this.active.run.startedAt });
    const holder = this.lockHolder();
    if (holder) throw new RunConflictError('Another QA run is already active.', holder);

    let now = (this.o.now ?? (() => new Date()))();
    let runId = now.toISOString().replace(/[:.]/g, '-');
    // Never reuse an id: not one in the history, not one with an archive.
    while (this.o.history().getRun(runId) || existsSync(join(this.o.artifactRoot, 'runs', runId)) || this.recent.has(runId)) {
      now = new Date(now.getTime() + 1);
      runId = now.toISOString().replace(/[:.]/g, '-');
    }

    const script = join(this.o.projectRoot, this.o.runnerScript ?? PHASE1_RUNNER);
    const child = fork(script, runnerArgs(runId, validated), {
      cwd: this.o.projectRoot,
      env: runnerEnv(validated, this.o.env ?? process.env),
      // Its own process group, so TERM/KILL reach it and the agents it spawned — and nothing else.
      detached: true,
      // Output goes straight to this terminal, not through this process: restarting the
      // workspace must never break a run's stdout (a write to a closed pipe would crash it).
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const shownDocs = displayApiDocsUrl(validated.apiDocsUrl);
    const run: ControllerRun = {
      runId, status: 'STARTING', startedAt: now.toISOString(), model: validated.model, target: validated.target,
      coverageMode: validated.coverageMode, ...(shownDocs ? { apiDocsUrl: shownDocs } : {}), cancelRequested: false,
    };
    this.recent.set(runId, run);
    while (this.recent.size > 20) this.recent.delete(this.recent.keys().next().value!);
    this.active = { run, child, timers: [] };
    const tag = `[run ${runId}]`;
    child.on('message', (m: unknown) => {
      const msg = m as { type?: string; mcpPid?: unknown };
      if (msg?.type === 'owned' && Number.isInteger(msg.mcpPid) && this.active?.run.runId === runId) this.active.mcpPid = msg.mcpPid as number;
    });
    this.exits.set(runId, new Promise((done) => {
      child.on('exit', (code, signal) => {
        try {
          this.afterExit(runId, code, signal);
        } catch (error) {
          this.log(`${tag} cleanup after exit failed: ${(error as Error).message}`);
        }
        done();
      });
    }));
    child.on('error', (error) => {
      run.status = 'FAILED';
      run.error = `The runner could not be started: ${error.message.split('\n')[0]}`;
    });
    this.log(`${tag} started from the workspace: ${validated.model} → ${validated.target} (coverage: ${validated.coverageMode})`);
    return run;
  }

  /**
   * Cancel the run this controller started. Only that one: a run started from
   * the terminal is stopped there. Returns whether cancellation was begun.
   */
  cancel(runId: string): boolean {
    const a = this.active;
    if (!a || a.run.runId !== runId) {
      const holder = this.lockHolder();
      if (holder?.runId === runId) throw new RunConflictError('This run was not started from this workspace; stop it where it was started (Ctrl-C).', holder);
      return false;
    }
    if (a.run.cancelRequested) return true;
    a.run.cancelRequested = true;
    const grace = this.o.graceMs ?? { cancel: 30_000, term: 10_000 };
    try {
      a.child.send({ type: 'cancel' });
    } catch { /* the channel is gone: escalate on the timer */ }
    a.timers.push(setTimeout(() => {
      if (a.child.exitCode !== null || a.child.signalCode !== null) return;
      this.log(`[run ${runId}] did not stop after the cancel request; sending TERM to its process group`);
      killGroup(a.child.pid, 'SIGTERM');
      a.timers.push(setTimeout(() => {
        if (a.child.exitCode !== null || a.child.signalCode !== null) return;
        this.log(`[run ${runId}] still running; sending KILL`);
        killGroup(a.child.pid, 'SIGKILL');
      }, grace.term));
    }, grace.cancel));
    return true;
  }

  /** Settle everything the run could not: history, event log, browser server, lock. */
  private afterExit(runId: string, code: number | null, signal: NodeJS.Signals | null) {
    const a = this.active;
    if (!a || a.run.runId !== runId) return;
    for (const t of a.timers) clearTimeout(t);
    this.active = undefined;
    const { run, child, mcpPid } = a;
    run.exitCode = code;

    // The browser server the run started, if the run did not stop it (killed outright).
    if (mcpPid && alive(mcpPid)) {
      this.log(`[run ${runId}] stopping the browser server it left running`);
      killGroup(mcpPid, 'SIGTERM');
      setTimeout(() => { if (alive(mcpPid)) killGroup(mcpPid, 'SIGKILL'); }, 5000).unref();
    }
    // Its lock, only if it is still this process's.
    try {
      const lockPath = join(this.o.artifactRoot, 'run.lock');
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LockHolder;
      if (lock.pid === child.pid) rmSync(lockPath, { force: true });
    } catch { /* no lock left behind */ }

    // The history row, if the run could not close it.
    let status: ControllerRun['status'] = run.cancelRequested ? 'CANCELLED' : code === 0 ? 'COMPLETED' : 'FAILED';
    try {
      const store = this.o.history();
      const row = store.getRun(runId);
      if (row) {
        const open = row.status === 'STARTING' || row.status === 'RUNNING';
        const cutOff = run.cancelRequested && (row.status === 'INTERRUPTED' || (row.status === 'FAILED' && row.errorCode === 'PROCESS_EXIT'));
        if (open || cutOff) {
          store.finishRun(runId, {
            status: run.cancelRequested ? 'CANCELLED' : 'FAILED',
            finishedAt: new Date().toISOString(),
            errorCode: run.cancelRequested ? 'CANCELLED' : 'PROCESS_EXIT',
            errorSummary: run.cancelRequested
              ? 'Stopped by the operator; the run had to be terminated.'
              : `The run process ended (${signal ?? `exit ${code}`}) before recording a result.`,
          });
        }
        status = (store.getRun(runId)?.status as ControllerRun['status']) ?? status;
      } else if (!run.error) {
        run.error = code === 2
          ? 'The run did not start: its configuration was refused or another run holds the lock.'
          : `The run process ended (${signal ?? `exit ${code}`}) before it was recorded.`;
      }
    } catch (error) {
      this.log(`[run ${runId}] run history could not be settled: ${(error as Error).message.split('\n')[0]}`);
    }
    run.status = status;

    // The event log's last word, if the run could not write it.
    const log = join(this.o.artifactRoot, 'runs', runId, 'events.jsonl');
    const last = readEventLog(log, { tail: 1 }).at(-1);
    // Only a log the run began: a run that died before registering has no archive to start.
    if (existsSync(log) && (!last || !isFinal(last))) {
      const writer = new EventLogWriter(log, runId);
      writer.emit(status === 'CANCELLED'
        ? { type: 'RUN_CANCELLED', status, level: 'warn', message: 'Stopped by the operator.' }
        : status === 'COMPLETED'
          ? { type: 'RUN_COMPLETED', status, message: 'Run completed.' }
          : { type: 'RUN_FAILED', status: 'FAILED', message: run.error ?? `The run process ended (${signal ?? `exit ${code}`}) before recording a result.` });
    }
    this.log(`[run ${runId}] ended: ${status}`);
  }
}
