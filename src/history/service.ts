// Run history for this host process: one connection, opened on first use and
// closed when the process exits, plus the two host-side decisions that need
// more than rows — whether a RUNNING row's owner is still alive, and how a
// historical artifact is found on disk.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QA_ARTIFACT_ROOT } from '../lib/qa-artifacts.ts';
import { resolveInsideRoot } from '../lib/trusted-roots.ts';
import { historyDbPath, openHistoryDatabase } from './database.ts';
import { archiveRoot } from './importer.ts';
import { SqliteRunHistoryStore, type RunHistoryStore } from './run-history-store.ts';
import { ARTIFACT_FILES, BUG_ID, RUN_ID, type ArtifactType, type RunRow, type SingleArtifactType } from './types.ts';

let instance: SqliteRunHistoryStore | undefined;

/** The history store for QA_ARTIFACT_ROOT. Throws — visibly — when the database cannot be opened or migrated. */
export function runHistory(): SqliteRunHistoryStore {
  if (!instance) {
    instance = new SqliteRunHistoryStore(openHistoryDatabase(historyDbPath(QA_ARTIFACT_ROOT)));
    process.once('exit', () => instance?.close());
  }
  return instance;
}

export function closeRunHistory(): void {
  instance?.close();
  instance = undefined;
}

function pidAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(artifactRoot: string): { pid?: number; runId?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(artifactRoot, 'run.lock'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A RUNNING row is live only while its owner process exists — and, for a run
 * that took the run lock, only while the lock still names that run and that
 * process. A reused pid therefore never keeps a dead run "running".
 */
export function ownerAlive(run: RunRow, artifactRoot = QA_ARTIFACT_ROOT): boolean {
  if (!pidAlive(run.ownerPid)) return false;
  if (!run.holdsRunLock) return true;
  const lock = readLock(artifactRoot);
  return lock?.runId === run.id && lock?.pid === run.ownerPid;
}

/** Mark RUNNING rows whose owner is gone as INTERRUPTED. */
export function reconcileInterrupted(store: RunHistoryStore = runHistory(), artifactRoot = QA_ARTIFACT_ROOT): string[] {
  return store.reconcileRunning((run) => ownerAlive(run, artifactRoot));
}

export class HistoricalArtifactError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Read an archived artifact of a recorded run, by domain identifiers only.
 *
 *   run id -> DB lookup -> known archive root -> host-built file name
 *          -> must be in this run's artifact index -> resolveInsideRoot (realpath) -> read
 *
 * The stored `relative_path` is checked against, never used to build the path.
 */
export function readHistoricalArtifact(
  store: RunHistoryStore,
  runId: string,
  type: ArtifactType,
  bugId?: string,
  artifactRoot = QA_ARTIFACT_ROOT,
): unknown {
  if (!RUN_ID.test(runId)) throw new HistoricalArtifactError(400, 'Invalid run id.');
  const run = store.getRun(runId);
  if (!run) throw new HistoricalArtifactError(404, 'No such run.');
  if (!run.archiveRelPath) throw new HistoricalArtifactError(404, 'This run has no archive.');
  let file: string;
  if (type === 'BUG_REPORT') {
    if (!bugId || !BUG_ID.test(bugId)) throw new HistoricalArtifactError(400, 'Invalid bug id.');
    file = `bugs/${bugId}.json`;
  } else if (Object.hasOwn(ARTIFACT_FILES, type)) {
    file = ARTIFACT_FILES[type as SingleArtifactType];
  } else {
    throw new HistoricalArtifactError(400, 'Unknown artifact type.');
  }
  if (!store.getArtifacts(runId).some((a) => a.artifactType === type && a.relativePath === file)) {
    throw new HistoricalArtifactError(404, 'This run did not archive that artifact.');
  }
  const runDir = resolveInsideRoot(archiveRoot(artifactRoot), runId);
  const path = resolveInsideRoot(runDir, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new HistoricalArtifactError(404, 'The archived file is missing or unreadable.');
  }
}
