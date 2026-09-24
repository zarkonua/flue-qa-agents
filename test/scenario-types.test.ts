// Scenario-type classification.
//
// The regression this guards against: the Test Designer prompt named no
// scenario vocabulary anywhere. `types` appeared once, in the list of required
// output fields. When a coverage-matrix section was added that enumerated four
// planning categories, the model took those to BE the vocabulary and a suite
// that had used six kinds collapsed to `positive`/`negative`, one label per
// case.
//
// The fix is to state the real enum — derived from the schema, so the two
// cannot disagree — and to say plainly that matrix categories are a planning
// aid, not a list of values. Nothing here requires diversity: a rule like
// "every suite needs a boundary test" is satisfied by inventing one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DIVERSITY_DIAGNOSTIC_MIN_CASES,
  coverageSummary,
  scenarioDiversityDiagnostic,
  validateTestCases,
  type CoverageSummary,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
  type TestCases,
} from '../src/lib/semantic-validate.ts';
import { scenarioTypeVocabulary } from '../src/lib/qa-artifacts.ts';

const designerSource = readFileSync(new URL('../src/agents/test-designer.ts', import.meta.url), 'utf8');

// --- fixtures ---------------------------------------------------------------

const discovery = {
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
  ],
  openQuestions: [],
  conflicts: [],
} as unknown as DiscoveredBehavior;

const requirements = {
  feature: 'Notes',
  acceptancePoints: [
    { id: 'AP-1', statement: 'Creating a note with a title adds it to the list and shows "Note created."', evidenceIds: ['BEH-1'] },
  ],
  businessRules: [],
  openQuestions: [],
  risks: [],
} as unknown as RequirementsAnalysis;

const tc = (over: Record<string, unknown> = {}) => ({
  id: 'TC-1',
  title: 'Create a note with a title',
  evidenceIds: ['BEH-1'],
  covers: ['AP-1'],
  priority: 'P1',
  types: ['positive'],
  preconditions: [],
  testData: {},
  steps: [{ action: 'Enter a title and create', expected: '"Note created." is shown' }],
  expectedResult: 'The note appears in the list',
  automationCandidate: true,
  automationReason: 'Deterministic',
  tags: [],
  ...over,
});

const suite = (cases: ReturnType<typeof tc>[]): TestCases =>
  ({ feature: 'Notes', testCases: cases, openQuestions: [] }) as unknown as TestCases;

/** A coverage summary with a given suite size and type distribution. */
const summaryWith = (testCases: number, scenarioTypes: Record<string, number>): CoverageSummary =>
  ({
    testable: 1,
    covered: 1,
    uncovered: 0,
    exempt: 0,
    testCases,
    uncoveredIds: [],
    scenarioTypes,
    multiRequirementCases: 0,
    requirementsWithMultipleCases: 0,
  }) as CoverageSummary;

// ---------------------------------------------------------------------------
// 1 + 2: the prompt states the real vocabulary, and does not pass off the
// matrix categories as one
// ---------------------------------------------------------------------------

