// The run-history store: the only module that speaks SQL.
//
// Orchestration, the importer and the workspace API call this interface; none
// of them build a query. Every value reaches SQLite as a bound parameter, every
// closed column is guarded by a CHECK constraint, and every free-text value is
// redacted before it is stored — the same redaction as artifacts and traces.
//
// SQLite is a catalog and index here. The archived files under `.qa/runs/<id>/`
// stay the source of truth for what a run produced; this records that the run
// happened, how it went, what it measured, and which files it left.

import type Database from 'better-sqlite3';
import { REDACTED, redactOpaqueSegment, redactText, SENSITIVE_PARAM_SOURCE } from '../lib/redaction.ts';
import { redactSecrets } from '../observability/content-policy.ts';
import {
  ACTIVE_STATUSES,
  ARTIFACT_TYPES,
  METRIC_NAME,
  RUN_ID,
  RUN_KINDS,
  RUN_STATUSES,
  type ArtifactRow,
  type FinishRun,
  type ImportedRun,
  type NewRun,
  type RunKind,
  type RunQuery,
  type RunRow,
  type RunStatus,
  type RunSummary,
  type StageRow,
  type StageStatus,
} from './types.ts';

export class DuplicateRunError extends Error {
  name = 'DuplicateRunError';
}
export class HistoryInputError extends Error {
  name = 'HistoryInputError';
}

/** Headline metrics the run list carries, so a list page needs no second request per row. */
export const LIST_METRICS = ['discovered_behaviors', 'test_cases_total', 'defects_confirmed', 'defects_potential', 'bug_reports_created'] as const;
export const MAX_PAGE = 100;

export interface RunHistoryStore {
  startRun(run: NewRun): void;
  /** STARTING -> RUNNING, once preflight is done and the first stage begins. */
  markRunning(runId: string): void;
  setCurrentStage(runId: string, stageName: string | null): void;
  setTraceId(runId: string, traceId: string): void;
  startStage(runId: string, stage: { stageName: string; label?: string; ordinal: number; startedAt: string }): number;
  setStageAttempts(stageId: number, attemptCount: number): void;
  completeStage(stageId: number, result: { finishedAt: string; attemptCount: number }): void;
  failStage(stageId: number, result: { finishedAt: string; attemptCount: number; errorCode: string; errorSummary?: string }): void;
  cancelStage(stageId: number, result: { finishedAt: string; attemptCount: number }): void;
  setMetrics(runId: string, metrics: Record<string, number>): void;
  finishRun(runId: string, result: FinishRun): void;
  setMetric(runId: string, name: string, value: number): void;
  indexArtifact(runId: string, artifact: ArtifactRow): void;
  importRun(imported: ImportedRun): boolean;
  reconcileRunning(isAlive: (run: RunRow) => boolean, now?: string): string[];

  getRun(id: string): RunRow | undefined;
  listRuns(query?: RunQuery): { runs: RunSummary[]; total: number; limit: number; offset: number };
  facets(): { models: string[]; providers: string[]; kinds: RunKind[]; targets: string[] };
  getStages(runId: string): StageRow[];
  getMetrics(runId: string): Record<string, number>;
  getArtifacts(runId: string): ArtifactRow[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Sanitising — applied to everything before it is stored
// ---------------------------------------------------------------------------

/** A name containing a sensitive word, then `=` or `:`, then a value. */
const SENSITIVE_PAIR = new RegExp(String.raw`\b([A-Za-z0-9_.-]*${SENSITIVE_PARAM_SOURCE}[A-Za-z0-9_.-]*)(\s*[=:]\s*)([^\s,;&"'<>)]+)`, 'gi');

/** One line, redacted, bounded. Never a stack: only the first line of a message is kept. */
export function sanitizeText(value: unknown, max = 500): string | null {
  if (value === undefined || value === null) return null;
  const firstLine = String(value).split('\n').find((l) => l.trim() !== '') ?? '';
  // Beyond URLs: a bare `token=…` or `password: …` in prose loses its value too.
  const pairs = redactText(firstLine).replace(SENSITIVE_PAIR, (match, name: string, _word: string, sep: string, value: string) =>
    (value === REDACTED ? match : `${name}${sep}${REDACTED}`));
  const clean = redactSecrets(pairs).trim();
  return clean === '' ? null : clean.slice(0, max);
}

/**
 * The target as it may be stored: scheme, host, port and a redacted path. No
 * credentials, no query, no fragment. Anything that is not an http(s) URL is dropped.
 */
export function safeTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.split('/').map(redactOpaqueSegment).join('/');
  return url.toString();
}

/** `openrouter/deepseek/x` -> `openrouter`. */
export function providerOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  return slash === -1 ? null : model.slice(0, slash);
}

