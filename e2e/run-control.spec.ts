// Run control in a real browser: start Phase 1 from the workspace, watch it
// live, cancel it, survive a reload. Served by e2e/serve-run-control-fixture.ts —
// the real server, controller and history, with a deterministic runner
// (the model name picks its behaviour: fake-complete, fake-slow, fake-fail).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: 'http://127.0.0.1:4557' });

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures', 'phase1-approved');
/** The fixture API e2e/serve-run-control-fixture.ts starts: real HTTP, its own OpenAPI document, one deliberate schema fault. */
const FAKE_API = 'http://127.0.0.1:4559';
const fixtureCount = (file: string, key: string) => (JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))[key] as unknown[]).length;

async function startRun(page: Page, model: string, fresh = false) {
  await page.goto('/runs/new');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  await page.getByLabel('Model').selectOption(model);
  if (fresh) await page.getByLabel('Fresh browser').check();
  await page.getByRole('button', { name: 'Start Phase 1' }).click();
  await expect(page).toHaveURL(/\/runs\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/live$/);
}
const stage = (page: Page, key: string) => page.getByTestId(`pipeline-${key}`);

test('start a run: New Run -> Live Run, RUNNING, stages PENDING -> RUNNING -> COMPLETED without a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'New Run' }).click();
  await expect(page.getByLabel('Target')).toHaveValue('http://localhost:4444/');
  await expect(page.getByText('http://localhost:8025')).toBeVisible(); // helper origins, read-only
  await startRun(page, 'ollama/fake-complete', true);
  await expect(page.getByTestId('live-status')).toHaveText(/STARTING|RUNNING/);
  await expect(stage(page, 'defects')).toHaveAttribute('data-state', 'PENDING');
  await expect(page.getByTestId('live-status')).toHaveText('RUNNING');
  await expect(stage(page, 'defects')).toHaveAttribute('data-state', 'RUNNING', { timeout: 20_000 });
  await expect(stage(page, 'defects')).toHaveAttribute('data-state', 'COMPLETED', { timeout: 20_000 });
  await expect(page.getByTestId('live-status')).toHaveText('COMPLETED');
  for (const key of ['discovery', 'analysis', 'design', 'prioritization']) await expect(stage(page, key)).toHaveAttribute('data-state', 'COMPLETED');
  await expect(page.getByTestId('live-completed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Run' })).toHaveCount(0);
});

test('live log: in order, filterable, and redacted; live metrics and artifact links', async ({ page }) => {
  await page.goto('/runs');
  await page.locator('tr[data-testid^="run-row-"]').first().getByRole('link').click();
  await page.getByRole('link', { name: 'Event log' }).click();
  const events = page.getByTestId('event');
  await expect(events.first()).toHaveAttribute('data-type', 'RUN_STARTED');
  await expect(events.last()).toHaveAttribute('data-type', 'RUN_COMPLETED');
  const types = await events.evaluateAll((els) => els.map((e) => e.getAttribute('data-type')));
  expect(types.indexOf('STAGE_STARTED')).toBeLessThan(types.indexOf('STAGE_COMPLETED'));
  await expect(page.getByTestId('event-log')).toContainText('fresh browser');
  await expect(page.getByTestId('event-log')).not.toContainText('987654');
  await expect(page.getByTestId('event-log')).not.toContainText('sk-or-v1-0123');

  await page.getByRole('button', { name: 'Stages', exact: true }).click();
  const staged = await events.evaluateAll((els) => els.map((e) => e.querySelector('.c')?.textContent));
  expect(new Set(staged)).toEqual(new Set(['RUN', 'STAGE']));
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  expect(new Set(await events.evaluateAll((els) => els.map((e) => e.querySelector('.c')?.textContent)))).toEqual(new Set(['BROWSER']));
  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  await expect(events).toHaveCount(0);

  await expect(page.getByTestId('live-metric-test_cases_total')).toHaveText(String(fixtureCount('test-cases.json', 'testCases')));
  await expect(page.getByTestId('live-metric-discovered_behaviors')).toHaveText(String(fixtureCount('discovered-behavior.json', 'behaviors')));
  await page.getByTestId('view-TEST_CASES').click();
  await expect(page.locator('[data-testid^="historical-case-"]')).toHaveCount(fixtureCount('test-cases.json', 'testCases'));
});

