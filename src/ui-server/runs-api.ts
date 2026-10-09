// The workspace's read-only view of QA run history.
//
//   GET /api/runs                              ?limit&offset&status&kind&model&provider&target&from&to
//   GET /api/runs/:runId                       run, stages, metrics, which artifacts exist
//   GET /api/runs/:runId/test-cases            the archived suite (+ its prioritization)
//   GET /api/runs/:runId/bugs                  the archived bug reports
//   GET /api/runs/:runId/bugs/:bugId           one archived bug report
//   GET /api/runs/:runId/artifacts/:type       one archived artifact, by type
//
// Everything here is GET: a historical snapshot cannot be edited, applied,
// approved or decided on. Requests name runs, artifact types and bug ids —
// never a path, a file name, a table or SQL. Every query value is checked
// against a closed list or bounded as plain data before it reaches the store.

import { statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { RunHistoryStore } from '../history/run-history-store.ts';
import { HistoricalArtifactError, ownerAlive, readHistoricalArtifact } from '../history/service.ts';
import { ARTIFACT_FILES, BUG_ID, RUN_ID, RUN_KINDS, RUN_STATUSES, type RunKind, type RunQuery, type RunRow, type RunStatus, type SingleArtifactType } from '../history/types.ts';
import { listBugReportIds, qaArtifactPath, readBugReport, readQaArtifact, type QaArtifactName } from '../lib/qa-artifacts.ts';
import { STAGES } from '../../scripts/lib/phase1-stages.mjs';
import type { ControllerRun } from '../run-control/run-controller.ts';
import { testLevelOf } from '../lib/coverage-mode.ts';

/** What the run controller knows that the history may not yet: runs it started. */
export interface RunControlView {
  getRun(runId: string): ControllerRun | undefined;
  isCancellable(runId: string): boolean;
  langfuseBaseUrl(): string | undefined;
}

/** Artifacts a run still in progress has already written, read from the live workspace — read-only. */
const LIVE_ARTIFACTS: Partial<Record<SingleArtifactType, QaArtifactName>> = {
  DISCOVERED_BEHAVIOR: 'discovered-behavior', REQUIREMENTS_ANALYSIS: 'requirements-analysis', TEST_CASES: 'test-cases',
  AUTOMATION_PRIORITIZATION: 'automation-prioritization', DEFECT_ANALYSIS: 'defect-analysis', DISCOVERY_EVIDENCE: 'discovery-evidence',
  API_DISCOVERY: 'api-discovery',
};

export class RunsApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = [string, RegExp, (m: RegExpExecArray, req: IncomingMessage) => Promise<[number, unknown]>];

/** The store, opened lazily: a database that cannot be opened is a visible 503, not a crashed server. */
export type HistoryProvider = () => RunHistoryStore;

/** Artifacts the viewer may open by type. Bug reports have their own routes; run bookkeeping is shown as data. */
const VIEWABLE = new Set<SingleArtifactType>([
  'DISCOVERED_BEHAVIOR', 'REQUIREMENTS_ANALYSIS', 'TEST_CASES', 'AUTOMATION_PRIORITIZATION', 'DEFECT_ANALYSIS',
  'TEST_CASE_REVIEW', 'REPO_ANALYSIS', 'AUTOMATION_PROJECT_CONTRACT', 'DISCOVERY_EVIDENCE', 'RUN_RECORD', 'API_DISCOVERY',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/;
const QUERY_KEYS = new Set(['limit', 'offset', 'status', 'kind', 'model', 'provider', 'target', 'from', 'to']);

function plain(value: string, name: string, max = 300): string {
  if (value.length > max || /[\u0000-\u001f]/.test(value)) throw new RunsApiError(400, `Invalid ${name}.`);
  return value;
}

/** Parse `/api/runs` query parameters — unknown keys and malformed values are refused. */
export function parseRunQuery(search: URLSearchParams): RunQuery {
  const q: RunQuery = {};
  for (const key of search.keys()) if (!QUERY_KEYS.has(key)) throw new RunsApiError(400, `Unknown query parameter "${key.slice(0, 30)}".`);
  const one = (key: string) => {
    const all = search.getAll(key);
    if (all.length > 1) throw new RunsApiError(400, `Repeated query parameter "${key}".`);
    return all[0] === '' ? undefined : all[0];
  };
  const int = (key: string) => {
    const v = one(key);
    if (v === undefined) return undefined;
    if (!/^\d{1,6}$/.test(v)) throw new RunsApiError(400, `Invalid ${key}.`);
    return Number(v);
  };
  q.limit = int('limit');
  q.offset = int('offset');
  const status = one('status');
  if (status !== undefined) {
    if (!RUN_STATUSES.includes(status as RunStatus)) throw new RunsApiError(400, 'Invalid status.');
    q.status = status as RunStatus;
  }
  const kind = one('kind');
  if (kind !== undefined) {
    if (!RUN_KINDS.includes(kind as RunKind)) throw new RunsApiError(400, 'Invalid run kind.');
    q.kind = kind as RunKind;
  }
  for (const key of ['model', 'provider', 'target'] as const) {
    const v = one(key);
    if (v !== undefined) q[key] = plain(v, key);
  }
  const from = one('from');
  const to = one('to');
  for (const [v, name] of [[from, 'from'], [to, 'to']] as const) {
    if (v !== undefined && (!ISO_DATE.test(v) || !Number.isFinite(Date.parse(v)))) throw new RunsApiError(400, `Invalid ${name} date.`);
  }
  if (from) q.startedFrom = new Date(from).toISOString();
  // A bare date means the whole day.
  if (to) q.startedTo = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : new Date(to).toISOString();
  return q;
}

function runId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!RUN_ID.test(id)) throw new RunsApiError(400, 'Invalid run id.');
  return id;
}

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === 'object') as Json[] : []);

