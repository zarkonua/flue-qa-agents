import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { ARTIFACT_LABEL, formatDuration, formatWhen, KIND_LABEL, metric, METRIC_GROUPS } from '../lib/runs.ts';

export function SnapshotBanner({ runId }: { runId: string }) {
  const live = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) }).data?.live;
  if (live) {
    return (
      <p className="notice snapshot warn" data-testid="snapshot-banner">
        <b>Live — read only.</b> Written by run <Link to={`/runs/${runId}/live`}>{runId}</Link>, which is still in progress; later stages may still depend on it.
      </p>
    );
  }
  return (
    <p className="notice snapshot" data-testid="snapshot-banner">
      <b>Historical snapshot — read only.</b> What run <Link to={`/runs/${runId}`}>{runId}</Link> produced, as archived when it ended.
      Later decisions and edits are not reflected here; changes are made in the current workspace.
    </p>
  );
}

export function RunPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    refetchInterval: (q) => (q.state.data?.run.status === 'RUNNING' ? 3000 : false),
  });
  if (error) return <p className="notice bad">{(error as Error).message}</p>;
  if (!data) return <p>Loading…</p>;
  const { run, stages, metrics } = data;
  const groups = METRIC_GROUPS.map((g) => ({ ...g, metrics: g.metrics.filter(([name]) => name in metrics) })).filter((g) => g.metrics.length > 0);
  const viewable = data.artifacts.filter((a) => a in ARTIFACT_LABEL);

  return (
    <>
      <p><Link to="/runs">← All runs</Link> · <Link to={`/runs/${run.id}/live`}>{data.live ? 'Live view' : 'Event log'}</Link>{data.langfuseUrl && <> · <a href={data.langfuseUrl} target="_blank" rel="noreferrer">Open in Langfuse</a></>}</p>
      <h1>Run {formatWhen(run.startedAt)} <span className={`badge run-${run.status.toLowerCase()}`} data-testid="run-status">{run.status}</span></h1>
      <SnapshotBanner runId={run.id} />
      {run.errorSummary && <p className={`notice ${run.status === 'FAILED' ? 'bad' : 'warn'}`} data-testid="run-error">{run.errorCode ? <b>{run.errorCode}: </b> : null}{run.errorSummary}</p>}

      <dl className="run-meta">
        <dt>Run</dt><dd className="mono">{run.id}</dd>
        <dt>Kind</dt><dd>{KIND_LABEL[run.kind]}</dd>
        <dt>Model</dt><dd className="mono">{run.model ?? '—'}</dd>
        <dt>Provider</dt><dd>{run.provider ?? '—'}</dd>
        <dt>Target</dt><dd className="mono">{run.target ?? '—'}</dd>
        <dt>Git commit</dt><dd className="mono">{run.gitCommit ? `${run.gitCommit}${run.gitDirty ? ' (uncommitted changes)' : ''}` : '—'}</dd>
        <dt>Started</dt><dd>{formatWhen(run.startedAt)}</dd>
        <dt>Finished</dt><dd>{formatWhen(run.finishedAt)}</dd>
        <dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd>
        {/* Only archives made while an auth bootstrap existed recorded one; there is none on main. */}
        {run.authMode && <><dt>Auth bootstrap (historical)</dt><dd>{run.authMode}</dd></>}
        {run.langfuseTraceId && <><dt>Langfuse trace</dt><dd className="mono">{run.langfuseTraceId}</dd></>}
        <dt>Recorded</dt><dd>{run.source === 'IMPORTED' ? 'imported from its archive' : 'while it ran'}</dd>
      </dl>

      <h2>Stages</h2>
      {stages.length === 0 ? <p className="muted">No stage history was recorded for this run.</p> : (
        <table className="list" data-testid="stage-timeline">
          <thead><tr><th>#</th><th>Stage</th><th>Status</th><th>Duration</th><th>Attempts</th><th>Problem</th></tr></thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.ordinal} data-testid={`stage-${s.stageName}`} className={`stage-${s.status.toLowerCase()}`}>
                <td>{s.ordinal}</td>
                <td>{s.label ?? s.stageName}</td>
                <td>{s.status === 'COMPLETED' ? '✓' : s.status === 'FAILED' ? '✗' : s.status === 'RUNNING' ? '…' : '■'} {s.status}</td>
                <td>{formatDuration(s.durationMs)}</td>
                <td>{s.attemptCount}</td>
                <td className="muted">{s.errorSummary ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Metrics</h2>
      {groups.length === 0 ? <p className="muted">No metrics were recorded for this run.</p> : (
        <div className="metric-groups" data-testid="run-metrics">
          {groups.map((g) => (
            <div className="panel" key={g.title}>
              <h3>{g.title}</h3>
              <dl>{g.metrics.map(([name, label]) => <div key={name} className="metric"><dt>{label}</dt><dd data-testid={`metric-${name}`}>{metric(metrics, name)}</dd></div>)}</dl>
            </div>
          ))}
        </div>
      )}

      <h2>Archived output</h2>
      {!run.archiveRelPath ? <p className="muted">This run left no archive.</p> : (
        <div className="buttons" data-testid="archived-output">
          {data.artifacts.includes('TEST_CASES') && <Link className="button" to={`/runs/${run.id}/test-cases`}>Test Cases ({metric(metrics, 'test_cases_total')})</Link>}
          {data.bugIds.length > 0 && <Link className="button" to={`/runs/${run.id}/bugs`}>Bugs ({data.bugIds.length})</Link>}
          {viewable.map((a) => <Link key={a} className="button" to={`/runs/${run.id}/artifacts/${a}`}>{ARTIFACT_LABEL[a]}</Link>)}
        </div>
      )}
    </>
  );
}
