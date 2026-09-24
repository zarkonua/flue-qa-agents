// Coverage-first test design.
//
// Coverage was already enforced: every testable requirement must appear in some
// case's `covers`, checked by the host rather than reported by the model. What
// that could not see is whether a coverage claim is *true*. A case can list a
// requirement it never exercises, and the count goes up while nothing is
// tested — the paper version of the same silence the other stages had.
//
// So a `covers` entry must now be traceable to shared evidence, and the host
// reports what KIND of scenarios a suite contains, because 100% coverage made
// entirely of happy paths is not a good suite and a percentage cannot say so.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coverageSummary,
  testableRequirements,
  validateTestCases,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
  type TestCases,
} from '../src/lib/semantic-validate.ts';

function discovery(): DiscoveredBehavior {
  return {
    product: 'Notes',
    areas: [{ name: 'Notes', routes: ['http://localhost:4444/notes'], notes: [] }],
    behaviors: [
      {
        id: 'BEH-1',
        area: 'Notes',
        statement: 'Creating a note with a title adds it to the list and shows "Note created."',
        status: 'OBSERVED',
        source: ['browser snapshot'],
        confidence: 'high',
        suspectedIssue: false,
      },
      {
        id: 'BEH-2',
        area: 'Notes',
        statement: 'Setting Sort to "Title (A-Z)" reorders the list alphabetically.',
        status: 'OBSERVED',
        source: ['browser snapshot'],
        confidence: 'high',
        suspectedIssue: false,
      },
    ],
    openQuestions: [],
    conflicts: [],
  } as DiscoveredBehavior;
}

function requirements(): RequirementsAnalysis {
  return {
    feature: 'Notes',
    acceptancePoints: [
      {
        id: 'AP-1',
        statement: 'Creating a note with a title adds it to the list and shows "Note created."',
        evidenceIds: ['BEH-1'],
      },
      {
        id: 'AP-2',
        statement: 'Setting Sort to "Title (A-Z)" reorders the list alphabetically.',
        evidenceIds: ['BEH-2'],
      },
    ],
    businessRules: [],
    openQuestions: [],
    risks: [],
  } as RequirementsAnalysis;
}

const tc = (over: Record<string, unknown> = {}) => ({
  id: 'TC-1',
  title: 'Create a note with a title',
  evidenceIds: ['BEH-1'],
  covers: ['AP-1'],
  priority: 'P1',
  types: ['positive'],
  preconditions: ['The notes list is empty'],
  testData: {},
  steps: [
    { action: 'Enter a title', expected: 'The title field holds the text' },
    { action: 'Click Create Note', expected: '"Note created." is shown' },
  ],
  expectedResult: 'The note appears in the list and "Note created." is shown',
  automationCandidate: true,
  automationReason: 'Deterministic and observable in the DOM',
  tags: ['notes'],
  ...over,
});

const suite = (cases: ReturnType<typeof tc>[]): TestCases =>
  ({ feature: 'Notes', testCases: cases, openQuestions: [] }) as unknown as TestCases;

/** A suite that legitimately covers both requirements. */
const goodSuite = () =>
  suite([
    tc(),
    tc({ id: 'TC-2', title: 'Sort A-Z reorders', evidenceIds: ['BEH-2'], covers: ['AP-2'], types: ['positive'] }),
  ]);

const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

// ---------------------------------------------------------------------------

describe('a coverage claim must be traceable', () => {
  it('accepts a case citing the behavior its requirement rests on', () => {
    assert.deepEqual(validateTestCases(discovery(), requirements(), goodSuite()), []);
  });

  it('accepts a case citing the requirement ID directly', () => {
    const s = suite([
      tc({ evidenceIds: ['AP-1'] }),
      tc({ id: 'TC-2', evidenceIds: ['AP-2'], covers: ['AP-2'], title: 'Sort A-Z reorders' }),
    ]);
    assert.deepEqual(validateTestCases(discovery(), requirements(), s), []);
  });

  it('rejects a case that claims a requirement whose evidence it never cites', () => {
    // TC-1 exercises note creation, but also claims the sorting requirement.
    const s = suite([
      tc({ covers: ['AP-1', 'AP-2'] }),
    ]);
    const errors = validateTestCases(discovery(), requirements(), s);
    const bad = errors.find((e) => e.code === 'COVERAGE_NOT_EVIDENCED');
    assert.ok(bad, 'the unsupported coverage claim is caught');
    assert.equal(bad!.value, 'AP-2');
    assert.match(bad!.details, /give it its own case/);
  });

  it('still allows a genuine multi-requirement scenario that shares evidence', () => {
    const r = requirements();
    // Both requirements now rest on the same observed behavior.
    r.acceptancePoints[1].evidenceIds = ['BEH-1'];
    const s = suite([tc({ covers: ['AP-1', 'AP-2'], evidenceIds: ['BEH-1'] })]);
    assert.deepEqual(validateTestCases(discovery(), r, s), []);
  });

  it('does not fire for a covers ID that does not resolve at all', () => {
    // That is UNKNOWN_COVERAGE_ID's job; two errors for one mistake is noise.
    const s = suite([tc({ covers: ['AP-1', 'AP-99'] }), tc({ id: 'TC-2', evidenceIds: ['BEH-2'], covers: ['AP-2'] })]);
    const errors = validateTestCases(discovery(), requirements(), s);
    assert.ok(codes(errors).includes('UNKNOWN_COVERAGE_ID'));
    assert.ok(!codes(errors).includes('COVERAGE_NOT_EVIDENCED'));
  });
});

