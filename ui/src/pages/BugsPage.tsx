import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export function BugsPage() {
  const { data } = useQuery({ queryKey: ['bugs'], queryFn: api.bugs });
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  if (!data) return <><h1>Bugs</h1><p>Loading…</p></>;
  const bugs = data.bugs;
  const shown = bugs.filter((b) =>
    (severity === 'ALL' || b.severity === severity) && (status === 'ALL' || b.status === status) &&
    (!q || `${b.id} ${b.title} ${b.area ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <h1>Bugs</h1>
      <p className="muted">Open a report to accept, reject, downgrade, request changes or edit it (the same decisions as <code>npm run qa:defects</code>).</p>
      <div className="filters">
        <input type="search" placeholder="Search id, title, area…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          {['ALL', 'BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {['ALL', 'CONFIRMED', 'POTENTIAL'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {bugs.length === 0 && <p className="muted">No bug reports: defect analysis found no evidence-backed contradiction.</p>}
      <table className="list">
        <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Severity</th><th>Priority</th><th>Area</th><th>Decision</th><th>Test cases</th></tr></thead>
        <tbody>
          {shown.map((b) => (
            <tr key={b.id} data-testid={`bug-row-${b.id}`}>
              <td><Link to={`/bugs/${b.id}`}>{b.id}</Link></td>
              <td>{b.title}</td><td>{b.status}</td><td>{b.severity}</td><td>{b.priority}</td><td>{b.area ?? '—'}</td><td>{b.decision}</td>
              <td>{b.relatedTestCaseIds.map((t) => <Link key={t} to={`/test-cases/${t}`}>{t} </Link>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
