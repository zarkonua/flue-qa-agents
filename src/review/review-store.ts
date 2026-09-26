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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
}

export const REQUEST_ID = /^REQ-[0-9]{4,}$/;
export const PROPOSAL_ID = /^PRP-[0-9]{4,}$/;

const now = () => new Date().toISOString();

/**
 * One JSON file per record:
 *
 *   <root>/requests/REQ-0001.json
 *   <root>/proposals/PRP-0001.json
 *
 * Every read is schema-checked: a file edited by hand into something invalid
 * is refused, never trusted. Ids are validated before they become file names.
 */
export class FileReviewStore implements ReviewStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(kind: 'requests' | 'proposals') {
    return join(this.root, kind);
  }

  private path(kind: 'requests' | 'proposals', id: string) {
    const pattern = kind === 'requests' ? REQUEST_ID : PROPOSAL_ID;
    if (!pattern.test(id)) throw new ReviewStoreError(`Not a ${kind === 'requests' ? 'request' : 'proposal'} id: ${JSON.stringify(id)}`);
    return join(this.dir(kind), `${id}.json`);
  }

  private read<T>(kind: 'requests' | 'proposals', id: string): T | undefined {
    const path = this.path(kind, id);
    if (!existsSync(path)) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new ReviewStoreError(`${kind}/${id}.json is not valid JSON.`);
    }
    const schema = join(SCHEMAS, kind === 'requests' ? 'review-request.schema.json' : 'review-proposal.schema.json');
    const issues = validateWithSchema(schema, data);
    if (issues.length > 0) throw new ReviewStoreError(`${kind}/${id}.json is invalid: ${issues.slice(0, 3).map(formatSchemaIssue).join('; ')}`);
    if ((data as { id: string }).id !== id) throw new ReviewStoreError(`${kind}/${id}.json claims to be ${(data as { id: string }).id}.`);
    return data as T;
  }

  private write(kind: 'requests' | 'proposals', record: { id: string }) {
    const schema = join(SCHEMAS, kind === 'requests' ? 'review-request.schema.json' : 'review-proposal.schema.json');
    const issues = validateWithSchema(schema, record);
    if (issues.length > 0) throw new ReviewStoreError(`Refusing to store an invalid ${kind.slice(0, -1)}: ${issues.slice(0, 3).map(formatSchemaIssue).join('; ')}`);
    atomicWriteFile(this.path(kind, record.id), JSON.stringify(record, null, 2));
  }

  private ids(kind: 'requests' | 'proposals'): string[] {
    const dir = this.dir(kind);
    if (!existsSync(dir)) return [];
    const pattern = kind === 'requests' ? REQUEST_ID : PROPOSAL_ID;
    return readdirSync(dir).map((f) => f.replace(/\.json$/, '')).filter((id) => pattern.test(id)).sort();
  }

  private nextId(kind: 'requests' | 'proposals'): string {
    const max = this.ids(kind).reduce((m, id) => Math.max(m, Number(id.slice(4))), 0);
    return `${kind === 'requests' ? 'REQ' : 'PRP'}-${String(max + 1).padStart(4, '0')}`;
  }

  /** Every readable record; an invalid file is skipped here and reported when fetched by id. */
  private all<T>(kind: 'requests' | 'proposals'): T[] {
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
}

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
