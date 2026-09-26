// Interactive test-case changes: AI PROPOSES, HOST VALIDATES, HUMAN AUTHORIZES,
// HOST WRITES.
//
//   request (a person's comment, manual edits, or a deletion)
//     -> proposal (the review agent's complete resulting cases, or the host's
//        own deletion)
//     -> validation (recomputed from disk every time it is shown or applied;
//        nothing stored on a proposal is trusted)
//     -> apply (a person's explicit action; the host rebuilds the candidate
//        suite, validates it and replaces test-cases.json atomically)
//
// Every proposal is bound to the SHA-256 of the suite it was generated from.
// Apply refuses any other suite: a proposal is never rebased or merged.
//
// Pure over two seams — the `ReviewStore` (workflow state) and a `Workspace`
// (the canonical artifacts) — so tests run without files or a model.

import { canonical, contentWords, type SemanticError, type TestCase, type TestCases } from '../lib/semantic-validate.ts';
import type { BugReport } from '../lib/defects.ts';
import type {
  ChangeProposal,
  ChangeRequest,
  ManualEdits,
  NewProposal,
  Operation,
  RequestStatus,
  ReviewStore,
} from './review-store.ts';
import { EDITABLE_FIELDS } from './review-store.ts';

/** The canonical artifacts, as the host sees them. */
export interface Workspace {
  readTestCases(): TestCases | undefined;
  testCasesSha256(): string | undefined;
  /** Schema problems of a candidate suite. */
  schemaErrors(candidate: TestCases): string[];
  /** Semantic problems of a candidate suite against discovery and requirements on disk. */
  semanticErrors(candidate: TestCases): SemanticError[];
  /** Validated, redacted, atomic replacement of test-cases.json. */
  writeTestCases(candidate: TestCases): void;
  readRequirementIds?(): string[];
  listBugs?(): BugReport[];
}

export class ReviewConflictError extends Error {
  name = 'ReviewConflictError';
}
export class ReviewInputError extends Error {
  name = 'ReviewInputError';
}

/** A test-case id as the suite uses them: a prefix and a number, e.g. TC-014. */
const CASE_ID = /^([A-Za-z][A-Za-z_]*-?)([0-9]+)$/;

/** Semantic codes that describe coverage getting worse — shown as impact, never a reason to refuse. */
const COVERAGE_CODES = new Set(['UNCOVERED_ACCEPTANCE_POINT']);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestInput {
  operation: Operation;
  targetTestCaseId?: string;
  humanComment?: string;
  manualEdits?: ManualEdits;
}

/** Record a person's request. Nothing about the suite changes. */
export async function createChangeRequest(store: ReviewStore, ws: Workspace, input: RequestInput): Promise<ChangeRequest> {
  const suite = ws.readTestCases();
  const base = ws.testCasesSha256();
  if (!suite || !base) throw new ReviewInputError('There is no test suite yet. Run: npm run qa:manual');
  const comment = input.humanComment?.trim() || undefined;
  const edits = input.manualEdits && Object.keys(input.manualEdits).length > 0 ? input.manualEdits : undefined;

  if (input.operation === 'create') {
    if (input.targetTestCaseId !== undefined) throw new ReviewInputError('A new test case has no target.');
    if (!comment) throw new ReviewInputError('Describe the test case you want.');
  } else {
    if (!input.targetTestCaseId || !suite.testCases.some((tc) => tc.id === input.targetTestCaseId)) {
      throw new ReviewInputError(`No active test case ${input.targetTestCaseId ?? '(none)'}.`);
    }
    if (input.operation === 'update' && !comment && !edits) throw new ReviewInputError('Say what should change, or edit a field.');
  }
  for (const key of Object.keys(edits ?? {})) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) throw new ReviewInputError(`"${key}" cannot be edited.`);
  }

  const request = await store.createRequest({
    operation: input.operation,
    ...(input.targetTestCaseId ? { targetTestCaseId: input.targetTestCaseId } : {}),
    baseTestCasesSha256: base,
    ...(comment ? { humanComment: comment } : {}),
    ...(edits && input.operation !== 'delete' ? { manualEdits: edits } : {}),
  });
  // A deletion needs no model: the host states it exactly.
  if (input.operation === 'delete') return proposeDeletion(store, ws, request);
  return request;
}

