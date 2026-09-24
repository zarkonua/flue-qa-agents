// Automation strategy: through WHAT a case would be automated.
//
// The existing artifact answered "automate it?" and "when?". It could not say
// "how", so a business rule whose real check belongs against an API became a
// browser test by default — not because anyone decided that, but because the
// evidence happened to arrive through a browser.
//
// Adding the question creates a new way to be wrong: claiming an API or visual
// capability nobody observed. So the host works out what this run actually saw
// and refuses a strategy that outruns it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOMATION_STRATEGIES,
  observedCapabilities,
  strategySummary,
  summarize,
  validateAutomationPrioritization,
  type AutomationPrioritization,
  type RequirementsAnalysis,
  type TestCases,
} from '../src/lib/semantic-validate.ts';

const testCases = {
  feature: 'Notes',
  testCases: [
    {
      id: 'TC-1',
      title: 'Create a note',
      evidenceIds: ['AP-1'],
      covers: ['AP-1'],
      priority: 'P1',
      types: ['positive'],
      preconditions: [],
      testData: {},
      steps: [{ action: 'Create a note', expected: 'It appears in the list' }],
      expectedResult: 'The note appears',
      automationCandidate: true,
      automationReason: 'Deterministic',
      tags: [],
    },
  ],
  openQuestions: [],
} as unknown as TestCases;

const entry = (over: Record<string, unknown> = {}) => ({
  testCaseId: 'TC-1',
  executionMode: 'AUTOMATION',
  automationPriority: 'HIGH',
  reason: 'Deterministic and observable',
  blockingFactors: [],
  ...over,
});

const prioritization = (over: Record<string, unknown> = {}): AutomationPrioritization =>
  ({ cases: [entry(over)] }) as unknown as AutomationPrioritization;

/** Requirements whose validation types decide what capabilities exist. */
const requirementsTyped = (validationType?: string): RequirementsAnalysis =>
  ({
    feature: 'Notes',
    acceptancePoints: [
      { id: 'AP-1', statement: 'Creating a note adds it to the list', evidenceIds: ['BEH-1'], ...(validationType ? { validationType } : {}) },
    ],
    businessRules: [],
    openQuestions: [],
    risks: [],
  }) as unknown as RequirementsAnalysis;

const UI_ONLY = { api: false, visual: false };
const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

// ---------------------------------------------------------------------------

describe('the strategy vocabulary', () => {
  it('offers exactly the six documented routes', () => {
    assert.deepEqual([...AUTOMATION_STRATEGIES], ['UI', 'API', 'UI_API', 'VISUAL', 'MANUAL', 'UNKNOWN']);
  });

  it('is optional — an entry that states none is still valid', () => {
    assert.deepEqual(validateAutomationPrioritization(testCases, prioritization(), undefined, undefined, UI_ONLY), []);
  });
});

describe('a UI candidate', () => {
  it('is accepted when the evidence is browser-observed', () => {
    const p = prioritization({ automationStrategy: 'UI', strategyReason: 'Observed entirely in the rendered list' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY), []);
  });

  it('needs no special capability — UI is what a browser run always has', () => {
    const p = prioritization({ automationStrategy: 'UI' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, { api: false, visual: false }), []);
  });
});

