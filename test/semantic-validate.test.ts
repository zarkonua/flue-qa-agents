// Regression tests for cross-artifact semantic validation.
//
// The REJECT cases use the actual artifacts from the 2026-09-21 run against
// http://localhost:4444/ (test/fixtures/bad-run-2026-09-21/), unmodified. The
// ACCEPT cases are the corrected equivalents a well-behaved agent should
// produce from the same discovery.
//
//   npm test

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDiscoveredBehavior,
  validateRequirementsAnalysis,
  validateTestCases,
  formatSemanticErrors,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
  type SemanticError,
  type TestCases,
} from '../src/lib/semantic-validate.ts';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bad-run-2026-09-21');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;

const discovery = load<DiscoveredBehavior>('discovered-behavior');
const badRequirements = load<RequirementsAnalysis>('requirements-analysis');
const badTestCases = load<TestCases>('test-cases');

/** Corrected analysis of the same discovery: every point cites the behavior that actually says it. */
const goodRequirements: RequirementsAnalysis = {
  feature: 'Authentication',
  acceptancePoints: [
    { id: 'AC-1', statement: 'The Login button is disabled while no credentials are entered', evidenceIds: ['BEH-1'] },
    { id: 'AC-2', statement: 'Submitting invalid credentials shows an error message', evidenceIds: ['BEH-2'] },
    { id: 'AC-3', statement: 'After a successful login the notes area becomes editable', evidenceIds: ['BEH-3'] },
  ],
  businessRules: [],
  openQuestions: [
    { id: 'OQ-1', question: 'What exact text does the invalid-credentials error message show?', impact: 'Needed for exact assertions' },
    { id: 'OQ-2', question: 'Is there a password reset flow?', impact: 'Unknown; not observed' },
  ],
  risks: [{ area: 'Authentication', probability: 'medium', impact: 'high', rationale: 'Login gates access to notes' }],
};

/** Corrected test cases: placeholders for unknown data, lineage to acceptance points, unknowns as questions. */
const goodTestCases: TestCases = {
  feature: 'Authentication',
  testCases: [
    {
      id: 'TC-1',
      title: 'Invalid credentials show an error message',
      evidenceIds: ['AC-2'],
      priority: 'P1',
      types: ['negative'],
      preconditions: ['Requires configured test credentials', 'The user is logged out'],
      testData: { username: 'VALID_USERNAME', password: 'INVALID_PASSWORD' },
      steps: [
        { action: 'Enter VALID_USERNAME and INVALID_PASSWORD and submit the login form', expected: 'An error message is displayed' },
      ],
      expectedResult: 'An error message is displayed and the user is not logged in',
      automationCandidate: true,
      automationReason: 'Deterministic negative path with an observable error',
      tags: ['auth', 'negative'],
    },
    {
      id: 'TC-2',
      title: 'Login button is disabled with empty credentials',
      evidenceIds: ['AC-1'],
      priority: 'P1',
      types: ['validation'],
      preconditions: ['The user is logged out'],
      testData: { username: '', password: '' },
      steps: [
        { action: 'Leave the username and password fields empty', expected: 'The Login button is disabled' },
      ],
      expectedResult: 'The Login button stays disabled while no credentials are entered',
      automationCandidate: true,
      automationReason: 'Pure UI state check',
      tags: ['auth', 'validation'],
    },
    {
      id: 'TC-3',
      title: 'Successful login makes the notes area editable',
      evidenceIds: ['AC-3'],
      priority: 'P0',
      types: ['positive'],
      preconditions: ['Requires configured test credentials'],
      testData: { username: 'VALID_USERNAME', password: 'VALID_PASSWORD' },
      steps: [
        { action: 'Log in with VALID_USERNAME and VALID_PASSWORD', expected: 'Login succeeds' },
        { action: 'Inspect the notes area', expected: 'The notes area is editable' },
      ],
      expectedResult: 'The notes area becomes editable after login',
      automationCandidate: true,
      automationReason: 'Core happy path',
      tags: ['auth', 'smoke'],
    },
  ],
  openQuestions: [
    'What exact wording does the invalid-credentials error use?',
    'Is there a password reset flow? None was observed.',
    'Is there an account lockout after repeated failures?',
  ],
};

const codes = (errors: SemanticError[]) => errors.map((e) => e.code);
const find = (errors: SemanticError[], code: string, value?: string) =>
  errors.find((e) => e.code === code && (value === undefined || e.value === value));

// ---------------------------------------------------------------------------

describe('discovered-behavior (the real one from the bad run)', () => {
  it('is internally consistent — discovery was not the problem', () => {
    assert.deepEqual(validateDiscoveredBehavior(discovery), []);
  });

  it('rejects a behavior in an undeclared area, and a question linked to a missing behavior', () => {
    const broken = structuredClone(discovery);
    broken.behaviors[0].area = 'Billing';
    broken.openQuestions[0].relatedBehaviorIds = ['BEH-99'];
    const errors = validateDiscoveredBehavior(broken);
    assert.ok(find(errors, 'UNKNOWN_AREA', 'Billing'));
    assert.ok(find(errors, 'UNKNOWN_EVIDENCE_ID', 'BEH-99'));
  });
});

