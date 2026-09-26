// The QA Review Workspace in a real browser, over fixture artifacts served by
// the real host. Serial: each flow changes the shared suite.

import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('bugs: list, detail, and explicit bug <-> case navigation', async ({ page }) => {
  await page.goto('/bugs');
  await expect(page.getByTestId('bug-row-BUG-001')).toContainText('Invalid-credentials error is generic');
  await page.getByRole('link', { name: 'BUG-001' }).first().click();
  await expect(page.getByTestId('bug-expected')).toHaveText('The message says which credential is wrong.');
  await expect(page.getByTestId('bug-actual')).toHaveText('An error message is shown for invalid credentials.');
  await page.getByTestId('related-cases').getByRole('link', { name: 'TC-1' }).click();
  await expect(page).toHaveURL(/\/test-cases\/TC-1$/);
  await page.getByTestId('related-bugs').getByRole('link', { name: 'BUG-001' }).click();
  await expect(page).toHaveURL(/\/bugs\/BUG-001$/);
  // TC-2 has no report naming it: no relation is shown.
  await page.goto('/test-cases/TC-2');
  await expect(page.getByTestId('related-bugs')).toContainText('No bug report names this case.');
});

test('update: comment -> processing -> diff -> request changes -> apply; Phase 1 goes stale', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('phase1-state')).toContainText('APPROVED');

  await page.goto('/test-cases/TC-1');
  await page.getByRole('button', { name: 'Request Change' }).click();
  await page.getByTestId('request-change').locator('textarea').fill('Say what happens to the form after the error.');
  await page.getByRole('button', { name: 'Process with QA Agent' }).click();
  await expect(page).toHaveURL(/\/reviews\/REQ-\d+$/);
  await expect(page.getByTestId('request-status')).toContainText('Proposal ready', { timeout: 15_000 });

  const latest = () => page.getByTestId('proposal').first();
  const diff = latest().getByTestId('case-diff');
  await expect(diff).toContainText('expectedResult');
  await expect(diff.locator('ins').first()).toBeVisible();
  await expect(latest().getByTestId('validation')).toContainText('VALID');

  // The active case is untouched until Apply.
  const reviewUrl = page.url();
  await page.goto('/test-cases/TC-1');
  await expect(page.getByTestId('expected-result')).toHaveText('Error message shown for invalid credentials');
  await page.goto(reviewUrl);

  await page.locator('textarea').fill('Keep the title; rewrite only the expected result.');
  await page.getByRole('button', { name: 'Request Changes' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Changes requested');
  await page.getByRole('button', { name: 'Process with QA Agent' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Proposal ready', { timeout: 15_000 });
  await expect(latest()).toContainText('Kept the title');
  await expect(latest().getByTestId('case-diff')).not.toContainText('(reviewed)');
  await expect(latest().getByTestId('case-diff')).toContainText('the form stays open');

  await page.getByRole('button', { name: 'Apply Change' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Applied');
  await page.reload();
  await expect(page.getByTestId('request-status')).toContainText('Applied');
  await page.goto('/test-cases/TC-1');
  await expect(page.getByTestId('expected-result')).toHaveText('Error message shown for invalid credentials; the form stays open');
  await page.goto('/');
  await expect(page.getByTestId('phase1-state')).toContainText('STALE');
  await expect(page.getByTestId('phase1-stale')).toContainText('test-cases.json');
  await expect(page.getByTestId('health-prioritization')).toContainText('STALE');
  await expect(page.getByTestId('health-prioritization')).toContainText('TC-1 was modified after this was generated.');
  await expect(page.getByTestId('health-defects')).toContainText('STALE');
  await expect(page.getByTestId('health-approval')).toContainText('STALE');
});

test('refresh dependent analysis: warning, run, CURRENT again — approval stays STALE', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Refresh dependent analysis' }).click();
  const confirm = page.getByTestId('refresh-confirm');
  await expect(confirm).toContainText('Automation Prioritizer');
  await expect(confirm).toContainText('Defect Analyzer');
  await expect(confirm).toContainText('existing bug decisions may need re-review');
  await expect(confirm).toContainText('New bugs start as PENDING.');
  await expect(confirm).toContainText('Materially unchanged bugs keep their decisions');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);

  await page.getByRole('button', { name: 'Refresh dependent analysis' }).click();
  await page.getByTestId('refresh-confirm').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('refresh-state')).toContainText('COMPLETED', { timeout: 20_000 });
  await expect(page.getByTestId('health-prioritization')).toContainText('CURRENT');
  await expect(page.getByTestId('health-defects')).toContainText('CURRENT');
  await expect(page.getByTestId('health-approval')).toContainText('STALE');
  await expect(page.getByTestId('reconciliation')).toContainText('Preserved (2)');
  await expect(page.getByRole('button', { name: 'Approve Phase 1' })).toBeEnabled();
});

test('bug edit: preview diff, apply, approval stale — other artifacts untouched', async ({ page }) => {
  await page.goto('/bugs/BUG-001');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('bug-edit').getByLabel('Severity').selectOption('MAJOR');
  await page.getByTestId('bug-edit').getByLabel('Priority').selectOption('P2');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  const diff = page.getByTestId('bug-edit-preview');
  await expect(diff).toContainText('severity');
  await expect(diff).toContainText('MINOR');
  await expect(diff).toContainText('MAJOR');
  await expect(page.getByTestId('bug-severity')).toHaveText('MINOR', { timeout: 1000 });
  await diff.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('bug-done')).toContainText('Edit applied');
  await expect(page.getByTestId('bug-severity')).toHaveText('MAJOR');
  await expect(page.getByTestId('bug-priority')).toHaveText('P2');
  await page.goto('/');
  await expect(page.getByTestId('health-approval')).toContainText('STALE');
  await expect(page.getByTestId('health-approval')).toContainText('bugs/BUG-001.json');
  await expect(page.getByTestId('health-prioritization')).toContainText('CURRENT');
  await expect(page.getByTestId('health-defects')).toContainText('CURRENT');
});

