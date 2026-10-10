import { useMutation } from '@tanstack/react-query';
import { api, type ApiPreview, type RunConfig } from '../api/client.ts';
import { operationKey, SAFETY_LABEL } from '../lib/api-validation.ts';

export interface LiveChoice { enabled: boolean; baseUrl: string; approved: string[] }

/**
 * Live API validation for a run: whether the host may call the documented API,
 * where it is, and — operation by operation — what a person approves beyond
 * read-only requests. Approvals can only be picked from a preview of the
 * documentation, so each one names an operation that document declares.
 */
export function ApiValidationOptions({ docsUrl, config, choice, onChange }: {
  docsUrl: string;
  config: RunConfig['apiValidation'];
  choice: LiveChoice;
  onChange: (next: LiveChoice) => void;
}) {
  const preview = useMutation<ApiPreview, Error>({ mutationFn: () => api.previewApiDocs(docsUrl.trim(), choice.baseUrl.trim() || undefined) });
  const plan = preview.data?.plan ?? null;
  const unsafe = plan?.operations.filter((o) => o.needsApproval) ?? [];
  const toggle = (key: string) => onChange({ ...choice, approved: choice.approved.includes(key) ? choice.approved.filter((k) => k !== key) : [...choice.approved, key] });

  return (
    <fieldset className="coverage-mode" data-testid="live-validation">
      <legend>Live API validation</legend>
      <label className="check">
        <input type="checkbox" aria-label="Live API validation" checked={choice.enabled} onChange={(e) => onChange({ ...choice, enabled: e.target.checked, approved: e.target.checked ? choice.approved : [] })} />
        <span>Call the documented API and compare its real responses with the documentation <span className="muted">— read-only requests unless you approve an operation below. Off: the documentation is used alone.</span></span>
      </label>
      {choice.enabled && (
        <>
          <label>API base URL <span className="muted">(optional — where the API is, when not where its documentation says)</span>
            <input type="url" aria-label="API base URL" data-testid="api-base-url" value={choice.baseUrl} maxLength={500}
              placeholder={config.baseUrl ?? 'from the documentation'} onChange={(e) => onChange({ ...choice, baseUrl: e.target.value, approved: [] })} />
          </label>
          <div className="muted small">
            Environment: <b>{config.environment}</b>{config.protectedEnvironment ? ' — protected: nothing state-changing is ever sent here' : ''} ·
            Credentials: {config.credentialsConfigured ? 'configured on the host' : 'none configured (QA_API_AUTH_TOKEN, or QA_API_AUTH_USERNAME / QA_API_AUTH_PASSWORD) — secured operations are only checked for refusing a request without them'}
          </div>
          <div className="buttons">
            <button type="button" data-testid="api-preview" disabled={!docsUrl.trim() || preview.isPending} onClick={() => { onChange({ ...choice, approved: [] }); preview.mutate(); }}>
              {preview.isPending ? 'Reading the documentation…' : 'Preview API and approvals'}
            </button>
          </div>
          {preview.error && <p className="notice bad small" data-testid="api-preview-error">{preview.error.message}</p>}
          {preview.data && !plan && (
            <p className="notice warn small" data-testid="api-preview-unavailable">
              The documentation could not be used: {preview.data.documentation.reason ?? 'no operations found'}. A run would continue without API validation.
            </p>
          )}
          {plan && (
            <div className="api-plan" data-testid="api-plan">
              <div>
                <b>{preview.data?.documentation.title ?? 'API'}</b> · {plan.operations.length} documented operation(s) · base URL{' '}
                <code className="chip">{plan.baseUrl ?? '—'}</code>
              </div>
              {!plan.allowed && <p className="notice bad small" data-testid="api-plan-blocked">The API will not be called: {plan.reason}.</p>}
              {plan.allowed && (
                <p className="muted small">
                  {plan.operations.length - unsafe.length} read-only operation(s) are called by default.{' '}
                  {unsafe.length > 0
                    ? plan.protectedEnvironment
                      ? `${unsafe.length} state-changing operation(s) are never called in this environment.`
                      : `${unsafe.length} operation(s) change state and are called only if you approve them here. Changes and deletions only ever touch what this run itself created.`
                    : ''}
                </p>
              )}
              {plan.allowed && unsafe.length > 0 && (
                <table className="list">
                  <thead><tr><th>Approve</th><th>Operation</th><th>Kind</th></tr></thead>
                  <tbody>
                    {unsafe.map((o) => {
                      const key = operationKey(o);
                      return (
                        <tr key={o.id}>
                          <td><input type="checkbox" aria-label={`Approve ${key}`} data-testid={`approve-${o.id}`} disabled={plan.protectedEnvironment} checked={choice.approved.includes(key)} onChange={() => toggle(key)} /></td>
                          <td className="mono">{key}<div className="muted small">{o.summary}</div></td>
                          <td>{SAFETY_LABEL[o.safety]}{o.secured ? ' · secured' : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {choice.approved.length > 0 && <p className="notice warn small" data-testid="approved-count">{choice.approved.length} state-changing operation(s) approved for this run: real data will be created or changed in {plan?.baseUrl ?? 'the API'}.</p>}
        </>
      )}
    </fieldset>
  );
}
