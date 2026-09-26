// The QA Review Workspace's deterministic logic: the proposal diff, review
// states and allowed actions, and bug <-> case links. Plain modules shared by
// the React pages, tested here without a browser.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffCases, diffSteps } from '../ui/src/lib/diff.ts';
import { applyBlockedReason, canProcess, isInFlight, proposalActions, REVIEW_GROUPS, STATUS_LABEL, statusTone } from '../ui/src/lib/review-state.ts';
import { bugsForCase, casesForBug } from '../ui/src/lib/relations.ts';

const step = (action: string, expected = 'ok') => ({ action, expected });

describe('proposal diff', () => {
  const current = {
    id: 'TC-1', title: 'Old title', priority: 'P2', types: ['positive'], covers: ['AP-1'], evidenceIds: ['BEH-1'],
    steps: [step('Open the page'), step('Submit', 'Saved'), step('Reload')], expectedResult: 'Saved', testData: { user: 'VALID_USERNAME' }, tags: [],
  };

  it('scalars read old -> new; the id is never part of a diff', () => {
    const d = diffCases(current, { ...current, id: 'TC-9', title: 'New title', expectedResult: 'Saved and listed' });
    assert.deepEqual(d, [
      { kind: 'scalar', field: 'title', before: 'Old title', after: 'New title' },
      { kind: 'scalar', field: 'expectedResult', before: 'Saved', after: 'Saved and listed' },
    ]);
  });

  it('lists read as added / removed; covers and evidence included', () => {
    const d = diffCases(current, { ...current, types: ['positive', 'boundary'], covers: ['AP-2'], evidenceIds: ['BEH-1', 'BEH-4'] });
    assert.deepEqual(d, [
      { kind: 'list', field: 'types', added: ['boundary'], removed: [] },
      { kind: 'list', field: 'covers', added: ['AP-2'], removed: ['AP-1'] },
      { kind: 'list', field: 'evidenceIds', added: ['BEH-4'], removed: [] },
    ]);
  });

  it('steps: + added, - removed, ~ changed, unchanged kept in place', () => {
    const changes = diffSteps(current.steps, [step('Open the page'), step('Submit', 'Saved with a timestamp'), step('Reload'), step('Search for it')]);
    assert.deepEqual(changes.map((c) => c.type), ['unchanged', 'changed', 'unchanged', 'added']);
    const removal = diffSteps(current.steps, [step('Open the page'), step('Reload')]);
    assert.deepEqual(removal.map((c) => c.type), ['unchanged', 'removed', 'unchanged']);
  });

  it('objects report added, removed and changed keys; identical cases have no diff', () => {
    const d = diffCases(current, { ...current, testData: { user: 'OTHER_USER', note: 'x' } });
    assert.deepEqual(d, [{ kind: 'object', field: 'testData', added: ['note'], removed: [], changed: ['user'] }]);
    assert.deepEqual(diffCases(current, structuredClone(current)), []);
  });
});

describe('review states and actions', () => {
  it('every status has a label and a tone', () => {
    for (const s of ['PENDING', 'PROCESSING', 'PROPOSAL_READY', 'CHANGES_REQUESTED', 'REJECTED', 'APPLIED', 'FAILED'] as const) {
      assert.ok(STATUS_LABEL[s]);
      assert.ok(statusTone(s));
    }
    assert.deepEqual(REVIEW_GROUPS.map((g) => g.title), ['Proposal ready', 'Processing', 'Pending', 'Failed', 'Recently applied', 'Rejected']);
  });

  it('Apply is disabled unless the host says VALID and the proposal is READY', () => {
    const p = (status: 'VALID' | 'INVALID' | 'UNRESOLVED' | 'STALE', proposal: 'READY' | 'APPLIED' = 'READY') =>
      ({ status: proposal, operation: 'update' as const, validation: { status, problems: [] } });
    assert.equal(applyBlockedReason(p('VALID')), undefined);
    assert.match(applyBlockedReason(p('UNRESOLVED'))!, /Unresolved/);
    assert.match(applyBlockedReason(p('INVALID'))!, /rejects/);
    assert.match(applyBlockedReason(p('STALE'))!, /older version of the test suite/);
    assert.match(applyBlockedReason(p('VALID', 'APPLIED'))!, /applied/);
    assert.match(applyBlockedReason({ status: 'READY', operation: 'update', validation: null })!, /not been validated/);
  });

  it('proposal actions never say "approve"; a deletion is applied or kept', () => {
    assert.deepEqual(proposalActions('delete'), { apply: 'Apply Deletion', reject: 'Keep Test Case' });
    assert.deepEqual(proposalActions('update'), { apply: 'Apply Change', reject: 'Reject', revise: 'Request Changes' });
    assert.ok(!JSON.stringify([proposalActions('create'), proposalActions('delete')]).toLowerCase().includes('approve'));
  });

  it('processing and polling', () => {
    assert.equal(canProcess('update', 'PENDING'), true);
    assert.equal(canProcess('update', 'PROPOSAL_READY'), false);
    assert.equal(canProcess('delete', 'PENDING'), false, 'deletions are proposed by the host');
    assert.equal(isInFlight('PROCESSING'), true);
    assert.equal(isInFlight('PENDING', true), true);
    assert.equal(isInFlight('APPLIED'), false);
  });
});

describe('bug <-> case links', () => {
  const bugs = [
    { id: 'BUG-001', relatedTestCaseIds: ['TC-2', 'TC-9'] },
    { id: 'BUG-002', relatedTestCaseIds: [] },
  ];

  it('only explicit references, both ways', () => {
    assert.deepEqual(bugsForCase(bugs, 'TC-2'), ['BUG-001']);
    assert.deepEqual(bugsForCase(bugs, 'TC-3'), []);
    assert.deepEqual(casesForBug(bugs[0], new Set(['TC-2'])), [{ id: 'TC-2', active: true }, { id: 'TC-9', active: false }]);
    assert.deepEqual(casesForBug(bugs[1], new Set(['TC-2'])), []);
  });
});

describe('malformed proposals render instead of crashing', async () => {
  const { steps, strings, text, record } = await import('../ui/src/lib/shape.ts');

  it('reads any value as the shape the page needs', () => {
    // Seen from a real model: preconditions as one string.
    assert.deepEqual(strings('Signed in'), ['Signed in']);
    assert.deepEqual(strings(undefined), []);
    assert.deepEqual(strings(['a', 2]), ['a', '2']);
    assert.deepEqual(steps('click it'), []);
    assert.deepEqual(steps([{ action: 'Open' }, 'Submit']), [{ action: 'Open', expected: '' }, { action: 'Submit', expected: '' }]);
    assert.equal(text({ a: 1 }), '{"a":1}');
    assert.deepEqual(record(['x']), {});
  });

  it('a diff over malformed steps falls back to a plain field change', () => {
    const d = diffCases({ steps: [{ action: 'a', expected: 'b' }] }, { steps: 'do the thing' });
    assert.deepEqual(d, [{ kind: 'scalar', field: 'steps', before: [{ action: 'a', expected: 'b' }], after: 'do the thing' }]);
  });
});
