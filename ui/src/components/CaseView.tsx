import type { TestCase } from '../api/client.ts';
import { record, steps, strings, text } from '../lib/shape.ts';

/** Renders any case-shaped value — including a malformed proposal — without trusting its shape. */
export function CaseView({ testCase }: { testCase: Partial<TestCase> | Record<string, unknown> }) {
  const tc = testCase as Record<string, unknown>;
  const preconditions = strings(tc.preconditions);
  const data = record(tc.testData);
  const tags = strings(tc.tags);
  return (
    <div className="case-view">
      <p><b>{text(tc.title)}</b></p>
      <p className="muted">{text(tc.priority)} · {strings(tc.types).join(', ')}{tags.length ? ` · tags: ${tags.join(', ')}` : ''}</p>
      {preconditions.length > 0 && <><h5>Preconditions</h5><ul>{preconditions.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
      {Object.keys(data).length > 0 && <><h5>Test data</h5><pre>{JSON.stringify(data, null, 2)}</pre></>}
      <h5>Steps</h5>
      <ol>{steps(tc.steps).map((s, i) => <li key={i}>{s.action} — <i>{s.expected}</i></li>)}</ol>
      <h5>Expected result</h5>
      <p data-testid="expected-result">{text(tc.expectedResult)}</p>
      <p className="muted">Covers: {strings(tc.covers).join(', ') || '—'} · Evidence: {strings(tc.evidenceIds).join(', ') || '—'}</p>
      <p className="muted">Automation candidate: {tc.automationCandidate === true ? 'yes' : 'no'}{text(tc.automationReason) ? ` — ${text(tc.automationReason)}` : ''}</p>
    </div>
  );
}