describe('an API candidate', () => {
  it('is accepted when a requirement was typed API', () => {
    const caps = observedCapabilities({ requirements: requirementsTyped('API') });
    assert.equal(caps.api, true);
    const p = prioritization({ automationStrategy: 'API' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, caps), []);
  });

  it('is accepted when a requirement was typed CONTRACT', () => {
    assert.equal(observedCapabilities({ requirements: requirementsTyped('CONTRACT') }).api, true);
  });

  it('is accepted when the browser evidence recorded real HTTP requests', () => {
    const caps = observedCapabilities({
      requirements: requirementsTyped(),
      evidence: { findings: [{ type: 'REQUEST_FAILED', source: 'http://localhost:4444/api/notes' }] },
    });
    assert.equal(caps.api, true, 'a recorded request proves there is a surface to drive');
  });

  it('is refused when nothing upstream observed an API', () => {
    const caps = observedCapabilities({ requirements: requirementsTyped('UI') });
    assert.equal(caps.api, false);
    const p = prioritization({ automationStrategy: 'API' });
    const errors = validateAutomationPrioritization(testCases, p, undefined, undefined, caps);
    const bad = errors.find((e) => e.code === 'UNSUPPORTED_STRATEGY');
    assert.ok(bad, 'inventing an API surface is refused');
    assert.match(bad!.details, /Do not assume an API exists/);
  });

  it('refuses UI_API on the same grounds', () => {
    const p = prioritization({ automationStrategy: 'UI_API' });
    assert.ok(codes(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY)).includes('UNSUPPORTED_STRATEGY'));
  });

  it('does not treat the case\'s own wording as evidence of an API', () => {
    const wordy = JSON.parse(JSON.stringify(testCases)) as TestCases;
    wordy.testCases[0].title = 'Call the notes API and assert the response';
    const caps = observedCapabilities({ requirements: requirementsTyped() });
    assert.equal(caps.api, false, 'saying it does not make it so');
  });
});

describe('a manual-only case', () => {
  it('accepts MANUAL strategy with MANUAL mode and NONE priority', () => {
    const p = prioritization({
      executionMode: 'MANUAL',
      automationPriority: 'NONE',
      automationStrategy: 'MANUAL',
      strategyReason: 'Needs a human to judge the wording',
    });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY), []);
  });

  it('accepts UNKNOWN on a manual case', () => {
    const p = prioritization({ executionMode: 'MANUAL', automationPriority: 'NONE', automationStrategy: 'UNKNOWN' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY), []);
  });
});

describe('an unknown strategy', () => {
  it('is always acceptable — considered and unsettled is honest', () => {
    const p = prioritization({ automationStrategy: 'UNKNOWN' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY), []);
  });

  it('needs no capability, unlike API or VISUAL', () => {
    const p = prioritization({ automationStrategy: 'UNKNOWN' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, { api: false, visual: false }), []);
  });
});

describe('a visual strategy', () => {
  it('is accepted when a requirement was typed VISUAL', () => {
    const caps = observedCapabilities({ requirements: requirementsTyped('VISUAL') });
    assert.equal(caps.visual, true);
    const p = prioritization({ automationStrategy: 'VISUAL' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, caps), []);
  });

  it('is refused when nothing upstream calls for comparing appearance', () => {
    const p = prioritization({ automationStrategy: 'VISUAL' });
    const errors = validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY);
    assert.ok(codes(errors).includes('UNSUPPORTED_STRATEGY'));
  });
});

describe('strategy cannot contradict executionMode', () => {
  for (const strategy of ['UI', 'API', 'UI_API', 'VISUAL'] as const) {
    it(`refuses a MANUAL case claiming ${strategy}`, () => {
      const p = prioritization({ executionMode: 'MANUAL', automationPriority: 'NONE', automationStrategy: strategy });
      const errors = validateAutomationPrioritization(testCases, p, undefined, undefined, { api: true, visual: true });
      const bad = errors.find((e) => e.code === 'CONTRADICTORY_STRATEGY');
      assert.ok(bad, `${strategy} must contradict MANUAL`);
      assert.match(bad!.details, /Use MANUAL or UNKNOWN/);
    });
  }

  it('refuses an AUTOMATION case claiming a MANUAL strategy', () => {
    const p = prioritization({ automationStrategy: 'MANUAL' });
    const errors = validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY);
    const bad = errors.find((e) => e.code === 'CONTRADICTORY_STRATEGY');
    assert.ok(bad);
    assert.match(bad!.details, /cannot have a MANUAL strategy/);
  });

  it('keeps the four judgements independent — a P0 case may still be MANUAL', () => {
    const p = prioritization({ executionMode: 'MANUAL', automationPriority: 'NONE', automationStrategy: 'MANUAL' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p, undefined, undefined, UI_ONLY), []);
  });
});