describe('REJECT: requirements-analysis from the bad run', () => {
  const errors = validateRequirementsAnalysis(discovery, badRequirements);

  it('rejects AC-2 citing an unrelated behavior (evidence exists but says nothing about the claim)', () => {
    const e = errors.find((x) => x.code === 'EVIDENCE_MISMATCH' && x.path === 'acceptancePoints[1].statement');
    assert.ok(e, `expected EVIDENCE_MISMATCH on AC-2, got ${codes(errors)}`);
  });

  it('rejects "missing password field" in an open question — discovery observed one', () => {
    const e = errors.find((x) => x.code === 'CONTRADICTS_UPSTREAM' && x.path === 'openQuestions[1].question');
    assert.ok(e);
    assert.match(e.details ?? '', /password field/);
  });

  it('rejects "missing password field" in a risk rationale too', () => {
    assert.ok(errors.find((x) => x.code === 'CONTRADICTS_UPSTREAM' && x.path === 'risks[1].rationale'));
  });

  it('rejects "Sign In does not trigger authentication" — discovery saw invalid credentials produce an error', () => {
    const e = errors.find((x) => x.code === 'CONTRADICTS_UPSTREAM' && x.path === 'openQuestions[0].question');
    assert.ok(e);
    assert.match(e.details ?? '', /BEH-2/);
  });
});

describe('REJECT: test-cases from the bad run', () => {
  const errors = validateTestCases(discovery, goodRequirements, badTestCases);

  for (const id of ['RA001', 'RA002', 'RA003']) {
    it(`rejects invented evidence ID ${id}`, () => {
      assert.ok(find(errors, 'UNKNOWN_EVIDENCE_ID', id));
    });
  }

  it('rejects /dashboard when discovery never saw it', () => {
    assert.ok(find(errors, 'UNSUPPORTED_FACT', '/dashboard'));
    assert.ok(find(errors, 'UNSUPPORTED_FACT', 'dashboard'), 'the word "dashboard" is a feature claim too');
  });

  it('rejects /login — discovery only visited http://localhost:4444/', () => {
    assert.ok(find(errors, 'UNSUPPORTED_FACT', '/login'));
  });

  it('rejects "Forgot password" and the whole invented password-reset flow', () => {
    assert.ok(find(errors, 'UNSUPPORTED_FACT', 'Forgot password'));
    assert.ok(find(errors, 'UNSUPPORTED_FACT', 'Reset link sent to email'));
    assert.ok(errors.some((e) => e.code === 'UNSUPPORTED_FACT' && /reset/i.test(e.value ?? '')));
  });

  it('rejects the fabricated credentials', () => {
    assert.ok(find(errors, 'FABRICATED_CREDENTIAL', 'user@example.com'));
    assert.ok(find(errors, 'FABRICATED_CREDENTIAL', 'Passw0rd!'));
    assert.ok(find(errors, 'FABRICATED_CREDENTIAL', 'wrongpassword'));
  });

  it('rejects quoting exact error text discovery never recorded', () => {
    assert.ok(find(errors, 'UNSUPPORTED_FACT', 'Invalid credentials'));
  });

  it('rejects "requires email verification" — no evidence of email verification', () => {
    assert.ok(errors.some((e) => e.code === 'UNSUPPORTED_FACT' && e.path.endsWith('automationReason')));
  });

  it('produces an error report compact and actionable enough for an 8192-token model', () => {
    const report = formatSemanticErrors('test-cases', errors);
    assert.ok(report.length < 4000, `report is ${report.length} chars`);
    assert.match(report, /RA001/);
    assert.match(report, /VALID_USERNAME|placeholder/);
    assert.match(report, /nothing was written/);
  });
});

describe('REJECT: other evidence misuse', () => {
  it('rejects citing a discovery open question as evidence', () => {
    const reqs = structuredClone(goodRequirements);
    reqs.acceptancePoints[0].evidenceIds = ['OQ-1'];
    assert.ok(find(validateRequirementsAnalysis(discovery, reqs), 'NOT_EVIDENCE', 'OQ-1'));
  });

  it('rejects an acceptance point with no evidence at all', () => {
    const reqs = structuredClone(goodRequirements);
    reqs.acceptancePoints[0].evidenceIds = [];
    assert.ok(validateRequirementsAnalysis(discovery, reqs).some((e) => e.code === 'MISSING_EVIDENCE'));
  });

  it('rejects turning a suspected issue into a requirement', () => {
    const d = structuredClone(discovery);
    d.behaviors[1].suspectedIssue = true;
    const reqs: RequirementsAnalysis = {
      ...structuredClone(goodRequirements),
      acceptancePoints: [{ id: 'AC-1', statement: 'Invalid credentials show an error message', evidenceIds: ['BEH-2'] }],
    };
    assert.ok(validateRequirementsAnalysis(d, reqs).some((e) => e.code === 'NOT_EVIDENCE'));
  });

  it('rejects a test citing an open question', () => {
    const tcs = structuredClone(goodTestCases);
    tcs.testCases[0].evidenceIds = ['OQ-2'];
    assert.ok(find(validateTestCases(discovery, goodRequirements, tcs), 'NOT_EVIDENCE', 'OQ-2'));
  });
});

