import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export function BugPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['bug', id], queryFn: () => api.bug(id) });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const { bug: b } = data;
  return (
    <>
      <h1>{b.id} <span className="muted">{b.title}</span></h1>
      <p><b>{b.status}</b> · severity {b.severity} · priority {b.priority}{b.area ? ` · ${b.area}` : ''} · decision <b>{b.review.decision}</b>{b.review.downgradedFrom ? ' (downgraded)' : ''}</p>
      {b.review.note && <p className="muted">Reviewer note: {b.review.note}</p>}
      <section className="panel" data-testid="bug-detail">
        {b.preconditions.length > 0 && <><h3>Preconditions</h3><ul>{b.preconditions.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
        <h3>Reproduction steps</h3>
        <ol>{b.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <h3>Expected result</h3><p data-testid="bug-expected">{b.expected}</p>
        <h3>Actual result</h3><p data-testid="bug-actual">{b.actual}</p>
        <p className="muted">Expected basis: {b.expectedBasis} · Environment: {b.environment.target} ({b.environment.browser}) · From {b.origin.findingId}{b.origin.runId ? `, run ${b.origin.runId}` : ''}</p>
      </section>
      <div className="columns">
        <section className="panel">
          <h3>Evidence</h3>
          <ul>{data.behaviors.map((x) => <li key={x.id}><b>{x.id}</b> {x.statement ?? <i>(not found)</i>}</li>)}</ul>
          {data.requirements.length > 0 && <><h3>Requirements</h3><ul>{data.requirements.map((x) => <li key={x.id}><b>{x.id}</b> {x.statement ?? <i>(not found)</i>}</li>)}</ul></>}
        </section>
        <section className="panel" data-testid="related-cases">
          <h3>Related test cases</h3>
          {data.relatedTestCases.length === 0 ? <p className="muted">This report names no test case.</p>
            : <ul>{data.relatedTestCases.map((t) => <li key={t.id}>{t.active ? <Link to={`/test-cases/${t.id}`}>{t.id}</Link> : <span>{t.id} <i>(no longer active)</i></span>}</li>)}</ul>}
        </section>
      </div>
      <p><Link to="/bugs">← All bugs</Link></p>
    </>
  );
}
