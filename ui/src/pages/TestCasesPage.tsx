import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { STATUS_LABEL } from '../lib/review-state.ts';

export function TestCasesPage() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['test-cases'], queryFn: api.testCases, refetchInterval: 5000 });
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('ALL');
  const [type, setType] = useState('ALL');
  const [strategy, setStrategy] = useState('ALL');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [intent, setIntent] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const { request } = await api.createReview({ operation: 'create', humanComment: intent });
      await api.process(request.id);
      return request;
    },
    onSuccess: (r) => navigate(`/reviews/${r.id}`),
  });

  const rows = data?.testCases ?? [];
  const types = useMemo(() => [...new Set(rows.flatMap((r) => r.types))].sort(), [rows]);
  const strategies = useMemo(() => [...new Set(rows.map((r) => r.automationStrategy).filter((x): x is string => !!x))].sort(), [rows]);
  const shown = rows.filter((r) =>
    (priority === 'ALL' || r.priority === priority) &&
    (type === 'ALL' || r.types.includes(type)) &&
    (strategy === 'ALL' || r.automationStrategy === strategy) &&
    (!pendingOnly || r.pendingReview) &&
    (!q || `${r.id} ${r.title} ${r.covers.join(' ')} ${r.strategyReason ?? ''}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <h1>Test Cases</h1>
      <div className="filters">
        <input type="search" placeholder="Search id, title, covers…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          {['ALL', 'P0', 'P1', 'P2', 'P3'].map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option>ALL</option>{types.map((t) => <option key={t}>{t}</option>)}
        </select>
        {strategies.length > 0 && (
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} aria-label="Strategy">
            <option>ALL</option>{strategies.map((t) => <option key={t}>{t}</option>)}
          </select>
        )}
        <label className="inline"><input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} /> Pending changes</label>
        <span className="muted">{shown.length} of {rows.length}</span>
        <button className="primary" onClick={() => setAdding(true)}>+ Add Test Case</button>
      </div>

      {adding && (
        <section className="panel" data-testid="add-case">
          <h3>Describe the test case you want</h3>
          <textarea value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="e.g. Verify search with a query that returns nothing." />
          <div className="buttons">
            <button className="primary" disabled={!intent.trim() || create.isPending} onClick={() => create.mutate()}>Process with QA Agent</button>
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {create.error && <p className="notice bad">{(create.error as Error).message}</p>}
        </section>
      )}

      <table className="list">
        <thead><tr><th>ID</th><th>Title</th><th>Priority</th><th>Types</th><th>Covers</th><th>Automation</th><th>Bugs</th><th>Review</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} data-testid={`case-row-${r.id}`}>
              <td><Link to={`/test-cases/${encodeURIComponent(r.id)}`}>{r.id}</Link></td>
              <td>{r.title}</td>
              <td>{r.priority}</td>
              <td>{r.types.join(', ')}</td>
              <td>{r.covers.join(', ')}</td>
              <td>{r.executionMode ? `${r.executionMode}${r.automationPriority && r.automationPriority !== 'NONE' ? ` · ${r.automationPriority}` : ''}${r.automationStrategy ? ` · ${r.automationStrategy}` : ''}` : '—'}</td>
              <td>{r.relatedBugIds.map((b) => <Link key={b} to={`/bugs/${b}`}>{b} </Link>)}</td>
              <td>{r.pendingReview ? <Link to={`/reviews/${r.pendingReview.id}`}>{STATUS_LABEL[r.pendingReview.status]} ({r.pendingReview.operation})</Link> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
