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
  await expect(page.getByTestId('prioritization-state')).toContainText('STALE');
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
