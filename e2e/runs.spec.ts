// Run history in the QA Review Workspace, in a real browser: the Runs list,
// its filters, a run's detail, and its read-only snapshot of test cases and bugs.
// The fixture archives three Phase 1 runs (two models, one failed) and imports them.

import { expect, test } from '@playwright/test';

const OLD = '2026-09-24T19-41-08-042Z';
const FAILED = '2026-09-25T20-06-11-699Z';
const DEEPSEEK = '2026-09-26T14-33-36-698Z';
const EMPTY_PORT = 4556;

/** Phase 1 runs only: other flows in this suite record refresh runs of their own. */
async function openPhase1Runs(page: import('@playwright/test').Page) {
  await page.goto('/runs');
  await page.getByLabel('Kind').selectOption('PHASE1_MANUAL');
  await expect(page.getByTestId(`run-row-${DEEPSEEK}`)).toBeVisible();
}

test('runs list: newest first, with model, status and counts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await openPhase1Runs(page);
  const ids = await page.locator('tr[data-testid^="run-row-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')!.replace('run-row-', '')));
  expect(ids).toEqual([DEEPSEEK, FAILED, OLD]);
  const deepseek = page.getByTestId(`run-row-${DEEPSEEK}`);
  await expect(deepseek).toContainText('openrouter/deepseek/deepseek-v4-flash-0731');
  await expect(deepseek).toContainText('COMPLETED');
  await expect(deepseek).toContainText('59:49'); // duration
  await expect(deepseek.locator('td').nth(8)).toHaveText('2'); // 1 confirmed + 1 potential
  // A metric the run never produced is a dash, not a zero.
  await expect(page.getByTestId(`run-row-${FAILED}`).locator('td').nth(7)).toHaveText('—');
});

test('filters: model, then status', async ({ page }) => {
  await openPhase1Runs(page);
  await page.getByLabel('Model').selectOption('ollama/gpt-oss-20b-q5-49k');
  await expect(page.locator('tr[data-testid^="run-row-"]')).toHaveCount(2);
  await expect(page.getByTestId(`run-row-${DEEPSEEK}`)).toHaveCount(0);
  await page.getByLabel('Status').selectOption('FAILED');
  await expect(page.locator('tr[data-testid^="run-row-"]')).toHaveCount(1);
  await expect(page.getByTestId(`run-row-${FAILED}`)).toBeVisible();
  await page.getByLabel('Provider').selectOption('openrouter');
  await expect(page.getByTestId('runs-empty')).toContainText('No run matches these filters.');
});

test('run detail: stage timeline, metrics, and its archived test cases', async ({ page }) => {
  await openPhase1Runs(page);
  await page.getByTestId(`run-row-${DEEPSEEK}`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/runs/${DEEPSEEK}$`));
  await expect(page.getByTestId('snapshot-banner')).toContainText('Historical snapshot — read only');
  await expect(page.getByTestId('run-status')).toHaveText('COMPLETED');
  const timeline = page.getByTestId('stage-timeline');
  await expect(timeline.locator('tbody tr')).toHaveCount(5);
  await expect(page.getByTestId('stage-discovery')).toContainText('Product Discovery');
  await expect(page.getByTestId('stage-defects')).toContainText('✓ COMPLETED');
  await expect(page.getByTestId('stage-defects')).toContainText('1:00');
  await expect(page.getByTestId('metric-defects_confirmed')).toHaveText('1');
  await expect(page.getByTestId('metric-bug_reports_created')).toHaveText('2');
  const cases = await page.getByTestId('metric-test_cases_total').innerText();
  await page.getByTestId('archived-output').getByRole('link', { name: /^Test Cases/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${DEEPSEEK}/test-cases$`));
  await expect(page.locator('[data-testid^="historical-case-"]')).toHaveCount(Number(cases));
  await expect(page.getByTestId('historical-case-TC-1')).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('historical bugs: the snapshot as it was, linked to its cases, with no way to change it', async ({ page }) => {
  await page.goto(`/runs/${DEEPSEEK}/bugs`);
  await expect(page.getByTestId('historical-bug-BUG-001')).toContainText('Archived: notes editable too early');
  await expect(page.getByTestId('historical-bug-BUG-002')).toContainText('POTENTIAL');
  await page.getByRole('link', { name: 'BUG-001' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${DEEPSEEK}/bugs/BUG-001$`));
  const bug = page.getByTestId('historical-bug');
  await expect(bug).toContainText('CONFIRMED_DEFECT');
  await expect(bug).toContainText('MAJOR');
  await expect(bug).toContainText('P1');
  await expect(page.getByText('behavior: BEH-3')).toBeVisible();
  // No decision, edit, apply or approve control anywhere on a snapshot.
  await expect(page.getByRole('button')).toHaveCount(0);
  for (const name of ['Accept', 'Reject', 'Downgrade', 'Edit', 'Apply', 'Approve Phase 1', 'Request Changes']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'TC-1' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${DEEPSEEK}/test-cases#TC-1$`));
  await expect(page.getByTestId('historical-case-TC-1')).toBeInViewport();
});

test('a failed run stays visible, saying where it stopped', async ({ page }) => {
  await openPhase1Runs(page);
  const row = page.getByTestId(`run-row-${FAILED}`);
  await expect(row).toContainText('FAILED');
  await expect(row).toContainText('Stopped at: Test Designer');
  await row.getByRole('link').click();
  await expect(page.getByTestId('run-status')).toHaveText('FAILED');
  await expect(page.getByTestId('run-error')).toContainText('Stopped at Test Designer.');
  await expect(page.getByTestId('stage-design')).toContainText('✗ FAILED');
  await expect(page.getByTestId('stage-design').locator('td').nth(4)).toHaveText('4');
  await expect(page.getByTestId('stage-analysis')).toContainText('✓ COMPLETED');
  // It left no test cases: there is nothing to open, and no dead link to one.
  await expect(page.getByTestId('archived-output').getByRole('link', { name: /^Test Cases/ })).toHaveCount(0);
  await expect(page.getByTestId('archived-output').getByRole('link', { name: 'Requirements' })).toBeVisible();
});

test('an empty history shows a proper empty state, not an error', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${EMPTY_PORT}/runs`);
  await expect(page.getByTestId('runs-empty')).toContainText('No runs recorded yet');
  await expect(page.getByTestId('runs-error')).toHaveCount(0);
});