describe('existing prioritization behaviour is unchanged', () => {
  it('still refuses MANUAL with HIGH automation priority', () => {
    const p = prioritization({ executionMode: 'MANUAL', automationPriority: 'HIGH' });
    assert.ok(codes(validateAutomationPrioritization(testCases, p)).includes('INCONSISTENT_PRIORITY'));
  });

  it('still refuses AUTOMATION with NONE', () => {
    const p = prioritization({ automationPriority: 'NONE' });
    assert.ok(codes(validateAutomationPrioritization(testCases, p)).includes('INCONSISTENT_PRIORITY'));
  });

  it('still requires exactly one entry per test case', () => {
    const p = { cases: [entry(), entry()] } as unknown as AutomationPrioritization;
    assert.ok(codes(validateAutomationPrioritization(testCases, p)).includes('DUPLICATE_PRIORITIZATION'));
    assert.ok(codes(validateAutomationPrioritization(testCases, { cases: [] } as unknown as AutomationPrioritization)).includes('MISSING_PRIORITIZATION'));
  });

  it('still refuses an entry for a test case that does not exist', () => {
    const p = { cases: [entry(), entry({ testCaseId: 'TC-99' })] } as unknown as AutomationPrioritization;
    assert.ok(codes(validateAutomationPrioritization(testCases, p)).includes('UNKNOWN_TEST_CASE'));
  });

  it('validates an artifact written without any strategy at all', () => {
    // Backwards compatibility: everything produced before this change.
    assert.deepEqual(validateAutomationPrioritization(testCases, prioritization()), []);
  });

  it('skips the capability check entirely when the host supplied no context', () => {
    const p = prioritization({ automationStrategy: 'API' });
    assert.deepEqual(validateAutomationPrioritization(testCases, p), [], 'no context means no guess');
  });
});

describe('the strategy breakdown is host-counted', () => {
  it('counts each strategy, and names unstated ones UNSPECIFIED', () => {
    const p = {
      cases: [
        entry({ testCaseId: 'TC-1', automationStrategy: 'UI' }),
        entry({ testCaseId: 'TC-2', automationStrategy: 'UI' }),
        entry({ testCaseId: 'TC-3', automationStrategy: 'UNKNOWN' }),
        entry({ testCaseId: 'TC-4' }),
      ],
    } as unknown as AutomationPrioritization;
    assert.deepEqual(strategySummary(p), { UI: 2, UNKNOWN: 1, UNSPECIFIED: 1 });
  });

  it('leaves the review summary untouched', () => {
    // ReviewSummary is the reviewer's contract: it must stay numbers only, or
    // a Test Cases Review is suddenly required to restate a nested object.
    const s = summarize(prioritization({ automationStrategy: 'UI' }));
    assert.deepEqual(Object.keys(s).sort(), [
      'automation', 'automationHigh', 'automationLow', 'automationMedium', 'manual', 'total',
    ]);
    assert.ok(Object.values(s).every((v) => typeof v === 'number'));
  });

  it('survives an empty prioritization', () => {
    assert.deepEqual(strategySummary({ cases: [] } as unknown as AutomationPrioritization), {});
  });
});

describe('the schema carries the strategy', () => {
  it('accepts an entry with a strategy and its reason', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const p = prioritization({ automationStrategy: 'UI', strategyReason: 'Observed in the DOM' });
    assert.deepEqual(schemaErrorsFor('automation-prioritization', p), []);
  });

  it('accepts an entry with no strategy', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.deepEqual(schemaErrorsFor('automation-prioritization', prioritization()), []);
  });

  it('rejects a strategy outside the enum', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.ok(schemaErrorsFor('automation-prioritization', prioritization({ automationStrategy: 'TELEPATHY' })).length > 0);
  });
});

describe('the prioritizer is told the rules', () => {
  const source = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/agents/automation-prioritizer.ts', import.meta.url), 'utf8'),
    );

  it('describes all six strategies', async () => {
    const s = await source();
    for (const strategy of AUTOMATION_STRATEGIES) assert.match(s, new RegExp(strategy.replace('_', '\\\\?_')));
  });

  it('forbids inventing an API or visual capability', async () => {
    const s = await source();
    assert.match(s, /Never invent a capability/);
    assert.match(s, /still not evidence that an API exists/);
  });

  it('keeps the judgements separate', async () => {
    assert.match(await source(), /none may be copied from another/);
  });
});
