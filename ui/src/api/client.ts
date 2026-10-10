// The only way the page talks to the host: fixed resources and fixed
// operations. No path, file name, command or agent name is ever sent.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (payload as { error?: string }).error ?? `Request failed (${res.status}).`);
  return payload as T;
}

const enc = encodeURIComponent;

export type CoverageMode = 'AUTOMATIC' | 'UI_ONLY' | 'API_ONLY';
export type TestLevel = 'UI' | 'API';
export type EvidenceClass = 'DOCUMENTED' | 'OBSERVED' | 'VALIDATED';
export type OperationSafety = 'SAFE' | 'UNSAFE_GET' | 'STATE_CHANGING' | 'DESTRUCTIVE';
/** How a run discovered the product: through the interface, its API, or both — each with its own outcome. */
export interface DiscoveryView {
  methods: ('UI' | 'API')[];
  ui?: { status: 'PLANNED' | 'SKIPPED'; reason?: string };
  api?: { status: 'COMPLETE' | 'BLOCKED' | 'NOT_REQUESTED'; reason?: string; evidence: 'LIVE' | 'DOCUMENTATION_ONLY' | 'NONE'; criteria: { name: string; met: boolean; required: boolean; detail: string }[] };
}
export interface ApiRequirementView {
  id: string; statement: string; operations: string[]; uiEvidence: string[]; source: 'API' | 'UI_AND_API'; apiEvidence: EvidenceClass | null; testCases: string[];
}
export interface ApiCheckView { name: string; outcome: 'PASS' | 'FAIL' | 'NOT_CHECKED'; detail?: string }
export interface ApiProbeView {
  id: string; endpointId: string; kind: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; contentType?: string; headers: Record<string, string>; bodySample?: string; bodyTruncated?: boolean; durationMs: number };
  error?: { code: string; message: string };
  checks: ApiCheckView[]; evidence?: 'OBSERVED' | 'VALIDATED';
}
export interface ApiFindingView {
  id: string; endpointId: string; probeId: string; classification: 'CONTRACT_VIOLATION' | 'POTENTIAL_ISSUE';
  type: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; expected: string; actual: string;
}
export interface ApiEndpointView {
  id: string; method: string; path: string; summary: string | null; secured: boolean; deprecated: boolean; documentedStatuses: string[];
  evidence: EvidenceClass; execution: 'EXECUTED' | 'SKIPPED'; safety: OperationSafety | null; skipReason: string | null; skipDetail: string | null;
  validated: string[]; observed: string[]; probes: ApiProbeView[]; findings: ApiFindingView[];
  testCases: { id: string; title: string; testLevel: string }[];
}
export interface ApiValidationView {
  coverageMode: CoverageMode; apiDocsUrl: string | null;
  discovery: DiscoveryView | null; requirements: ApiRequirementView[];
  documentation: { status: string; reason: string | null; title: string | null; version: string | null; format: string | null } | null;
  validation: {
    status: 'COMPLETED' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_REQUESTED'; reason: string | null; baseUrl: string | null; baseUrlSource: string | null;
    environment: string | null; startedAt: string | null; finishedAt: string | null;
    authentication: { status: 'NOT_CONFIGURED' | 'READY' | 'FAILED'; method?: string; detail?: string };
    policy: { allowedHosts: string[]; approvedOperations: string[]; maxRequests: number; requestsSent: number };
    summary: Record<string, number>;
  } | null;
  endpoints: ApiEndpointView[]; findings: ApiFindingView[];
}
/** What live validation would call for some documentation — nothing has been sent. */
export interface ApiPreview {
  documentation: { status: string; reason: string | null; title: string | null; url: string | null; operations: number };
  plan: {
    baseUrl?: string; baseUrlSource?: string; allowed: boolean; reason?: string; allowedHosts: string[]; environment: string; protectedEnvironment: boolean;
    operations: { id: string; method: string; path: string; summary?: string; safety: OperationSafety; secured: boolean; needsApproval: boolean }[];
  } | null;
  credentialsConfigured: boolean;
}
/** The suite's coverage mode and the API documentation read for it. */
export interface CoverageModeView {
  mode: CoverageMode; label: string; recorded: boolean; apiDocsUrl: string | null;
  api: { status: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_REQUESTED'; endpoints: number; reason: string | null };
  live?: { status: string; reason?: string; validated: number; observed: number; documented: number; contractViolations: number; potentialIssues: number; requests: number };
  discovery?: DiscoveryView | null;
}

export interface Step { action: string; expected: string }
export interface TestCase {
  id: string; title: string; priority: string; types: string[]; covers: string[]; evidenceIds: string[];
  preconditions: string[]; testData: Record<string, unknown>; steps: Step[]; expectedResult: string;
  automationCandidate: boolean; automationReason: string; tags: string[];
  /** UI or API. Absent on a suite written before levels existed; read it through `levelOf`. */
  testLevel?: TestLevel;
  /** Host-set on an API-level case: how real the API evidence behind it is. */
  apiEvidence?: EvidenceClass;
}
export type RequestStatus = 'PENDING' | 'PROCESSING' | 'PROPOSAL_READY' | 'CHANGES_REQUESTED' | 'REJECTED' | 'APPLIED' | 'FAILED';
export type Operation = 'update' | 'create' | 'delete';
export interface Validation {
  status: 'VALID' | 'INVALID' | 'UNRESOLVED' | 'STALE';
  problems: string[]; warnings: string[]; applicable: boolean;
  duplicates: { testCaseId: string; similarTo: string }[];
  impact: { coveredBefore: string[]; coveredAfter: string[]; wouldBecomeUncovered: string[]; evidenceNoLongerCited: string[] };
}
export interface Proposal {
  id: string; requestId: string; operation: Operation; targetTestCaseId?: string; author: 'agent' | 'host'; baseCase?: TestCase;
  proposedCases: TestCase[]; removedTestCaseIds: string[]; rationale: string; evidenceRefs: string[];
  unresolvedIssues: string[]; status: 'READY' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED'; createdAt: string;
  validation?: Validation;
}
export interface ReviewRequest {
  id: string; operation: Operation; targetTestCaseId?: string; humanComment?: string; manualEdits?: Partial<TestCase>;
  status: RequestStatus; latestProposalId?: string; error?: string; processing: boolean;
  history: { at: string; event: string; note?: string; proposalId?: string }[]; createdAt: string; updatedAt: string;
}
export interface Phase1 { state: 'NONE' | 'APPROVED' | 'STALE'; changed: string[]; approvedBy?: string; approvedAt?: string; missing: string[]; findings: number; blocking: number }
export interface DependencyState {
  state: 'CURRENT' | 'STALE' | 'MISSING'; reasons: string[]; legacy: boolean; generatedAt?: string;
  changedCases: { added: string[]; modified: string[]; removed: string[] };
}
export interface Reconciliation {
  preserved: { from: string; to: string; decision: string; editsCarried: boolean }[];
  reset: { from: string; to: string; previousDecision: string }[];
  added: string[];
  removed: { id: string; previousDecision: string }[];
}
export interface RefreshStatus {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED'; startedAt?: string; finishedAt?: string; error?: string;
  stages?: { stage: string; passed: boolean; attempts: number }[]; reconciliation?: Reconciliation;
}
export interface Health {
  testCases: { state: string; count: number };
  prioritization: DependencyState & { automationCandidates: number };
  defectAnalysis: DependencyState & { confirmed: number; potential: number };
  review: { state: 'CURRENT' | 'STALE' | 'MISSING' };
  approval: Phase1;
  refresh: RefreshStatus;
  refreshNeeded: boolean;
  bugsReferencingChangedCases: string[];
  decidedBugs: string[];
}
export interface Overview {
  artifactRoot: string; phase1: Phase1; health: Health;
  counts: { testCases: number; pendingReviews: number; bugs: number; openBugs: number; confirmedBugs: number; potentialBugs: number };
  coverage: { testable: number; covered: number; uncovered: number; outOfScope?: number; testLevels?: Partial<Record<TestLevel, number>> } | null;
  coverageMode?: CoverageModeView;
  requirements: { id: string; kind: 'acceptancePoint' | 'businessRule'; statement: string; testable: boolean; validationType: string | null; coveredBy: string[] }[];
}
export interface CaseRow {
  id: string; title: string; priority: string; types: string[]; covers: string[]; evidenceIds: string[];
  testLevel: TestLevel;
  apiEvidence: EvidenceClass | null;
  executionMode?: string; automationPriority?: string; automationStrategy: string | null; strategyReason: string | null; relatedBugIds: string[];
  pendingReview: { id: string; status: RequestStatus; operation: Operation } | null;
}
export interface BugRow { id: string; title: string; status: string; severity: string; priority: string; area: string | null; decision: string; relatedTestCaseIds: string[] }
export interface Bug {
  id: string; status: string; title: string; severity: string; priority: string; area?: string; expectedBasis: string;
  preconditions: string[]; steps: string[]; expected: string; actual: string;
  evidence: { type: string; sourceId: string }[]; environment: { target: string; browser: string };
  review: { decision: string; by?: string; at?: string; note?: string; downgradedFrom?: string; editedFields?: string[] };
  origin: { phase: number; stage: string; findingId: string; runId?: string };
  sourceBehaviorIds: string[]; sourceAcceptancePointIds?: string[]; sourceBusinessRuleIds?: string[]; sourceTestCaseIds?: string[];
}
export interface BugHistoryEvent {
  at: string; action: string; by: string; via?: string; note?: string; editedFields?: string[];
  before: { status: string; decision: string; severity: string; priority: string };
  after: { status: string; decision: string; severity: string; priority: string };
}
export interface BugChanges { title?: string; severity?: string; priority?: string; steps?: string[] }
export interface BugEditPreview {
  current: Record<string, unknown>; next: Record<string, unknown>; changedFields: string[]; problems: string[]; applicable: boolean; baseSha256: string;
}
type BugMutation = { bug: Bug; sha256: string; phase1: Phase1 };

export type RunKind = 'PHASE1_MANUAL' | 'DEPENDENCY_REFRESH' | 'PHASE1_REVIEW' | 'PHASE2_AUTOMATION';
export type RunStatus = 'STARTING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface Run {
  id: string; kind: RunKind; status: RunStatus; model: string | null; provider: string | null; target: string | null;
  gitCommit: string | null; gitDirty: boolean | null; startedAt: string; finishedAt: string | null; durationMs: number | null;
  authMode: string | null; archiveRelPath: string | null; errorCode: string | null; errorSummary: string | null;
  currentStage: string | null; langfuseTraceId: string | null; source: 'LIVE' | 'IMPORTED';
  /** Null for a run recorded before coverage modes. */
  coverageMode: CoverageMode | null; apiDocsUrl: string | null;
}
export interface RunSummary extends Run { metrics: Record<string, number>; failedStage: string | null }
export interface RunStage {
  stageName: string; label: string | null; ordinal: number; status: RunStatus | 'SKIPPED'; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null; attemptCount: number; errorCode: string | null; errorSummary: string | null;
}
export interface RunFilters { status?: string; kind?: string; model?: string; provider?: string; target?: string; from?: string; to?: string }
export interface RunList {
  runs: RunSummary[]; total: number; limit: number; offset: number;
  facets: { models: string[]; providers: string[]; kinds: RunKind[]; targets: string[] };
  active: { id: string; kind: RunKind; status: RunStatus; model: string | null; currentStage: string | null; startedAt: string }[];
}

