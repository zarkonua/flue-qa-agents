import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type RunFilters } from '../api/client.ts';
import { formatDuration, formatWhen, KIND_LABEL, metric, STATUSES } from '../lib/runs.ts';

const PAGE = 25;

/** Every recorded QA run, newest first. Read-only; polls while a run is active and this page is open. */
export function RunsPage() {
  const [filters, setFilters] = useState<RunFilters>({});
  const [offset, setOffset] = useState(0);
  const { data, error } = useQuery({
    queryKey: ['runs', filters, offset],
    queryFn: () => api.runs(filters, PAGE, offset),
    placeholderData: keepPreviousData,
    // Only this page polls, and only while something is running; react-query stops when it unmounts or the tab is hidden.
    refetchInterval: (q) => ((q.state.data?.active.length ?? 0) > 0 ? 3000 : false),
  });
  const set = (key: keyof RunFilters) => (value: string) => {
    setOffset(0);
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  };

  if (error) return <><h1>Runs</h1><p className="notice bad" data-testid="runs-error">{(error as Error).message}</p></>;
  if (!data) return <><h1>Runs</h1><p>Loading…</p></>;
  const f = data.facets;
  const filtered = Object.values(filters).some(Boolean);
  return (
    <>
      <h1>Runs</h1>
      <p className="muted">Every QA run — completed, failed or interrupted — from the local run history. Open one to browse what it produced, read-only.</p>

      {data.active.map((a) => (
        <p key={a.id} className="notice warn" data-testid="active-run">
          <b>RUNNING</b> · {KIND_LABEL[a.kind]} · {a.model ?? 'unknown model'} · started {formatWhen(a.startedAt)}
          {a.currentStage && <> · current stage: <b>{a.currentStage}</b></>} · <Link to={`/runs/${a.id}`}>open</Link>
        </p>
      ))}

      <div className="filters">
        <select aria-label="Status" value={filters.status ?? ''} onChange={(e) => set('status')(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Kind" value={filters.kind ?? ''} onChange={(e) => set('kind')(e.target.value)}>
          <option value="">All kinds</option>
          {f.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="Model" value={filters.model ?? ''} onChange={(e) => set('model')(e.target.value)}>
          <option value="">All models</option>
          {f.models.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select aria-label="Provider" value={filters.provider ?? ''} onChange={(e) => set('provider')(e.target.value)}>
          <option value="">All providers</option>
          {f.providers.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select aria-label="Target" value={filters.target ?? ''} onChange={(e) => set('target')(e.target.value)}>
          <option value="">All targets</option>
          {f.targets.map((t) => <option key={t}>{t}</option>)}
        </select>
        <label>From <input type="date" aria-label="From" value={filters.from ?? ''} onChange={(e) => set('from')(e.target.value)} /></label>
        <label>To <input type="date" aria-label="To" value={filters.to ?? ''} onChange={(e) => set('to')(e.target.value)} /></label>
        {filtered && <button onClick={() => { setFilters({}); setOffset(0); }}>Clear</button>}
      </div>

      {data.total === 0 ? (
        <p className="notice" data-testid="runs-empty">
          {filtered ? 'No run matches these filters.' : <>No runs recorded yet. Start one with <code>npm run qa:manual</code>; runs archived before the history existed are imported with <code>npm run qa:history:import</code>.</>}
        </p>
      ) : (
        <>
          <table className="list runs">
            <thead><tr><th>Started</th><th>Kind</th><th>Status</th><th>Model</th><th>Target</th><th>Duration</th><th>Behaviors</th><th>Test cases</th><th>Defects</th></tr></thead>
            <tbody>
              {data.runs.map((r) => {
                const defects = 'defects_confirmed' in r.metrics || 'defects_potential' in r.metrics
                  ? String((r.metrics.defects_confirmed ?? 0) + (r.metrics.defects_potential ?? 0)) : '—';
                return (
                  <tr key={r.id} data-testid={`run-row-${r.id}`}>
                    <td><Link to={`/runs/${r.id}`}>{formatWhen(r.startedAt)}</Link></td>
                    <td>{KIND_LABEL[r.kind]}</td>
                    <td>
                      <span className={`badge run-${r.status.toLowerCase()}`}>{r.status}</span>
                      {r.failedStage && <div className="muted small">Stopped at: {r.failedStage}</div>}
                      {r.status === 'RUNNING' && r.currentStage && <div className="muted small">Now: {r.currentStage}</div>}
                    </td>
                    <td className="mono">{r.model ?? '—'}</td>
                    <td className="mono">{r.target ?? '—'}</td>
                    <td>{formatDuration(r.durationMs)}</td>
                    <td>{metric(r.metrics, 'discovered_behaviors')}</td>
                    <td>{metric(r.metrics, 'test_cases_total')}</td>
                    <td>{defects}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="buttons pager">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
            <span className="muted">{offset + 1}–{Math.min(offset + data.runs.length, data.total)} of {data.total}</span>
            <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
          </div>
        </>
      )}
    </>
  );
}
