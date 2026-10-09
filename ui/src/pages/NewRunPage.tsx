import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type CoverageMode } from '../api/client.ts';
import { apiDocsProblem, COVERAGE_MODES, showsApiDocs } from '../lib/coverage.ts';
import { formatWhen } from '../lib/runs.ts';

/**
 * Start a Phase 1 run. Every choice comes from the host (GET /api/run-config);
 * the page sends a typed request, never a command, a path or an environment.
 */
export function NewRunPage() {
  const navigate = useNavigate();
  const { data, error } = useQuery({ queryKey: ['run-config'], queryFn: api.runConfig, refetchInterval: 4000 });
  const [target, setTarget] = useState('');
  const [model, setModel] = useState('');
  const [freshBrowser, setFreshBrowser] = useState(false);
  const [coverageMode, setCoverageMode] = useState<CoverageMode>('AUTOMATIC');
  const [apiDocsUrl, setApiDocsUrl] = useState('');
  const [touched, setTouched] = useState(false);

  // Defaults from the host, once.
  useEffect(() => {
    if (!data || touched) return;
    setTarget(data.config.targets.find((t) => t.default)?.url ?? data.config.targets[0]?.url ?? '');
    setModel(data.config.models.find((m) => m.default && m.available)?.id ?? data.config.models.find((m) => m.available)?.id ?? '');
    setFreshBrowser(data.config.freshBrowser.default);
    setCoverageMode(data.config.coverageModes.find((m) => m.default)?.id ?? 'AUTOMATIC');
    setApiDocsUrl(data.config.apiDocs.default ?? '');
  }, [data, touched]);

  const start = useMutation({
    // The URL is sent only for the modes that read it; an empty one says "none", not "use the host default".
    mutationFn: () => api.startRun({
      pipeline: 'PHASE1_MANUAL', target, model, freshBrowser, coverageMode,
      ...(showsApiDocs(coverageMode) ? { apiDocsUrl: apiDocsUrl.trim() } : {}),
    }),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}/live`),
  });

  if (error) return <><h1>New Run</h1><p className="notice bad">{(error as Error).message}</p></>;
  if (!data) return <><h1>New Run</h1><p>Loading…</p></>;
  const { config } = data;
  const busy = data.activeRun ?? data.lockHolder;
  const touch = <T,>(set: (v: T) => void) => (v: T) => { setTouched(true); set(v); };
  const offered = COVERAGE_MODES.filter((m) => config.coverageModes.some((c) => c.id === m.id));
  const docsProblem = apiDocsProblem(coverageMode, apiDocsUrl);

  return (
    <>
      <h1>New Run</h1>
      <p className="muted">Start Phase 1 — Product Discovery through Defect Analyzer — exactly as <code>npm run qa:manual</code> does. The choices below are the host's configuration; nothing else can be set from here.</p>

      {busy && (
        <p className="notice warn" data-testid="run-busy">
          <b>Another QA run is already active.</b>{' '}
          {data.activeRun ? <>Run: <Link to={`/runs/${data.activeRun.runId}/live`}>{data.activeRun.runId}</Link> · Model: {data.activeRun.model} · Started: {formatWhen(data.activeRun.startedAt)}</>
            : <>Run: {data.lockHolder?.runId ? <Link to={`/runs/${data.lockHolder.runId}/live`}>{data.lockHolder.runId}</Link> : '—'} · Model: {data.lockHolder?.model ?? '—'} · Started: {formatWhen(data.lockHolder?.startedAt)} {data.lockHolder?.command ? `(${data.lockHolder.command})` : ''}</>}
        </p>
      )}

      <form className="panel new-run" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
        <label>Pipeline
          <select value="PHASE1_MANUAL" disabled aria-label="Pipeline"><option value="PHASE1_MANUAL">Phase 1 — manual QA design</option></select>
        </label>
        <label>Target
          <select aria-label="Target" value={target} onChange={(e) => touch(setTarget)(e.target.value)}>
            {config.targets.map((t) => <option key={t.url} value={t.url}>{t.url}{t.default ? ' (default)' : ''}</option>)}
          </select>
        </label>
        <label>Model
          <select aria-label="Model" value={model} onChange={(e) => touch(setModel)(e.target.value)}>
            {config.models.map((m) => <option key={m.id} value={m.id} disabled={!m.available}>{m.id}{m.default ? ' (default)' : ''}{m.available ? '' : ` — ${m.reason}`}</option>)}
          </select>
        </label>
        <fieldset className="coverage-mode" data-testid="coverage-mode">
          <legend>Test coverage</legend>
          {offered.map((m) => (
            <label key={m.id} className="check">
              <input type="radio" name="coverage-mode" value={m.id} checked={coverageMode === m.id} onChange={() => touch(setCoverageMode)(m.id)} />
              <span><b>{m.label}</b>{config.coverageModes.find((c) => c.id === m.id)?.default ? ' (default)' : ''} <span className="muted">— {m.hint}</span></span>
            </label>
          ))}
        </fieldset>
        {showsApiDocs(coverageMode) && (
          <label>API documentation URL <span className="muted">({coverageMode === 'API_ONLY' ? 'required for API only' : 'optional'})</span>
            <input type="url" aria-label="API documentation URL" data-testid="api-docs-url" value={apiDocsUrl} maxLength={500}
              placeholder="https://example.test/openapi.json" onChange={(e) => touch(setApiDocsUrl)(e.target.value)} />
            <span className="muted small">
              An OpenAPI / Swagger document — JSON or YAML — or a Swagger UI page. The host reads it before the agents run.
              {coverageMode === 'AUTOMATIC' ? ' Without one, or if it cannot be read, the run continues with UI-level test cases only.' : ''}
            </span>
            {docsProblem && touched && <span className="notice bad small" data-testid="api-docs-problem">{docsProblem}</span>}
          </label>
        )}
        <label className="check">
          <input type="checkbox" aria-label="Fresh browser" checked={freshBrowser} onChange={(e) => touch(setFreshBrowser)(e.target.checked)} />
          Fresh browser — restart the browser server so the run starts signed out
        </label>
        <div className="muted">
          Helper origins: {config.auxiliaryOrigins.length ? config.auxiliaryOrigins.map((o) => <code key={o} className="chip">{o}</code>) : 'none configured (QA_DISCOVERY_AUX_ORIGINS)'}
        </div>
        <div className="muted">Langfuse tracing: {config.langfuse.enabled ? `on (${config.langfuse.baseUrl})` : 'off'}</div>
        {start.error && <p className="notice bad" data-testid="start-error">{(start.error as Error).message}</p>}
        <div className="buttons">
          <button className="primary" type="submit" disabled={!!busy || start.isPending || !target || !model || !!docsProblem}>Start Phase 1</button>
        </div>
      </form>
    </>
  );
}
