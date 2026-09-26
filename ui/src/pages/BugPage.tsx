import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type BugChanges, type BugEditPreview } from '../api/client.ts';
import { TestCaseDiff } from '../components/TestCaseDiff.tsx';

const SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'];
const PRIORITIES = ['UNASSIGNED', 'P0', 'P1', 'P2', 'P3'];

/** A person's decisions and edits — the same trusted service as `npm run qa:defects`. */
export function BugPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['bug', id], queryFn: () => api.bug(id) });
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ title: string; severity: string; priority: string; steps: string }>({ title: '', severity: '', priority: '', steps: '' });
  const [preview, setPreview] = useState<{ changes: BugChanges; result: BugEditPreview } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const after = (message: string) => {
    setDone(message);
    setNote('');
    setEditing(false);
    setPreview(null);
    return qc.invalidateQueries();
  };
  const decision = useMutation({
    mutationFn: (action: 'accept' | 'reject' | 'downgrade') => api.bugDecision(id, action, data!.sha256, note || undefined),
    onSuccess: (r) => after(`Recorded: ${r.bug.status} · ${r.bug.review.decision}.`),
  });
  const requestChanges = useMutation({
    mutationFn: () => api.bugRequestChanges(id, data!.sha256, note),
    onSuccess: () => after('Change request recorded. The report itself is unchanged.'),
  });
  const previewEdit = useMutation({
    mutationFn: (changes: BugChanges) => api.bugEditPreview(id, changes).then((result) => ({ changes, result })),
    onSuccess: setPreview,
  });
  const applyEdit = useMutation({
    mutationFn: () => api.bugEdit(id, preview!.changes, preview!.result.baseSha256, note || undefined),
    onSuccess: () => after('Edit applied.'),
  });

  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const { bug: b } = data;
  const busy = decision.isPending || requestChanges.isPending || previewEdit.isPending || applyEdit.isPending;
  const failure = (decision.error ?? requestChanges.error ?? previewEdit.error ?? applyEdit.error) as Error | null;

  const startEdit = () => {
    setForm({ title: b.title, severity: b.severity, priority: b.priority, steps: b.steps.join('\n') });
    setPreview(null);
    setEditing(true);
  };
  const changesFromForm = (): BugChanges => {
    const steps = form.steps.split('\n').map((s) => s.trim()).filter(Boolean);
    const out: BugChanges = {};
    if (form.title.trim() !== b.title) out.title = form.title.trim();
    if (form.severity !== b.severity) out.severity = form.severity;
    if (form.priority !== b.priority) out.priority = form.priority;
    if (JSON.stringify(steps) !== JSON.stringify(b.steps)) out.steps = steps;
    return out;
  };

  return (
    <>
      <h1>{b.id} <span className="muted">{b.title}</span></h1>
      <p data-testid="bug-header">
        <b data-testid="bug-status">{b.status}</b>
        {data.classification && <> · classification {data.classification}</>}
        {' '}· severity <b data-testid="bug-severity">{b.severity}</b> · priority <b data-testid="bug-priority">{b.priority}</b>
        {b.area ? ` · ${b.area}` : ''} · decision <b data-testid="bug-decision">{b.review.decision}</b>{b.review.downgradedFrom ? ' (downgraded)' : ''}
      </p>
      {b.review.note && <p className="muted">Reviewer note: {b.review.note}</p>}
      {done && <p className="notice ok" data-testid="bug-done">{done} Phase 1 approval is now stale — approve again when you are done.</p>}
      {failure && <p className="notice bad" data-testid="bug-error">{failure.message}</p>}

      <section className="panel" data-testid="bug-detail">
        {b.preconditions.length > 0 && <><h3>Preconditions</h3><ul>{b.preconditions.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
        <h3>Reproduction steps</h3>
        <ol data-testid="bug-steps">{b.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <h3>Expected result</h3><p data-testid="bug-expected">{b.expected}</p>
        <h3>Actual result</h3><p data-testid="bug-actual">{b.actual}</p>
        <p className="muted">Expected basis: {b.expectedBasis} · Environment: {b.environment.target} ({b.environment.browser}) · From {b.origin.findingId}{b.origin.runId ? `, run ${b.origin.runId}` : ''}</p>
      </section>

      <section className="panel" data-testid="bug-review">
        <h3>Human review</h3>
        <textarea placeholder="Note (required for Request Changes)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="buttons">
          <button className="primary" disabled={busy} onClick={() => decision.mutate('accept')}>Accept</button>
          <button disabled={busy} onClick={() => decision.mutate('reject')}>Reject</button>
          {data.actions.downgrade && <button disabled={busy} onClick={() => decision.mutate('downgrade')}>Downgrade</button>}
          <button disabled={busy || !note.trim()} onClick={() => requestChanges.mutate()}>Request Changes</button>
          <button disabled={busy} onClick={startEdit}>Edit</button>
        </div>
      </section>

      {editing && (
        <section className="panel editor" data-testid="bug-edit">
          <h3>Edit {b.id} <span className="muted">(ids, evidence and environment are fixed)</span></h3>
          <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Severity<select aria-label="Severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Priority<select aria-label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{PRIORITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Steps (one per line)<textarea value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} /></label>
          <div className="buttons">
            <button disabled={busy || Object.keys(changesFromForm()).length === 0} onClick={() => previewEdit.mutate(changesFromForm())}>Preview changes</button>
            <button onClick={() => { setEditing(false); setPreview(null); }}>Cancel</button>
          </div>
          {preview && (
            <div data-testid="bug-edit-preview">
              <h4>Before vs after</h4>
              <TestCaseDiff current={preview.result.current} proposed={preview.result.next} />
              {preview.result.problems.length > 0 && (
                <div className="notice bad"><b>Cannot be applied</b><ul>{preview.result.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
              )}
              <button className="primary" disabled={busy || !preview.result.applicable} onClick={() => applyEdit.mutate()}>Apply</button>
            </div>
          )}
        </section>
      )}

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

      <h2>Review history</h2>
      {data.history.length === 0 ? <p className="muted">No decisions yet.</p> : (
        <ul className="history" data-testid="bug-history">
          {data.history.map((h, i) => (
            <li key={i}>
              <span className="muted">{h.at}</span> <b>{h.action}</b> by {h.by}{h.via ? ` (${h.via})` : ''}: {h.before.status}/{h.before.decision} → {h.after.status}/{h.after.decision}
              {h.editedFields?.length ? ` · edited ${h.editedFields.join(', ')}` : ''}{h.note ? ` — ${h.note}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p><Link to="/bugs">← All bugs</Link></p>
    </>
  );
}
