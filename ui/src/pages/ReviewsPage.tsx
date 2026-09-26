import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { REVIEW_GROUPS, STATUS_LABEL } from '../lib/review-state.ts';

export function ReviewsPage() {
  const { data } = useQuery({ queryKey: ['reviews'], queryFn: api.reviews, refetchInterval: 3000 });
  if (!data) return <><h1>Reviews</h1><p>Loading…</p></>;
  const all = data.reviews;
  return (
    <>
      <h1>Reviews</h1>
      {all.length === 0 && <p className="muted">No change requests yet. Open a test case to edit, comment on or delete it, or add one.</p>}
      {REVIEW_GROUPS.map((g) => {
        const items = all.filter((r) => g.statuses.includes(r.status)).reverse();
        if (items.length === 0) return null;
        return (
          <section key={g.title}>
            <h2>{g.title} ({items.length})</h2>
            <table className="list">
              <thead><tr><th>Request</th><th>Operation</th><th>Case</th><th>Status</th><th>Comment</th><th>Proposal</th><th>Updated</th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/reviews/${r.id}`}>{r.id}</Link></td>
                    <td>{r.operation}</td>
                    <td>{r.targetTestCaseId ? <Link to={`/test-cases/${r.targetTestCaseId}`}>{r.targetTestCaseId}</Link> : 'new'}</td>
                    <td>{STATUS_LABEL[r.status]}{r.error ? ` — ${r.error}` : ''}</td>
                    <td>{r.humanComment ?? ''}</td>
                    <td>{r.proposal ? `${r.proposal.id} ${r.proposal.validation ?? r.proposal.status}` : ''}</td>
                    <td>{r.updatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}
