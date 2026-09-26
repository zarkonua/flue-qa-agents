import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type TestCase } from '../api/client.ts';
import { CaseView } from '../components/CaseView.tsx';
import { TestCaseEditor } from '../components/TestCaseEditor.tsx';
import { STATUS_LABEL } from '../lib/review-state.ts';

export function TestCasePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useQuery({ queryKey: ['test-case', id], queryFn: () => api.testCase(id) });
  const [mode, setMode] = useState<'view' | 'edit' | 'comment' | 'delete'>('view');
  const [text, setText] = useState('');
  const submit = useMutation({
    mutationFn: async (input: { operation: 'update' | 'delete'; humanComment?: string; manualEdits?: Partial<TestCase> }) => {
      const { request } = await api.createReview({ targetTestCaseId: id, ...input });
      if (input.operation === 'update') await api.process(request.id);
      return request;
    },
    onSuccess: (r) => navigate(`/reviews/${r.id}`),
  });

  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const tc = data.testCase;
  return (
    <>
      <h1>{tc.id} <span className="muted">{tc.title}</span></h1>
      {data.openReviewId && <p className="notice warn">A change to this case is under review: <Link to={`/reviews/${data.openReviewId}`}>{data.openReviewId}</Link></p>}
      <div className="buttons">
        <button onClick={() => setMode('edit')}>Edit</button>
        <button onClick={() => { setMode('comment'); setText(''); }}>Request Change</button>
        <button className="danger" onClick={() => { setMode('delete'); setText(''); }}>Delete</button>
      </div>

      {mode === 'edit' && (
        <TestCaseEditor testCase={tc} busy={submit.isPending} onCancel={() => setMode('view')}
          onSubmit={(edits, comment) => submit.mutate({ operation: 'update', manualEdits: edits, humanComment: comment || undefined })} />
      )}
      {(mode === 'comment' || mode === 'delete') && (
        <section className="panel" data-testid={mode === 'comment' ? 'request-change' : 'delete-case'}>
          <h3>{mode === 'comment' ? 'What should change?' : 'Why delete this case? (optional)'}</h3>
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
          <div className="buttons">
            {mode === 'comment'
              ? <button className="primary" disabled={!text.trim() || submit.isPending} onClick={() => submit.mutate({ operation: 'update', humanComment: text })}>Process with QA Agent</button>
              : <button className="danger" disabled={submit.isPending} onClick={() => submit.mutate({ operation: 'delete', humanComment: text || undefined })}>Propose deletion</button>}
            <button onClick={() => setMode('view')}>Cancel</button>
          </div>
        </section>
      )}
      {submit.error && <p className="notice bad">{(submit.error as Error).message}</p>}

      <section className="panel"><h3>Active case</h3><CaseView testCase={tc} /></section>
      {data.prioritization && (
        <p className="muted">Automation: {data.prioritization.executionMode} · {data.prioritization.automationPriority}{data.prioritization.automationStrategy ? ` · ${data.prioritization.automationStrategy}` : ''} — {data.prioritization.reason}</p>
      )}

      <div className="columns">
        <section className="panel">
          <h3>Covers</h3>
          <ul>{data.covers.map((c) => <li key={c.id}><b>{c.id}</b> {c.statement ?? <i>(not found)</i>}</li>)}</ul>
          <h3>Evidence</h3>
          <ul>{data.evidence.map((b) => <li key={b.id}><b>{b.id}</b> {b.status ? `[${b.status}] ` : ''}{b.statement ?? <i>(not found)</i>}</li>)}</ul>
        </section>
        <section className="panel" data-testid="related-bugs">
          <h3>Related bugs</h3>
          {data.relatedBugIds.length === 0 ? <p className="muted">No bug report names this case.</p>
            : <ul>{data.relatedBugIds.map((b) => <li key={b}><Link to={`/bugs/${b}`}>{b}</Link></li>)}</ul>}
          <h3>Review history</h3>
          {data.reviews.length === 0 ? <p className="muted">None.</p>
            : <ul>{data.reviews.map((r) => <li key={r.id}><Link to={`/reviews/${r.id}`}>{r.id}</Link> {r.operation} · {STATUS_LABEL[r.status]}</li>)}</ul>}
        </section>
      </div>
    </>
  );
}
