// Test coverage modes and test levels.
//
//   npm test
//
// A run is started in one of three modes — Automatic, UI only, API only — and
// every test case states the level it is exercised at. What makes that more
// than a label is that the host checks it at every stage, from the artifacts:
//
//   - a documented API operation is evidence, and an undocumented one is not;
//   - a test case's level must be one the mode allows, and one its own
//     evidence supports — "API" needs a documented operation, "UI" needs
//     something a browser observed;
//   - Automatic may pick either level per scenario, and may not write the
//     same scenario at both;
//   - the automation strategy follows the level;
//   - a workspace from before any of this existed validates exactly as it did.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-coverage-modes-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.QA_ENV_FILE = '/nonexistent';

const {
  apiOperations, coverageSummary, inCoverageScope, observedCapabilities, testableRequirements,
  validateAutomationPrioritization, validateRequirementsAnalysis, validateTestCases,
} = await import('../src/lib/semantic-validate.ts');
const { extractApiDiscovery } = await import('../src/lib/api-discovery.ts');
const {
  allowedTestLevels, coverageBriefing, COVERAGE_MODES, displayApiDocsUrl, normalizeApiDocsUrl, parseCoverageMode, testLevelOf, usesApiDocs,
} = await import('../src/lib/coverage-mode.ts');
const qa = await import('../src/lib/qa-artifacts.ts');
const { focusedContext } = await import('../src/review/context.ts');
const ui = await import('../ui/src/lib/coverage.ts');

import type { AutomationPrioritization, CoverageContext, DiscoveredBehavior, RequirementsAnalysis, SemanticError, TestCase, TestCases } from '../src/lib/semantic-validate.ts';
import type { CoverageMode } from '../src/lib/coverage-mode.ts';

