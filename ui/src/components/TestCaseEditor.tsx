import { useFieldArray, useForm } from 'react-hook-form';
import type { TestCase } from '../api/client.ts';

export interface EditorValues {
  title: string;
  priority: string;
  types: string;
  preconditions: string;
  steps: { action: string; expected: string }[];
  expectedResult: string;
  automationCandidate: boolean;
  automationReason: string;
  tags: string;
  comment: string;
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Only the fields a person changed, in the case's own shape. */
export function editsFrom(original: TestCase, v: EditorValues): Partial<TestCase> {
  const next: Partial<TestCase> = {
    title: v.title.trim(),
    priority: v.priority,
    types: list(v.types),
    preconditions: lines(v.preconditions),
    steps: v.steps.map((s) => ({ action: s.action.trim(), expected: s.expected.trim() })).filter((s) => s.action || s.expected),
    expectedResult: v.expectedResult.trim(),
    automationCandidate: v.automationCandidate,
    automationReason: v.automationReason.trim(),
    tags: list(v.tags),
  };
  const out: Partial<TestCase> = {};
  for (const [k, value] of Object.entries(next) as [keyof TestCase, unknown][]) {
    if (JSON.stringify(value) !== JSON.stringify(original[k])) (out as Record<string, unknown>)[k] = value;
  }
  return out;
}

/** Edits become a change request; the active case is untouched until a proposal is applied. */
export function TestCaseEditor({ testCase, busy, onSubmit, onCancel }: {
  testCase: TestCase;
  busy: boolean;
  onSubmit: (edits: Partial<TestCase>, comment: string) => void;
  onCancel: () => void;
}) {
  const { register, control, handleSubmit } = useForm<EditorValues>({
    defaultValues: {
      title: testCase.title,
      priority: testCase.priority,
      types: testCase.types.join(', '),
      preconditions: testCase.preconditions.join('\n'),
      steps: testCase.steps,
      expectedResult: testCase.expectedResult,
      automationCandidate: testCase.automationCandidate,
      automationReason: testCase.automationReason,
      tags: testCase.tags.join(', '),
      comment: '',
    },
  });
  const steps = useFieldArray({ control, name: 'steps' });
  return (
    <form className="panel editor" onSubmit={handleSubmit((v) => onSubmit(editsFrom(testCase, v), v.comment))}>
      <h3>Edit {testCase.id} <span className="muted">(id is fixed)</span></h3>
      <label>Title<input {...register('title', { required: true })} /></label>
      <label>Priority<select {...register('priority')}>{['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>Types (comma-separated)<input {...register('types')} /></label>
      <label>Preconditions (one per line)<textarea {...register('preconditions')} /></label>
      <fieldset>
        <legend>Steps</legend>
        {steps.fields.map((f, i) => (
          <div key={f.id} className="step-edit">
            <input placeholder="Action" {...register(`steps.${i}.action`)} />
            <input placeholder="Expected" {...register(`steps.${i}.expected`)} />
            <button type="button" onClick={() => steps.remove(i)}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => steps.append({ action: '', expected: '' })}>+ Step</button>
      </fieldset>
      <label>Expected result<textarea {...register('expectedResult')} /></label>
      <label className="inline"><input type="checkbox" {...register('automationCandidate')} /> Automation candidate</label>
      <label>Automation reason<input {...register('automationReason')} /></label>
      <label>Tags (comma-separated)<input {...register('tags')} /></label>
      <label>Comment for the QA agent (optional)<textarea {...register('comment')} /></label>
      <div className="buttons">
        <button className="primary" type="submit" disabled={busy}>Submit edits for review</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
