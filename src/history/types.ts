// Run history: the vocabulary. Every value stored in a closed column comes from
// one of these lists — host code chooses them; no request can invent one.

export const RUN_KINDS = ['PHASE1_MANUAL', 'DEPENDENCY_REFRESH', 'PHASE1_REVIEW', 'PHASE2_AUTOMATION'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ['STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'] as const;
/** A run in one of these is still going (or its owner died and reconciliation has not seen it yet). */
export const ACTIVE_STATUSES = ['STARTING', 'RUNNING'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STAGE_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED', 'INTERRUPTED'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Where a row came from: recorded while the run happened, or backfilled from its archive. */
export type RunSource = 'LIVE' | 'IMPORTED';

/**
 * The files an archive may hold, by type. A closed map: the host resolves a
 * historical artifact from (run id, type[, bug id]) through this table, never
 * from a path stored in the database or sent by a browser.
 */
export const ARTIFACT_FILES = {
  DISCOVERED_BEHAVIOR: 'discovered-behavior.json',
  REQUIREMENTS_ANALYSIS: 'requirements-analysis.json',
  TEST_CASES: 'test-cases.json',
  AUTOMATION_PRIORITIZATION: 'automation-prioritization.json',
  DEFECT_ANALYSIS: 'defect-analysis.json',
  TEST_CASE_REVIEW: 'test-cases-review.json',
  PHASE1_APPROVAL: 'phase1-approval.json',
  DISCOVERY_SURFACE: 'discovery-surface.json',
  DISCOVERY_OBSERVATIONS: 'discovery-observations.json',
  DISCOVERY_EVIDENCE: 'discovery-evidence.json',
  REPO_ANALYSIS: 'repo-analysis.json',
  AUTOMATION_PROJECT_CONTRACT: 'automation-project-contract.json',
  RUN_RECORD: 'phase1-run.json',
  PHASE2_RUN_RECORD: 'phase2-run.json',
  REFRESH_RECORD: 'phase1-refresh.json',
  RUN_METADATA: 'run-metadata.json',
  /** The run's structured event log (redacted), one JSON object per line. */
  EVENT_LOG: 'events.jsonl',
} as const;
export type SingleArtifactType = keyof typeof ARTIFACT_FILES;
export type ArtifactType = SingleArtifactType | 'BUG_REPORT';
export const ARTIFACT_TYPES = [...Object.keys(ARTIFACT_FILES), 'BUG_REPORT'] as ArtifactType[];

/** Run ids are the run's start stamp — `2026-09-27T18-07-17-457Z` — as used by the archive and the run lock. */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export const BUG_ID = /^BUG-\d{3,}$/;
/** Metric names are host-chosen snake_case identifiers. */
export const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface RunRow {
  id: string;
  kind: RunKind;
  status: RunStatus;
  model: string | null;
  provider: string | null;
  target: string | null;
  gitCommit: string | null;
  gitDirty: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  authMode: string | null;
  archiveRelPath: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  currentStage: string | null;
  ownerPid: number | null;
  holdsRunLock: boolean;
  langfuseTraceId: string | null;
  source: RunSource;
  createdAt: string;
  updatedAt: string;
}

export interface StageRow {
  id: number;
  runId: string;
  stageName: string;
  label: string | null;
  ordinal: number;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  attemptCount: number;
  errorCode: string | null;
  errorSummary: string | null;
}

export interface ArtifactRow {
  artifactType: ArtifactType;
  relativePath: string;
  sha256: string | null;
  sizeBytes: number | null;
}

/** A run as the list shows it: the row plus the few headline metrics and where it stopped. */
export interface RunSummary extends RunRow {
  metrics: Record<string, number>;
  failedStage: string | null;
}

export interface RunQuery {
  limit?: number;
  offset?: number;
  status?: RunStatus;
  kind?: RunKind;
  model?: string;
  provider?: string;
  target?: string;
  /** ISO timestamps, inclusive. */
  startedFrom?: string;
  startedTo?: string;
}

export interface NewRun {
  id: string;
  kind: RunKind;
  /** STARTING while preflight runs; RUNNING once stages begin. Default RUNNING. */
  status?: 'STARTING' | 'RUNNING';
  model?: string | null;
  target?: string | null;
  gitCommit?: string | null;
  startedAt: string;
  ownerPid?: number | null;
  /** Whether the owner holds the run lock under this id — used to tell a live run from a dead one. */
  holdsRunLock?: boolean;
  authMode?: string | null;
  langfuseTraceId?: string | null;
}

export interface FinishRun {
  status: Exclude<RunStatus, 'STARTING' | 'RUNNING'>;
  finishedAt: string;
  errorCode?: string | null;
  errorSummary?: string | null;
  archiveRelPath?: string | null;
  metrics?: Record<string, number>;
  artifacts?: ArtifactRow[];
  langfuseTraceId?: string | null;
}

/** A complete historical run, as the importer builds it from an archive. */
export interface ImportedRun {
  run: Omit<NewRun, 'status'> & { status: Exclude<RunStatus, 'STARTING' | 'RUNNING'>; finishedAt: string | null; durationMs: number | null; archiveRelPath: string; errorCode?: string | null; errorSummary?: string | null };
  stages: { stageName: string; label?: string | null; status: StageStatus; durationMs: number | null; attemptCount: number; errorCode?: string | null; errorSummary?: string | null }[];
  metrics: Record<string, number>;
  artifacts: ArtifactRow[];
}
