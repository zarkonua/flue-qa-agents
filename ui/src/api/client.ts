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

export interface Step { action: string; expected: string }
export interface TestCase {
  id: string; title: string; priority: string; types: string[]; covers: string[]; evidenceIds: string[];
  preconditions: string[]; testData: Record<string, unknown>; steps: Step[]; expectedResult: string;
  automationCandidate: boolean; automationReason: string; tags: string[];
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
export interface Overview {
  artifactRoot: string; phase1: Phase1;
  counts: { testCases: number; pendingReviews: number; bugs: number; openBugs: number; confirmedBugs: number; potentialBugs: number };
  coverage: { testable: number; covered: number; uncovered: number } | null;
  requirements: { id: string; kind: 'acceptancePoint' | 'businessRule'; statement: string; testable: boolean; validationType: string | null; coveredBy: string[] }[];
  prioritization: { state: 'CURRENT' | 'STALE' | 'MISSING'; detail?: string; refresh: { status: string; output?: string; at?: string } };
}
export interface CaseRow {
  id: string; title: string; priority: string; types: string[]; covers: string[]; evidenceIds: string[];
  executionMode?: string; automationPriority?: string; automationStrategy: string | null; strategyReason: string | null; relatedBugIds: string[];
  pendingReview: { id: string; status: RequestStatus; operation: Operation } | null;
}
export interface BugRow { id: string; title: string; status: string; severity: string; priority: string; area: string | null; decision: string; relatedTestCaseIds: string[] }
export interface Bug {
  id: string; status: string; title: string; severity: string; priority: string; area?: string; expectedBasis: string;
  preconditions: string[]; steps: string[]; expected: string; actual: string;
  evidence: { type: string; sourceId: string }[]; environment: { target: string; browser: string };
  review: { decision: string; by?: string; at?: string; note?: string; downgradedFrom?: string };
  origin: { phase: number; stage: string; findingId: string; runId?: string };
}

export const api = {
  overview: () => call<Overview>('GET', '/api/overview'),
  testCases: () => call<{ testCases: CaseRow[] }>('GET', '/api/test-cases'),
  testCase: (id: string) => call<{
    testCase: TestCase; prioritization: { executionMode: string; automationPriority: string; automationStrategy?: string; reason: string } | null;
    covers: { id: string; statement: string | null }[]; evidence: { id: string; statement: string | null; status: string | null }[];
    relatedBugIds: string[]; reviews: { id: string; operation: Operation; status: RequestStatus; updatedAt: string }[]; openReviewId: string | null;
  }>('GET', `/api/test-cases/${enc(id)}`),
  bugs: () => call<{ bugs: BugRow[] }>('GET', '/api/bugs'),
  bug: (id: string) => call<{
    bug: Bug; relatedTestCases: { id: string; active: boolean }[];
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
  apply: (id: string) => call<{ request: ReviewRequest; prioritization: Overview['prioritization']; phase1: Phase1 }>('POST', `/api/proposals/${enc(id)}/apply`, {}),
  reject: (id: string, note?: string) => call<{ request: ReviewRequest }>('POST', `/api/proposals/${enc(id)}/reject`, note ? { note } : {}),
  requestChanges: (id: string, note: string) => call<{ request: ReviewRequest }>('POST', `/api/proposals/${enc(id)}/request-changes`, { note }),
  refreshPrioritization: () => call<{ accepted: boolean }>('POST', '/api/prioritization/refresh', {}),
  approvePhase1: () => call<{ ok: boolean; approval?: { approvedBy: string; approvedAt: string } }>('POST', '/api/phase1/approve', {}),
};