after(() => rmSync(ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// One small product, seen two ways: through a browser, and in its API documentation
// ---------------------------------------------------------------------------

const api = extractApiDiscovery({
  openapi: '3.0.3',
  info: { title: 'Notes API', version: '1' },
  security: [{ bearer: [] }],
  paths: {
    '/api/notes': {
      get: { summary: 'Retrieves the collection of notes.', responses: { 200: { description: 'Note collection' }, 401: { description: 'Unauthenticated' } } },
      post: {
        summary: 'Creates a note.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 255 }, content: { type: 'string' } } } } } },
        responses: { 201: { description: 'Note created' }, 422: { description: 'Validation failed' } },
      },
    },
    '/api/notes/{id}': { delete: { summary: 'Removes a note.', responses: { 204: { description: 'Note removed' }, 404: { description: 'Note not found' } } } },
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
}, { url: 'http://localhost:4444/api/doc', format: 'SWAGGER_UI' });

const discovery = (): DiscoveredBehavior => ({
  product: 'Notes',
  locations: [{ url: 'http://localhost:4444/notes', status: 'EXPLORED' }],
  areas: [{ name: 'Notes', routes: ['http://localhost:4444/notes'], notes: [] }],
  behaviors: [
    { id: 'BEH-1', area: 'Notes', statement: 'Creating a note with a title adds it to the list of notes.', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false },
    { id: 'BEH-2', area: 'Notes', statement: 'Submitting the note form with an empty title shows a validation message under the title field.', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false },
  ],
  openQuestions: [],
  conflicts: [],
});

/** AP-1 and AP-2 were observed in the interface; AP-3 and BR-1 are declared by the documentation; AP-4 rests on both. */
const requirements = (): RequirementsAnalysis => ({
  feature: 'Notes',
  acceptancePoints: [
    { id: 'AP-1', statement: 'Creating a note with a title adds it to the list of notes.', evidenceIds: ['BEH-1'], validationType: 'UI' },
    { id: 'AP-2', statement: 'Submitting the note form with an empty title shows a validation message.', evidenceIds: ['BEH-2'], validationType: 'UI' },
    { id: 'AP-3', statement: 'Creating a note through the API responds with status 201.', evidenceIds: ['API-2'], validationType: 'API' },
    { id: 'AP-4', statement: 'A note created with a title is returned in the collection of notes.', evidenceIds: ['BEH-1', 'API-1'], validationType: 'API' },
  ],
  businessRules: [
    { id: 'BR-1', statement: 'Creating a note without a title is rejected with status 422, validation failed.', evidenceIds: ['API-2'], validationType: 'API' },
  ],
  openQuestions: [],
  risks: [],
});

const tc = (id: string, over: Partial<TestCase>): TestCase => ({
  id,
  title: 'Creating a note with a title adds it to the list of notes',
  evidenceIds: ['AP-1'],
  covers: ['AP-1'],
  priority: 'P1',
  types: ['positive'],
  preconditions: [],
  testData: {},
  steps: [{ action: 'Create a note with a title', expected: 'The note is added to the list of notes' }],
  expectedResult: 'The note is added to the list of notes',
  automationCandidate: true,
  automationReason: 'Deterministic',
  tags: [],
  ...over,
});

const uiCreate = () => tc('TC-1', { testLevel: 'UI' });
const uiValidation = () => tc('TC-2', {
  testLevel: 'UI', title: 'Empty title shows a validation message', evidenceIds: ['AP-2'], covers: ['AP-2'], types: ['negative', 'validation'],
  steps: [{ action: 'Submit the note form with an empty title', expected: 'A validation message is shown under the title field' }],
  expectedResult: 'A validation message is shown under the title field',
});
const apiCreate = () => tc('TC-3', {
  testLevel: 'API', title: 'Creating a note through the API responds with status 201', evidenceIds: ['AP-3', 'API-2'], covers: ['AP-3'],
  steps: [{ action: 'Send POST /api/notes with a title', expected: 'The response status is 201 and the note is created' }],
  expectedResult: 'The response status is 201, note created',
});
const apiRejects = () => tc('TC-4', {
  testLevel: 'API', title: 'Creating a note without a title is rejected with status 422', evidenceIds: ['BR-1'], covers: ['BR-1'], types: ['negative', 'validation'],
  steps: [{ action: 'Send POST /api/notes without a title', expected: 'The response status is 422, validation failed' }],
  expectedResult: 'The request is rejected with status 422, validation failed',
});
const apiList = () => tc('TC-5', {
  testLevel: 'API', title: 'A created note is returned in the collection of notes', evidenceIds: ['AP-4'], covers: ['AP-4'], types: ['positive', 'integration'],
  steps: [{ action: 'Send GET /api/notes after creating a note with a title', expected: 'The collection of notes contains the note' }],
  expectedResult: 'The note is returned in the collection of notes',
});

const suite = (...testCases: TestCase[]): TestCases => ({ feature: 'Notes', testCases, openQuestions: [] });
const ctx = (mode: CoverageMode, withApi = true): CoverageContext => ({ mode, api: withApi ? api : undefined });
const codes = (errors: SemanticError[]) => errors.map((e) => e.code);
const only = (errors: SemanticError[], code: string) => errors.filter((e) => e.code === code);

// ---------------------------------------------------------------------------

describe('the three modes', () => {
  it('are a closed vocabulary; Automatic is the default and the only reading of an unknown value is "none"', () => {
    assert.deepEqual([...COVERAGE_MODES], ['AUTOMATIC', 'UI_ONLY', 'API_ONLY']);
    for (const [raw, mode] of [['automatic', 'AUTOMATIC'], ['Auto', 'AUTOMATIC'], ['ui', 'UI_ONLY'], ['UI only', 'UI_ONLY'], ['ui-only', 'UI_ONLY'], ['API_ONLY', 'API_ONLY'], ['api', 'API_ONLY']] as const) {
      assert.equal(parseCoverageMode(raw), mode, raw);
    }
    for (const bad of ['', 'both', 'e2e', undefined, null, 3]) assert.equal(parseCoverageMode(bad), undefined);
  });

  it('decide which levels a case may have, and whether API documentation is read', () => {
    assert.deepEqual([...allowedTestLevels('AUTOMATIC')], ['UI', 'API']);
    assert.deepEqual([...allowedTestLevels('UI_ONLY')], ['UI']);
    assert.deepEqual([...allowedTestLevels('API_ONLY')], ['API']);
    assert.deepEqual(COVERAGE_MODES.map(usesApiDocs), [true, false, true]);
  });

  it('read a case with no level as UI — every suite from before levels was', () => {
    assert.equal(testLevelOf({}), 'UI');
    assert.equal(testLevelOf({ testLevel: 'API' }), 'API');
    assert.equal(testLevelOf({ testLevel: 'api' }), 'UI', 'not a level: not API');
    assert.equal(testLevelOf(undefined), 'UI');
  });

  it('accept an API documentation URL only as a fetchable http(s) URL, and never store its query', () => {
    assert.equal(normalizeApiDocsUrl(' https://example.test/openapi.json#/paths '), 'https://example.test/openapi.json');
    assert.equal(normalizeApiDocsUrl('http://localhost:4444/api/doc?token=abc'), 'http://localhost:4444/api/doc?token=abc', 'fetched as given');
    assert.equal(displayApiDocsUrl('http://localhost:4444/api/doc?token=abc'), 'http://localhost:4444/api/doc', 'stored without it');
    for (const bad of ['', 'ftp://example.test/x', 'file:///etc/passwd', 'https://u:p@example.test/', 'example.test/openapi.json', `https://example.test/${'a'.repeat(600)}`, 'https://exa mple.test/', 42]) {
      assert.equal(normalizeApiDocsUrl(bad), undefined, String(bad).slice(0, 40));
    }
  });

  it('brief every stage with the run\'s facts, and never tell discovery to read what it cannot', () => {
    for (const mode of COVERAGE_MODES) {
      for (const stage of ['discovery', 'analysis', 'design', 'prioritization', 'defects']) {
        const text = coverageBriefing(stage, mode, { available: true, endpoints: 3 });
        assert.match(text, new RegExp(`\\(${mode}\\)`), `${stage}/${mode} names the mode`);
      }
      assert.doesNotMatch(coverageBriefing('discovery', mode, { available: true, endpoints: 3 }), /read_qa_artifact/);
    }
    assert.match(coverageBriefing('design', 'UI_ONLY'), /"testLevel": "UI" on every test case/);
    assert.match(coverageBriefing('design', 'API_ONLY', { available: true, endpoints: 3 }), /"testLevel": "API" on every test case/);
    assert.match(coverageBriefing('design', 'AUTOMATIC', { available: true, endpoints: 3 }), /Do not write the same scenario at both levels/);
    assert.match(coverageBriefing('analysis', 'AUTOMATIC', { available: true, endpoints: 3 }), /3 documented operation\(s\)/);
    // Documentation that could not be read is said plainly, with the reason, and API level is ruled out.
    const none = coverageBriefing('design', 'AUTOMATIC', { available: false, endpoints: 0, reason: 'could not be fetched: HTTP 404' });
    assert.match(none, /No API documentation is available to this run \(could not be fetched: HTTP 404\)/);
    assert.match(none, /"testLevel": "UI" on every test case/);
    assert.doesNotMatch(coverageBriefing('analysis', 'UI_ONLY', { available: true, endpoints: 3 }), /documented operation\(s\)/, 'UI only never mentions the documentation');
  });
});

describe('documented API operations are evidence — and only documented ones', () => {
  it('are citable in Automatic and API only, and do not exist in UI only or without documentation', () => {
    assert.deepEqual([...apiOperations(ctx('AUTOMATIC')).keys()], ['API-1', 'API-2', 'API-3']);
    assert.equal(apiOperations(ctx('API_ONLY')).size, 3);
    assert.equal(apiOperations(ctx('UI_ONLY')).size, 0);
    assert.equal(apiOperations(ctx('AUTOMATIC', false)).size, 0);
    assert.equal(apiOperations(undefined).size, 0);
    assert.equal(apiOperations({ mode: 'AUTOMATIC', api: { status: 'UNAVAILABLE', reason: 'x', authentication: [], endpoints: [], schemas: [] } }).size, 0);
  });

  it('a requirement may rest on a documented operation, alone or beside an observed behavior', () => {
    assert.deepEqual(validateRequirementsAnalysis(discovery(), requirements(), ctx('AUTOMATIC')), []);
    assert.deepEqual(validateRequirementsAnalysis(discovery(), requirements(), ctx('API_ONLY')), []);
  });

  it('an operation id nobody documented is an unknown evidence id — with the real ones named', () => {
    const reqs = requirements();
    reqs.acceptancePoints[2].evidenceIds = ['API-9'];
    const errors = only(validateRequirementsAnalysis(discovery(), reqs, ctx('AUTOMATIC')), 'UNKNOWN_EVIDENCE_ID');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].value, 'API-9');
    assert.match(errors[0].details ?? '', /Valid IDs: BEH-1, BEH-2, API-1, API-2, API-3/);
  });

  it('the same requirements are refused in UI only, and when there is no documentation — an API id means nothing there', () => {
    for (const context of [ctx('UI_ONLY'), ctx('AUTOMATIC', false), undefined]) {
      const errors = only(validateRequirementsAnalysis(discovery(), requirements(), context), 'UNKNOWN_EVIDENCE_ID');
      assert.deepEqual(errors.map((e) => e.value).sort(), ['API-1', 'API-2', 'API-2']);
    }
  });

  it('a requirement must say what the operation it cites declares', () => {
    const reqs = requirements();
    reqs.acceptancePoints[2] = { id: 'AP-3', statement: 'The dashboard greets the signed-in user.', evidenceIds: ['API-3'], validationType: 'API' };
    assert.ok(codes(validateRequirementsAnalysis(discovery(), reqs, ctx('AUTOMATIC'))).some((c) => c === 'EVIDENCE_MISMATCH' || c === 'UNSUPPORTED_FACT'));
  });

  it('an endpoint the documentation does not declare is an invented fact, wherever it is written', () => {
    const reqs = requirements();
    reqs.acceptancePoints[2].statement = 'Creating a note through POST /api/tags responds with status 201.';
    const inReqs = only(validateRequirementsAnalysis(discovery(), reqs, ctx('AUTOMATIC')), 'UNSUPPORTED_FACT');
    assert.deepEqual(inReqs.map((e) => e.value), ['/api/tags']);

    const invented = apiCreate();
    invented.steps = [{ action: 'Send POST /api/notes/42/share with a title', expected: 'The response status is 201 and the note is created' }];
    const inCase = only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), invented, apiRejects(), apiList()), ctx('AUTOMATIC')), 'UNSUPPORTED_FACT');
    assert.deepEqual(inCase.map((e) => e.value), ['/api/notes/42/share']);
  });

  it('a documented path with a method the documentation does not declare for it is invented too', () => {
    const wrongMethod = apiCreate();
    wrongMethod.steps = [{ action: 'Send PUT /api/notes with a title', expected: 'The response status is 201 and the note is created' }];
    const errors = only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), wrongMethod, apiRejects(), apiList()), ctx('AUTOMATIC')), 'UNSUPPORTED_FACT');
    assert.deepEqual(errors.map((e) => e.value), ['PUT /api/notes']);
    assert.match(errors[0].details ?? '', /declares no PUT for "\/api\/notes" \(it declares: GET, POST\)/);
    // The only operation on a single note is DELETE: reading one is not documented.
    wrongMethod.steps = [{ action: 'Send GET /api/notes/42 for the note', expected: 'The response status is 201 and the note is created' }];
    const single = only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), wrongMethod, apiRejects(), apiList()), ctx('AUTOMATIC')), 'UNSUPPORTED_FACT');
    assert.deepEqual(single.map((e) => e.value), ['GET /api/notes/42']);
  });

  it('a concrete path under a documented template is supported; a documented path is not, once the documentation is gone', () => {
    const concrete = tc('TC-6', {
      testLevel: 'API', title: 'Removing a note that does not exist responds with status 404', evidenceIds: ['API-3'], covers: [], types: ['negative'],
      steps: [{ action: 'Send DELETE /api/notes/999 for a note that does not exist', expected: 'The response status is 404, note not found' }],
      expectedResult: 'The response status is 404, note not found',
    });
    const withDocs = validateTestCases(discovery(), requirements(), suite(concrete), ctx('AUTOMATIC'));
    assert.deepEqual(only(withDocs, 'UNSUPPORTED_FACT'), []);
    const without = validateTestCases(discovery(), requirements(), suite(concrete), ctx('AUTOMATIC', false));
    assert.ok(only(without, 'UNSUPPORTED_FACT').some((e) => e.value === '/api/notes/999'));
  });
});

