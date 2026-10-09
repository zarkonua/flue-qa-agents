import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { deriveLiveState, EVENT_FILTERS, useRunEvents, type LiveStage } from '../lib/live-run.ts';
import { ARTIFACT_LABEL, formatDuration, formatWhen, METRIC_GROUPS } from '../lib/runs.ts';

const ICON: Record<string, string> = { PENDING: '○', RUNNING: '▶', COMPLETED: '✓', FAILED: '✗', CANCELLED: '■', SKIPPED: '–', INTERRUPTED: '■' };
/** The handful of numbers worth watching while a run goes on; the rest are on the run page. */
const LIVE_METRICS: [string, string][] = [
  ['product_states', 'States'], ['discovered_behaviors', 'Behaviors'], ['acceptance_points', 'Acceptance points'],
  ['test_cases_total', 'Test cases'], ['defects_confirmed', 'Confirmed defects'], ['defects_potential', 'Potential defects'],
  ['semantic_rejections', 'Semantic rejections'],
];
const ACTIVE = new Set(['STARTING', 'RUNNING']);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

function artifactLink(runId: string, type: string): { to: string; label: string } | undefined {
  if (type === 'TEST_CASES') return { to: `/runs/${runId}/test-cases`, label: 'View test cases' };
  if (type === 'BUG_REPORT') return { to: `/runs/${runId}/bugs`, label: 'View bugs' };
  if (ARTIFACT_LABEL[type]) return { to: `/runs/${runId}/artifacts/${type}`, label: `View ${ARTIFACT_LABEL[type].toLowerCase()}` };
  return undefined;
}