test('while a run is active: a second one cannot start; its artifacts are viewable live; a reload restores it; cancel with confirmation', async ({ page }) => {
  await startRun(page, 'ollama/fake-slow');
  const runUrl = page.url();
  await expect(stage(page, 'design')).toHaveAttribute('data-state', 'RUNNING', { timeout: 20_000 });
  await expect(page.getByTestId('live-current-stage')).toContainText('Test Designer');
  await expect(page.getByTestId('live-metric-discovered_behaviors')).toBeVisible();

  // Artifacts already written can be opened, read-only, while the run goes on.
  await page.getByTestId('view-DISCOVERED_BEHAVIOR').click();
  await expect(page.getByTestId('snapshot-banner')).toContainText('Live — read only');
  await expect(page.getByTestId('historical-artifact')).toContainText('behaviors');

  // Another run cannot start.
  await page.goto('/runs/new');
  await expect(page.getByTestId('run-busy')).toContainText('Another QA run is already active');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeDisabled();
  await expect(page.getByTestId('run-in-progress')).toBeVisible();

  // A reload: state comes back from the history, and the stream reconnects.
  await page.goto(runUrl);
  await page.reload();
  await expect(stage(page, 'design')).toHaveAttribute('data-state', 'RUNNING');
  await expect(stage(page, 'discovery')).toHaveAttribute('data-state', 'COMPLETED');
  await expect(page.getByTestId('live-metric-discovered_behaviors')).toBeVisible();
  await expect(page.getByTestId('event').first()).toHaveAttribute('data-type', 'RUN_STARTED');
  const before = await page.getByTestId('event').count();

  // Cancel, with confirmation — "Keep Running" first.
  await page.getByRole('button', { name: 'Cancel Run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this QA run?' });
  await expect(dialog).toContainText('Completed artifacts will be preserved.');
  await dialog.getByRole('button', { name: 'Keep Running' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('live-status')).toHaveText('RUNNING');
  await page.getByRole('button', { name: 'Cancel Run' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel Run' }).click();
  await expect(page.getByTestId('live-status')).toHaveText('CANCELLED', { timeout: 20_000 });
  await expect(stage(page, 'design')).toHaveAttribute('data-state', 'CANCELLED');
  await expect(stage(page, 'analysis')).toHaveAttribute('data-state', 'COMPLETED');
  await expect(stage(page, 'defects')).toHaveAttribute('data-state', 'PENDING');
  await expect(page.getByTestId('live-cancelled')).toBeVisible();
  // The stream kept going after the reload: the cancellation arrives as events, after the history says CANCELLED at the latest.
  await expect(page.getByTestId('event').last()).toHaveAttribute('data-type', 'RUN_CANCELLED');
  expect(await page.getByTestId('event').count()).toBeGreaterThan(before);

  // The lock is gone: a new run can start.
  await page.goto('/runs/new');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
});

test('test coverage: three modes, Automatic by default; the API documentation field follows the mode', async ({ page }) => {
  await page.goto('/runs/new');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  const modes = page.getByTestId('coverage-mode');
  await expect(modes.getByRole('radio')).toHaveCount(3);
  await expect(modes.getByRole('radio', { name: /Automatic/ })).toBeChecked();
  // Automatic: the URL is offered and optional.
  const docs = page.getByLabel('API documentation URL');
  await expect(docs).toBeVisible();
  await expect(docs).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  // UI only: no API documentation is read, so the field is gone.
  await modes.getByRole('radio', { name: /UI only/ }).check();
  await expect(docs).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  // API only: the field is back, and required.
  await modes.getByRole('radio', { name: /API only/ }).check();
  await expect(docs).toBeVisible();
  await expect(page.getByTestId('api-docs-problem')).toContainText('needs the URL');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeDisabled();
  await docs.fill('not a url');
  await expect(page.getByTestId('api-docs-problem')).toContainText('http:// or https://');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeDisabled();
  await docs.fill('http://localhost:4444/api/doc');
  await expect(page.getByTestId('api-docs-problem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
});

test('a run keeps the coverage mode it was started in: shown on the run and in the list', async ({ page }) => {
  await page.goto('/runs/new');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  await page.getByTestId('coverage-mode').getByRole('radio', { name: /API only/ }).check();
  await page.getByLabel('API documentation URL').fill(`${FAKE_API}/docs?api_key=s3cr3t`);
  await page.getByRole('button', { name: 'Start Phase 1' }).click();
  await expect(page).toHaveURL(/\/runs\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/live$/);
  const runId = /\/runs\/([^/]+)\/live$/.exec(page.url())![1];
  await expect(page.getByTestId('live-status')).toHaveText('COMPLETED', { timeout: 30_000 });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId('run-coverage-mode')).toHaveText('API only');
  // Stored and shown without its query — that is where a key would be.
  await expect(page.getByTestId('run-api-docs')).toHaveText(`${FAKE_API}/docs`);
  await page.goto('/runs');
  await expect(page.getByTestId(`run-coverage-${runId}`)).toHaveText('API only');
});

test('live API validation: preview, approve one operation, run, and read the results on the API page', async ({ page }) => {
  await page.goto('/runs/new');
  await expect(page.getByRole('button', { name: 'Start Phase 1' })).toBeEnabled();
  // Live validation is offered only beside documentation to validate against.
  await expect(page.getByTestId('live-validation')).toHaveCount(0);
  await page.getByLabel('API documentation URL').fill(`${FAKE_API}/docs`);
  const live = page.getByTestId('live-validation');
  await expect(live.getByLabel('Live API validation')).toBeChecked();
  await expect(live).toContainText('Credentials: configured on the host');
  await expect(live).not.toContainText('fake-api-token');

  // The preview reads the documentation and sends nothing to the API itself.
  await page.getByTestId('api-preview').click();
  const plan = page.getByTestId('api-plan');
  await expect(plan).toContainText('Items API');
  await expect(plan).toContainText('8 documented operation(s)');
  await expect(plan).toContainText(FAKE_API);
  await expect(plan).toContainText('3 read-only operation(s) are called by default');
  // Nothing state-changing is approved until a person ticks it — one operation at a time.
  const approvals = plan.getByRole('checkbox');
  await expect(approvals).toHaveCount(5);
  for (const box of await approvals.all()) await expect(box).not.toBeChecked();
  await expect(plan).toContainText('DELETE /items/{id}');
  await expect(plan).toContainText('Destructive');
  await plan.getByLabel('Approve POST /items').check();
  await expect(page.getByTestId('approved-count')).toContainText('1 state-changing operation(s) approved');

  // A base URL on a host the workspace may not call is refused before anything is sent.
  await page.getByLabel('API base URL').fill('https://api.production.example.com');
  await page.getByTestId('api-preview').click();
  await expect(page.getByTestId('api-plan-blocked')).toContainText('not a host this workspace may call');
  await page.getByLabel('API base URL').fill('');
  await page.getByTestId('api-preview').click();
  await expect(page.getByTestId('api-plan-blocked')).toHaveCount(0);
  await page.getByTestId('api-plan').getByLabel('Approve POST /items').check();

  await page.getByRole('button', { name: 'Start Phase 1' }).click();
  await expect(page).toHaveURL(/\/runs\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/live$/);
  const runId = /\/runs\/([^/]+)\/live$/.exec(page.url())![1];
  await expect(page.getByTestId('live-status')).toHaveText('COMPLETED', { timeout: 30_000 });

  // The API page: what is documented, what was really called, and what did not match.
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page.getByTestId('api-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('api-summary')).toContainText('8documented operations');
  await expect(page.getByTestId('api-violations')).toHaveText('1');
  await expect(page.getByTestId('api-credentials')).toContainText('configured (TOKEN)');
  await expect(page.getByTestId('api-run')).toContainText('POST /items');
  await expect(page.getByTestId('api-run')).not.toContainText('fake-api-token');
  const row = (key: string) => page.locator('tr[data-testid^="endpoint-"]').filter({ hasText: key });
  // Validated only where a real response matched; the listing breaks its schema, so it is merely observed.
  await expect(row('GET /health')).toHaveAttribute('data-evidence', 'VALIDATED');
  await expect(row('GET /items').first()).toHaveAttribute('data-evidence', 'OBSERVED');
  await expect(row('POST /items')).toContainText('Called');
  // Not approved, so never called — and the page says so instead of implying it was checked.
  await expect(row('DELETE /items/{id}')).toHaveAttribute('data-evidence', 'DOCUMENTED');
  await expect(row('DELETE /items/{id}')).toContainText('Needs approval');
  await expect(row('GET /session/logout')).toContainText('Needs approval');

  // Filters, then the evidence behind one row: the real request and response, secrets redacted.
  await page.getByTestId('api-filter-MISMATCH').click();
  await expect(page.locator('tr[data-testid^="endpoint-"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Details' }).click();
  const detail = page.locator('tr.endpoint-detail');
  await expect(detail).toContainText('Contract violation');
  await expect(detail).toContainText('does not match its documented schema');
  await expect(detail).toContainText('With credentials');
  await expect(detail).toContainText('→ 200');
  await expect(detail).not.toContainText('fake-api-token');
  await page.getByTestId('api-filter-DOCUMENTED').click();
  await expect(page.locator('tr[data-testid^="endpoint-"]')).toHaveCount(4);
  await expect(page.getByTestId('api-findings')).toContainText('Contract violation');

  // The run keeps its own results: metrics on the run, and the raw artifact in its archive.
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId('metric-api_contract_violations')).toHaveText('1');
  await expect(page.getByTestId('metric-api_endpoints_documented_only')).toHaveText('4');
  await page.getByRole('link', { name: 'Live API validation' }).click();
  await expect(page.getByTestId('historical-artifact')).toContainText('"CONTRACT_VIOLATION"');
  await expect(page.getByTestId('historical-artifact')).not.toContainText('fake-api-token');
});

test('live API validation off, or unavailable: the API page says why, and nothing is shown as validated', async ({ page }) => {
  await page.goto('/runs/new');
  await page.getByLabel('API documentation URL').fill(`${FAKE_API}/docs`);
  await page.getByTestId('live-validation').getByLabel('Live API validation').uncheck();
  await expect(page.getByTestId('api-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start Phase 1' }).click();
  await expect(page.getByTestId('live-status')).toHaveText('COMPLETED', { timeout: 30_000 });
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page.getByTestId('api-unavailable')).toContainText('The API was not called');
  await expect(page.getByTestId('api-validated')).toHaveText('0');
  await expect(page.getByTestId('api-documented-only')).toHaveText('8');

  // Documentation that cannot be read: a useful message, not an empty page.
  await page.goto('/runs/new');
  await page.getByLabel('API documentation URL').fill(`${FAKE_API}/nothing-here`);
  await page.getByTestId('api-preview').click();
  await expect(page.getByTestId('api-preview-unavailable')).toContainText('could not be used');
});

test('a failed stage: FAILED, the stage and a sanitised reason, diagnostics on request', async ({ page }) => {
  await startRun(page, 'ollama/fake-fail');
  const failure = page.getByTestId('live-failure');
  await expect(failure).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('live-status')).toHaveText('FAILED');
  await expect(failure).toContainText('Test Designer');
  await expect(failure).toContainText('Model response could not be parsed');
  await expect(failure).not.toContainText('abc123secret');
  await failure.getByRole('button', { name: 'Open diagnostic details' }).click();
  await expect(failure.locator('.diagnostics li')).not.toHaveCount(0);
  await expect(stage(page, 'design')).toHaveAttribute('data-state', 'FAILED');
  await expect(stage(page, 'prioritization')).toHaveAttribute('data-state', 'PENDING');
});