async function proposeDeletion(store: ReviewStore, ws: Workspace, request: ChangeRequest): Promise<ChangeRequest> {
  const proposal = await store.saveProposal({
    requestId: request.id,
    operation: 'delete',
    targetTestCaseId: request.targetTestCaseId,
    baseTestCasesSha256: ws.testCasesSha256()!,
    author: 'host',
    baseCase: ws.readTestCases()!.testCases.find((tc) => tc.id === request.targetTestCaseId) as unknown as Record<string, unknown>,
    proposedCases: [],
    removedTestCaseIds: [request.targetTestCaseId!],
    rationale: request.humanComment ? `Deletion requested: ${request.humanComment}` : 'Deletion requested.',
    evidenceRefs: [],
    unresolvedIssues: [],
  });
  return store.updateRequestStatus(request.id, 'PROPOSAL_READY', { proposalId: proposal.id });
}

/** Which statuses a request may be processed from. */
export const PROCESSABLE: ReadonlySet<RequestStatus> = new Set(['PENDING', 'CHANGES_REQUESTED', 'FAILED']);

/**
 * Run the review agent for a request. `runAgent` does the model work and
 * must submit through `submitAgentProposal`; this only moves the request
 * through its states. A run that submits nothing leaves the request FAILED
 * and retryable, and the suite untouched.
 */
export async function processChangeRequest(
  store: ReviewStore,
  id: string,
  runAgent: (request: ChangeRequest) => Promise<void>,
): Promise<ChangeRequest> {
  return finishProcessing(store, await beginProcessing(store, id), runAgent);
}

/** Check a request can be processed and mark it PROCESSING — before anyone is told it started. */
export async function beginProcessing(store: ReviewStore, id: string): Promise<ChangeRequest> {
  const request = await store.getRequest(id);
  if (!request) throw new ReviewInputError(`No request ${id}.`);
  if (request.operation === 'delete') throw new ReviewInputError('A deletion is proposed by the host; there is nothing to process.');
  if (!PROCESSABLE.has(request.status)) throw new ReviewConflictError(`Request ${id} is ${request.status} and cannot be processed now.`);
  return store.updateRequestStatus(id, 'PROCESSING');
}

/** Run the agent for a request `beginProcessing` started, and record the outcome. */
export async function finishProcessing(
  store: ReviewStore,
  started: ChangeRequest,
  runAgent: (request: ChangeRequest) => Promise<void>,
): Promise<ChangeRequest> {
  const id = started.id;
  const before = new Set((await store.listProposals(id)).map((p) => p.id));
  try {
    await runAgent(started);
  } catch (error) {
    return store.updateRequestStatus(id, 'FAILED', { error: `The review agent failed: ${(error as Error).message}`.slice(0, 500) });
  }
  const fresh = (await store.listProposals(id)).filter((p) => !before.has(p.id) && p.status === 'READY');
  const latest = fresh.at(-1);
  if (!latest) return store.updateRequestStatus(id, 'FAILED', { error: 'The review agent did not submit a proposal.' });
  return store.updateRequestStatus(id, 'PROPOSAL_READY', { proposalId: latest.id });
}

