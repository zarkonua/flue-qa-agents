// The run-history database: one file under the trusted artifact root, opened
// once per host process.
//
// The path is never configurable from a request, and not from the environment
// either: it is `<QA_ARTIFACT_ROOT>/history.sqlite`, where QA_ARTIFACT_ROOT has
// already been validated as absolute and outside the control plane.
//
// Settings:
//   journal_mode = WAL     readers (the workspace) never block the writer (a run)
//   foreign_keys = ON      stages, metrics and artifacts die with their run
//   busy_timeout = 5000    a second process waits for a lock instead of failing
//   synchronous  = NORMAL  with WAL: never corrupts, and survives a crashed
//                          process; a power loss can drop the last commit. The
//                          archive on disk is the source of truth and can be
//                          re-imported, so FULL's extra fsync buys nothing here.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrate } from './migrations.ts';

export const HISTORY_DB_FILE = 'history.sqlite';

export function historyDbPath(artifactRoot: string): string {
  return join(artifactRoot, HISTORY_DB_FILE);
}

export function openHistoryDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
