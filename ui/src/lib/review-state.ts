// How review workflow states read, and which actions are allowed — one place,
// so the pages cannot disagree with each other. The host enforces the same
// rules; these only keep the UI honest about them.

export type RequestStatus = 'PENDING' | 'PROCESSING' | 'PROPOSAL_READY' | 'CHANGES_REQUESTED' | 'REJECTED' | 'APPLIED' | 'FAILED';
export type ValidationStatus = 'VALID' | 'INVALID' | 'UNRESOLVED' | 'STALE';
export type Operation = 'update' | 'create' | 'delete';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  PROPOSAL_READY: 'Proposal ready',
  CHANGES_REQUESTED: 'Changes requested',
  REJECTED: 'Rejected',
  APPLIED: 'Applied',
  FAILED: 'Failed',
};

export type Tone = 'neutral' | 'busy' | 'good' | 'warn' | 'bad';

export function statusTone(status: RequestStatus): Tone {
  switch (status) {
    case 'PROCESSING': return 'busy';
    case 'PROPOSAL_READY': return 'warn';
    case 'APPLIED': return 'good';
    case 'FAILED': return 'bad';
    default: return 'neutral';
  }
}

/** The groups the Reviews page shows, in order. */
export const REVIEW_GROUPS: { title: string; statuses: RequestStatus[] }[] = [
  { title: 'Proposal ready', statuses: ['PROPOSAL_READY'] },
  { title: 'Processing', statuses: ['PROCESSING'] },
  { title: 'Pending', statuses: ['PENDING', 'CHANGES_REQUESTED'] },
  { title: 'Failed', statuses: ['FAILED'] },
  { title: 'Recently applied', statuses: ['APPLIED'] },
  { title: 'Rejected', statuses: ['REJECTED'] },
];

/** A request that can be sent to the review agent now. */
export const canProcess = (op: Operation, status: RequestStatus) =>
  op !== 'delete' && (status === 'PENDING' || status === 'CHANGES_REQUESTED' || status === 'FAILED');

/** Keep polling while something is in flight. */
export const isInFlight = (status: RequestStatus, processing = false) => processing || status === 'PROCESSING';

export interface ProposalLike {
  status: 'READY' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED';
  operation: Operation;
  validation?: { status: ValidationStatus; problems: string[] } | null;
}

/** Why Apply is disabled, or undefined when it is allowed. */
export function applyBlockedReason(p: ProposalLike): string | undefined {
  if (p.status !== 'READY') return `This proposal is ${p.status.toLowerCase()}.`;
  const v = p.validation;
  if (!v) return 'This proposal has not been validated.';
  switch (v.status) {
    case 'VALID': return undefined;
    case 'STALE': return 'This proposal was generated from an older version of the test suite. The suite has changed since then. Re-process the request.';
    case 'UNRESOLVED': return 'Unresolved issues must be settled before this can be applied.';
    case 'INVALID': return 'The host rejects this proposal; see the problems below.';
  }
}

/** The action labels for a proposal — never "approve": that is Phase 1's word. */
export function proposalActions(op: Operation): { apply: string; reject: string; revise?: string } {
  return op === 'delete'
    ? { apply: 'Apply Deletion', reject: 'Keep Test Case' }
    : { apply: 'Apply Change', reject: 'Reject', revise: 'Request Changes' };
}
