import type { Phase1 } from '../api/client.ts';

const TEXT: Record<Phase1['state'], string> = { NONE: 'NOT APPROVED', APPROVED: 'APPROVED', STALE: 'STALE' };

export function Phase1Badge({ phase1 }: { phase1: Phase1 }) {
  return <span className={`badge phase1 ${phase1.state.toLowerCase()}`} data-testid="phase1-state">Phase 1: {TEXT[phase1.state]}</span>;
}

export function Phase1Notice({ phase1 }: { phase1: Phase1 }) {
  if (phase1.state === 'STALE') {
    return (
      <p className="notice warn" data-testid="phase1-stale">
        Phase 1 approval is stale because reviewed artifacts changed: {phase1.changed.join(', ')}. Approve Phase 1 again.
      </p>
    );
  }
  if (phase1.state === 'APPROVED') return <p className="notice ok">Phase 1 approved by {phase1.approvedBy} at {phase1.approvedAt}.</p>;
  return <p className="notice">Phase 1 is not approved.</p>;
}
