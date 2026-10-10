import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ApiEndpointView, type ApiProbeView } from '../api/client.ts';
import {
  discoveryLabel, discoveryNotes, endpointCounts, EVIDENCE_HINT, EVIDENCE_LABEL, matchesEndpointFilter, probeKindLabel, SAFETY_LABEL, skipLabel, unavailableMessage,
  type EndpointFilter,
} from '../lib/api-validation.ts';
import { coverageModeLabel } from '../lib/coverage.ts';
import { formatWhen } from '../lib/runs.ts';

function Evidence({ value }: { value: 'DOCUMENTED' | 'OBSERVED' | 'VALIDATED' }) {
  return <span className={`badge evidence-${value.toLowerCase()}`} title={EVIDENCE_HINT[value]}>{EVIDENCE_LABEL[value]}</span>;
}

function Probe({ probe }: { probe: ApiProbeView }) {
  return (
    <div className="probe" data-testid={`probe-${probe.id}`}>
      <p>
        <b>{probe.id}</b> · {probeKindLabel(probe.kind)} · <span className="mono">{probe.request.method} {probe.request.url}</span>{' '}
        {probe.response
          ? <>→ <b>{probe.response.status}</b>{probe.response.contentType ? ` ${probe.response.contentType}` : ''} <span className="muted">({probe.response.durationMs} ms)</span> {probe.evidence && <Evidence value={probe.evidence} />}</>
          : <span className="notice bad small">no response: {probe.error?.message ?? 'unknown'}</span>}
      </p>
      {probe.checks.length > 0 && (
        <ul className="checks">
          {probe.checks.map((c) => (
            <li key={c.name} className={`check-${c.outcome.toLowerCase()}`}>
              {c.outcome === 'PASS' ? '✓' : c.outcome === 'FAIL' ? '✗' : '–'} {c.name.toLowerCase().replace('_', ' ')}{c.detail ? `: ${c.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
      {probe.request.body && <><h5>Request body</h5><pre>{probe.request.body}</pre></>}
      {probe.response?.bodySample && <><h5>Response body{probe.response.bodyTruncated ? ' (truncated)' : ''} — sensitive values redacted</h5><pre>{probe.response.bodySample}</pre></>}
    </div>
  );
}

function EndpointRow({ e }: { e: ApiEndpointView }) {
  const [open, setOpen] = useState(false);
  const expandable = e.probes.length > 0 || e.findings.length > 0 || e.skipDetail;
  return (
    <>
      <tr data-testid={`endpoint-${e.id}`} data-evidence={e.evidence}>
        <td className="mono">{e.id}</td>
        <td className="mono"><b>{e.method}</b> {e.path}{e.deprecated ? ' (deprecated)' : ''}<div className="muted small">{e.summary}</div></td>
        <td><Evidence value={e.evidence} /></td>
        <td>
          {e.execution === 'EXECUTED'
            ? <>Called · {e.probes.length} request(s){e.skipDetail ? <div className="muted small">{e.skipDetail}</div> : null}</>
            : <><span className="badge none" data-testid={`skip-${e.id}`}>{skipLabel(e.skipReason) || 'Not called'}</span>{e.skipDetail ? <div className="muted small">{e.skipDetail}</div> : null}</>}
        </td>
        <td>{e.safety ? SAFETY_LABEL[e.safety] : '—'}{e.secured ? ' · secured' : ''}</td>
        <td>{e.findings.length > 0 ? <span className="badge stale">{e.findings.length} mismatch(es)</span> : e.execution === 'EXECUTED' ? '—' : ''}</td>
        <td>{e.testCases.map((t) => <Link key={t.id} to={`/test-cases/${encodeURIComponent(t.id)}`} title={t.title}>{t.id} </Link>)}</td>
        <td>{expandable && <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Details'}</button>}</td>
      </tr>
      {open && (
        <tr className="endpoint-detail">
          <td colSpan={8}>
            <p className="muted small">Documented statuses: {e.documentedStatuses.join(', ') || 'none'}</p>
            {e.findings.map((f) => (
              <div key={f.id} className={`notice ${f.classification === 'CONTRACT_VIOLATION' ? 'bad' : 'warn'}`} data-testid={`finding-${f.id}`}>
                <b>{f.classification === 'CONTRACT_VIOLATION' ? 'Contract violation' : 'Potential issue'}</b> · {f.severity} · {f.title}
                <div className="small">Expected: {f.expected}</div>
                <div className="small">Actual: {f.actual}</div>
              </div>
            ))}
            {e.probes.map((p) => <Probe key={p.id} probe={p} />)}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Live API discovery and validation for the suite in the workspace: every
 * documented operation, whether the host called it, and what came back.
 * Read-only — the host wrote all of it.
 */
export function ApiPage() {
  const { data, error } = useQuery({ queryKey: ['api-validation'], queryFn: api.apiValidation, refetchInterval: 5000 });
  const [filter, setFilter] = useState<EndpointFilter>('ALL');
  if (error) return <><h1>API</h1><p className="notice bad">{(error as Error).message}</p></>;
  if (!data) return <><h1>API</h1><p>Loading…</p></>;
  const message = unavailableMessage(data);
  const counts = endpointCounts(data.endpoints);
  const v = data.validation;
  const shown = data.endpoints.filter((e) => matchesEndpointFilter(e, filter));
  const violations = data.findings.filter((f) => f.classification === 'CONTRACT_VIOLATION');
  const issues = data.findings.filter((f) => f.classification === 'POTENTIAL_ISSUE');

  return (
    <>
      <h1>API <span className="muted">discovery and live validation</span></h1>
      <p className="muted">
        Test coverage: <b>{coverageModeLabel(data.coverageMode)}</b>
        {data.documentation?.title ? <> · {data.documentation.title}{data.documentation.version ? ` ${data.documentation.version}` : ''}</> : null}
        {data.apiDocsUrl ? <> · documentation: <span className="mono">{data.apiDocsUrl}</span></> : null}
      </p>
      <p className="muted" data-testid="discovery-method">Discovery: <b>{discoveryLabel(data.discovery)}</b></p>
      {discoveryNotes(data.discovery).map((n) => <p key={n} className="notice small" data-testid="discovery-note">{n}</p>)}
      {data.discovery?.api && data.discovery.api.criteria.length > 0 && (
        <details data-testid="discovery-criteria">
          <summary>API discovery: {data.discovery.api.status === 'COMPLETE' ? 'complete' : data.discovery.api.status.toLowerCase()} — its own criteria, none about a browser</summary>
          <ul className="checks">
            {data.discovery.api.criteria.map((c) => (
              <li key={c.name} className={c.met ? 'check-pass' : c.required ? 'check-fail' : 'check-not_checked'}>
                {c.met ? '✓' : c.required ? '✗' : '–'} {c.name.toLowerCase().replace(/_/g, ' ')}{c.required ? '' : ' (optional)'}: {c.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      {message && <p className="notice warn" data-testid="api-unavailable">{message}</p>}
      {v?.status === 'PARTIAL' && <p className="notice warn" data-testid="api-partial"><b>Partial.</b> {v.reason}</p>}

      {data.endpoints.length > 0 && (
        <>
          <div className="tiles" data-testid="api-summary">
            <div className="tile"><b>{counts.ALL}</b>documented operations</div>
            <div className="tile"><b data-testid="api-validated">{counts.VALIDATED}</b>validated</div>
            <div className="tile"><b data-testid="api-observed">{counts.OBSERVED}</b>observed</div>
            <div className="tile"><b data-testid="api-documented-only">{counts.DOCUMENTED}</b>documented only</div>
            <div className="tile"><b data-testid="api-violations">{violations.length}</b>contract violations</div>
            <div className="tile"><b data-testid="api-issues">{issues.length}</b>potential issues</div>
          </div>
          {v && (v.status === 'COMPLETED' || v.status === 'PARTIAL') && (
            <dl className="run-meta" data-testid="api-run">
              <dt>API base URL</dt><dd className="mono">{v.baseUrl}{v.baseUrlSource === 'OVERRIDE' ? ' (set for this run)' : v.baseUrlSource === 'SPEC_SERVER' ? ' (from the documentation)' : ' (where the documentation is)'}</dd>
              <dt>Requests sent</dt><dd>{v.policy.requestsSent} of at most {v.policy.maxRequests} · {formatWhen(v.startedAt)}</dd>
              <dt>Environment</dt><dd>{v.environment}</dd>
              <dt>Credentials</dt><dd data-testid="api-credentials">{v.authentication.status === 'READY' ? `configured (${v.authentication.method})` : v.authentication.status === 'FAILED' ? `not usable — ${v.authentication.detail}` : 'none configured — secured operations were only checked for refusing a request without credentials'}</dd>
              <dt>Approved operations</dt><dd>{v.policy.approvedOperations.length ? v.policy.approvedOperations.map((o) => <code key={o} className="chip">{o}</code>) : 'none — only read-only requests were sent'}</dd>
              <dt>Allowed hosts</dt><dd>{v.policy.allowedHosts.map((h) => <code key={h} className="chip">{h}</code>)}</dd>
            </dl>
          )}

          <h2>Operations</h2>
          <div className="filters">
            {(['ALL', 'VALIDATED', 'OBSERVED', 'DOCUMENTED', 'SKIPPED', 'MISMATCH'] as EndpointFilter[]).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)} data-testid={`api-filter-${f}`}>
                {f === 'ALL' ? 'All' : f === 'SKIPPED' ? 'Not called' : f === 'MISMATCH' ? 'With mismatches' : EVIDENCE_LABEL[f]} ({counts[f]})
              </button>
            ))}
          </div>
          <table className="list" data-testid="api-endpoints">
            <thead><tr><th>ID</th><th>Operation</th><th>Evidence</th><th>Execution</th><th>Kind</th><th>Mismatches</th><th>Test cases</th><th /></tr></thead>
            <tbody>{shown.map((e) => <EndpointRow key={e.id} e={e} />)}</tbody>
          </table>

          <h2>Requirements from the API</h2>
          {data.requirements.length === 0 ? <p className="muted">No requirement rests on a documented operation yet.</p> : (
            <table className="list" data-testid="api-requirements">
              <thead><tr><th>ID</th><th>Requirement</th><th>Evidence</th><th>Operations</th><th>Test cases</th></tr></thead>
              <tbody>
                {data.requirements.map((r) => (
                  <tr key={r.id} data-testid={`api-requirement-${r.id}`}>
                    <td className="mono">{r.id}</td>
                    <td>{r.statement}</td>
                    <td>
                      {r.source === 'UI_AND_API' && <span className="badge level-ui" title={`Observed in the interface: ${r.uiEvidence.join(', ')}`}>UI</span>}
                      <span className="badge level-api">API</span>
                      {r.apiEvidence && <Evidence value={r.apiEvidence} />}
                    </td>
                    <td className="mono">{r.operations.join(', ')}</td>
                    <td>{r.testCases.length ? r.testCases.map((t) => <Link key={t} to={`/test-cases/${encodeURIComponent(t)}`}>{t} </Link>) : <span className="muted">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.findings.length > 0 && (
            <>
              <h2>Contract mismatches and potential defects</h2>
              <p className="muted">Found by the host, by comparing real responses with the documentation. A <b>contract violation</b> contradicts something the documentation states; a <b>potential issue</b> needs a person to look. The Defect Analyzer classifies them as bugs under <Link to="/bugs">Bugs</Link>.</p>
              <table className="list" data-testid="api-findings">
                <thead><tr><th>ID</th><th>Classification</th><th>Severity</th><th>Operation</th><th>Finding</th></tr></thead>
                <tbody>
                  {data.findings.map((f) => (
                    <tr key={f.id}>
                      <td className="mono">{f.id}</td>
                      <td><span className={`badge ${f.classification === 'CONTRACT_VIOLATION' ? 'run-failed' : 'run-running'}`}>{f.classification === 'CONTRACT_VIOLATION' ? 'Contract violation' : 'Potential issue'}</span></td>
                      <td>{f.severity}</td>
                      <td className="mono">{f.endpointId}</td>
                      <td>{f.title}<div className="muted small">Expected: {f.expected} Actual: {f.actual}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </>
  );
}