describe('Automatic: the level that fits each scenario, and each scenario once', () => {
  const mixed = () => suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList());

  it('accepts a suite that mixes UI and API cases, each resting on the right evidence', () => {
    assert.deepEqual(validateTestCases(discovery(), requirements(), mixed(), ctx('AUTOMATIC')), []);
    const summary = coverageSummary(requirements(), mixed(), ctx('AUTOMATIC'));
    assert.deepEqual(summary.testLevels, { UI: 2, API: 3 });
    assert.equal(summary.outOfScope, 0);
    assert.equal(summary.uncovered, 0);
  });

  it('refuses an API-level case that cites no documented operation', () => {
    const wrong = uiCreate();
    wrong.testLevel = 'API';
    const errors = only(validateTestCases(discovery(), requirements(), suite(wrong, uiValidation(), apiCreate(), apiRejects(), apiList()), ctx('AUTOMATIC')), 'UNSUPPORTED_TEST_LEVEL');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'testCases[0].testLevel');
    assert.match(errors[0].details ?? '', /cites no documented operation.*API-1, API-2, API-3/);
  });

  it('refuses a UI-level case that rests only on documentation nobody saw in the interface', () => {
    const wrong = apiRejects();
    wrong.testLevel = 'UI';
    const errors = only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), apiCreate(), wrong, apiList()), ctx('AUTOMATIC')), 'UNSUPPORTED_TEST_LEVEL');
    assert.equal(errors.length, 1);
    assert.match(errors[0].details ?? '', /rests only on API documentation/);
  });

  it('lets a requirement that rests on both be tested at either level', () => {
    for (const level of ['UI', 'API'] as const) {
      const either = apiList();
      either.testLevel = level;
      assert.deepEqual(only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), either), ctx('AUTOMATIC')), 'UNSUPPORTED_TEST_LEVEL'), []);
    }
  });

  it('refuses the same scenario written at both levels, naming the pair', () => {
    const twin = { ...apiList(), id: 'TC-9', testLevel: 'UI' as const };
    const errors = only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList(), twin), ctx('AUTOMATIC')), 'DUPLICATE_ACROSS_LEVELS');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].value, 'TC-9');
    assert.match(errors[0].details ?? '', /TC-9 \(UI\) and TC-5 \(API\) cover the same requirements \(AP-4\)/);
  });

  it('does not call it a duplicate when the second case is a different kind of scenario, or the same level', () => {
    const smoke = { ...apiList(), id: 'TC-9', testLevel: 'UI' as const, types: ['smoke'] };
    assert.deepEqual(only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList(), smoke), ctx('AUTOMATIC')), 'DUPLICATE_ACROSS_LEVELS'), []);
    const sameLevel = { ...apiList(), id: 'TC-9' };
    assert.deepEqual(only(validateTestCases(discovery(), requirements(), suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList(), sameLevel), ctx('AUTOMATIC')), 'DUPLICATE_ACROSS_LEVELS'), []);
  });

  it('without documentation, Automatic is UI: an API-level case has nothing to rest on', () => {
    const reqs = requirements();
    reqs.acceptancePoints = reqs.acceptancePoints.slice(0, 2);
    reqs.businessRules = [];
    const wrong = uiCreate();
    wrong.testLevel = 'API';
    const errors = only(validateTestCases(discovery(), reqs, suite(wrong, uiValidation()), ctx('AUTOMATIC', false)), 'UNSUPPORTED_TEST_LEVEL');
    assert.equal(errors.length, 1);
    assert.match(errors[0].details ?? '', /this run has no API documentation/);
    assert.deepEqual(validateTestCases(discovery(), reqs, suite(uiCreate(), uiValidation()), ctx('AUTOMATIC', false)), []);
  });
});

