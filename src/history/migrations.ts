// Schema migrations for the run-history database, tracked by SQLite's own
// `PRAGMA user_version`. Migration N runs when user_version is N-1; each runs in
// its own transaction together with the version bump, so a failed migration
// leaves the previous version intact. Append only — never edit a shipped entry.

import type Database from 'better-sqlite3';

export const MIGRATIONS: readonly string[] = [
  // 1 — the initial schema.
  `
  CREATE TABLE runs (
    id                TEXT PRIMARY KEY,
    run_kind          TEXT NOT NULL CHECK (run_kind IN ('PHASE1_MANUAL','DEPENDENCY_REFRESH','PHASE1_REVIEW','PHASE2_AUTOMATION')),
    status            TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED')),
    model             TEXT,
    provider          TEXT,
    target            TEXT,
    git_commit        TEXT,
    git_dirty         INTEGER CHECK (git_dirty IN (0, 1)),
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    duration_ms       INTEGER,
    auth_mode         TEXT,
    archive_rel_path  TEXT,
    error_code        TEXT,
    error_summary     TEXT,
    current_stage     TEXT,
    owner_pid         INTEGER,
    holds_run_lock    INTEGER NOT NULL DEFAULT 0 CHECK (holds_run_lock IN (0, 1)),
    langfuse_trace_id TEXT,
    source            TEXT NOT NULL CHECK (source IN ('LIVE','IMPORTED')),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  -- The list is newest first and filtered by status and model.
  CREATE INDEX idx_runs_started_at ON runs(started_at DESC);
  CREATE INDEX idx_runs_status ON runs(status);
  CREATE INDEX idx_runs_model ON runs(model);

  CREATE TABLE run_stages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_name    TEXT NOT NULL,
    label         TEXT,
    ordinal       INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED')),
    started_at    TEXT,
    finished_at   TEXT,
    duration_ms   INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    error_code    TEXT,
    error_summary TEXT,
    UNIQUE (run_id, ordinal)
  );

  CREATE TABLE run_metrics (
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    numeric_value REAL,
    PRIMARY KEY (run_id, name)
  );

  CREATE TABLE run_artifacts (
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256        TEXT,
    size_bytes    INTEGER,
    PRIMARY KEY (run_id, artifact_type, relative_path)
  );
  `,

  // 2 — run control: a run may be STARTING (registered, preflight not done) or
  // CANCELLED (stopped by a person, which is not a failure); a stage may be
  // CANCELLED or SKIPPED. SQLite cannot alter a CHECK constraint, so both
  // tables are rebuilt (the documented 12-step procedure); rows are copied as they are.
  `
  CREATE TABLE runs_v2 (
    id                TEXT PRIMARY KEY,
    run_kind          TEXT NOT NULL CHECK (run_kind IN ('PHASE1_MANUAL','DEPENDENCY_REFRESH','PHASE1_REVIEW','PHASE2_AUTOMATION')),
    status            TEXT NOT NULL CHECK (status IN ('STARTING','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
    model             TEXT,
    provider          TEXT,
    target            TEXT,
    git_commit        TEXT,
    git_dirty         INTEGER CHECK (git_dirty IN (0, 1)),
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    duration_ms       INTEGER,
    auth_mode         TEXT,
    archive_rel_path  TEXT,
    error_code        TEXT,
    error_summary     TEXT,
    current_stage     TEXT,
    owner_pid         INTEGER,
    holds_run_lock    INTEGER NOT NULL DEFAULT 0 CHECK (holds_run_lock IN (0, 1)),
    langfuse_trace_id TEXT,
    source            TEXT NOT NULL CHECK (source IN ('LIVE','IMPORTED')),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  INSERT INTO runs_v2 SELECT * FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_v2 RENAME TO runs;
  CREATE INDEX idx_runs_started_at ON runs(started_at DESC);
  CREATE INDEX idx_runs_status ON runs(status);
  CREATE INDEX idx_runs_model ON runs(model);

  CREATE TABLE run_stages_v2 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_name    TEXT NOT NULL,
    label         TEXT,
    ordinal       INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','SKIPPED','INTERRUPTED')),
    started_at    TEXT,
    finished_at   TEXT,
    duration_ms   INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    error_code    TEXT,
    error_summary TEXT,
    UNIQUE (run_id, ordinal)
  );
  INSERT INTO run_stages_v2 SELECT * FROM run_stages;
  DROP TABLE run_stages;
  ALTER TABLE run_stages_v2 RENAME TO run_stages;
  `,
];

export class HistorySchemaError extends Error {
  name = 'HistorySchemaError';
}

/** Bring `db` to the latest schema. Idempotent; refuses a database newer than this code. */
export function migrate(db: Database.Database): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new HistorySchemaError(
      `The run-history database is at schema version ${current}, newer than this code supports (${MIGRATIONS.length}). ` +
        'Update the project, or move the database aside.',
    );
  }
  if (current === MIGRATIONS.length) return current;
  // Rebuilding a parent table with foreign keys ON would cascade its DELETE into
  // the children. The switch is a no-op inside a transaction, so it is made
  // around them, and the result is checked before it is switched back on.
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    for (let version = current + 1; version <= MIGRATIONS.length; version += 1) {
      db.transaction(() => {
        db.exec(MIGRATIONS[version - 1]);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) throw new HistorySchemaError(`Migration ${version} left ${broken.length} dangling reference(s).`);
        db.pragma(`user_version = ${version}`);
      })();
    }
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
  return MIGRATIONS.length;
}