export function LiveRunPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { events, connected, ended } = useRunEvents(id);
  const { data, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    // The history catches up with the stream; poll it only while the run is going.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.run.status) ? 3000 : false),
  });
  // When the stream says the run is over, read the final record once more.
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: ['run', id] });
  }, [ended, id, queryClient]);
  const [filter, setFilter] = useState('all');
  const [confirming, setConfirming] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [now, setNow] = useState(Date.now());
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(id),
    onSuccess: () => { setConfirming(false); void queryClient.invalidateQueries({ queryKey: ['run', id] }); },
  });
  const state = useMemo(() => (data ? deriveLiveState(data, events) : undefined), [data, events]);
  const active = state ? ACTIVE.has(state.status) : false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const logRef = useRef<HTMLDivElement>(null);
  const shown = events.filter(EVENT_FILTERS.find((f) => f.id === filter)!.test);
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data || !state) return <p>Loading…</p>;
  const { run } = data;
  const elapsed = active ? now - Date.parse(run.startedAt) : run.durationMs;
  const failedStage = state.stages.find((s) => s.state === 'FAILED');
  const errors = events.filter((e) => e.level === 'error');

  return (
    <>
      <p><Link to="/runs">← All runs</Link> · <Link to={`/runs/${id}`}>Run details</Link></p>
      <h1>
        Live Run <span className={`badge run-${state.status.toLowerCase()}`} data-testid="live-status">{state.status}</span>
        {!connected && active && <span className="muted small"> reconnecting…</span>}
      </h1>
      <dl className="run-meta">
        <dt>Run</dt><dd className="mono">{run.id}</dd>
        <dt>Model</dt><dd className="mono">{run.model ?? '—'}</dd>
        <dt>Target</dt><dd className="mono">{run.target ?? '—'}</dd>
        <dt>Started</dt><dd>{formatWhen(run.startedAt)}</dd>
        <dt>Elapsed</dt><dd data-testid="live-elapsed">{formatDuration(elapsed)}</dd>
        <dt>Current stage</dt><dd data-testid="live-current-stage">{state.currentStage ? `${state.currentStage.label}${state.currentAttempt ? ` — attempt ${state.currentAttempt}` : ''}` : '—'}</dd>
      </dl>

      {active && data.cancellable && (
        <div className="buttons">
          <button className="danger" onClick={() => setConfirming(true)} disabled={cancel.isPending}>Cancel Run</button>
        </div>
      )}
      {active && !data.cancellable && <p className="muted small">This run was started from the terminal (or its cancellation is under way); stop it where it was started.</p>}
      {confirming && (
        <div className="panel confirm" role="dialog" aria-label="Cancel this QA run?">
          <h3>Cancel this QA run?</h3>
          <p>Completed artifacts will be preserved. The current stage will stop.</p>
          <div className="buttons">
            <button onClick={() => setConfirming(false)}>Keep Running</button>
            <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel Run</button>
          </div>
          {cancel.error && <p className="notice bad">{(cancel.error as Error).message}</p>}
        </div>
      )}

      {state.status === 'FAILED' && (
        <div className="notice bad" data-testid="live-failure">
          <b>FAILED</b>
          {failedStage && <><br />Stage: <b>{failedStage.label}</b></>}
          <br />Error: {failedStage?.problem ?? run.errorSummary ?? state.finalEvent?.message ?? 'The run ended without recording why.'}
          <div className="buttons">
            {errors.length > 0 && <button onClick={() => setShowDiagnostics((v) => !v)}>{showDiagnostics ? 'Hide' : 'Open'} diagnostic details</button>}
            {data.langfuseUrl && <a className="button" href={data.langfuseUrl} target="_blank" rel="noreferrer">Open in Langfuse</a>}
          </div>
          {showDiagnostics && <ul className="diagnostics">{errors.map((e) => <li key={e.id}>{time(e.timestamp)} {e.message}</li>)}</ul>}
        </div>
      )}
      {state.status === 'CANCELLED' && <p className="notice warn" data-testid="live-cancelled">Cancelled by the operator. Completed artifacts are kept in the run's archive.</p>}
      {state.status === 'COMPLETED' && <p className="notice ok" data-testid="live-completed">{state.finalEvent?.message ?? 'Run completed.'}</p>}

      <div className="columns live">
        <div>
          <h2>Pipeline</h2>
          <ol className="pipeline" data-testid="pipeline">
            {state.stages.map((s: LiveStage) => (
              <li key={s.key} className={`stage-${s.state.toLowerCase()}`} data-testid={`pipeline-${s.key}`} data-state={s.state}>
                <span className="icon">{ICON[s.state]}</span> {s.label}
                <span className="muted small"> {s.state}{s.attempts > 0 ? ` · ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}` : ''}{s.durationMs !== null ? ` · ${formatDuration(s.durationMs)}` : ''}</span>
              </li>
            ))}
          </ol>

          <h2>Metrics</h2>
          <dl className="live-metrics" data-testid="live-metrics">
            {LIVE_METRICS.filter(([name]) => name in state.metrics).map(([name, label]) => (
              <div key={name} className="metric"><dt>{label}</dt><dd data-testid={`live-metric-${name}`}>{state.metrics[name]}</dd></div>
            ))}
            {!LIVE_METRICS.some(([name]) => name in state.metrics) && <p className="muted">No counts yet — they appear as stages produce artifacts.</p>}
          </dl>
          {!active && Object.keys(state.metrics).length > 0 && <p className="muted small">All metrics, grouped: <Link to={`/runs/${id}`}>run details</Link> ({METRIC_GROUPS.length} groups).</p>}

          <h2>Artifacts</h2>
          {state.artifacts.length === 0 ? <p className="muted">None yet.</p> : (
            <ul className="artifacts" data-testid="live-artifacts">
              {state.artifacts.map((a) => {
                const link = artifactLink(id, a.type);
                return link ? <li key={a.type}><Link to={link.to} data-testid={`view-${a.type}`}>{link.label}</Link>{a.count !== undefined ? ` (${a.count})` : ''}</li> : null;
              })}
            </ul>
          )}
          {data.langfuseUrl && state.status !== 'FAILED' && <p><a href={data.langfuseUrl} target="_blank" rel="noreferrer">Open in Langfuse</a></p>}
        </div>

        <div>
          <h2>Activity</h2>
          <div className="filters" role="group" aria-label="Event filter">
            {EVENT_FILTERS.map((f) => <button key={f.id} className={filter === f.id ? 'active' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
          <div className="event-log" ref={logRef} data-testid="event-log">
            {shown.length === 0 && <p className="muted">No events{filter === 'all' ? ' yet' : ' of this kind'}.</p>}
            {shown.map((e) => (
              <div key={e.id} className={`event level-${e.level}`} data-testid="event" data-type={e.type}>
                <span className="t">{time(e.timestamp)}</span>
                <span className="c">{e.category}</span>
                <span className="m">{e.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
