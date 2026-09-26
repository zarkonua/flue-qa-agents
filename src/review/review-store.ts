// Workflow state for interactive test-case review: change requests and the
// proposals answering them.
//
// This is WORKFLOW state, not QA results. Canonical artifacts (test cases,
// bug reports, prioritization, the Phase 1 approval) stay in their files and
// are changed only by host code in `test-case-changes.ts`. A proposal here is
// never a change to the suite until a person applies it.
//
// `ReviewStore` is the seam for persistence. `FileReviewStore` keeps one JSON
// file per record under the artifact root; a database-backed store can replace
// it without changing the API routes, the UI or the review-agent flow. Every
// method is async for that reason, although files do not need it.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../lib/atomic-write.ts';
import { formatSchemaIssue, validateWithSchema } from '../lib/schema-validation.ts';

const SCHEMAS = resolve(import.meta.dirname, '..', '..', 'schemas');

export const OPERATIONS = ['update', 'create', 'delete'] as const;
export type Operation = (typeof OPERATIONS)[number];

export const REQUEST_STATUSES = ['PENDING', 'PROCESSING', 'PROPOSAL_READY', 'CHANGES_REQUESTED', 'REJECTED', 'APPLIED', 'FAILED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type ProposalStatus = 'READY' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED';

/** Fields a person may edit on a case. The id, coverage and evidence are not among them. */
export const EDITABLE_FIELDS = [
  'title', 'priority', 'types', 'preconditions', 'testData', 'steps', 'expectedResult', 'automationCandidate', 'automationReason', 'tags',
] as const;

export interface ManualEdits {
  title?: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  types?: string[];
  preconditions?: string[];
  testData?: Record<string, unknown>;
  steps?: { action: string; expected: string }[];
  expectedResult?: string;
  automationCandidate?: boolean;
  automationReason?: string;
  tags?: string[];
}

export type HistoryEvent = 'created' | 'processing' | 'proposal' | 'failed' | 'rejected' | 'changes_requested' | 'applied' | 'comment';

export interface ChangeRequest {
  id: string;
  operation: Operation;
  targetTestCaseId?: string;
  /** SHA-256 of test-cases.json when the request was made. */
  baseTestCasesSha256: string;
  humanComment?: string;
  manualEdits?: ManualEdits;
  status: RequestStatus;
  latestProposalId?: string;
  error?: string;
  history: { at: string; event: HistoryEvent; note?: string; proposalId?: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ChangeProposal {
  id: string;
  requestId: string;
  operation: Operation;
  targetTestCaseId?: string;
  /** SHA-256 of the suite this proposal was generated from. Apply refuses any other. */
  baseTestCasesSha256: string;
  author: 'agent' | 'host';
  /** The target case as it was when this proposal was made — what its diff is against, forever. */
  baseCase?: Record<string, unknown>;
  /** Complete resulting cases — never a description of a change. */
  proposedCases: Record<string, unknown>[];
  removedTestCaseIds: string[];
  rationale: string;
  evidenceRefs: string[];
  unresolvedIssues: string[];
  status: ProposalStatus;
  createdAt: string;
}

/** A person's action on a bug report, kept as history. The decision itself lives in the bug file. */
export type BugAction = 'accept' | 'reject' | 'downgrade' | 'request-changes' | 'edit'
  /** The host carried a review across a regenerated defect analysis. */
  | 'reconcile';

export interface BugReviewState {
  status: 'CONFIRMED' | 'POTENTIAL';
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CHANGES_REQUESTED';
  severity: 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'TRIVIAL';
  priority: 'UNASSIGNED' | 'P0' | 'P1' | 'P2' | 'P3';
}

export interface BugReviewEvent {
  at: string;
  action: BugAction;
  by: string;
  /** Where the person acted — the command line or the workspace. */
  via?: 'cli' | 'ui';
  note?: string;
  editedFields?: string[];
  before: BugReviewState;
  after: BugReviewState;
}

export type NewRequest = Pick<ChangeRequest, 'operation' | 'targetTestCaseId' | 'baseTestCasesSha256' | 'humanComment' | 'manualEdits'>;
export type NewProposal = Omit<ChangeProposal, 'id' | 'status' | 'createdAt'>;

export class ReviewStoreError extends Error {
  name = 'ReviewStoreError';
}

export interface ReviewStore {
  createRequest(input: NewRequest): Promise<ChangeRequest>;
  getRequest(id: string): Promise<ChangeRequest | undefined>;
  listRequests(): Promise<ChangeRequest[]>;
  /** Move a request to `status`, recording why. The caller enforces which moves are legal. */
  updateRequestStatus(id: string, status: RequestStatus, detail?: { event?: HistoryEvent; note?: string; error?: string; proposalId?: string }): Promise<ChangeRequest>;
  addComment(id: string, note: string): Promise<ChangeRequest>;

  /** Store a proposal as READY; earlier READY proposals of the same request become SUPERSEDED. */
  saveProposal(input: NewProposal): Promise<ChangeProposal>;
  getProposal(id: string): Promise<ChangeProposal | undefined>;
  listProposals(requestId?: string): Promise<ChangeProposal[]>;
  rejectProposal(id: string): Promise<ChangeProposal>;
  markProposalApplied(id: string): Promise<ChangeProposal>;

  /** Append one round of a person's review of a bug report. */
  addBugReviewEvent(bugId: string, event: BugReviewEvent): Promise<BugReviewEvent[]>;
  listBugReviewEvents(bugId: string): Promise<BugReviewEvent[]>;
  /** Every bug id with review history. */
  listBugReviewIds(): Promise<string[]>;
  /**
   * Replace all bug review histories at once — after a regenerated defect
   * analysis, when reports get new ids. Ids not in `histories` lose theirs;
   * the caller archives the old set first.
   */
  replaceBugReviewHistories(histories: Record<string, BugReviewEvent[]>): Promise<void>;
}

export const REQUEST_ID = /^REQ-[0-9]{4,}$/;
export const BUG_REVIEW_ID = /^BUG-[0-9]{3,}$/;
export const PROPOSAL_ID = /^PRP-[0-9]{4,}$/;

const now = () => new Date().toISOString();

/**
 * One JSON file per record:
 *
 *   <root>/requests/REQ-0001.json
 *   <root>/proposals/PRP-0001.json
 *   <root>/bugs/BUG-001.json          review history of one bug report
 *
 * Every read is schema-checked: a file edited by hand into something invalid
 * is refused, never trusted. Ids are validated before they become file names.
 */
export class FileReviewStore implements ReviewStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(kind: Kind) {
    return join(this.root, kind);
  }

  private path(kind: Kind, id: string) {
    if (!KINDS[kind].pattern.test(id)) throw new ReviewStoreError(`Not a ${KINDS[kind].noun} id: ${JSON.stringify(id)}`);
    return join(this.dir(kind), `${id}.json`);
  }

  private read<T>(kind: Kind, id: string): T | undefined {
    const path = this.path(kind, id);
    if (!existsSync(path)) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new ReviewStoreError(`${kind}/${id}.json is not valid JSON.`);
    }
    const issues = validateWithSchema(join(SCHEMAS, KINDS[kind].schema), data);
    if (issues.length > 0) throw new ReviewStoreError(`${kind}/${id}.json is invalid: ${issues.slice(0, 3).map(formatSchemaIssue).join('; ')}`);
    const own = (data as Record<string, unknown>)[KINDS[kind].key];
    if (own !== id) throw new ReviewStoreError(`${kind}/${id}.json claims to be ${String(own)}.`);
    return data as T;
  }

  private write(kind: Kind, record: object) {
    const issues = validateWithSchema(join(SCHEMAS, KINDS[kind].schema), record);
    if (issues.length > 0) throw new ReviewStoreError(`Refusing to store an invalid ${KINDS[kind].noun}: ${issues.slice(0, 3).map(formatSchemaIssue).join('; ')}`);
    atomicWriteFile(this.path(kind, String((record as Record<string, unknown>)[KINDS[kind].key])), JSON.stringify(record, null, 2));
  }

  private ids(kind: Kind): string[] {
    const dir = this.dir(kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => f.replace(/\.json$/, '')).filter((id) => KINDS[kind].pattern.test(id)).sort();
  }

  private nextId(kind: 'requests' | 'proposals'): string {
    const max = this.ids(kind).reduce((m, id) => Math.max(m, Number(id.slice(4))), 0);
    return `${kind === 'requests' ? 'REQ' : 'PRP'}-${String(max + 1).padStart(4, '0')}`;
  }

  /** Every readable record; an invalid file is skipped here and reported when fetched by id. */
  private all<T>(kind: Kind): T[] {
    const out: T[] = [];
    for (const id of this.ids(kind)) {
      try {
        const r = this.read<T>(kind, id);
        if (r) out.push(r);
      } catch {
        // Listed nowhere, trusted nowhere.
      }
    }
    return out;
  }

  async createRequest(input: NewRequest): Promise<ChangeRequest> {
    const at = now();
    const request: ChangeRequest = {
      id: this.nextId('requests'),
      operation: input.operation,
      ...(input.targetTestCaseId !== undefined ? { targetTestCaseId: input.targetTestCaseId } : {}),
      baseTestCasesSha256: input.baseTestCasesSha256,
      ...(input.humanComment ? { humanComment: input.humanComment } : {}),
      ...(input.manualEdits && Object.keys(input.manualEdits).length > 0 ? { manualEdits: input.manualEdits } : {}),
      status: 'PENDING',
      history: [{ at, event: 'created', ...(input.humanComment ? { note: input.humanComment } : {}) }],
      createdAt: at,
      updatedAt: at,
    };
    this.write('requests', request);
    return request;
  }

  async getRequest(id: string) {
    return this.read<ChangeRequest>('requests', id);
  }

  async listRequests() {
    return this.all<ChangeRequest>('requests');
  }

  async updateRequestStatus(id: string, status: RequestStatus, detail: { event?: HistoryEvent; note?: string; error?: string; proposalId?: string } = {}) {
    const request = this.read<ChangeRequest>('requests', id);
    if (!request) throw new ReviewStoreError(`No request ${id}.`);
    const at = now();
    const { error: _previous, ...rest } = request;
    const next: ChangeRequest = {
      ...rest,
      status,
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.proposalId ? { latestProposalId: detail.proposalId } : {}),
      history: [
        ...request.history,
        {
          at,
          event: detail.event ?? eventFor(status),
          ...(detail.note ? { note: detail.note } : detail.error ? { note: detail.error } : {}),
          ...(detail.proposalId ? { proposalId: detail.proposalId } : {}),
        },
      ],
      updatedAt: at,
    };
    this.write('requests', next);
    return next;
  }

  async addComment(id: string, note: string) {
    const request = this.read<ChangeRequest>('requests', id);
    if (!request) throw new ReviewStoreError(`No request ${id}.`);
    const at = now();
    const next = { ...request, history: [...request.history, { at, event: 'comment' as const, note }], updatedAt: at };
    this.write('requests', next);
    return next;
  }

  async saveProposal(input: NewProposal) {
    for (const earlier of this.all<ChangeProposal>('proposals')) {
      if (earlier.requestId === input.requestId && earlier.status === 'READY') this.write('proposals', { ...earlier, status: 'SUPERSEDED' });
    }
    const proposal: ChangeProposal = { ...input, id: this.nextId('proposals'), status: 'READY', createdAt: now() };
    this.write('proposals', proposal);
    return proposal;
  }

  async getProposal(id: string) {
    return this.read<ChangeProposal>('proposals', id);
  }

  async listProposals(requestId?: string) {
    const all = this.all<ChangeProposal>('proposals');
    return requestId === undefined ? all : all.filter((p) => p.requestId === requestId);
  }

  private setProposalStatus(id: string, status: ProposalStatus) {
    const proposal = this.read<ChangeProposal>('proposals', id);
    if (!proposal) throw new ReviewStoreError(`No proposal ${id}.`);
    const next = { ...proposal, status };
    this.write('proposals', next);
    return next;
  }

  async rejectProposal(id: string) {
    return this.setProposalStatus(id, 'REJECTED');
  }

  async markProposalApplied(id: string) {
    return this.setProposalStatus(id, 'APPLIED');
  }

  async addBugReviewEvent(bugId: string, event: BugReviewEvent) {
    const history = this.read<{ bugId: string; events: BugReviewEvent[] }>('bugs', bugId) ?? { bugId, events: [] };
    const next = { bugId, events: [...history.events, event] };
    this.write('bugs', next);
    return next.events;
  }

  async listBugReviewEvents(bugId: string) {
    return this.read<{ bugId: string; events: BugReviewEvent[] }>('bugs', bugId)?.events ?? [];
  }

  async listBugReviewIds() {
    return this.ids('bugs');
  }

  async replaceBugReviewHistories(histories: Record<string, BugReviewEvent[]>) {
    // Validate everything before touching anything.
    const records = Object.entries(histories).filter(([, events]) => events.length > 0).map(([bugId, events]) => ({ bugId, events }));
    for (const r of records) {
      const issues = validateWithSchema(join(SCHEMAS, KINDS.bugs.schema), r);
      if (issues.length > 0) throw new ReviewStoreError(`Refusing to store an invalid bug review history: ${issues.slice(0, 3).map(formatSchemaIssue).join('; ')}`);
    }
    const keep = new Set(records.map((r) => r.bugId));
    for (const r of records) this.write('bugs', r);
    for (const id of this.ids('bugs')) if (!keep.has(id)) rmSync(this.path('bugs', id), { force: true });
  }
}

type Kind = 'requests' | 'proposals' | 'bugs';
const KINDS: Record<Kind, { pattern: RegExp; schema: string; key: string; noun: string }> = {
  requests: { pattern: REQUEST_ID, schema: 'review-request.schema.json', key: 'id', noun: 'request' },
  proposals: { pattern: PROPOSAL_ID, schema: 'review-proposal.schema.json', key: 'id', noun: 'proposal' },
  bugs: { pattern: BUG_REVIEW_ID, schema: 'review-bug-history.schema.json', key: 'bugId', noun: 'bug review history' },
};

function eventFor(status: RequestStatus): HistoryEvent {
  switch (status) {
    case 'PROCESSING': return 'processing';
    case 'PROPOSAL_READY': return 'proposal';
    case 'FAILED': return 'failed';
    case 'REJECTED': return 'rejected';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'APPLIED': return 'applied';
    default: return 'comment';
  }
}