describe('UI only', () => {
  const uiRequirements = () => {
    const reqs = requirements();
    reqs.acceptancePoints = reqs.acceptancePoints.slice(0, 2);
    reqs.businessRules = [];
    return reqs;
  };

  it('accepts a suite of UI cases, and counts every requirement in scope', () => {
    assert.deepEqual(validateTestCases(discovery(), uiRequirements(), suite(uiCreate(), uiValidation()), ctx('UI_ONLY')), []);
    assert.equal(testableRequirements(uiRequirements(), ctx('UI_ONLY')).length, 2);
  });

  it('refuses any API-level case, even one the documentation would support in another mode', () => {
    const errors = validateTestCases(discovery(), uiRequirements(), suite(uiCreate(), uiValidation(), apiCreate()), ctx('UI_ONLY'));
    const level = only(errors, 'TEST_LEVEL_OUT_OF_MODE');
    assert.equal(level.length, 1);
    assert.equal(level[0].value, 'API');
    assert.match(level[0].details ?? '', /this run is UI only/);
  });

  it('automates nothing through an API', () => {
    const capabilities = observedCapabilities({ requirements: requirements(), context: ctx('UI_ONLY') });
    assert.deepEqual(capabilities, { api: false, visual: false });
    const p: AutomationPrioritization = { cases: [{ testCaseId: 'TC-1', executionMode: 'AUTOMATION', automationPriority: 'HIGH', reason: 'Core flow', blockingFactors: [], automationStrategy: 'UI_API' }] };
    const errors = only(validateAutomationPrioritization(suite(uiCreate()), p, discovery(), uiRequirements(), capabilities, ctx('UI_ONLY')), 'UNSUPPORTED_STRATEGY');
    assert.equal(errors.length, 1);
    assert.match(errors[0].details ?? '', /This run is UI only/);
  });
});

