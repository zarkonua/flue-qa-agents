import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { ProposalPanel } from '../components/ProposalPanel.tsx';
import { CaseView } from '../components/CaseView.tsx';
import { canProcess, isInFlight, STATUS_LABEL, statusTone } from '../lib/review-state.ts';

export function ReviewPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['review', id],
    queryFn: () => api.review(id),
    refetchInterval: (q) => (q.state.data && isInFlight(q.state.data.request.status, q.state.data.request.processing) ? 1500 : false),
  });
  const process = useMutation({ mutationFn: () => api.process(id), onSettled: () => qc.invalidateQueries() });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const { request: r, currentCase, proposals } = data;
  const latest = proposals.find((p) => p.id === r.latestProposalId);
  const earlier = proposals.filter((p) => p.id !== r.latestProposalId).reverse();

  return (
    <>
      <h1>{r.id} <span className="muted">{r.operation}{r.targetTestCaseId ? ` of ${r.targetTestCaseId}` : ' — new test case'}</span></h1>
      <p className={`status ${statusTone(r.status)}`} data-testid="request-status">{STATUS_LABEL[r.status]}{isInFlight(r.status, r.processing) ? ' — the QA agent is working…' : ''}</p>
      {r.error && <p className="notice bad">{r.error}</p>}
      {r.humanComment && <p><b>Request:</b> {r.humanComment}</p>}
      {r.manualEdits && <p><b>Manual edits:</b> {Object.keys(r.manualEdits).join(', ')}</p>}
      {canProcess(r.operation, r.status) && (
        <button className="primary" disabled={process.isPending} onClick={() => process.mutate()}>Process with QA Agent</button>
      )}
      {process.error && <p className="notice bad">{(process.error as Error).message}</p>}

      {latest && <ProposalPanel proposal={latest} current={currentCase} />}
      {!latest && currentCase && <section className="panel"><h3>Active case {currentCase.id}</h3><CaseView testCase={currentCase} /></section>}
      {r.targetTestCaseId && <p><Link to={`/test-cases/${r.targetTestCaseId}`}>Open {r.targetTestCaseId}</Link></p>}

      <h2>History</h2>
      <ul className="history">
        {r.history.map((h, i) => <li key={i}><span className="muted">{h.at}</span> {h.event}{h.proposalId ? ` ${h.proposalId}` : ''}{h.note ? ` — ${h.note}` : ''}</li>)}
      </ul>
      {earlier.length > 0 && (
        <details>
          <summary>Earlier proposals ({earlier.length})</summary>
          {earlier.map((p) => <ProposalPanel key={p.id} proposal={p} current={currentCase} />)}
        </details>
      )}
    </>
  );
}
