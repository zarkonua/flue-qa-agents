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
  await page.getByLabel('API documentation URL').fill('http://localhost:4444/api/doc?api_key=s3cr3t');
  await page.getByRole('button', { name: 'Start Phase 1' }).click();
  await expect(page).toHaveURL(/\/runs\/\d{4}-\d{2}-\d{2}T[\d-]+Z\/live$/);
  const runId = /\/runs\/([^/]+)\/live$/.exec(page.url())![1];
  await expect(page.getByTestId('live-status')).toHaveText('COMPLETED', { timeout: 30_000 });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId('run-coverage-mode')).toHaveText('API only');
  // Stored and shown without its query — that is where a key would be.
  await expect(page.getByTestId('run-api-docs')).toHaveText('http://localhost:4444/api/doc');
  await page.goto('/runs');
  await expect(page.getByTestId(`run-coverage-${runId}`)).toHaveText('API only');
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
