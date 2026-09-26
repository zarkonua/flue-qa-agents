import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DependencyState, type Reconciliation } from '../api/client.ts';
import { Phase1Notice } from '../components/Phase1Status.tsx';

function State({ state }: { state: string }) {
  return <span className={`badge ${state === 'CURRENT' || state === 'APPROVED' ? 'approved' : state === 'MISSING' || state === 'NONE' ? 'none' : 'stale'}`}>{state}</span>;
}

const why = (d: DependencyState) => (d.reasons.length ? d.reasons.join(' ') : d.state === 'CURRENT' ? 'Matches its inputs.' : '');

function ReconciliationSummary({ r }: { r: Reconciliation }) {
  const ids = (xs: string[]) => xs.join(', ') || '—';
  return (
    <div className="panel" data-testid="reconciliation">
      <h4>Bug reviews after refresh</h4>
      <p><b>Preserved ({r.preserved.length})</b> — materially the same defect; the earlier decision carried over:{' '}
        {r.preserved.map((p) => `${p.from} → ${p.to} (${p.decision}${p.editsCarried ? ', with edits' : ''})`).join(', ') || '—'}</p>
      <p><b>Reset ({r.reset.length})</b> — the finding changed; back to PENDING:{' '}
        {r.reset.map((p) => `${p.from} → ${p.to} (was ${p.previousDecision})`).join(', ') || '—'}</p>
      <p><b>New ({r.added.length})</b> — PENDING: {ids(r.added)}</p>
      <p><b>Removed ({r.removed.length})</b> — no longer produced; kept in the archive: {r.removed.map((x) => `${x.id} (${x.previousDecision})`).join(', ') || '—'}</p>
    </div>
  );
}

export function OverviewPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: (q) => (q.state.data?.health.refresh.status === 'RUNNING' ? 2000 : 5000),
  });
  const [confirming, setConfirming] = useState(false);
  const approve = useMutation({ mutationFn: api.approvePhase1, onSettled: () => qc.invalidateQueries() });
  const refresh = useMutation({ mutationFn: api.refreshDependents, onSettled: () => { setConfirming(false); return qc.invalidateQueries(); } });
  if (!data) return <p>Loading…</p>;
  const { counts, health: h } = data;
  const running = h.refresh.status === 'RUNNING';

  return (
    <>
      <h1>Overview</h1>
      <p className="muted">Artifacts: <code>{data.artifactRoot}</code></p>

      <h2>Phase 1</h2>
      <table className="list" data-testid="phase1-health">
        <thead><tr><th>Artifact</th><th>Count</th><th>State</th><th>Why</th></tr></thead>
        <tbody>
          <tr data-testid="health-test-cases"><td>Test cases</td><td>{h.testCases.count}</td><td><State state={h.testCases.state} /></td><td className="muted">The source the rows below derive from.</td></tr>
          <tr data-testid="health-prioritization"><td>Automation prioritization</td><td>{h.prioritization.automationCandidates} automation candidates</td><td><State state={h.prioritization.state} /></td><td>{why(h.prioritization)}</td></tr>
          <tr data-testid="health-defects"><td>Defect analysis</td><td>{h.defectAnalysis.confirmed} confirmed · {h.defectAnalysis.potential} potential</td><td><State state={h.defectAnalysis.state} /></td><td>{why(h.defectAnalysis)}</td></tr>
          <tr data-testid="health-review"><td>AI review (advisory)</td><td /><td><State state={h.review.state} /></td><td className="muted">{h.review.state === 'STALE' ? 'Older than the artifacts it summarises; re-run npm run qa:review if you rely on it.' : ''}</td></tr>
          <tr data-testid="health-approval"><td>Human approval</td><td /><td><State state={h.approval.state} /></td><td>{h.approval.state === 'STALE' ? `Changed since approval: ${h.approval.changed.join(', ')}` : ''}</td></tr>
        </tbody>
      </table>
      {h.bugsReferencingChangedCases.length > 0 && (
        <p className="notice warn">Bug reports naming a changed test case: {h.bugsReferencingChangedCases.map((b) => <Link key={b} to={`/bugs/${b}`}>{b} </Link>)}</p>
      )}

      <p data-testid="refresh-state">
        Refresh: <b>{h.refresh.status}</b>{h.refresh.finishedAt ? ` (finished ${h.refresh.finishedAt})` : h.refresh.startedAt ? ` (started ${h.refresh.startedAt})` : ''}
        {running ? ' — Automation Prioritizer, then Defect Analyzer are running…' : ''}
      </p>
      {h.refresh.status === 'FAILED' && h.refresh.error && <p className="notice bad" data-testid="refresh-error">{h.refresh.error} The previous artifacts were kept and remain STALE. You can retry.</p>}
      {h.refresh.status === 'COMPLETED' && h.refresh.reconciliation && <ReconciliationSummary r={h.refresh.reconciliation} />}

      {h.refreshNeeded && !confirming && (
        <button className="primary" disabled={running || refresh.isPending} onClick={() => setConfirming(true)}>Refresh dependent analysis</button>
      )}
      {confirming && (
        <section className="panel" data-testid="refresh-confirm">
          <h3>Refresh dependent analysis</h3>
          <p>This will re-run, with the model:</p>
          <ul><li>Automation Prioritizer</li><li>Defect Analyzer</li></ul>
          <p><b>Bug review impact:</b></p>
          <ul>
            <li>Bug reports are regenerated; existing bug decisions may need re-review{h.decidedBugs.length ? ` (${h.decidedBugs.length} decided: ${h.decidedBugs.join(', ')})` : ''}.</li>
            <li>New bugs start as PENDING.</li>
            <li>Materially unchanged bugs keep their decisions and edits.</li>
            <li>The previous reports are archived; nothing is lost.</li>
          </ul>
          <p className="muted">If either stage fails, nothing is replaced and the artifacts stay STALE. Phase 1 approval is never restored by a refresh.</p>
          <div className="buttons">
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button className="primary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh</button>
          </div>
        </section>
      )}
      {refresh.error && <p className="notice bad">{(refresh.error as Error).message}</p>}

      <h2>Phase 1 approval</h2>
      <Phase1Notice phase1={data.phase1} />
      {data.phase1.findings > 0 && <p className="muted">{data.phase1.findings} semantic finding(s) — approval from the command line: <code>npm run qa:approve -- --accept-findings</code></p>}
      {h.refreshNeeded && <p className="muted">Refresh the dependent analysis before approving: an approval would lock stale artifacts.</p>}
      <button className="primary" disabled={approve.isPending || running} onClick={() => approve.mutate()}>Approve Phase 1</button>
      {approve.data?.ok && <p className="notice ok">Approved.</p>}
      {approve.error && <p className="notice bad">{(approve.error as Error).message}</p>}

      <h2>Workspace</h2>
      <div className="tiles">
        <div className="tile"><b>{counts.testCases}</b>Test cases</div>
        <div className="tile"><b>{counts.pendingReviews}</b>Pending changes</div>
        <div className="tile"><b>{counts.bugs}</b>Bugs ({counts.confirmedBugs} confirmed, {counts.potentialBugs} potential)</div>
        <div className="tile"><b>{counts.openBugs}</b>Open bugs (not rejected)</div>
        {data.coverage && <div className="tile"><b>{data.coverage.covered}/{data.coverage.testable}</b>Requirements covered</div>}
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
    </>
  );
}