// ---------------------------------------------------------------------------

describe('ACCEPT: grounded equivalents from the same discovery', () => {
  it('accepts requirements that cite the behaviors that actually support them', () => {
    assert.deepEqual(validateRequirementsAnalysis(discovery, goodRequirements), []);
  });

  it('accepts a negative login test based on the observed invalid-credentials error', () => {
    const only = { ...goodTestCases, testCases: [goodTestCases.testCases[0]] };
    assert.deepEqual(validateTestCases(discovery, goodRequirements, only), []);
  });

  it('accepts a disabled-login-button test with empty credentials', () => {
    const only = { ...goodTestCases, testCases: [goodTestCases.testCases[1]] };
    assert.deepEqual(validateTestCases(discovery, goodRequirements, only), []);
  });

  it('accepts generic placeholders for unknown credentials', () => {
    const only = { ...goodTestCases, testCases: [goodTestCases.testCases[2]] };
    assert.deepEqual(validateTestCases(discovery, goodRequirements, only), []);
  });

  it('accepts open questions about unobserved features — that is where unknowns belong', () => {
    // "password reset" and "lockout" are rejected inside a test case but allowed as questions.
    assert.deepEqual(validateTestCases(discovery, goodRequirements, goodTestCases), []);
  });

  it('accepts tests citing behaviors directly, not only acceptance points', () => {
    const tcs = structuredClone(goodTestCases);
    tcs.testCases[0].evidenceIds = ['BEH-2'];
    assert.deepEqual(validateTestCases(discovery, goodRequirements, tcs), []);
  });

  it('does not misread an apostrophe as a quote', () => {
    const tcs = structuredClone(goodTestCases);
    tcs.testCases[2].expectedResult = "The user's notes area becomes editable after login";
    assert.deepEqual(validateTestCases(discovery, goodRequirements, tcs), []);
  });

  it('does not misread "username/password" as a route', () => {
    const tcs = structuredClone(goodTestCases);
    tcs.testCases[1].steps[0].action = 'Leave the username/password fields empty';
    assert.deepEqual(validateTestCases(discovery, goodRequirements, tcs), []);
  });

  it('allows a no-effect claim scoped to a state (empty credentials)', () => {
    const tcs = structuredClone(goodTestCases);
    tcs.testCases[1].expectedResult = 'Clicking Login does nothing when the credentials are empty';
    assert.deepEqual(validateTestCases(discovery, goodRequirements, tcs), []);
  });
});

// ---------------------------------------------------------------------------

describe('integration: write_qa_artifact enforces it', () => {
  let root: string;
  let qa: typeof import('../src/lib/qa-artifacts.ts');

  before(async () => {
    // QA_ARTIFACT_ROOT is resolved at module load, so set it before importing.
    root = mkdtempSync(join(tmpdir(), 'qa-semantic-'));
    process.env.QA_ARTIFACT_ROOT = root;
    qa = await import('../src/lib/qa-artifacts.ts');
    writeFileSync(join(root, 'discovered-behavior.json'), JSON.stringify(discovery));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('refuses the bad requirements-analysis and writes nothing', () => {
    assert.throws(() => qa.writeQaArtifact('requirements-analysis', badRequirements), qa.SemanticValidationError);
    assert.equal(existsSync(join(root, 'requirements-analysis.json')), false);
  });

  it('refuses test cases while requirements-analysis is missing', () => {
    assert.throws(
      () => qa.writeQaArtifact('test-cases', goodTestCases),
      (e: unknown) => e instanceof qa.SemanticValidationError && e.errors[0].code === 'MISSING_UPSTREAM',
    );
  });

  it('refuses test cases built on a stale requirements-analysis — the bad run\'s exact situation', () => {
    writeFileSync(join(root, 'requirements-analysis.json'), JSON.stringify(badRequirements));
    assert.throws(
      () => qa.writeQaArtifact('test-cases', goodTestCases),
      (e: unknown) => e instanceof qa.SemanticValidationError && e.errors[0].code === 'UPSTREAM_INVALID',
    );
  });

  it('writes the grounded chain end to end', () => {
    qa.writeQaArtifact('requirements-analysis', goodRequirements);
    qa.writeQaArtifact('test-cases', goodTestCases);
    assert.equal(existsSync(join(root, 'test-cases.json')), true);
  });

  it('refuses the bad test cases even with valid upstream, and keeps the good file', () => {
    assert.throws(() => qa.writeQaArtifact('test-cases', badTestCases), qa.SemanticValidationError);
    const onDisk = JSON.parse(readFileSync(join(root, 'test-cases.json'), 'utf8')) as TestCases;
    assert.equal(onDisk.testCases[0].id, 'TC-1', 'a rejected write must not overwrite the previous artifact');
  });
});