describe('API only', () => {
  const apiSuite = () => suite(apiCreate(), apiRejects(), apiList());

  it('owes a case only to requirements the documentation supports — the rest are out of scope, not uncovered', () => {
    const reqs = requirements();
    assert.deepEqual(testableRequirements(reqs, ctx('API_ONLY')).map((r) => r.id), ['AP-3', 'AP-4', 'BR-1']);
    assert.equal(inCoverageScope(reqs.acceptancePoints[0], ctx('API_ONLY')), false);
    assert.equal(inCoverageScope(reqs.acceptancePoints[0], ctx('AUTOMATIC')), true);
    assert.deepEqual(validateTestCases(discovery(), reqs, apiSuite(), ctx('API_ONLY')), []);
    const summary = coverageSummary(reqs, apiSuite(), ctx('API_ONLY'));
    assert.deepEqual({ testable: summary.testable, covered: summary.covered, uncovered: summary.uncovered, outOfScope: summary.outOfScope, exempt: summary.exempt },
      { testable: 3, covered: 3, uncovered: 0, outOfScope: 2, exempt: 0 });
    assert.deepEqual(summary.testLevels, { API: 3 });
  });

  it('still requires every in-scope requirement to be covered', () => {
    const errors = only(validateTestCases(discovery(), requirements(), suite(apiCreate(), apiList()), ctx('API_ONLY')), 'UNCOVERED_ACCEPTANCE_POINT');
    assert.deepEqual(errors.map((e) => e.value), ['BR-1']);
  });

  it('refuses any UI-level case, and a case with no level at all', () => {
    const noLevel = uiValidation();
    delete noLevel.testLevel;
    const errors = only(validateTestCases(discovery(), requirements(), suite(...apiSuite().testCases, uiCreate(), noLevel), ctx('API_ONLY')), 'TEST_LEVEL_OUT_OF_MODE');
    assert.deepEqual(errors.map((e) => e.path), ['testCases[3].testLevel', 'testCases[4].testLevel']);
    assert.match(errors[0].details ?? '', /this run is API only/);
  });

  it('with no documentation there is nothing in scope and nothing an API case could rest on', () => {
    assert.deepEqual(testableRequirements(requirements(), ctx('API_ONLY', false)), []);
    const errors = validateTestCases(discovery(), { ...requirements(), acceptancePoints: requirements().acceptancePoints.slice(0, 2), businessRules: [] }, suite({ ...uiCreate(), testLevel: 'API' }), ctx('API_ONLY', false));
    assert.ok(codes(errors).includes('UNSUPPORTED_TEST_LEVEL'));
  });
});