describe('the prompt separates planning categories from the vocabulary', () => {
  it('says outright that the matrix categories are not a vocabulary', () => {
    assert.match(designerSource, /These four are planning prompts, not a vocabulary/);
    assert.match(designerSource, /NOT the list of values the .*types.* field accepts/);
  });

  it('keeps matrix-first planning intact', () => {
    assert.match(designerSource, /requirements -> coverage matrix -> scenario design -> test cases/);
    assert.match(designerSource, /Do not start by writing test cases/);
  });

  it('classifies after designing, as a separate judgement', () => {
    assert.match(designerSource, /## Classifying each case/);
    assert.match(designerSource, /Once a case is written, classify what it actually IS/);
  });
});

describe('the prompt vocabulary cannot drift from the schema', () => {
  it('derives the list from the schema rather than hard-coding a second copy', () => {
    // The block is interpolated, not written out: no literal list to go stale.
    assert.match(designerSource, /\$\{VOCABULARY_BLOCK\}/);
    assert.match(designerSource, /scenarioTypeVocabulary\(\)/);
  });

  it('describes every type the schema declares', () => {
    for (const type of scenarioTypeVocabulary()) {
      assert.match(
        designerSource,
        new RegExp(`^\\s*${type.replace('-', '\\-')}:|'${type}':`, 'm'),
        `${type} needs an entry in SCENARIO_TYPE_INTENT`,
      );
    }
  });

  it('throws at module load if the schema gains a type with no description', () => {
    // The guard itself, asserted as source: a new enum value must not reach the
    // model as a bare name it has to guess the meaning of.
    assert.match(designerSource, /with no description in/);
    assert.match(designerSource, /SCENARIO_TYPE_INTENT/);
  });

  it('exposes the full 11-value enum, not a subset', () => {
    const vocabulary = scenarioTypeVocabulary();
    assert.equal(vocabulary.length, 11);
    for (const expected of ['boundary', 'validation', 'state-transition', 'permission', 'integration', 'regression', 'smoke', 'accessibility', 'security-functional']) {
      assert.ok(vocabulary.includes(expected), `${expected} must be available to the model`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 8: one label, several labels, and the richer kinds
// ---------------------------------------------------------------------------

describe('scenario labelling', () => {
  it('accepts a case with exactly one type', () => {
    assert.deepEqual(validateTestCases(discovery, requirements, suite([tc({ types: ['positive'] })])), []);
  });

  it('accepts a case with several types', () => {
    assert.deepEqual(
      validateTestCases(discovery, requirements, suite([tc({ types: ['positive', 'smoke', 'regression'] })])),
      [],
    );
  });

  it('keeps every richer classification representable', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    for (const type of ['boundary', 'state-transition', 'regression', 'smoke', 'validation', 'accessibility']) {
      const s = suite([tc({ types: [type] })]);
      assert.deepEqual(schemaErrorsFor('test-cases', s), [], `${type} must remain writable`);
      assert.deepEqual(validateTestCases(discovery, requirements, s), [], `${type} must remain valid`);
    }
  });

  it('accepts the combinations the prompt gives as examples', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    for (const combo of [['positive', 'smoke'], ['negative', 'validation'], ['boundary', 'negative'], ['state-transition', 'regression']]) {
      assert.deepEqual(schemaErrorsFor('test-cases', suite([tc({ types: combo })])), []);
    }
  });

  it('still rejects a type outside the schema enum', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.ok(schemaErrorsFor('test-cases', suite([tc({ types: ['vibes'] })])).length > 0);
    assert.ok(schemaErrorsFor('test-cases', suite([tc({ types: ['positive', 'chaos'] })])).length > 0);
  });

  it('tells the model not to label for variety', () => {
    assert.match(designerSource, /no credit for variety/);
    assert.match(designerSource, /One accurate label beats three decorative ones/);
  });

  it('tells the model not to flatten everything either', () => {
    assert.match(designerSource, /do not\s*\n?\s*flatten everything to/);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7: fabrication guidance, and no forced diversity
// ---------------------------------------------------------------------------

describe('classification must be defensible, not decorative', () => {
  it('defines what boundary, smoke and regression actually mean', () => {
    assert.match(designerSource, /needs a real limit/);
    assert.match(designerSource, /If most\s*\n?\s*of your cases are smoke, none of them are/);
    assert.match(designerSource, /Every automated test can catch\s*\n?\s*regressions in principle; that is not what this label means/);
  });
});

describe('no artificial diversity is enforced', () => {
  it('imposes no minimum number of kinds', () => {
    const s = suite([tc({ types: ['positive'] }), tc({ id: 'TC-2', types: ['positive'] })]);
    assert.deepEqual(validateTestCases(discovery, requirements, s), []);
  });

  it('imposes no minimum number of labels per case', () => {
    assert.deepEqual(validateTestCases(discovery, requirements, suite([tc({ types: ['positive'] })])), []);
  });

  it('accepts a suite with no boundary or smoke case at all', () => {
    const s = suite([tc({ types: ['positive'] }), tc({ id: 'TC-2', types: ['negative'] })]);
    assert.deepEqual(validateTestCases(discovery, requirements, s), []);
  });

  it('the prompt states there is no required count', () => {
    assert.match(designerSource, /no required number of labels, no required number of distinct kinds/);
  });
});

// ---------------------------------------------------------------------------
// 8: the diagnostic warns, and only warns
// ---------------------------------------------------------------------------

describe('the low-diversity diagnostic', () => {
  it('fires on the shape the real regression had', () => {
    const note = scenarioDiversityDiagnostic(summaryWith(23, { positive: 17, negative: 6 }));
    assert.ok(note);
    assert.match(note!, /23 cases use only negative\/positive/);
    assert.match(note!, /boundary, state-transition/);
  });

  it('says plainly that it is not a failure', () => {
    const note = scenarioDiversityDiagnostic(summaryWith(23, { positive: 17, negative: 6 }));
    assert.match(note!, /not a failure/);
  });

  it('is silent for a suite with three or more kinds', () => {
    assert.equal(scenarioDiversityDiagnostic(summaryWith(23, { positive: 14, negative: 4, boundary: 3 })), undefined);
  });

  it('is silent for a small suite — two kinds is normal there', () => {
    assert.equal(
      scenarioDiversityDiagnostic(summaryWith(DIVERSITY_DIAGNOSTIC_MIN_CASES - 1, { positive: 5, negative: 2 })),
      undefined,
    );
  });

  it('notices a suite that carries no classification at all', () => {
    const note = scenarioDiversityDiagnostic(summaryWith(20, {}));
    assert.match(note!, /no scenario classification at all/);
  });

  it('is a diagnostic only — it produces no semantic error', () => {
    const narrow = suite(
      Array.from({ length: 10 }, (_, i) => tc({ id: `TC-${i + 1}`, types: ['positive'] })),
    );
    assert.deepEqual(validateTestCases(discovery, requirements, narrow), [], 'narrow classification is not a rejection');
    assert.ok(scenarioDiversityDiagnostic(coverageSummary(requirements, narrow)), 'but it is noticed');
  });
});

// ---------------------------------------------------------------------------
// 9 + 10: nothing about coverage moved
// ---------------------------------------------------------------------------

describe('coverage guarantees are unchanged', () => {
  it('still rejects an uncovered testable requirement', () => {
    const reqs = {
      ...requirements,
      acceptancePoints: [
        ...requirements.acceptancePoints,
        { id: 'AP-2', statement: 'Sorting reorders the list', evidenceIds: ['BEH-1'] },
      ],
    } as RequirementsAnalysis;
    const errors = validateTestCases(discovery, reqs, suite([tc()]));
    assert.ok(errors.some((e) => e.code === 'UNCOVERED_ACCEPTANCE_POINT' && e.value === 'AP-2'));
  });

  it('still rejects a coverage claim whose evidence the case never cites', () => {
    const reqs = {
      ...requirements,
      acceptancePoints: [
        ...requirements.acceptancePoints,
        { id: 'AP-2', statement: 'Sorting reorders the list', evidenceIds: ['BEH-9'] },
      ],
    } as RequirementsAnalysis;
    const errors = validateTestCases(discovery, reqs, suite([tc({ covers: ['AP-1', 'AP-2'] })]));
    assert.ok(errors.some((e) => e.code === 'COVERAGE_NOT_EVIDENCED' && e.value === 'AP-2'));
  });

  it('still counts coverage from the artifacts', () => {
    const s = coverageSummary(requirements, suite([tc({ types: ['positive', 'smoke'] })]));
    assert.equal(s.testable, 1);
    assert.equal(s.covered, 1);
    assert.deepEqual(s.scenarioTypes, { positive: 1, smoke: 1 });
  });

  it('still sets no target number of test cases', () => {
    assert.match(designerSource, /Suite size follows from coverage, never from a target number/);
    assert.doesNotMatch(designerSource, /at least \d+ (test )?cases/i);
  });
});