/** Was this workspace file written by this run — not left over from the previous one? */
function writtenBy(run: RunRow, name: QaArtifactName): boolean {
  try {
    return statSync(qaArtifactPath(name)).mtimeMs >= Date.parse(run.startedAt);
  } catch {
    return false;
  }
}

/** Is this run still being produced? Only while it is open AND its owner holds the lock under its id. */
const isLive = (run: RunRow | undefined, artifactRoot?: string) => !!run && (run.status === 'STARTING' || run.status === 'RUNNING') && ownerAlive(run, artifactRoot);

/** The stages a Phase 1 run executes: from the first one it recorded, to the end. */
function plannedStages(run: RunRow, recorded: string[]) {
  if (run.kind !== 'PHASE1_MANUAL') return [];
  const first = STAGES.findIndex((s) => s.key === recorded[0]);
  return STAGES.slice(Math.max(0, first)).map((s) => ({ key: s.key, label: s.label }));
}

export function runRoutes(history: HistoryProvider, artifactRoot?: string, control?: RunControlView): Handler[] {
  const store = () => {
    try {
      return history();
    } catch (error) {
      throw new RunsApiError(503, `Run history is unavailable: ${String((error as Error).message).split('\n')[0]}`);
    }
  };
  /** Which artifacts a run has — archived, or (while it runs) already written to the workspace. */
  const available = (s: RunHistoryStore, id: string): { live: boolean; types: Set<string>; bugIds: string[] } => {
    const run = s.getRun(id);
    if (isLive(run, artifactRoot)) {
      const types = new Set(Object.entries(LIVE_ARTIFACTS).filter(([, name]) => writtenBy(run!, name!)).map(([t]) => t));
      return { live: true, types, bugIds: types.has('DEFECT_ANALYSIS') ? listBugReportIds() : [] };
    }
    const index = s.getArtifacts(id);
    return {
      live: false,
      types: new Set(index.filter((a) => a.artifactType !== 'BUG_REPORT').map((a) => a.artifactType)),
      bugIds: index.filter((a) => a.artifactType === 'BUG_REPORT').map((a) => a.relativePath.replace(/^bugs\/|\.json$/g, '')),
    };
  };
  const read = (s: RunHistoryStore, id: string, type: SingleArtifactType | 'BUG_REPORT', bugId?: string) => {
    const run = s.getRun(id);
    if (isLive(run, artifactRoot)) {
      if (type === 'BUG_REPORT') {
        if (!bugId || !BUG_ID.test(bugId) || !writtenBy(run!, 'defect-analysis') || !listBugReportIds().includes(bugId)) throw new RunsApiError(404, 'No such bug report in this run yet.');
        return readBugReport(bugId);
      }
      const name = LIVE_ARTIFACTS[type];
      const value = name && writtenBy(run!, name) ? readQaArtifact(name) : undefined;
      if (value === undefined) throw new RunsApiError(404, 'This run has not produced that artifact yet.');
      return value;
    }
    try {
      return readHistoricalArtifact(s, id, type, bugId, artifactRoot);
    } catch (error) {
      if (error instanceof HistoricalArtifactError) throw new RunsApiError(error.status, error.message);
      throw error;
    }
  };
  const recorded = (s: RunHistoryStore, id: string) => {
    const run = s.getRun(id);
    if (!run) throw new RunsApiError(404, 'No such run.');
    return run;
  };

  return [
    ['GET', /^\/api\/runs$/, async (_m, req) => {
      const query = parseRunQuery(new URL(req.url ?? '/', 'http://localhost').searchParams);
      const s = store();
      // A row left RUNNING by a process that died is settled before it is shown.
      s.reconcileRunning((run) => ownerAlive(run, artifactRoot));
      const page = s.listRuns(query);
      const active = [...s.listRuns({ status: 'STARTING', limit: 5 }).runs, ...s.listRuns({ status: 'RUNNING', limit: 5 }).runs]
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, model: r.model, currentStage: r.currentStage, startedAt: r.startedAt }));
      return [200, { ...page, facets: s.facets(), active }];
    }],

    ['GET', /^\/api\/runs\/([^/]+)$/, async (m) => {
      const id = runId(m[1]);
      const s = store();
      const row = s.getRun(id);
      if (!row) {
        // Started from this workspace but not (yet, or ever) in the history: the controller says what it knows.
        const c = control?.getRun(id);
        if (!c) throw new RunsApiError(404, 'No such run.');
        return [200, {
          run: { id, kind: 'PHASE1_MANUAL', status: c.status, model: c.model, provider: c.model.split('/')[0], target: c.target, coverageMode: c.coverageMode ?? null, apiDocsUrl: c.apiDocsUrl ?? null, startedAt: c.startedAt, finishedAt: null, durationMs: null, errorCode: c.error ? 'NOT_STARTED' : null, errorSummary: c.error ?? null, currentStage: null, langfuseTraceId: null, source: 'LIVE' },
          stages: [], plannedStages: STAGES.map((st) => ({ key: st.key, label: st.label })), metrics: {}, artifacts: [], bugIds: [],
          live: c.status === 'STARTING', cancellable: control?.isCancellable(id) ?? false, langfuseUrl: null,
        }];
      }
      const stages = s.getStages(id);
      const a = available(s, id);
      const base = control?.langfuseBaseUrl();
      return [200, {
        run: row,
        stages,
        plannedStages: plannedStages(row, stages.map((st) => st.stageName)),
        metrics: s.getMetrics(id),
        // Which artifacts exist — as types and bug ids, never as paths.
        artifacts: [...a.types],
        bugIds: a.bugIds,
        live: a.live,
        cancellable: control?.isCancellable(id) ?? false,
        langfuseUrl: base && row.langfuseTraceId ? `${base.replace(/\/+$/, '')}/trace/${row.langfuseTraceId}` : null,
      }];
    }],

    ['GET', /^\/api\/runs\/([^/]+)\/test-cases$/, async (m) => {
      const id = runId(m[1]);
      const s = store();
      recorded(s, id);
      const suite = asRecord(read(s, id, 'TEST_CASES'));
      const hasPrio = available(s, id).types.has('AUTOMATION_PRIORITIZATION');
      const prio = hasPrio ? asList(asRecord(read(s, id, 'AUTOMATION_PRIORITIZATION')).cases) : [];
      return [200, {
        // Each case with its level stated, so a snapshot from before levels filters like any other.
        testCases: asList(suite.testCases).map((tc) => ({ ...tc, testLevel: testLevelOf(tc) })),
        prioritization: Object.fromEntries(prio.filter((c) => typeof c.testCaseId === 'string').map((c) => [c.testCaseId as string, {
          executionMode: c.executionMode ?? null, automationPriority: c.automationPriority ?? null, automationStrategy: c.automationStrategy ?? null,
        }])),
      }];
    }],

    ['GET', /^\/api\/runs\/([^/]+)\/bugs$/, async (m) => {
      const id = runId(m[1]);
      const s = store();
      recorded(s, id);
      const ids = available(s, id).bugIds;
      const bugs = ids.map((bugId) => asRecord(read(s, id, 'BUG_REPORT', bugId)));
      return [200, {
        bugs: bugs.map((b) => ({
          id: b.id, title: b.title ?? null, status: b.status ?? null, severity: b.severity ?? null, priority: b.priority ?? null,
          area: b.area ?? null, decision: asRecord(b.review).decision ?? null,
          relatedTestCaseIds: Array.isArray(b.sourceTestCaseIds) ? b.sourceTestCaseIds : [],
        })),
      }];
    }],

    ['GET', /^\/api\/runs\/([^/]+)\/bugs\/([^/]+)$/, async (m) => {
      const id = runId(m[1]);
      const bugId = decodeURIComponent(m[2]);
      if (!BUG_ID.test(bugId)) throw new RunsApiError(400, 'Invalid bug id.');
      const s = store();
      recorded(s, id);
      const bug = asRecord(read(s, id, 'BUG_REPORT', bugId));
      const have = available(s, id).types;
      const hasSuite = have.has('TEST_CASES');
      const inSnapshot = new Set(hasSuite ? asList(asRecord(read(s, id, 'TEST_CASES')).testCases).map((t) => t.id) : []);
      const hasDefects = have.has('DEFECT_ANALYSIS');
      const finding = hasDefects ? asList(asRecord(read(s, id, 'DEFECT_ANALYSIS')).findings).find((f) => f.bugReportId === bugId || f.id === asRecord(bug.origin).findingId) : undefined;
      return [200, {
        bug,
        classification: finding?.classification ?? null,
        relatedTestCases: (Array.isArray(bug.sourceTestCaseIds) ? bug.sourceTestCaseIds : []).map((t: unknown) => ({ id: t, inSnapshot: inSnapshot.has(t) })),
      }];
    }],

    ['GET', /^\/api\/runs\/([^/]+)\/artifacts\/([A-Z0-9_]+)$/, async (m) => {
      const id = runId(m[1]);
      const type = m[2] as SingleArtifactType;
      if (!Object.hasOwn(ARTIFACT_FILES, type) || !VIEWABLE.has(type)) throw new RunsApiError(400, 'That artifact type cannot be viewed.');
      const s = store();
      recorded(s, id);
      return [200, { type, artifact: read(s, id, type) }];
    }],
  ];
}