describe('the automation strategy follows the test level', () => {
  const entry = (testCaseId: string, automationStrategy: string, executionMode = 'AUTOMATION') =>
    ({ testCaseId, executionMode, automationPriority: executionMode === 'MANUAL' ? 'NONE' : 'HIGH', reason: 'Repeatable and deterministic', blockingFactors: [], automationStrategy }) as AutomationPrioritization['cases'][number];
  const check = (cases: AutomationPrioritization['cases'], testCases: TestCases, context = ctx('AUTOMATIC')) =>
    validateAutomationPrioritization(testCases, { cases }, discovery(), requirements(), observedCapabilities({ requirements: requirements(), context }), context);

  it('accepts API for an API-level case and UI or UI_API for a UI-level one', () => {
    assert.deepEqual(check([entry('TC-1', 'UI'), entry('TC-3', 'API')], suite(uiCreate(), apiCreate())), []);
    assert.deepEqual(check([entry('TC-1', 'UI_API'), entry('TC-3', 'UNKNOWN')], suite(uiCreate(), apiCreate())), []);
  });

  it('refuses a browser strategy for an API-level case, and API alone for a UI-level one', () => {
    for (const strategy of ['UI', 'UI_API', 'VISUAL']) {
      const errors = only(check([entry('TC-3', strategy)], suite(apiCreate())), 'CONTRADICTORY_STRATEGY');
      assert.equal(errors.length, 1, strategy);
      assert.equal(errors[0].value, `API/${strategy}`);
    }
    const errors = only(check([entry('TC-1', 'API')], suite(uiCreate())), 'CONTRADICTORY_STRATEGY');
    assert.equal(errors.length, 1);
    assert.match(errors[0].details ?? '', /UI-level test case; it cannot be automated through API alone/);
  });

  it('documentation the host read is what makes an API strategy supportable', () => {
    // No requirement typed API, no recorded request — only the documentation.
    const untyped = requirements();
    for (const r of [...untyped.acceptancePoints, ...untyped.businessRules]) delete r.validationType;
    assert.deepEqual(observedCapabilities({ requirements: untyped, context: ctx('AUTOMATIC') }), { api: true, visual: false });
    assert.deepEqual(observedCapabilities({ requirements: untyped, context: ctx('AUTOMATIC', false) }), { api: false, visual: false });
    assert.deepEqual(observedCapabilities({ requirements: untyped }), { api: false, visual: false });
  });

  it('leaves a suite that states no level alone — a strategy chosen before levels existed is not contradicted', () => {
    const legacy = uiCreate();
    delete legacy.testLevel;
    assert.deepEqual(only(check([entry('TC-1', 'API')], suite(legacy)), 'CONTRADICTORY_STRATEGY'), []);
  });

  it('does not judge a MANUAL case by its level', () => {
    assert.deepEqual(check([entry('TC-3', 'MANUAL', 'MANUAL')], suite(apiCreate())), []);
  });
});

describe('backward compatibility', () => {
  const legacyReqs = () => ({ ...requirements(), acceptancePoints: requirements().acceptancePoints.slice(0, 2), businessRules: [] });
  const legacySuite = () => {
    const cases = [uiCreate(), uiValidation()];
    for (const c of cases) delete c.testLevel;
    return suite(...cases);
  };

  it('a suite from before coverage modes validates with no context at all, exactly as it did', () => {
    assert.deepEqual(validateRequirementsAnalysis(discovery(), legacyReqs()), []);
    assert.deepEqual(validateTestCases(discovery(), legacyReqs(), legacySuite()), []);
    assert.deepEqual(testableRequirements(legacyReqs()).length, 2);
  });

  it('a workspace with no run-config.json is Automatic with no API documentation', () => {
    assert.equal(qa.readRunConfig(), undefined);
    assert.deepEqual(qa.readCoverageContext(), { mode: 'AUTOMATIC', api: undefined });
  });

  it('the test-cases schema accepts a case with or without a level, and nothing else in that field', () => {
    assert.deepEqual(qa.schemaErrorsFor('test-cases', legacySuite()), []);
    assert.deepEqual(qa.schemaErrorsFor('test-cases', suite(uiCreate(), apiCreate())), []);
    const bad = suite({ ...uiCreate(), testLevel: 'E2E' as never });
    assert.match(qa.schemaErrorsFor('test-cases', bad).join('\n'), /testLevel.*must be one of \["UI","API"\]/);
  });
});

