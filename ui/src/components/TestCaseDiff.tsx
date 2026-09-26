import { diffCases, type CaseLike, type FieldChange } from '../lib/diff.ts';

const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

function Change({ change }: { change: FieldChange }) {
  switch (change.kind) {
    case 'scalar':
      return (
        <div className="diff-row">
          <b>{change.field}</b>
          <div><del>{show(change.before)}</del> → <ins>{show(change.after)}</ins></div>
        </div>
      );
    case 'list':
    case 'object': {
      const changed = change.kind === 'object' ? change.changed : [];
      return (
        <div className="diff-row">
          <b>{change.field}</b>
          <div>
            {change.added.map((x) => <ins key={`+${x}`} className="chip">+ {x}</ins>)}
            {change.removed.map((x) => <del key={`-${x}`} className="chip">− {x}</del>)}
            {changed.map((x) => <span key={`~${x}`} className="chip">~ {x}</span>)}
          </div>
        </div>
      );
    }
    case 'steps':
      return (
        <div className="diff-row">
          <b>steps</b>
          <ol className="steps-diff">
            {change.changes.map((s, i) => {
              if (s.type === 'unchanged') return <li key={i} className="same">{s.after.action} — <i>{s.after.expected}</i></li>;
              if (s.type === 'added') return <li key={i} className="added"><ins>+ {s.after.action} — <i>{s.after.expected}</i></ins></li>;
              if (s.type === 'removed') return <li key={i} className="removed"><del>− {s.before.action} — <i>{s.before.expected}</i></del></li>;
              return (
                <li key={i} className="changed">
                  ~ <del>{s.before.action} — <i>{s.before.expected}</i></del><br />
                  → <ins>{s.after.action} — <i>{s.after.expected}</i></ins>
                </li>
              );
            })}
          </ol>
        </div>
      );
  }
}

/** CURRENT vs PROPOSED, field by field. */
export function TestCaseDiff({ current, proposed }: { current?: CaseLike; proposed?: CaseLike }) {
  const changes = diffCases(current, proposed);
  if (changes.length === 0) return <p className="muted">No field changes.</p>;
  return <div className="diff" data-testid="case-diff">{changes.map((c, i) => <Change key={i} change={c} />)}</div>;
}