/** `e0f13d1-dirty` -> commit `e0f13d1`, dirty. */
export function splitCommit(raw: unknown): { commit: string | null; dirty: boolean | null } {
  if (typeof raw !== 'string' || !/^[0-9a-f]{4,40}(-dirty)?$/.test(raw)) return { commit: null, dirty: null };
  return { commit: raw.replace(/-dirty$/, ''), dirty: raw.endsWith('-dirty') };
}

function assertRunId(id: string) {
  if (!RUN_ID.test(id)) throw new HistoryInputError(`Not a run id: "${String(id).slice(0, 60)}".`);
}

function assertMetric(name: string, value: number) {
  if (!METRIC_NAME.test(name)) throw new HistoryInputError(`Not a metric name: "${String(name).slice(0, 60)}".`);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HistoryInputError(`Metric ${name} is not a finite number.`);
}

function assertArtifact(a: ArtifactRow) {
  if (!ARTIFACT_TYPES.includes(a.artifactType)) throw new HistoryInputError(`Not an artifact type: "${String(a.artifactType).slice(0, 40)}".`);
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(a.relativePath) || a.relativePath.includes('..')) {
    throw new HistoryInputError(`Not an archive-relative file name: "${String(a.relativePath).slice(0, 80)}".`);
  }
}