test('bug reject persists after reload', async ({ page }) => {
  await page.goto('/bugs/BUG-001');
  await page.getByTestId('bug-review').locator('textarea').fill('Works as designed.');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('bug-decision')).toHaveText('REJECTED');
  await page.reload();
  await expect(page.getByTestId('bug-decision')).toHaveText('REJECTED');
  await expect(page.getByTestId('bug-history')).toContainText('reject');
});

test('bug downgrade: CONFIRMED becomes POTENTIAL and stays so', async ({ page }) => {
  await page.goto('/bugs/BUG-002');
  await expect(page.getByTestId('bug-status')).toHaveText('CONFIRMED');
  await page.getByRole('button', { name: 'Downgrade' }).click();
  await expect(page.getByTestId('bug-status')).toHaveText('POTENTIAL');
  await expect(page.getByRole('button', { name: 'Downgrade' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('bug-status')).toHaveText('POTENTIAL');
});

test('bug request changes: history shows it; the report content is unchanged', async ({ page }) => {
  await page.goto('/bugs/BUG-002');
  const expected = (await page.getByTestId('bug-expected').textContent()) ?? '';
  const steps = (await page.getByTestId('bug-steps').textContent()) ?? '';
  await expect(page.getByRole('button', { name: 'Request Changes' })).toBeDisabled();
  await page.getByTestId('bug-review').locator('textarea').fill('Name the exact control that becomes editable.');
  await page.getByRole('button', { name: 'Request Changes' }).click();
  await expect(page.getByTestId('bug-decision')).toHaveText('CHANGES_REQUESTED');
  await expect(page.getByTestId('bug-history')).toContainText('Name the exact control that becomes editable.');
  await expect(page.getByTestId('bug-expected')).toHaveText(expected);
  await expect(page.getByTestId('bug-steps')).toHaveText(steps);
});

test('create: natural language -> structured candidate -> apply -> active', async ({ page }) => {
  await page.goto('/test-cases');
  await page.getByRole('button', { name: '+ Add Test Case' }).click();
  await page.getByTestId('add-case').locator('textarea').fill('Check the login button when only the username is entered.');
  await page.getByRole('button', { name: 'Process with QA Agent' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Proposal ready', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'New case TC-3' })).toBeVisible();
  await expect(page.getByTestId('validation')).toContainText('VALID');
  await page.getByRole('button', { name: 'Apply Change' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Applied');
  await page.goto('/test-cases');
  await expect(page.getByTestId('case-row-TC-3')).toContainText('only a username entered');
});

test('create without evidence: unresolved, nothing invented, Apply disabled', async ({ page }) => {
  await page.goto('/test-cases');
  await page.getByRole('button', { name: '+ Add Test Case' }).click();
  await page.getByTestId('add-case').locator('textarea').fill('Prove that an empty title is rejected.');
  await page.getByRole('button', { name: 'Process with QA Agent' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Proposal ready', { timeout: 15_000 });
  await expect(page.getByTestId('validation')).toContainText('UNRESOLVED');
  await expect(page.getByRole('button', { name: 'Apply Change' })).toBeDisabled();
  await expect(page.getByTestId('apply-blocked')).toContainText('Unresolved');
});

test('delete: stays active, Keep keeps it, Apply Deletion removes it', async ({ page }) => {
  await page.goto('/test-cases/TC-2');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('delete-case').locator('textarea').fill('Covered elsewhere.');
  await page.getByRole('button', { name: 'Propose deletion' }).click();
  await expect(page.getByTestId('proposal')).toContainText('Until you apply it, the case stays active.');
  // TC-3, created above, also covers AC-1 — so deleting TC-2 uncovers nothing, and the impact says so.
  await expect(page.getByTestId('impact')).toContainText('Currently covers: AC-1');
  await expect(page.getByTestId('impact')).not.toContainText('Would become uncovered');
  await page.goto('/test-cases');
  await expect(page.getByTestId('case-row-TC-2')).toBeVisible();

  await page.goBack();
  await page.getByRole('button', { name: 'Keep Test Case' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Rejected');
  await page.goto('/test-cases/TC-2');
  await expect(page.getByTestId('expected-result')).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Propose deletion' }).click();
  await page.getByRole('button', { name: 'Apply Deletion' }).click();
  await expect(page.getByTestId('request-status')).toContainText('Applied');
  await page.goto('/test-cases');
  await expect(page.getByTestId('case-row-TC-2')).toHaveCount(0);
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: /Rejected/ })).toBeVisible();
});