/** Any request left PROCESSING by a process that no longer exists becomes retryable. */
export async function recoverInterrupted(store: ReviewStore): Promise<number> {
  let n = 0;
  for (const r of await store.listRequests()) {
    if (r.status !== 'PROCESSING') continue;
    await store.updateRequestStatus(r.id, 'FAILED', { error: 'Processing was interrupted. Process it again.' });
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Proposals from the agent
// ---------------------------------------------------------------------------

export interface AgentDraft {
  cases: Record<string, unknown>[];
  rationale: string;
  evidenceRefs: string[];
  unresolvedIssues: string[];
}

/**
 * Store what the review agent proposes for `request`. The host, not the
 * model, decides every id: an update keeps its target's id, anything new gets
 * an id no case has ever had.
 */
export async function submitAgentProposal(store: ReviewStore, ws: Workspace, request: ChangeRequest, draft: AgentDraft): Promise<ChangeProposal> {
  if (request.status !== 'PROCESSING') throw new ReviewConflictError(`Request ${request.id} is not being processed.`);
  const suite = ws.readTestCases();
  const base = ws.testCasesSha256();
  if (!suite || !base) throw new ReviewInputError('There is no test suite.');
  if (request.operation === 'update' && draft.cases.length === 0) throw new ReviewInputError('An update must contain the complete resulting case.');
  if (request.operation === 'create' && draft.cases.length === 0 && draft.unresolvedIssues.length === 0) {
    throw new ReviewInputError('Propose a case, or say in unresolvedIssues why none can be supported.');
  }

  const taken = await knownCaseIds(store, suite);
  const fresh = idAllocator(suite, taken);
  const cases = draft.cases.map((c, i) => {
    const { id: _ignored, ...rest } = c;
    const keepTarget = request.operation === 'update' && i === 0;
    return { id: keepTarget ? request.targetTestCaseId! : fresh(), ...rest };
  });

  const proposal: NewProposal = {
    requestId: request.id,
    operation: request.operation,
    ...(request.targetTestCaseId ? { targetTestCaseId: request.targetTestCaseId } : {}),
    baseTestCasesSha256: base,
    author: 'agent',
    ...(request.targetTestCaseId ? { baseCase: suite.testCases.find((tc) => tc.id === request.targetTestCaseId) as unknown as Record<string, unknown> } : {}),
    proposedCases: cases,
    removedTestCaseIds: [],
    rationale: draft.rationale,
    evidenceRefs: draft.evidenceRefs,
    unresolvedIssues: draft.unresolvedIssues.filter((s) => s.trim() !== ''),
  };
  return store.saveProposal(proposal);
}

/** Every case id the suite or the review history has ever used — deleted ones are never reissued. */
async function knownCaseIds(store: ReviewStore, suite: TestCases): Promise<Set<string>> {
  const ids = new Set(suite.testCases.map((tc) => tc.id));
  for (const p of await store.listProposals()) {
    if (p.status !== 'APPLIED') continue;
    for (const id of p.removedTestCaseIds) ids.add(id);
    for (const c of p.proposedCases) if (typeof c.id === 'string') ids.add(c.id);
  }
  for (const r of await store.listRequests()) if (r.targetTestCaseId) ids.add(r.targetTestCaseId);
  return ids;
}

/** New ids in the suite's own style, above every id ever used. Never `length + 1`. */
export function idAllocator(suite: TestCases, taken: Set<string>): () => string {
  const styled = suite.testCases.map((tc) => CASE_ID.exec(tc.id)).find(Boolean);
  const prefix = styled?.[1] ?? 'TC-';
  const width = styled?.[2].length ?? 3;
  let max = 0;
  for (const id of taken) {
    const m = CASE_ID.exec(id);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return () => {
    let id: string;
    do id = `${prefix}${String(++max).padStart(width, '0')}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
}

// ---------------------------------------------------------------------------
// Validation — recomputed, never read from the proposal
// ---------------------------------------------------------------------------

export interface Impact {
  /** Requirement ids the affected cases covered before. */
  coveredBefore: string[];
  coveredAfter: string[];
  /** Requirements no case would cover any more. */
  wouldBecomeUncovered: string[];
  /** Behaviors no case would cite any more. */
  evidenceNoLongerCited: string[];
}

export type ValidationStatus = 'VALID' | 'INVALID' | 'UNRESOLVED' | 'STALE';

export interface ProposalValidation {
  status: ValidationStatus;
  /** Why it cannot be applied. */
  problems: string[];
  /** What a person should know, without blocking: coverage loss, possible duplicates. */
  warnings: string[];
  duplicates: { testCaseId: string; similarTo: string }[];
  impact: Impact;
  applicable: boolean;
}

/** The suite that applying `proposal` to `suite` would produce, or why there is none. */
export function candidateSuite(suite: TestCases, proposal: ChangeProposal): { candidate?: TestCases; problems: string[] } {
  const problems: string[] = [];
  const active = new Set(suite.testCases.map((tc) => tc.id));
  const proposedIds = proposal.proposedCases.map((c) => (typeof c.id === 'string' ? c.id : ''));
  if (new Set(proposedIds).size !== proposedIds.length) problems.push('Proposed cases repeat an id.');

  let cases = [...suite.testCases];
  switch (proposal.operation) {
    case 'delete': {
      for (const id of proposal.removedTestCaseIds) if (!active.has(id)) problems.push(`${id} is not an active test case.`);
      if (proposal.proposedCases.length > 0) problems.push('A deletion proposes no cases.');
      cases = cases.filter((tc) => !proposal.removedTestCaseIds.includes(tc.id));
      break;
    }
    case 'update': {
      const target = proposal.targetTestCaseId;
      if (!target || !active.has(target)) {
        problems.push(`${target ?? '(none)'} is not an active test case.`);
        break;
      }
      if (proposedIds[0] !== target) problems.push(`An update must keep the id ${target}.`);
      for (const id of proposedIds.slice(1)) if (active.has(id)) problems.push(`${id} already exists.`);
      const [first, ...extra] = proposal.proposedCases as unknown as TestCase[];
      cases = cases.map((tc) => (tc.id === target ? first : tc));
      cases.push(...extra);
      if (proposal.removedTestCaseIds.length > 0) problems.push('An update removes no cases.');
      break;
    }
    case 'create': {
      for (const id of proposedIds) if (active.has(id) || !CASE_ID.test(id)) problems.push(`${id || '(missing id)'} is not a new test case id.`);
      cases.push(...(proposal.proposedCases as unknown as TestCase[]));
      if (proposal.removedTestCaseIds.length > 0) problems.push('A creation removes no cases.');
      break;
    }
  }
  return problems.length > 0 ? { problems } : { candidate: { ...suite, testCases: cases }, problems };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Coverage before and after, from the cases' own `covers` and `evidenceIds`. */
export function impactOf(suite: TestCases, candidate: TestCases, proposal: ChangeProposal): Impact {
  const affected = new Set([...proposal.removedTestCaseIds, ...(proposal.targetTestCaseId ? [proposal.targetTestCaseId] : [])]);
  const before = suite.testCases.filter((tc) => affected.has(tc.id));
  const after = candidate.testCases.filter((tc) => affected.has(tc.id) || proposal.proposedCases.some((c) => c.id === tc.id));
  const coveredBy = (s: TestCases) => new Set(s.testCases.flatMap((tc) => tc.covers ?? []));
  const citedBy = (s: TestCases) => new Set(s.testCases.flatMap((tc) => tc.evidenceIds ?? []));
  const [coveredNow, coveredLater] = [coveredBy(suite), coveredBy(candidate)];
  const [citedNow, citedLater] = [citedBy(suite), citedBy(candidate)];
  return {
    coveredBefore: sortedUnique(before.flatMap((tc) => tc.covers ?? [])),
    coveredAfter: sortedUnique(after.flatMap((tc) => tc.covers ?? [])),
    wouldBecomeUncovered: sortedUnique([...coveredNow].filter((id) => !coveredLater.has(id))),
    evidenceNoLongerCited: sortedUnique([...citedNow].filter((id) => !citedLater.has(id))),
  };
}

/** Word overlap of title + steps + expected result above which a new case may duplicate an active one. */
export const DUPLICATE_SIMILARITY = 0.6;

function caseWords(tc: Partial<TestCase>): Set<string> {
  const steps = Array.isArray(tc.steps) ? tc.steps.flatMap((s) => [s?.action ?? '', s?.expected ?? '']) : [];
  return contentWords(canonical([tc.title ?? '', tc.expectedResult ?? '', ...steps].join(' ')));
}

/** New cases that look like an active one. Flagged for a person; never removed. */
export function possibleDuplicates(suite: TestCases, proposal: ChangeProposal): { testCaseId: string; similarTo: string }[] {
  const fresh = proposal.proposedCases.filter((c) => c.id !== proposal.targetTestCaseId) as unknown as TestCase[];
  const out: { testCaseId: string; similarTo: string }[] = [];
  for (const c of fresh) {
    const words = caseWords(c);
    for (const tc of suite.testCases) {
      if (tc.id === proposal.targetTestCaseId) continue;
      const other = caseWords(tc);
      let shared = 0;
      for (const w of words) if (other.has(w)) shared += 1;
      const union = words.size + other.size - shared;
      if (union > 0 && shared / union >= DUPLICATE_SIMILARITY) out.push({ testCaseId: c.id, similarTo: tc.id });
    }
  }
  return out;
}

/** "testCases[3].steps[0]" -> 3 */
function caseIndex(path: string): number | undefined {
  const m = /^testCases\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/**
 * Whether `proposal` may be applied to the suite as it is on disk now. Every
 * rule is re-run here; the proposal file is only an input.
 *
 * Semantic problems count against a proposal only when it introduces them —
 * in a case it proposes, or suite-wide where the current suite has none — so
 * an unrelated problem elsewhere cannot block a good change. Coverage getting
 * worse is impact for a person to weigh, not a refusal.
 */
export function validateProposal(ws: Workspace, proposal: ChangeProposal): ProposalValidation {
  const emptyImpact: Impact = { coveredBefore: [], coveredAfter: [], wouldBecomeUncovered: [], evidenceNoLongerCited: [] };
  const suite = ws.readTestCases();
  const sha = ws.testCasesSha256();
  const result = (status: ValidationStatus, problems: string[], rest: Partial<ProposalValidation> = {}): ProposalValidation => ({
    status,
    problems,
    warnings: rest.warnings ?? [],
    duplicates: rest.duplicates ?? [],
    impact: rest.impact ?? emptyImpact,
    applicable: status === 'VALID' && proposal.status === 'READY',
  });
  if (!suite || !sha) return result('INVALID', ['There is no test suite.']);
  if (sha !== proposal.baseTestCasesSha256) {
    return result('STALE', [
      'This proposal was generated from an older version of the test suite. The suite has changed since then. Re-process the request.',
    ]);
  }

  const built = candidateSuite(suite, proposal);
  if (!built.candidate) return result('INVALID', built.problems);
  const candidate = built.candidate;
  const impact = impactOf(suite, candidate, proposal);
  const duplicates = possibleDuplicates(suite, proposal);
  const warnings = [
    ...impact.wouldBecomeUncovered.map((id) => `${id} would no longer be covered by any test case.`),
    ...duplicates.map((d) => `${d.testCaseId} may duplicate ${d.similarTo}.`),
  ];

  const schema = ws.schemaErrors(candidate);
  if (schema.length > 0) return result('INVALID', schema, { warnings, duplicates, impact });

  const proposedIds = new Set(proposal.proposedCases.map((c) => c.id));
  const key = (e: SemanticError) => `${e.code}\u0000${e.value ?? ''}`;
  const existing = new Set(ws.semanticErrors(suite).filter((e) => caseIndex(e.path) === undefined).map(key));
  const problems: string[] = [];
  for (const e of ws.semanticErrors(candidate)) {
    if (COVERAGE_CODES.has(e.code)) continue;
    const i = caseIndex(e.path);
    const introduced = i === undefined ? !existing.has(key(e)) : proposedIds.has(candidate.testCases[i]?.id);
    if (!introduced) continue;
    const where = i === undefined ? e.path : `${candidate.testCases[i].id}${e.path.slice(`testCases[${i}]`.length)}`;
    problems.push(`[${e.code}] ${where}${e.value !== undefined ? ` = ${JSON.stringify(e.value)}` : ''}${e.details ? ` — ${e.details}` : ''}`);
  }
  if (problems.length > 0) return result('INVALID', problems, { warnings, duplicates, impact });
  if (proposal.unresolvedIssues.length > 0) return result('UNRESOLVED', proposal.unresolvedIssues, { warnings, duplicates, impact });
  return result('VALID', [], { warnings, duplicates, impact });
}

// ---------------------------------------------------------------------------
// A person's decisions
// ---------------------------------------------------------------------------

async function activeProposal(store: ReviewStore, id: string): Promise<{ proposal: ChangeProposal; request: ChangeRequest }> {
  const proposal = await store.getProposal(id);
  if (!proposal) throw new ReviewInputError(`No proposal ${id}.`);
  const request = await store.getRequest(proposal.requestId);
  if (!request) throw new ReviewInputError(`Proposal ${id} belongs to no request.`);
  if (proposal.status !== 'READY' || request.status !== 'PROPOSAL_READY' || request.latestProposalId !== proposal.id) {
    throw new ReviewConflictError(`Proposal ${id} is ${proposal.status}; only the latest READY proposal can be acted on.`);
  }
  return { proposal, request };
}

/**
 * Apply a proposal to the canonical suite. The host re-reads the proposal,
 * refuses a stale or invalid one, rebuilds the candidate suite from the
 * suite on disk, and replaces test-cases.json atomically. Only then is the
 * proposal marked applied.
 */
export async function applyProposal(store: ReviewStore, ws: Workspace, id: string): Promise<{ request: ChangeRequest; impact: Impact }> {
  const { proposal, request } = await activeProposal(store, id);
  const validation = validateProposal(ws, proposal);
  if (validation.status === 'STALE') throw new ReviewConflictError(validation.problems[0]);
  if (validation.status !== 'VALID') throw new ReviewConflictError(`Proposal ${id} cannot be applied (${validation.status}): ${validation.problems.slice(0, 3).join('; ')}`);
  const { candidate } = candidateSuite(ws.readTestCases()!, proposal);
  ws.writeTestCases(candidate!);
  await store.markProposalApplied(proposal.id);
  const updated = await store.updateRequestStatus(request.id, 'APPLIED', { proposalId: proposal.id });
  return { request: updated, impact: validation.impact };
}

/** Reject the proposal and close the request. For a deletion, the case stays. */
export async function rejectProposal(store: ReviewStore, id: string, note?: string): Promise<ChangeRequest> {
  const { proposal, request } = await activeProposal(store, id);
  await store.rejectProposal(proposal.id);
  return store.updateRequestStatus(request.id, 'REJECTED', { proposalId: proposal.id, ...(note?.trim() ? { note: note.trim() } : {}) });
}

/** Turn the proposal down with a note; the request can be processed again. */
export async function requestProposalChanges(store: ReviewStore, id: string, note: string): Promise<ChangeRequest> {
  if (!note.trim()) throw new ReviewInputError('Say what should change.');
  const { proposal, request } = await activeProposal(store, id);
  if (proposal.operation === 'delete') throw new ReviewInputError('A deletion is applied or kept; there is nothing to revise.');
  await store.rejectProposal(proposal.id);
  return store.updateRequestStatus(request.id, 'CHANGES_REQUESTED', { proposalId: proposal.id, note: note.trim() });
}
