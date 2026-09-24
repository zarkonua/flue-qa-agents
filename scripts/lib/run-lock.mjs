// One QA run at a time, enforced by the host.
//
// Two runs started together do not merely race on output — they corrupt each
// other. Measured: a second `qa:manual` killed the first with
// `SQLITE_BUSY: database is locked` on Flue's shared conversation store, while
// both wrote the same `.qa/*.json` and drove the same browser. The artifacts
// that survived belonged to neither run.
//
// Three things are shared and none of them are per-run:
//
//   - `node_modules/.cache/flue/run.db`  — Flue's conversation store
//   - `QA_ARTIFACT_ROOT`                 — the hand-off artifacts
//   - the Playwright MCP browser         — one browser, one session
//
// So the lock is on the run, not on any one of them. It is a file holding the
// owner's pid; a lock whose process is gone is stale and reclaimed, because the
// alternative is a crashed run blocking every later one until someone deletes a
// file they have never heard of.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LOCK_FILE = 'run.lock';

/** Is a process alive? Signal 0 tests for existence without touching it. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return error.code === 'EPERM';
  }
}

export function lockPath(artifactRoot) {
  return join(artifactRoot, LOCK_FILE);
}

/** The lock's contents, or undefined when there is none or it is unreadable. */
export function readLock(artifactRoot) {
  try {
    const raw = JSON.parse(readFileSync(lockPath(artifactRoot), 'utf8'));
    return typeof raw?.pid === 'number' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock, or explain who holds it.
 *
 * Returns `{ ok: true, release }` or `{ ok: false, message }`. The caller is
 * expected to print the message and exit rather than proceed — a run that
 * ignores this produces results that cannot be attributed to either model.
 */
export function acquireRunLock(artifactRoot, { runId, model, command }) {
  const path = lockPath(artifactRoot);
  const existing = readLock(artifactRoot);

  if (existing && alive(existing.pid) && existing.pid !== process.pid) {
    return {
      ok: false,
      message:
        `Another QA run is already in progress (pid ${existing.pid}` +
        `${existing.command ? `, ${existing.command}` : ''}${existing.model ? `, model ${existing.model}` : ''}` +
        `${existing.startedAt ? `, started ${existing.startedAt}` : ''}).\n\n` +
        'Runs share Flue\'s conversation store, the .qa artifact root and one browser, so two at once\n' +
        'corrupt each other rather than queue. Wait for it to finish, or stop it and try again.\n' +
        `Lock: ${path}`,
    };
  }

  if (existing) {
    console.log(`Stale lock      : pid ${existing.pid} is gone; reclaiming ${path}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: process.pid, runId, model, command, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only ever remove our own lock: a run that overran and was replaced must
    // not delete the lock of the run that replaced it.
    const current = readLock(artifactRoot);
    if (current?.pid === process.pid) rmSync(path, { force: true });
  };

  // Release on every ordinary way a run ends, including Ctrl-C.
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      release();
      process.exit(130);
    });
  }

  return { ok: true, release };
}
