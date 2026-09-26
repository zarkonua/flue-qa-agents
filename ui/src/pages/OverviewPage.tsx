import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { Phase1Notice } from '../components/Phase1Status.tsx';

export function OverviewPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 5000 });
  const approve = useMutation({ mutationFn: api.approvePhase1, onSettled: () => qc.invalidateQueries() });
  const refresh = useMutation({ mutationFn: api.refreshPrioritization, onSettled: () => qc.invalidateQueries() });
  if (!data) return <p>Loading…</p>;
  const { counts, coverage, prioritization: p } = data;
  return (
    <>
      <h1>Overview</h1>
      <p className="muted">Artifacts: <code>{data.artifactRoot}</code></p>
      <div className="tiles">
        <div className="tile"><b>{counts.testCases}</b>Test cases</div>
        <div className="tile"><b>{counts.pendingReviews}</b>Pending changes</div>
        <div className="tile"><b>{counts.bugs}</b>Bugs ({counts.confirmedBugs} confirmed, {counts.potentialBugs} potential)</div>
        <div className="tile"><b>{counts.openBugs}</b>Open bugs (not rejected)</div>
        {coverage && <div className="tile"><b>{coverage.covered}/{coverage.testable}</b>Requirements covered</div>}
      </div>

      {data.requirements.length > 0 && (
        <>
          <h2>Requirements</h2>
          <table className="list" data-testid="requirements">
            <thead><tr><th>ID</th><th>Statement</th><th>Validation</th><th>Covered by</th></tr></thead>
            <tbody>
              {data.requirements.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}<br /><span className="muted">{r.kind === 'acceptancePoint' ? 'acceptance point' : 'business rule'}</span></td>
                  <td>{r.statement}</td>
                  <td>{r.testable ? (r.validationType ?? '—') : 'not testable'}</td>
                  <td>{r.coveredBy.length === 0
                    ? <span className={r.testable ? 'bad' : 'muted'}>{r.testable ? 'UNCOVERED' : '—'}</span>
                    : r.coveredBy.map((c) => <Link key={c} to={`/test-cases/${c}`}>{c} </Link>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Automation prioritization</h2>
      <p className={`notice ${p.state === 'CURRENT' ? 'ok' : 'warn'}`} data-testid="prioritization-state">
        {p.state === 'CURRENT' ? 'CURRENT — covers every active case.' : `${p.state === 'MISSING' ? 'MISSING' : 'PRIORITIZATION STALE'}${p.detail ? ` — ${p.detail}` : ''}. Phase 1 is not ready until it is refreshed.`}
        {p.refresh.status !== 'IDLE' && <><br />Refresh: {p.refresh.status}{p.refresh.at ? ` (${p.refresh.at})` : ''}</>}
      </p>
      {p.state !== 'CURRENT' && (
        <button disabled={refresh.isPending || p.refresh.status === 'RUNNING'} onClick={() => refresh.mutate()}>
          Re-run prioritization and defect analysis
        </button>
      )}
      {p.refresh.status === 'FAILED' && p.refresh.output && <pre>{p.refresh.output}</pre>}

      <h2>Phase 1 approval</h2>
      <Phase1Notice phase1={data.phase1} />
      {data.phase1.findings > 0 && <p className="muted">{data.phase1.findings} semantic finding(s) — approval from the command line: <code>npm run qa:approve -- --accept-findings</code></p>}
      <button className="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>Approve Phase 1</button>
      {approve.data?.ok && <p className="notice ok">Approved.</p>}
      {approve.error && <p className="notice bad">{(approve.error as Error).message}</p>}
    </>
  );
}
