// Read-only views of one run's archived output. Nothing here can change
// anything: no buttons, no forms — the host API behind them is GET-only.

import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { CaseView } from '../components/CaseView.tsx';
import { ARTIFACT_LABEL } from '../lib/runs.ts';
import { levelCounts, matchesLevel, type LevelFilter } from '../lib/coverage.ts';
import { SnapshotBanner } from './RunPage.tsx';

export function RunTestCasesPage() {
  const { id = '' } = useParams();
  const { hash } = useLocation();
  const { data, error } = useQuery({ queryKey: ['run-test-cases', id], queryFn: () => api.runTestCases(id) });
  const [level, setLevel] = useState<LevelFilter>('ALL');
  // Bug pages link to a case as #TC-1; bring it into view once the list is there.
  useEffect(() => {
    if (data && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [data, hash]);
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <p><Link to={`/runs/${id}`}>← Run</Link></p>
      <h1>Test Cases ({data.testCases.length}) <span className="muted">in this run</span></h1>
      <SnapshotBanner runId={id} />
      <div className="filters">
        <select value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)} aria-label="Test level" data-testid="level-filter">
          <option value="ALL">All levels</option>
          <option value="UI">UI ({levelCounts(data.testCases).UI})</option>
          <option value="API">API ({levelCounts(data.testCases).API})</option>
        </select>
      </div>
      {data.testCases.filter((tc) => matchesLevel(tc, level) || hash === `#${String(tc.id ?? '')}`).map((tc) => {
        const caseId = String(tc.id ?? '');
        const p = data.prioritization[caseId];
        return (
          <div className={`panel historical-case${hash === `#${caseId}` ? ' target' : ''}`} key={caseId} id={caseId} data-testid={`historical-case-${caseId}`}>
            <h3>{caseId}{p && <span className="muted"> · {p.executionMode ?? '—'}{p.automationPriority ? ` · ${p.automationPriority}` : ''}{p.automationStrategy ? ` · ${p.automationStrategy}` : ''}</span>}</h3>
            <CaseView testCase={tc} />
          </div>
        );
      })}
    </>
  );
}

export function RunBugsPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['run-bugs', id], queryFn: () => api.runBugs(id) });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <p><Link to={`/runs/${id}`}>← Run</Link></p>
      <h1>Bugs ({data.bugs.length}) <span className="muted">in this run</span></h1>
      <SnapshotBanner runId={id} />
      <table className="list">
        <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Severity</th><th>Priority</th><th>Decision then</th><th>Test cases</th></tr></thead>
        <tbody>
          {data.bugs.map((b) => (
            <tr key={b.id} data-testid={`historical-bug-${b.id}`}>
              <td><Link to={`/runs/${id}/bugs/${b.id}`}>{b.id}</Link></td>
              <td>{b.title}</td><td>{b.status}</td><td>{b.severity}</td><td>{b.priority}</td><td>{b.decision ?? '—'}</td>
              <td>{b.relatedTestCaseIds.map((t) => <Link key={t} to={`/runs/${id}/test-cases#${t}`}>{t} </Link>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function RunBugPage() {
  const { id = '', bugId = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['run-bug', id, bugId], queryFn: () => api.runBug(id, bugId) });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const b = data.bug;
  const evidence = Array.isArray(b.evidence) ? (b.evidence as { type?: string; sourceId?: string }[]) : [];
  return (
    <>
      <p><Link to={`/runs/${id}/bugs`}>← Bugs in this run</Link></p>
      <h1>{String(b.id)} <span className="muted">{String(b.title ?? '')}</span></h1>
      <SnapshotBanner runId={id} />
      <dl className="run-meta" data-testid="historical-bug">
        <dt>Classification</dt><dd>{data.classification ?? '—'}</dd>
        <dt>Status</dt><dd>{String(b.status ?? '—')}</dd>
        <dt>Severity</dt><dd>{String(b.severity ?? '—')}</dd>
        <dt>Priority then</dt><dd>{String(b.priority ?? '—')}</dd>
        <dt>Expected basis</dt><dd>{String(b.expectedBasis ?? '—')}</dd>
      </dl>
      {strs(b.steps).length > 0 && <><h3>Steps</h3><ol>{strs(b.steps).map((s, i) => <li key={i}>{s}</li>)}</ol></>}
      <h3>Expected</h3><p>{String(b.expected ?? '—')}</p>
      <h3>Actual</h3><p>{String(b.actual ?? '—')}</p>
      <h3>Evidence</h3>
      <p>{evidence.length ? evidence.map((e, i) => <span key={i} className="chip">{e.type}: {e.sourceId}</span>) : '—'}</p>
      <h3>Related test cases</h3>
      {data.relatedTestCases.length === 0 ? <p className="muted">This report names no test case.</p> : (
        <ul>{data.relatedTestCases.map((t) => (
          <li key={t.id}>{t.inSnapshot ? <Link to={`/runs/${id}/test-cases#${t.id}`}>{t.id}</Link> : <span>{t.id} <i>(not in this run's suite)</i></span>}</li>
        ))}</ul>
      )}
    </>
  );
}

export function RunArtifactPage() {
  const { id = '', type = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['run-artifact', id, type], queryFn: () => api.runArtifact(id, type) });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <p><Link to={`/runs/${id}`}>← Run</Link></p>
      <h1>{ARTIFACT_LABEL[type] ?? type} <span className="muted">in this run</span></h1>
      <SnapshotBanner runId={id} />
      <pre className="artifact" data-testid="historical-artifact">{JSON.stringify(data.artifact, null, 2)}</pre>
    </>
  );
}
