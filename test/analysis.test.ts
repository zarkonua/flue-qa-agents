// Requirements analysis completeness.
//
// The failure this guards against is silence. Every per-item rule in the
// validator asks "is this statement well evidenced?", and a run that analysed
// four of fifteen behaviors passes every one of them — because the four it did
// write were fine. Nothing asked what happened to the other eleven.
//
// So the rule here is the one discovery already follows for observations, one
// stage later: everything upstream is either represented downstream or
// explicitly accounted for.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analysisCoverageSummary,
  validateRequirementsAnalysis,
  VALIDATION_TYPES,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
} from '../src/lib/semantic-validate.ts';

/** Discovery with three plain observed behaviors, plus the awkward ones. */
function discovery(over: Partial<DiscoveredBehavior> = {}): DiscoveredBehavior {
  return {
    product: 'Notes',
    areas: [{ name: 'Notes', routes: ['http://localhost:4444/notes'], notes: [] }],
    behaviors: [
      {
        id: 'BEH-1',
        area: 'Notes',
        statement: 'Creating a note with a title and content adds it to the list and shows "Note created."',
        status: 'OBSERVED',
        source: ['browser snapshot'],
        confidence: 'high',
        suspectedIssue: false,
      },
      {
        id: 'BEH-2',
        area: 'Notes',
        statement: 'Submitting the create form with an empty title leaves the list unchanged.',
        status: 'OBSERVED',
        source: ['browser snapshot'],
        confidence: 'high',
        suspectedIssue: false,
      },
      {
        id: 'BEH-3',
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
    ...over,
  } as DiscoveredBehavior;
}

function analysis(over: Partial<RequirementsAnalysis> = {}): RequirementsAnalysis {
  return {
    feature: 'Notes',
    acceptancePoints: [],
    businessRules: [],
    openQuestions: [],
    risks: [],
    ...over,
  } as RequirementsAnalysis;
}

const ap = (id: string, statement: string, evidenceIds: string[], over = {}) => ({
  id,
  statement,
  evidenceIds,
  ...over,
});

/** Analysis that accounts for all three behaviors the honest way. */
function complete(over: Partial<RequirementsAnalysis> = {}): RequirementsAnalysis {
  return analysis({
    acceptancePoints: [
      ap('AP-1', 'Creating a note with a title and content adds it to the list and shows "Note created."', ['BEH-1']),
      ap('AP-2', 'Submitting the create form with an empty title leaves the list unchanged.', ['BEH-2']),
      ap('AP-3', 'Setting Sort to "Title (A-Z)" reorders the list alphabetically.', ['BEH-3']),
    ],
    ...over,
  });
}

const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

// ---------------------------------------------------------------------------

describe('every discovered behavior is accounted for', () => {
  it('accepts an analysis that cites all of them', () => {
    assert.deepEqual(validateRequirementsAnalysis(discovery(), complete()), []);
  });

  it('rejects one that silently drops a behavior', () => {
    const partial = analysis({
      acceptancePoints: [ap('AP-1', 'Creating a note with a title and content adds it to the list and shows "Note created."', ['BEH-1'])],
    });
    const errors = validateRequirementsAnalysis(discovery(), partial);
    const unanalyzed = errors.filter((e) => e.code === 'UNANALYZED_BEHAVIOR');
    assert.equal(unanalyzed.length, 2, 'BEH-2 and BEH-3 are both missing');
    assert.deepEqual(unanalyzed.map((e) => e.value).sort(), ['BEH-2', 'BEH-3']);
  });

  it('names the behavior in the message, so the fix is obvious', () => {
    const errors = validateRequirementsAnalysis(discovery(), analysis());
    assert.match(errors[0].details, /BEH-1/);
    assert.match(errors[0].details, /Creating a note/);
  });

  it('accepts a behavior excluded with a reason', () => {
    const partial = complete({
      acceptancePoints: complete().acceptancePoints.slice(0, 2),
      excludedBehaviors: [{ id: 'BEH-3', reason: 'Restates the ordering already covered by AP-2.' }],
    });
    assert.deepEqual(validateRequirementsAnalysis(discovery(), partial), []);
  });

  it('refuses an exclusion with no reason', () => {
    const partial = complete({
      acceptancePoints: complete().acceptancePoints.slice(0, 2),
      excludedBehaviors: [{ id: 'BEH-3', reason: '   ' }],
    });
    assert.ok(codes(validateRequirementsAnalysis(discovery(), partial)).includes('UNANALYZED_BEHAVIOR'));
  });

  it('refuses an exclusion naming a behavior that does not exist', () => {
    const partial = complete({ excludedBehaviors: [{ id: 'BEH-99', reason: 'not real' }] });
    const errors = validateRequirementsAnalysis(discovery(), partial);
    assert.ok(codes(errors).includes('UNKNOWN_BEHAVIOR_REFERENCE'));
    assert.match(errors.find((e) => e.code === 'UNKNOWN_BEHAVIOR_REFERENCE')!.details, /BEH-1, BEH-2, BEH-3/);
  });

  it('refuses a behavior both cited and excluded', () => {
    const partial = complete({ excludedBehaviors: [{ id: 'BEH-1', reason: 'also excluded' }] });
    const errors = validateRequirementsAnalysis(discovery(), partial);
    const clash = errors.find((e) => e.code === 'UNKNOWN_BEHAVIOR_REFERENCE');
    assert.ok(clash, 'a behavior cannot be in both places');
    assert.match(clash!.details, /Decide which/);
  });
});

describe('behaviors that cannot become requirements', () => {
  it('tells a suspected issue to become an open question, not a requirement', () => {
    const d = discovery();
    d.behaviors[2] = { ...d.behaviors[2], suspectedIssue: true };
    const partial = analysis({ acceptancePoints: complete().acceptancePoints.slice(0, 2) });
    const error = validateRequirementsAnalysis(d, partial).find((e) => e.value === 'BEH-3');
    assert.match(error!.details, /suspected issue/);
    assert.match(error!.details, /open question/);
  });

  it('tells an INFERRED behavior the same', () => {
    const d = discovery();
    d.behaviors[2] = { ...d.behaviors[2], status: 'INFERRED' };
    const partial = analysis({ acceptancePoints: complete().acceptancePoints.slice(0, 2) });
    const error = validateRequirementsAnalysis(d, partial).find((e) => e.value === 'BEH-3');
    assert.match(error!.details, /INFERRED/);
  });

  it('is satisfied once that behavior is excluded with a reason', () => {
    const d = discovery();
    d.behaviors[2] = { ...d.behaviors[2], suspectedIssue: true };
    const partial = analysis({
      acceptancePoints: complete().acceptancePoints.slice(0, 2),
      excludedBehaviors: [{ id: 'BEH-3', reason: 'Suspected issue; raised as OQ-1 instead.' }],
      openQuestions: [{ id: 'OQ-1', question: 'Is the sort order intended to be case-sensitive?', impact: 'ordering' }],
    });
    assert.deepEqual(validateRequirementsAnalysis(d, partial), []);
  });
});

describe('validation type', () => {
  it('offers exactly the six documented values', () => {
    assert.deepEqual([...VALIDATION_TYPES], ['UI', 'API', 'VISUAL', 'CONTRACT', 'MANUAL', 'UNKNOWN']);
  });

  it('accepts an omitted type — undecided is honest', () => {
    assert.deepEqual(validateRequirementsAnalysis(discovery(), complete()), []);
  });

  it('accepts UNKNOWN — considered, and not settled by the evidence', () => {
    const a = complete();
    a.acceptancePoints[0].validationType = 'UNKNOWN';
    assert.deepEqual(validateRequirementsAnalysis(discovery(), a), []);
  });

  it('accepts a stated type on a testable requirement', () => {
    const a = complete();
    a.acceptancePoints[0].validationType = 'UI';
    a.acceptancePoints[0].validationTypeReason = 'Observed entirely through rendered list state.';
    assert.deepEqual(validateRequirementsAnalysis(discovery(), a), []);
  });

  it('refuses a not-testable requirement that claims an automatable route', () => {
    const a = complete();
    a.acceptancePoints[0].testable = false;
    a.acceptancePoints[0].notTestableReason = 'Needs a production mailbox.';
    a.acceptancePoints[0].validationType = 'API';
    const errors = validateRequirementsAnalysis(discovery(), a);
    assert.ok(codes(errors).includes('CONTRADICTORY_VALIDATION_TYPE'));
  });

  it('allows a not-testable requirement to be MANUAL or UNKNOWN', () => {
    for (const type of ['MANUAL', 'UNKNOWN'] as const) {
      const a = complete();
      a.acceptancePoints[0].testable = false;
      a.acceptancePoints[0].notTestableReason = 'Needs a human to judge the wording.';
      a.acceptancePoints[0].validationType = type;
      assert.deepEqual(validateRequirementsAnalysis(discovery(), a), [], `${type} must be allowed`);
    }
  });
});

describe('host-derived analysis coverage', () => {
  it('counts analyzed, excluded and unaccounted from the artifacts', () => {
    const a = complete({
      acceptancePoints: complete().acceptancePoints.slice(0, 1),
      excludedBehaviors: [{ id: 'BEH-2', reason: 'duplicate' }],
    });
    const summary = analysisCoverageSummary(discovery(), a);
    assert.equal(summary.behaviors, 3);
    assert.equal(summary.analyzed, 1);
    assert.equal(summary.excluded, 1);
    assert.equal(summary.unaccounted, 1);
    assert.deepEqual(summary.unaccountedIds, ['BEH-3']);
  });

  it('reports zero unaccounted for a valid analysis', () => {
    const summary = analysisCoverageSummary(discovery(), complete());
    assert.equal(summary.unaccounted, 0);
    assert.equal(summary.analyzed, 3);
  });

  it('breaks the testable requirements down by validation type', () => {
    const a = complete();
    a.acceptancePoints[0].validationType = 'UI';
    a.acceptancePoints[1].validationType = 'UI';
    a.acceptancePoints[2].validationType = 'API';
    const summary = analysisCoverageSummary(discovery(), a);
    assert.deepEqual(summary.validationTypes, { UI: 2, API: 1 });
  });

  it('counts an omitted type as UNSPECIFIED rather than inventing one', () => {
    const summary = analysisCoverageSummary(discovery(), complete());
    assert.deepEqual(summary.validationTypes, { UNSPECIFIED: 3 });
  });

  it('leaves not-testable requirements out of the validation-type breakdown', () => {
    const a = complete();
    a.acceptancePoints[0].testable = false;
    a.acceptancePoints[0].notTestableReason = 'manual only';
    const summary = analysisCoverageSummary(discovery(), a);
    assert.equal(summary.notTestable, 1);
    assert.equal(Object.values(summary.validationTypes).reduce((x, y) => x + y, 0), 2);
  });

  it('survives a missing discovery artifact instead of throwing', () => {
    const summary = analysisCoverageSummary(undefined, complete());
    assert.equal(summary.behaviors, 0);
    assert.equal(summary.unaccounted, 0);
    assert.equal(summary.acceptancePoints, 3);
  });
});

describe('the schema carries the new fields', () => {
  it('accepts validationType and excludedBehaviors', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const a = complete({
      acceptancePoints: complete().acceptancePoints.slice(0, 2),
      excludedBehaviors: [{ id: 'BEH-3', reason: 'duplicate of AP-2' }],
    });
    a.acceptancePoints[0].validationType = 'UI';
    a.acceptancePoints[0].validationTypeReason = 'rendered list state';
    assert.deepEqual(schemaErrorsFor('requirements-analysis', a), []);
  });

  it('rejects a validation type outside the enum', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const a = complete();
    (a.acceptancePoints[0] as { validationType: string }).validationType = 'VIBES';
    assert.ok(schemaErrorsFor('requirements-analysis', a).length > 0);
  });

  it('rejects an exclusion missing its reason', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const a = complete({ excludedBehaviors: [{ id: 'BEH-3' } as { id: string; reason: string }] });
    assert.ok(schemaErrorsFor('requirements-analysis', a).length > 0);
  });
});

describe('the analyst is told about the contract', () => {
  it('explains exclusion and forbids collapsing distinct behaviors', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/agents/behavior-analyst.ts', import.meta.url), 'utf8'),
    );
    assert.match(source, /excludedBehaviors/);
    assert.match(source, /Do NOT collapse materially different behaviors/);
    assert.match(source, /validationType/);
    assert.match(source, /Omitting it\s*\n?\s*is always acceptable; guessing is not/);
  });
});