export interface RunDetail {
  run: Run; stages: RunStage[]; plannedStages: { key: string; label: string }[]; metrics: Record<string, number>;
  artifacts: string[]; bugIds: string[]; live: boolean; cancellable: boolean; langfuseUrl: string | null;
  discovery?: DiscoveryView | null;
}

export interface RunConfig {
  pipelines: 'PHASE1_MANUAL'[];
  targets: { url: string; default: boolean }[];
  models: { id: string; provider: string; default: boolean; available: boolean; reason?: string }[];
  freshBrowser: { default: boolean };
  coverageModes: { id: CoverageMode; default: boolean }[];
  apiDocs: { default: string | null };
  apiValidation: { default: boolean; baseUrl: string | null; environment: string; protectedEnvironment: boolean; credentialsConfigured: boolean; extraAllowedHosts: string[] };
  auxiliaryOrigins: string[];
  langfuse: { enabled: boolean; baseUrl?: string };
}
export interface RunConfigResponse {
  config: RunConfig;
  activeRun: { runId: string; status: string; model: string; startedAt: string; cancelRequested: boolean } | null;
  lockHolder: { runId: string | null; model: string | null; command: string | null; startedAt: string | null } | null;
}
export interface StartRunRequest {
  /** Omitted for a run that does not explore the interface. */
  pipeline: 'PHASE1_MANUAL'; target?: string; model: string; freshBrowser: boolean; coverageMode: CoverageMode; apiDocsUrl?: string;
  liveValidation?: boolean; apiBaseUrl?: string; approvedOperations?: string[];
}

