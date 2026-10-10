// Live API validation, as the pages word and filter it. Plain logic, shared by
// the React pages and tested without a browser.

export type EvidenceClass = 'DOCUMENTED' | 'OBSERVED' | 'VALIDATED';
export type OperationSafety = 'SAFE' | 'UNSAFE_GET' | 'STATE_CHANGING' | 'DESTRUCTIVE';
export type EndpointFilter = 'ALL' | EvidenceClass | 'SKIPPED' | 'MISMATCH';

export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  DOCUMENTED: 'Documented',
  OBSERVED: 'Observed',
  VALIDATED: 'Validated',
};

/** What each class means, in a sentence — shown wherever the class is. */
export const EVIDENCE_HINT: Record<EvidenceClass, string> = {
  DOCUMENTED: 'Declared by the API documentation. It was not called, so nothing is known about what it actually does.',
  OBSERVED: 'Called: a real response was captured, but it did not fully match the documentation, or could not be checked against it.',
  VALIDATED: 'Called and checked: a real response matched the documented contract.',
};

export const SAFETY_LABEL: Record<OperationSafety, string> = {
  SAFE: 'Read-only',
  UNSAFE_GET: 'Action (GET)',
  STATE_CHANGING: 'Changes state',
  DESTRUCTIVE: 'Destructive',
};

const SKIP_LABEL: Record<string, string> = {
  APPROVAL_REQUIRED: 'Needs approval',
  ENVIRONMENT_PROTECTED: 'Protected environment',
  MISSING_PARAMETERS: 'Missing parameters',
  MISSING_TEST_DATA: 'No test data',
  UNSUPPORTED_BODY: 'Unsupported request body',
  UNSUPPORTED_METHOD: 'Unsupported method',
  REQUEST_BUDGET: 'Request budget used up',
  RATE_LIMITED: 'Rate limited',
  UNREACHABLE: 'API unreachable',
  NOT_ATTEMPTED: 'Not called',
};
export const skipLabel = (reason: string | null | undefined): string => (reason ? SKIP_LABEL[reason] ?? reason : '');

const KIND_LABEL: Record<string, string> = {
  ANONYMOUS: 'No credentials needed',
  UNAUTHENTICATED: 'Without credentials',
  AUTHENTICATED: 'With credentials',
  NOT_FOUND: 'Missing resource',
  INVALID_BODY: 'Empty request body',
  VALID_BODY: 'Valid request body',
};
export const probeKindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

interface EndpointLike { evidence: EvidenceClass; execution: string; findings: readonly unknown[] }

export function matchesEndpointFilter(e: EndpointLike, filter: EndpointFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'SKIPPED') return e.execution !== 'EXECUTED';
  if (filter === 'MISMATCH') return e.findings.length > 0;
  return e.evidence === filter;
}

export function endpointCounts(endpoints: readonly EndpointLike[]): Record<EndpointFilter, number> {
  const count = (f: EndpointFilter) => endpoints.filter((e) => matchesEndpointFilter(e, f)).length;
  return { ALL: endpoints.length, VALIDATED: count('VALIDATED'), OBSERVED: count('OBSERVED'), DOCUMENTED: count('DOCUMENTED'), SKIPPED: count('SKIPPED'), MISMATCH: count('MISMATCH') };
}

/** `METHOD /path` — how an approval names an operation, and what the host checks it against. */
export const operationKey = (o: { method: string; path: string }): string => `${o.method} ${o.path}`;

/**
 * Why the page has no live results to show, in words a person can act on —
 * or undefined when there are some.
 */
export function unavailableMessage(view: {
  coverageMode: string;
  documentation: { status: string; reason: string | null } | null;
  validation: { status: string; reason: string | null } | null;
}): string | undefined {
  if (view.coverageMode === 'UI_ONLY') return 'This suite was designed UI only: the API documentation was not read and the API was not called.';
  if (!view.documentation || view.documentation.status === 'NOT_REQUESTED') return 'No API documentation was given for this run. Start a run with an API documentation URL to discover and validate the API.';
  if (view.documentation.status === 'UNAVAILABLE') return `The API documentation could not be read: ${view.documentation.reason ?? 'unknown reason'}.`;
  if (!view.validation) return 'This suite was produced before live API validation existed: its operations are documented only.';
  if (view.validation.status === 'NOT_REQUESTED') return `The API was not called: ${view.validation.reason ?? 'live validation was off'}. Every operation is documented only.`;
  if (view.validation.status === 'UNAVAILABLE') return `Live validation was not possible: ${view.validation.reason ?? 'unknown reason'}. Every operation is documented only.`;
  return undefined;
}

interface DiscoveryLike {
  methods: readonly string[];
  ui?: { status: string; reason?: string };
  api?: { status: string; reason?: string; evidence: string };
}

/** "UI (browser) + API (documentation + live requests)" — how a run discovered the product, in words. */
export function discoveryLabel(d: DiscoveryLike | null | undefined): string {
  if (!d) return 'UI (browser)';
  if (d.methods.length === 0) return 'none';
  return d.methods.map((m) => (m === 'UI' ? 'UI (browser)' : `API (${d.api?.evidence === 'LIVE' ? 'documentation + live requests' : 'documentation only'})`)).join(' + ');
}

/** What a person should know about the limits of that discovery — or nothing. */
export function discoveryNotes(d: DiscoveryLike | null | undefined): string[] {
  if (!d) return [];
  const notes: string[] = [];
  if (d.ui?.status === 'SKIPPED') notes.push(`No browser was started: ${d.ui.reason ?? 'the interface was not explored'}.`);
  if (d.api?.status === 'BLOCKED') notes.push(`API discovery was blocked: ${d.api.reason ?? 'unknown reason'}.`);
  if (d.methods.includes('API') && d.api?.evidence === 'DOCUMENTATION_ONLY') notes.push('Documentation only: the API was not called, so API requirements and test cases state what is documented, not what was observed.');
  return notes;
}

/** Can New Run start without an application URL? Only when the run has the other discovery source. */
export function mayOmitTarget(mode: string, apiDocsUrl: string): boolean {
  return mode !== 'UI_ONLY' && apiDocsUrl.trim() !== '';
}