describe('coverage completeness is unchanged', () => {
  it('still rejects a testable requirement with no case', () => {
    const s = suite([tc()]);
    const errors = validateTestCases(discovery(), requirements(), s);
    const uncovered = errors.find((e) => e.code === 'UNCOVERED_ACCEPTANCE_POINT');
    assert.ok(uncovered);
    assert.equal(uncovered!.value, 'AP-2');
  });

  it('still rejects a case that names no requirement at all', () => {
    const s = suite([tc({ covers: [] }), tc({ id: 'TC-2', evidenceIds: ['BEH-2'], covers: ['AP-2'] })]);
    assert.ok(codes(validateTestCases(discovery(), requirements(), s)).includes('MISSING_COVERAGE'));
  });

  it('exempts a requirement the analyst marked not testable', () => {
    const r = requirements();
    r.acceptancePoints[1].testable = false;
    r.acceptancePoints[1].notTestableReason = 'Needs a production mailbox.';
    assert.equal(testableRequirements(r).length, 1);
    assert.deepEqual(validateTestCases(discovery(), r, suite([tc()])), []);
  });

  it('imposes no minimum number of cases', () => {
    const r = requirements();
    r.acceptancePoints = [r.acceptancePoints[0]];
    // One requirement, one case, and that is a complete suite.
    assert.deepEqual(validateTestCases(discovery(), r, suite([tc()])), []);
  });
});

describe('host-derived coverage totals', () => {
  it('counts coverage from the artifacts, not from anything the model reports', () => {
    const s = coverageSummary(requirements(), goodSuite());
    assert.equal(s.testable, 2);
    assert.equal(s.covered, 2);
    assert.equal(s.uncovered, 0);
    assert.equal(s.testCases, 2);
  });

  it('names what is uncovered rather than only counting it', () => {
    const s = coverageSummary(requirements(), suite([tc()]));
    assert.deepEqual(s.uncoveredIds, ['AP-2']);
    assert.equal(s.uncovered, 1);
  });

  it('breaks the suite down by scenario type', () => {
    const s = coverageSummary(
      requirements(),
      suite([
        tc({ types: ['positive'] }),
        tc({ id: 'TC-2', evidenceIds: ['BEH-2'], covers: ['AP-2'], types: ['negative', 'validation'] }),
      ]),
    );
    assert.deepEqual(s.scenarioTypes, { positive: 1, negative: 1, validation: 1 });
  });

  it('counts cases that claim more than one requirement', () => {
    const r = requirements();
    r.acceptancePoints[1].evidenceIds = ['BEH-1'];
    const s = coverageSummary(r, suite([tc({ covers: ['AP-1', 'AP-2'] })]));
    assert.equal(s.multiRequirementCases, 1);
  });

  it('counts requirements demonstrated by more than one case', () => {
    const s = coverageSummary(
      requirements(),
      suite([
        tc(),
        tc({ id: 'TC-1b', title: 'Create with a long title', types: ['boundary'] }),
        tc({ id: 'TC-2', evidenceIds: ['BEH-2'], covers: ['AP-2'] }),
      ]),
    );
    assert.equal(s.requirementsWithMultipleCases, 1, 'AP-1 has two cases');
  });

  it('reports an all-positive suite as such, so 100% cannot hide it', () => {
    const s = coverageSummary(requirements(), goodSuite());
    assert.equal(s.covered, s.testable, 'coverage is complete');
    assert.equal(s.scenarioTypes.negative ?? 0, 0);
    assert.equal(s.scenarioTypes.validation ?? 0, 0);
  });
});

describe('the designer is told to plan coverage before writing', () => {
  const source = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/agents/test-designer.ts', import.meta.url), 'utf8'),
    );

  it('states the matrix-first workflow', async () => {
    const s = await source();
    assert.match(s, /requirements -> coverage matrix -> scenario design -> test cases/);
    assert.match(s, /Do not start by writing test cases/);
  });

  it('forbids rows that exist only to raise the count', async () => {
    assert.match(await source(), /only to raise the count/);
  });

  it('forbids inventing a negative path the evidence never showed', async () => {
    assert.match(await source(), /inventing a negative path discovery never observed is fabrication/);
  });

  it('explains the traceability rule the host enforces', async () => {
    const s = await source();
    assert.match(s, /a case may only claim a\s*\n?\s*requirement whose evidence it also cites/);
  });

  it('still sets no target number of cases', async () => {
    const s = await source();
    assert.match(s, /Suite size follows from coverage, never from a target number/);
    assert.doesNotMatch(s, /at least \d+ test cases/i);
  });
});