const durationBetween = (from: string | null, to: string | null) => {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RunDbRow {
  id: string; run_kind: RunKind; status: RunStatus; model: string | null; provider: string | null; target: string | null;
  git_commit: string | null; git_dirty: number | null; started_at: string; finished_at: string | null; duration_ms: number | null;
  auth_mode: string | null; archive_rel_path: string | null; error_code: string | null; error_summary: string | null;
  current_stage: string | null; owner_pid: number | null; holds_run_lock: number; langfuse_trace_id: string | null;
  source: 'LIVE' | 'IMPORTED'; created_at: string; updated_at: string;
}

const toRun = (r: RunDbRow): RunRow & { holdsRunLock: boolean } => ({
  id: r.id, kind: r.run_kind, status: r.status, model: r.model, provider: r.provider, target: r.target,
  gitCommit: r.git_commit, gitDirty: r.git_dirty === null ? null : r.git_dirty === 1,
  startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms, authMode: r.auth_mode,
  archiveRelPath: r.archive_rel_path, errorCode: r.error_code, errorSummary: r.error_summary,
  currentStage: r.current_stage, ownerPid: r.owner_pid, holdsRunLock: r.holds_run_lock === 1,
  langfuseTraceId: r.langfuse_trace_id, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
});

interface StageDbRow {
  id: number; run_id: string; stage_name: string; label: string | null; ordinal: number; status: StageStatus;
  started_at: string | null; finished_at: string | null; duration_ms: number | null; attempt_count: number;
  error_code: string | null; error_summary: string | null;
}

const toStage = (s: StageDbRow): StageRow => ({
  id: s.id, runId: s.run_id, stageName: s.stage_name, label: s.label, ordinal: s.ordinal, status: s.status,
  startedAt: s.started_at, finishedAt: s.finished_at, durationMs: s.duration_ms, attemptCount: s.attempt_count,
  errorCode: s.error_code, errorSummary: s.error_summary,
});

// ---------------------------------------------------------------------------

export class SqliteRunHistoryStore implements RunHistoryStore {
  readonly db: Database.Database;
  private readonly now: () => string;

  constructor(db: Database.Database, options: { now?: () => string } = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private insertRun(run: NewRun & { status?: RunStatus; finishedAt?: string | null; durationMs?: number | null; archiveRelPath?: string | null; errorCode?: string | null; errorSummary?: string | null }, source: 'LIVE' | 'IMPORTED') {
    assertRunId(run.id);
    if (!RUN_KINDS.includes(run.kind)) throw new HistoryInputError(`Not a run kind: "${String(run.kind).slice(0, 40)}".`);
    const { commit, dirty } = splitCommit(run.gitCommit);
    const model = sanitizeText(run.model, 200);
    const now = this.now();
    try {
      this.db.prepare(`
        INSERT INTO runs (id, run_kind, status, model, provider, target, git_commit, git_dirty, started_at, finished_at,
          duration_ms, auth_mode, archive_rel_path, error_code, error_summary, owner_pid, holds_run_lock,
          langfuse_trace_id, source, created_at, updated_at)
        VALUES (@id, @kind, @status, @model, @provider, @target, @commit, @dirty, @startedAt, @finishedAt,
          @durationMs, @authMode, @archive, @errorCode, @errorSummary, @ownerPid, @holdsLock,
          @traceId, @source, @now, @now)`).run({
        id: run.id, kind: run.kind, status: run.status ?? 'RUNNING', model, provider: sanitizeText(providerOf(model), 40),
        target: safeTarget(run.target), commit, dirty: dirty === null ? null : dirty ? 1 : 0,
        startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, durationMs: run.durationMs ?? null,
        authMode: sanitizeText(run.authMode, 40), archive: run.archiveRelPath ?? null,
        errorCode: sanitizeText(run.errorCode, 60), errorSummary: sanitizeText(run.errorSummary),
        ownerPid: Number.isInteger(run.ownerPid) ? run.ownerPid : null, holdsLock: run.holdsRunLock ? 1 : 0,
        traceId: traceIdOrNull(run.langfuseTraceId), source, now,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new DuplicateRunError(`Run ${run.id} is already recorded.`);
      throw error;
    }
  }

  startRun(run: NewRun): void {
    if (run.status !== undefined && run.status !== 'STARTING' && run.status !== 'RUNNING') throw new HistoryInputError('A run starts as STARTING or RUNNING.');
    this.insertRun(run, 'LIVE');
  }

  markRunning(runId: string): void {
    this.db.prepare(`UPDATE runs SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'STARTING'`).run(this.now(), runId);
  }

  setCurrentStage(runId: string, stageName: string | null): void {
    this.db.prepare('UPDATE runs SET current_stage = ?, updated_at = ? WHERE id = ?').run(sanitizeText(stageName, 60), this.now(), runId);
  }

  setTraceId(runId: string, traceId: string): void {
    this.db.prepare('UPDATE runs SET langfuse_trace_id = ?, updated_at = ? WHERE id = ?').run(traceIdOrNull(traceId), this.now(), runId);
  }

  startStage(runId: string, stage: { stageName: string; label?: string; ordinal: number; startedAt: string }): number {
    return this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO run_stages (run_id, stage_name, label, ordinal, status, started_at, attempt_count)
        VALUES (?, ?, ?, ?, 'RUNNING', ?, 0)`).run(runId, sanitizeText(stage.stageName, 60), sanitizeText(stage.label, 80), stage.ordinal, stage.startedAt);
      this.setCurrentStage(runId, stage.stageName);
      return Number(info.lastInsertRowid);
    })();
  }

  setStageAttempts(stageId: number, attemptCount: number): void {
    this.db.prepare('UPDATE run_stages SET attempt_count = ? WHERE id = ?').run(attemptCount, stageId);
  }

  private endStage(stageId: number, status: StageStatus, r: { finishedAt: string; attemptCount: number; errorCode?: string; errorSummary?: string }) {
    const row = this.db.prepare('SELECT started_at FROM run_stages WHERE id = ?').get(stageId) as { started_at: string | null } | undefined;
    this.db.prepare(`
      UPDATE run_stages SET status = ?, finished_at = ?, duration_ms = ?, attempt_count = ?, error_code = ?, error_summary = ?
      WHERE id = ?`).run(status, r.finishedAt, durationBetween(row?.started_at ?? null, r.finishedAt), r.attemptCount,
      sanitizeText(r.errorCode, 60), sanitizeText(r.errorSummary), stageId);
  }

  completeStage(stageId: number, result: { finishedAt: string; attemptCount: number }): void {
    this.endStage(stageId, 'COMPLETED', result);
  }

  cancelStage(stageId: number, result: { finishedAt: string; attemptCount: number }): void {
    this.endStage(stageId, 'CANCELLED', { ...result, errorCode: 'CANCELLED', errorSummary: 'Stopped by the operator.' });
  }

  setMetrics(runId: string, metrics: Record<string, number>): void {
    for (const [name, value] of Object.entries(metrics)) assertMetric(name, value);
    this.db.transaction(() => {
      for (const [name, value] of Object.entries(metrics)) this.setMetric(runId, name, value);
    })();
  }

  failStage(stageId: number, result: { finishedAt: string; attemptCount: number; errorCode: string; errorSummary?: string }): void {
    this.endStage(stageId, 'FAILED', result);
  }

  setMetric(runId: string, name: string, value: number): void {
    assertMetric(name, value);
    this.db.prepare(`
      INSERT INTO run_metrics (run_id, name, numeric_value) VALUES (?, ?, ?)
      ON CONFLICT (run_id, name) DO UPDATE SET numeric_value = excluded.numeric_value`).run(runId, name, value);
  }

  indexArtifact(runId: string, a: ArtifactRow): void {
    assertArtifact(a);
    this.db.prepare(`
      INSERT INTO run_artifacts (run_id, artifact_type, relative_path, sha256, size_bytes) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (run_id, artifact_type, relative_path) DO UPDATE SET sha256 = excluded.sha256, size_bytes = excluded.size_bytes`)
      .run(runId, a.artifactType, a.relativePath, a.sha256, a.sizeBytes);
  }

  /**
   * Close a run: status, metrics, artifact index and any still-running stage,
   * in ONE transaction — a failure leaves the run exactly as it was, never
   * "completed" with half its metadata.
   */
  finishRun(runId: string, result: FinishRun): void {
    if (!RUN_STATUSES.includes(result.status) || (ACTIVE_STATUSES as readonly string[]).includes(result.status)) throw new HistoryInputError(`Not a final status: ${result.status}`);
    for (const [name, value] of Object.entries(result.metrics ?? {})) assertMetric(name, value);
    for (const a of result.artifacts ?? []) assertArtifact(a);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId) as { started_at: string } | undefined;
      if (!row) throw new HistoryInputError(`Run ${runId} is not recorded.`);
      this.db.prepare(`
        UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, error_code = ?, error_summary = ?,
          archive_rel_path = COALESCE(?, archive_rel_path), langfuse_trace_id = COALESCE(?, langfuse_trace_id),
          current_stage = NULL, updated_at = ?
        WHERE id = ?`).run(result.status, result.finishedAt, durationBetween(row.started_at, result.finishedAt),
        sanitizeText(result.errorCode, 60), sanitizeText(result.errorSummary), result.archiveRelPath ?? null,
        traceIdOrNull(result.langfuseTraceId), this.now(), runId);
      // A stage still RUNNING when its run ends did not finish: it failed with the run, or was cut off with it.
      const orphan: StageStatus = result.status === 'COMPLETED' ? 'COMPLETED' : result.status === 'INTERRUPTED' || result.status === 'CANCELLED' ? result.status : 'FAILED';
      this.db.prepare(`UPDATE run_stages SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status = 'RUNNING'`)
        .run(orphan, result.finishedAt, runId);
      for (const [name, value] of Object.entries(result.metrics ?? {})) this.setMetric(runId, name, value);
      for (const a of result.artifacts ?? []) this.indexArtifact(runId, a);
    })();
  }

  /** Insert a whole historical run in one transaction. Returns false when the id is already recorded. */
  importRun(imported: ImportedRun): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(imported.run.id)) return false;
      this.insertRun(imported.run, 'IMPORTED');
      imported.stages.forEach((s, i) => {
        this.db.prepare(`
          INSERT INTO run_stages (run_id, stage_name, label, ordinal, status, duration_ms, attempt_count, error_code, error_summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(imported.run.id, sanitizeText(s.stageName, 60), sanitizeText(s.label, 80), i + 1,
          s.status, s.durationMs, s.attemptCount, sanitizeText(s.errorCode, 60), sanitizeText(s.errorSummary));
      });
      for (const [name, value] of Object.entries(imported.metrics)) this.setMetric(imported.run.id, name, value);
      for (const a of imported.artifacts) this.indexArtifact(imported.run.id, a);
      return true;
    })();
  }

  /**
   * Mark every RUNNING row whose owner is gone as INTERRUPTED. `isAlive`
   * decides — the caller knows about processes and the run lock; this module
   * knows only rows. A live run is never touched.
   */
  reconcileRunning(isAlive: (run: RunRow) => boolean, now = this.now()): string[] {
    const running = (this.db.prepare(`SELECT * FROM runs WHERE status IN ('STARTING', 'RUNNING')`).all() as RunDbRow[]).map(toRun);
    const dead = running.filter((r) => !isAlive(r)).map((r) => r.id);
    this.db.transaction(() => {
      for (const id of dead) {
        this.db.prepare(`
          UPDATE runs SET status = 'INTERRUPTED', error_code = 'OWNER_PROCESS_GONE',
            error_summary = 'The process running this QA run ended without recording a result.', current_stage = NULL, updated_at = ?
          WHERE id = ? AND status IN ('STARTING', 'RUNNING')`).run(now, id);
        this.db.prepare(`UPDATE run_stages SET status = 'INTERRUPTED' WHERE run_id = ? AND status = 'RUNNING'`).run(id);
      }
    })();
    return dead;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunDbRow | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(query: RunQuery = {}): { runs: RunSummary[]; total: number; limit: number; offset: number } {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), MAX_PAGE);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    // Fixed fragments; values only ever as parameters.
    const where: string[] = [];
    const params: Record<string, unknown> = { limit, offset };
    if (query.status) { where.push('status = @status'); params.status = query.status; }
    if (query.kind) { where.push('run_kind = @kind'); params.kind = query.kind; }
    if (query.model) { where.push('model = @model'); params.model = query.model; }
    if (query.provider) { where.push('provider = @provider'); params.provider = query.provider; }
    if (query.target) { where.push('target = @target'); params.target = query.target; }
    if (query.startedFrom) { where.push('started_at >= @startedFrom'); params.startedFrom = query.startedFrom; }
    if (query.startedTo) { where.push('started_at <= @startedTo'); params.startedTo = query.startedTo; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`).get(params) as { n: number }).n;
    const rows = (this.db.prepare(`SELECT * FROM runs ${clause} ORDER BY started_at DESC, id DESC LIMIT @limit OFFSET @offset`).all(params) as RunDbRow[]).map(toRun);
    const ids = JSON.stringify(rows.map((r) => r.id));
    const metrics = this.db.prepare(`
      SELECT run_id, name, numeric_value FROM run_metrics
      WHERE run_id IN (SELECT value FROM json_each(?)) AND name IN (SELECT value FROM json_each(?))`)
      .all(ids, JSON.stringify(LIST_METRICS)) as { run_id: string; name: string; numeric_value: number }[];
    const failed = this.db.prepare(`
      SELECT run_id, COALESCE(label, stage_name) AS stage FROM run_stages
      WHERE run_id IN (SELECT value FROM json_each(?)) AND status IN ('FAILED', 'INTERRUPTED') ORDER BY ordinal`)
      .all(ids) as { run_id: string; stage: string }[];
    const runs = rows.map((r) => ({
      ...r,
      metrics: Object.fromEntries(metrics.filter((m) => m.run_id === r.id).map((m) => [m.name, m.numeric_value])),
      failedStage: failed.find((f) => f.run_id === r.id)?.stage ?? null,
    }));
    return { runs, total, limit, offset };
  }

  facets() {
    const col = (sql: string) => (this.db.prepare(sql).all() as { v: string }[]).map((r) => r.v);
    return {
      models: col('SELECT DISTINCT model AS v FROM runs WHERE model IS NOT NULL ORDER BY v'),
      providers: col('SELECT DISTINCT provider AS v FROM runs WHERE provider IS NOT NULL ORDER BY v'),
      kinds: col('SELECT DISTINCT run_kind AS v FROM runs ORDER BY v') as RunKind[],
      targets: col('SELECT DISTINCT target AS v FROM runs WHERE target IS NOT NULL ORDER BY v'),
    };
  }

  getStages(runId: string): StageRow[] {
    return (this.db.prepare('SELECT * FROM run_stages WHERE run_id = ? ORDER BY ordinal').all(runId) as StageDbRow[]).map(toStage);
  }

  getMetrics(runId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT name, numeric_value FROM run_metrics WHERE run_id = ? ORDER BY name').all(runId) as { name: string; numeric_value: number }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.numeric_value]));
  }

  getArtifacts(runId: string): ArtifactRow[] {
    return (this.db.prepare('SELECT artifact_type, relative_path, sha256, size_bytes FROM run_artifacts WHERE run_id = ? ORDER BY artifact_type, relative_path').all(runId) as
      { artifact_type: ArtifactRow['artifactType']; relative_path: string; sha256: string | null; size_bytes: number | null }[])
      .map((a) => ({ artifactType: a.artifact_type, relativePath: a.relative_path, sha256: a.sha256, sizeBytes: a.size_bytes }));
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

function traceIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null;
}