describe('the mode travels on disk, so every later step judges by it', () => {
  it('validates an agent\'s write, a person\'s edit and the approval gate by the recorded mode', () => {
    qa.writeQaArtifact('discovered-behavior', discovery());
    qa.writeQaArtifact('api-discovery', api);
    qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC', apiDocsUrl: 'http://localhost:4444/api/doc', runId: '2026-10-09T10-00-00-000Z' });
    assert.equal(qa.readRunConfig()?.coverageMode, 'AUTOMATIC');
    assert.equal(qa.readCoverageContext().api?.endpoints.length, 3);

    // The agents' own write path: requirements citing documented operations, then a mixed suite.
    qa.writeQaArtifact('requirements-analysis', requirements());
    qa.writeQaArtifact('test-cases', suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList()));
    assert.equal((qa.readQaArtifact('test-cases') as TestCases).testCases[2].testLevel, 'API');

    // The same suite, re-validated after the mode on disk changes — as a refresh, an applied edit or the approval would.
    qa.writeQaArtifact('run-config', { coverageMode: 'UI_ONLY' });
    const underUiOnly = qa.semanticErrorsFor('test-cases', qa.readQaArtifact('test-cases'));
    // Under UI only no operation is citable, so the requirements themselves no longer stand — the designer is told to stop.
    assert.deepEqual(codes(underUiOnly), ['UPSTREAM_INVALID']);

    qa.writeQaArtifact('run-config', { coverageMode: 'API_ONLY', apiDocsUrl: 'http://localhost:4444/api/doc' });
    const underApiOnly = qa.semanticErrorsFor('test-cases', qa.readQaArtifact('test-cases'));
    assert.deepEqual([...new Set(codes(underApiOnly))], ['TEST_LEVEL_OUT_OF_MODE']);
    assert.throws(() => qa.replaceTestCases(suite(uiCreate(), uiValidation(), apiCreate(), apiRejects(), apiList())), /TEST_LEVEL_OUT_OF_MODE/);
    qa.replaceTestCases(suite(apiCreate(), apiRejects(), apiList()));
    assert.equal((qa.readQaArtifact('test-cases') as TestCases).testCases.length, 3);
  });

  it('documentation that became unavailable takes its operations with it', () => {
    qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC' });
    qa.writeQaArtifact('api-discovery', { status: 'UNAVAILABLE', reason: 'could not be fetched: HTTP 404', authentication: [], endpoints: [], schemas: [] });
    assert.deepEqual(codes(qa.semanticErrorsFor('test-cases', suite(apiCreate(), apiRejects(), apiList()))), ['UPSTREAM_INVALID']);
    qa.writeQaArtifact('api-discovery', api);
  });

  it('refuses a run configuration that is not one', () => {
    assert.throws(() => qa.writeQaArtifact('run-config', { coverageMode: 'BOTH' }), /does not match run-config\.schema\.json/);
    assert.throws(() => qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC', command: 'rm -rf /' }), /unexpected property "command"/);
    assert.throws(() => qa.writeQaArtifact('api-discovery', { status: 'AVAILABLE', endpoints: [{ id: 'made-up', method: 'GET', path: '/x', parameters: [], responses: [], security: [] }], schemas: [], authentication: [] }), /api-discovery\.schema\.json/);
  });
});

