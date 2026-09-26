import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Proposal, type TestCase } from '../api/client.ts';
import { applyBlockedReason, proposalActions } from '../lib/review-state.ts';
import { TestCaseDiff } from './TestCaseDiff.tsx';
import { CaseView } from './CaseView.tsx';

export function ProposalPanel({ proposal, current }: { proposal: Proposal; current: TestCase | null }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [raw, setRaw] = useState(false);
  const refresh = () => qc.invalidateQueries();
  const apply = useMutation({ mutationFn: () => api.apply(proposal.id), onSettled: refresh });
  const affected = apply.data?.affected ?? [];
  const reject = useMutation({ mutationFn: () => api.reject(proposal.id, note || undefined), onSettled: refresh });
  const revise = useMutation({ mutationFn: () => api.requestChanges(proposal.id, note), onSettled: refresh });
  const labels = proposalActions(proposal.operation);
  const blocked = applyBlockedReason(proposal);
  const v = proposal.validation;
  const error = (apply.error ?? reject.error ?? revise.error) as Error | null;
  const busy = apply.isPending || reject.isPending || revise.isPending;

  return (
    <section className="panel" data-testid="proposal">
      <h3>Proposal {proposal.id} <span className="muted">by {proposal.author === 'host' ? 'the host' : 'the QA agent'} · {proposal.status}</span></h3>
      <p>{proposal.rationale}</p>

      {proposal.operation === 'delete' && <p className="notice warn">Deleting <b>{proposal.removedTestCaseIds.join(', ')}</b>. Until you apply it, the case stays active.</p>}
      {proposal.operation === 'update' && proposal.proposedCases[0] && (
        <>
          <h4>{proposal.baseCase ? 'Before vs proposed' : 'Current vs proposed'}</h4>
          <TestCaseDiff current={proposal.baseCase ?? current ?? undefined} proposed={proposal.proposedCases[0]} />
        </>
      )}
      {(proposal.operation === 'create' ? proposal.proposedCases : proposal.proposedCases.slice(1)).map((c) => (
        <div key={c.id} className="new-case"><h4>New case {c.id}</h4><CaseView testCase={c} /></div>
      ))}

      {v && (
        <div className={`validation ${v.status.toLowerCase()}`} data-testid="validation">
          <b>Host validation: {v.status}</b>
          {v.problems.length > 0 && <ul>{v.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          {v.warnings.length > 0 && <ul className="warnings">{v.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          {(v.impact.coveredBefore.length > 0 || v.impact.wouldBecomeUncovered.length > 0) && (
            <p data-testid="impact">
              Currently covers: {v.impact.coveredBefore.join(', ') || '—'}
              {v.impact.wouldBecomeUncovered.length > 0 && <> · <b>Would become uncovered: {v.impact.wouldBecomeUncovered.join(', ')}</b></>}
              {v.impact.evidenceNoLongerCited.length > 0 && <> · Evidence no longer cited: {v.impact.evidenceNoLongerCited.join(', ')}</>}
            </p>
          )}
        </div>
      )}
      {proposal.unresolvedIssues.length > 0 && (
        <div className="notice warn"><b>Unresolved</b><ul>{proposal.unresolvedIssues.map((u, i) => <li key={i}>{u}</li>)}</ul></div>
      )}
      {proposal.evidenceRefs.length > 0 && <p className="muted">Evidence relied on: {proposal.evidenceRefs.join(', ')}</p>}

      {proposal.status === 'READY' && (
        <div className="actions">
          <textarea placeholder="Optional note (required for Request Changes)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="buttons">
            <button className="primary" disabled={!!blocked || busy} title={blocked} onClick={() => apply.mutate()}>{labels.apply}</button>
            <button disabled={busy} onClick={() => reject.mutate()}>{labels.reject}</button>
            {labels.revise && <button disabled={busy || !note.trim()} onClick={() => revise.mutate()}>{labels.revise}</button>}
          </div>
          {blocked && <p className="muted" data-testid="apply-blocked">{blocked}</p>}
        </div>
      )}
      {apply.data && (
        <div className="notice warn" data-testid="apply-impact">
          <b>Applied.</b> {affected.length ? <>Your change affected: {affected.join(', ')}. </> : null}
          No upstream evidence artifacts were changed.
          {apply.data.bugsReferencingChangedCases.length > 0 && <> Bug reports naming this case: {apply.data.bugsReferencingChangedCases.join(', ')}.</>}
          {' '}Refresh the dependent analysis on the Overview, then approve Phase 1 again.
        </div>
      )}
      {error && <p className="notice bad">{error.message}</p>}
      <button className="link" onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} raw JSON</button>
      {raw && <pre>{JSON.stringify(proposal, null, 2)}</pre>}
    </section>
  );
}