/** One structured event from a run's event log — host-normalised and redacted. */
export interface RunEvent {
  id: number; runId: string; timestamp: string; type: string; category: string; level: 'info' | 'warn' | 'error'; message: string;
  stage?: string; stageLabel?: string; attempt?: number; tool?: string; artifactType?: string; count?: number;
  metrics?: Record<string, number>; plan?: { key: string; label: string }[]; status?: string; errorCode?: string;
}

function runQuery(filters: RunFilters, limit: number, offset: number): string {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return q.toString();
}

export const api = {
  overview: () => call<Overview>('GET', '/api/overview'),
  testCases: () => call<{ testCases: CaseRow[] }>('GET', '/api/test-cases'),
  testCase: (id: string) => call<{
    testCase: TestCase; testLevel: TestLevel; prioritization: { executionMode: string; automationPriority: string; automationStrategy?: string; reason: string } | null;
    covers: { id: string; statement: string | null }[]; evidence: { id: string; statement: string | null; status: string | null }[];
    relatedBugIds: string[]; reviews: { id: string; operation: Operation; status: RequestStatus; updatedAt: string }[]; openReviewId: string | null;
  }>('GET', `/api/test-cases/${enc(id)}`),
  bugs: () => call<{ bugs: BugRow[] }>('GET', '/api/bugs'),
  bug: (id: string) => call<{
    bug: Bug; sha256: string; classification: string | null; history: BugHistoryEvent[]; actions: { downgrade: boolean };
    relatedTestCases: { id: string; active: boolean }[];
    behaviors: { id: string; statement: string | null }[]; requirements: { id: string; statement: string | null }[];
  }>('GET', `/api/bugs/${enc(id)}`),
  reviews: () => call<{ reviews: {
    id: string; operation: Operation; targetTestCaseId: string | null; status: RequestStatus; humanComment: string | null;
    updatedAt: string; error: string | null; processing: boolean; proposal: { id: string; status: string; validation: string | null } | null;
  }[] }>('GET', '/api/reviews'),
  review: (id: string) => call<{ request: ReviewRequest; currentCase: TestCase | null; proposals: Proposal[] }>('GET', `/api/reviews/${enc(id)}`),
  createReview: (input: { operation: Operation; targetTestCaseId?: string; humanComment?: string; manualEdits?: Partial<TestCase> }) =>
    call<{ request: ReviewRequest }>('POST', '/api/reviews', input),
  process: (id: string) => call<{ accepted: boolean }>('POST', `/api/reviews/${enc(id)}/process`, {}),
  apply: (id: string) => call<{ request: ReviewRequest; affected: string[]; bugsReferencingChangedCases: string[]; health: Health }>('POST', `/api/proposals/${enc(id)}/apply`, {}),
  reject: (id: string, note?: string) => call<{ request: ReviewRequest }>('POST', `/api/proposals/${enc(id)}/reject`, note ? { note } : {}),
  requestChanges: (id: string, note: string) => call<{ request: ReviewRequest }>('POST', `/api/proposals/${enc(id)}/request-changes`, { note }),
  refreshDependents: () => call<{ accepted: boolean }>('POST', '/api/phase1/refresh', {}),
  bugDecision: (id: string, action: 'accept' | 'reject' | 'downgrade', baseSha256: string, note?: string) =>
    call<BugMutation>('POST', `/api/bugs/${enc(id)}/${action}`, { baseSha256, ...(note ? { note } : {}) }),
  bugRequestChanges: (id: string, baseSha256: string, note: string) => call<BugMutation>('POST', `/api/bugs/${enc(id)}/request-changes`, { baseSha256, note }),
  bugEditPreview: (id: string, changes: BugChanges) => call<BugEditPreview>('POST', `/api/bugs/${enc(id)}/edit/preview`, { changes }),
  bugEdit: (id: string, changes: BugChanges, baseSha256: string, note?: string) =>
    call<BugMutation>('POST', `/api/bugs/${enc(id)}/edit`, { changes, baseSha256, ...(note ? { note } : {}) }),
  runs: (filters: RunFilters, limit: number, offset: number) => call<RunList>('GET', `/api/runs?${runQuery(filters, limit, offset)}`),
  run: (id: string) => call<RunDetail>('GET', `/api/runs/${enc(id)}`),
  runConfig: () => call<RunConfigResponse>('GET', '/api/run-config'),
  apiValidation: () => call<ApiValidationView>('GET', '/api/api-validation'),
  previewApiDocs: (apiDocsUrl: string, apiBaseUrl?: string) => call<ApiPreview>('POST', '/api/api-docs/preview', { apiDocsUrl, ...(apiBaseUrl ? { apiBaseUrl } : {}) }),
  startRun: (request: StartRunRequest) => call<{ runId: string; status: string }>('POST', '/api/runs', request),
  cancelRun: (id: string) => call<{ accepted: boolean }>('POST', `/api/runs/${enc(id)}/cancel`, {}),
  /** The URL of a run's event stream; the page opens it with EventSource. */
  runEventsUrl: (id: string) => `/api/runs/${enc(id)}/events`,
  runTestCases: (id: string) => call<{ testCases: Partial<TestCase>[]; prioritization: Record<string, { executionMode: string | null; automationPriority: string | null; automationStrategy: string | null }> }>('GET', `/api/runs/${enc(id)}/test-cases`),
  runBugs: (id: string) => call<{ bugs: (Omit<BugRow, 'decision'> & { decision: string | null })[] }>('GET', `/api/runs/${enc(id)}/bugs`),
  runBug: (id: string, bugId: string) => call<{ bug: Partial<Bug> & Record<string, unknown>; classification: string | null; relatedTestCases: { id: string; inSnapshot: boolean }[] }>('GET', `/api/runs/${enc(id)}/bugs/${enc(bugId)}`),
  runArtifact: (id: string, type: string) => call<{ type: string; artifact: unknown }>('GET', `/api/runs/${enc(id)}/artifacts/${enc(type)}`),
  approvePhase1: () => call<{ ok: boolean; approval?: { approvedBy: string; approvedAt: string } }>('POST', '/api/phase1/approve', {}),
};