describe('no agent can author API facts or the run configuration', () => {
  const toolSource = readFileSync(new URL('../src/tools/qa-artifacts.ts', import.meta.url), 'utf8');
  const writable = /const ARTIFACT_NAMES = \[([\s\S]*?)\] as const/.exec(toolSource)![1];
  const readable = /const READABLE_ARTIFACT_NAMES = \[([\s\S]*?)\] as const/.exec(toolSource)![1];

  it('api-discovery is readable and not writable; run-config is neither', () => {
    assert.doesNotMatch(writable, /api-discovery|run-config/);
    assert.match(readable, /'api-discovery'/);
    assert.doesNotMatch(readable, /run-config/);
  });

  it('the agents are told the rules they are checked against', () => {
    const read = (name: string) => readFileSync(new URL(`../src/agents/${name}.ts`, import.meta.url), 'utf8');
    const designer = read('test-designer');
    assert.match(designer, /## Test level — the \\`testLevel\\` field/);
    assert.match(designer, /Never invent an\s+endpoint, a field or a status code/);
    assert.match(designer, /Do not write the same scenario\s+at both levels/);
    assert.match(read('behavior-analyst'), /Documented API operations — a second kind of evidence/);
    assert.match(read('behavior-analyst'), /does not exist for this run/);
    assert.match(read('automation-prioritizer'), /The strategy follows the test level/);
    assert.match(read('test-case-change-reviewer'), /vocabulary\.testLevels/);
  });
});

describe('a change request sees the mode, the allowed levels and the documented operations', () => {
  const request = { id: 'REQ-0001', operation: 'create', baseTestCasesSha256: 'x'.repeat(64), humanComment: 'Add a case', status: 'PROCESSING', history: [], createdAt: '', updatedAt: '' } as never;

  it('for a new case: every operation, and the levels the mode allows', () => {
    const context = focusedContext({ request, suite: suite(uiCreate(), apiCreate()), discovery: discovery(), requirements: requirements(), proposals: [], types: ['positive'], coverage: ctx('API_ONLY') });
    assert.equal(context.coverageMode, 'API_ONLY');
    assert.deepEqual(context.vocabulary.testLevels, ['API']);
    assert.deepEqual(context.apiOperations.map((o) => `${o.id} ${o.method} ${o.path}`), ['API-1 GET /api/notes', 'API-2 POST /api/notes', 'API-3 DELETE /api/notes/{id}']);
    assert.deepEqual(context.apiOperations[1].responses, ['201', '422']);
    assert.equal(context.apiOperations[1].requiresAuthentication, true);
    assert.deepEqual(context.otherCases.map((c) => c.testLevel), ['UI', 'API']);
  });

  it('with no coverage context: Automatic, both levels, and no operations', () => {
    const context = focusedContext({ request, suite: suite(uiCreate()), discovery: discovery(), requirements: requirements(), proposals: [], types: ['positive'] });
    assert.equal(context.coverageMode, 'AUTOMATIC');
    assert.deepEqual(context.vocabulary.testLevels, ['UI', 'API']);
    assert.deepEqual(context.apiOperations, []);
  });
});

describe('the workspace pages: mode labels, the URL field and the level filter', () => {
  const cases = [{ id: 'TC-1' }, { id: 'TC-2', testLevel: 'UI' }, { id: 'TC-3', testLevel: 'API' }, { id: 'TC-4', testLevel: 'API' }];

  it('offers the three modes, Automatic first', () => {
    assert.deepEqual(ui.COVERAGE_MODES.map((m) => [m.id, m.label]), [['AUTOMATIC', 'Automatic'], ['UI_ONLY', 'UI only'], ['API_ONLY', 'API only']]);
    assert.equal(ui.coverageModeLabel('API_ONLY'), 'API only');
    assert.equal(ui.coverageModeLabel(null), '—', 'a run from before coverage modes shows none, never a guess');
  });

  it('shows the API documentation field for Automatic and API only, and hides it for UI only', () => {
    assert.deepEqual(ui.COVERAGE_MODES.map((m) => ui.showsApiDocs(m.id)), [true, false, true]);
  });

  it('treats the URL as optional in Automatic, required in API only, and irrelevant in UI only', () => {
    assert.equal(ui.apiDocsProblem('AUTOMATIC', ''), undefined);
    assert.equal(ui.apiDocsProblem('AUTOMATIC', 'http://localhost:4444/api/doc'), undefined);
    assert.match(ui.apiDocsProblem('API_ONLY', '  ') ?? '', /needs the URL/);
    assert.equal(ui.apiDocsProblem('UI_ONLY', 'not even a url'), undefined);
    assert.match(ui.apiDocsProblem('AUTOMATIC', 'localhost:4444/api/doc') ?? '', /http:\/\/ or https:\/\//);
    assert.match(ui.apiDocsProblem('AUTOMATIC', 'ftp://example.test/x') ?? '', /http:\/\/ or https:\/\//);
    assert.match(ui.apiDocsProblem('AUTOMATIC', 'https://u:p@example.test/x') ?? '', /user name or password/);
  });

  it('filters test cases by level, counting a case with no level as UI', () => {
    assert.deepEqual(ui.levelCounts(cases), { UI: 2, API: 2 });
    assert.deepEqual(cases.filter((c) => ui.matchesLevel(c, 'UI')).map((c) => c.id), ['TC-1', 'TC-2']);
    assert.deepEqual(cases.filter((c) => ui.matchesLevel(c, 'API')).map((c) => c.id), ['TC-3', 'TC-4']);
    assert.equal(cases.filter((c) => ui.matchesLevel(c, 'ALL')).length, 4);
  });
});

describe('the Phase 1 runner: missing or inaccessible API documentation', () => {
  const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  /** The real runner, against its own empty artifact root. Every case here ends before a browser or a model is needed. */
  function run(args: string[], env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'qa-coverage-runner-'));
    const previous = '{"feature":"Previous run","testCases":[],"openQuestions":[]}';
    writeFileSync(join(root, 'test-cases.json'), previous);
    const r = spawnSync(process.execPath, [join(PROJECT, 'scripts', 'qa-manual.mjs'), ...args], {
      cwd: PROJECT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: '/nonexistent', LANGFUSE_ENABLED: 'false', TARGET_URL: 'http://localhost:4444/', QA_MODEL: 'ollama/none', QA_COVERAGE_MODE: '', QA_API_DOCS_URL: '', ...env },
    });
    const untouched = readFileSync(join(root, 'test-cases.json'), 'utf8') === previous && !existsSync(join(root, 'archive'));
    const state = { status: r.status, output: `${r.stdout}${r.stderr}`, untouched, locked: existsSync(join(root, 'run.lock')), wroteConfig: existsSync(join(root, 'run-config.json')) };
    rmSync(root, { recursive: true, force: true });
    return state;
  }

  it('refuses a coverage mode or a URL that is not one, before anything else happens', () => {
    const mode = run(['--coverage-mode', 'everything']);
    assert.equal(mode.status, 2);
    assert.match(mode.output, /Unknown coverage mode "everything"\. Use one of: automatic, ui, api\./);
    const url = run(['--coverage-mode=automatic', '--api-docs=file:///etc/passwd']);
    assert.equal(url.status, 2);
    assert.match(url.output, /must be an http\(s\) URL/);
    assert.ok(mode.untouched && url.untouched && !mode.locked && !url.locked);
  });

  it('API only without a URL stops before archiving anything, and says what to do', () => {
    const r = run(['--coverage-mode', 'api']);
    assert.equal(r.status, 1);
    assert.match(r.output, /API-only coverage needs API documentation, and no API documentation URL was given/);
    assert.match(r.output, /Nothing was archived or changed/);
    assert.ok(r.untouched, 'the previous run\'s output is still in place');
    assert.equal(r.locked, false, 'the run lock is released');
    assert.equal(r.wroteConfig, false);
  });

  it('API only with documentation that cannot be reached stops the same way, naming the reason', () => {
    const r = run([], { QA_COVERAGE_MODE: 'api', QA_API_DOCS_URL: 'http://127.0.0.1:9/openapi.json' });
    assert.equal(r.status, 1);
    assert.match(r.output, /the API documentation is unavailable \(could not be fetched: /);
    assert.ok(r.untouched && !r.locked);
  });
});
