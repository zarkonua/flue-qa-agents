// Phase 1 end-state and the human approval gate.
//
//   npm test
//
// Every invariant here is enforced in host code or by a tool's input schema —
// none of it depends on a model following instructions.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  summarize,
  validateAutomationPrioritization,
  validateTestCasesReview,
  type AutomationPrioritization,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
  type TestCases,
  type TestCasesReview,
} from '../src/lib/semantic-validate.ts';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bad-run-2026-09-21');
const discovery = JSON.parse(readFileSync(join(FIXTURES, 'discovered-behavior.json'), 'utf8')) as DiscoveredBehavior;

const requirements: RequirementsAnalysis = {
  feature: 'Authentication',
  acceptancePoints: [
    { id: 'AC-1', statement: 'The Login button is disabled while no credentials are entered', evidenceIds: ['BEH-1'] },
    { id: 'AC-2', statement: 'Submitting invalid credentials shows an error message', evidenceIds: ['BEH-2'] },
  ],
  businessRules: [],
  openQuestions: [],
  risks: [],
};

const tc = (id: string, evidence: string, title: string, expected: string) => ({
  id,
  title,
  evidenceIds: [evidence],
  priority: 'P1',
  types: ['negative'],
  preconditions: ['Requires configured test credentials'],
  testData: { username: 'VALID_USERNAME', password: 'INVALID_PASSWORD' },
  steps: [{ action: 'Submit the login form with INVALID_PASSWORD', expected }],
  expectedResult: expected,
  automationCandidate: true,
  automationReason: 'Deterministic',
  tags: ['auth'],
});

const testCases: TestCases = {
  feature: 'Authentication',
  testCases: [
    tc('TC-1', 'AC-2', 'Invalid credentials show an error message', 'An error message is displayed'),
    tc('TC-2', 'AC-1', 'Login button is disabled with empty credentials', 'The Login button is disabled'),
    tc('TC-3', 'AC-2', 'Error message wording is clear to a user', 'An error message is displayed'),
  ],
  openQuestions: [],
};

const prioritization: AutomationPrioritization = {
  cases: [
    { testCaseId: 'TC-1', executionMode: 'AUTOMATION', automationPriority: 'HIGH', reason: 'Deterministic negative path', blockingFactors: [] },
    { testCaseId: 'TC-2', executionMode: 'AUTOMATION', automationPriority: 'MEDIUM', reason: 'Pure UI state', blockingFactors: [] },
    { testCaseId: 'TC-3', executionMode: 'MANUAL', automationPriority: 'NONE', reason: 'Clarity is a human judgement', blockingFactors: ['subjective judgement'] },
  ],
};

const clone = <T>(x: T): T => structuredClone(x);

// QA_ARTIFACT_ROOT is read once, when qa-artifacts.ts first loads, and every
// module that imports it shares that value. So the whole file uses one root,
// set before anything imports it.
const ROOT = mkdtempSync(join(tmpdir(), 'qa-phase1-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
const has = (errors: { code: string; value?: string }[], code: string, value?: string) =>
  errors.some((e) => e.code === code && (value === undefined || e.value === value));

// ---------------------------------------------------------------------------

describe('automation-prioritization invariants', () => {
  const check = (p: AutomationPrioritization) => validateAutomationPrioritization(testCases, p, discovery, requirements);

  it('accepts one well-formed entry per test case', () => {
    assert.deepEqual(check(prioritization), []);
  });

  it('keeps product priority and automation priority separate (P1 + MANUAL is fine)', () => {
    assert.equal(testCases.testCases[2].priority, 'P1');
    assert.deepEqual(check(prioritization), []);
  });

  it('rejects an entry for a test case that does not exist', () => {
    const p = clone(prioritization);
    p.cases[0].testCaseId = 'TC-99';
    assert.ok(has(check(p), 'UNKNOWN_TEST_CASE', 'TC-99'));
  });

  it('rejects a dropped test case — manual cases may not disappear', () => {
    const p = clone(prioritization);
    p.cases.pop();
    assert.ok(has(check(p), 'MISSING_PRIORITIZATION', 'TC-3'));
  });

  it('rejects two entries for one test case', () => {
    const p = clone(prioritization);
    p.cases.push({ ...p.cases[0] });
    assert.ok(has(check(p), 'DUPLICATE_PRIORITIZATION', 'TC-1'));
  });

  it('rejects MANUAL with HIGH automation priority', () => {
    const p = clone(prioritization);
    p.cases[2].automationPriority = 'HIGH';
    assert.ok(has(check(p), 'INCONSISTENT_PRIORITY', 'MANUAL/HIGH'));
  });

  it('rejects AUTOMATION with NONE', () => {
    const p = clone(prioritization);
    p.cases[0].automationPriority = 'NONE';
    assert.ok(has(check(p), 'INCONSISTENT_PRIORITY', 'AUTOMATION/NONE'));
  });

  it('permits MANUAL with LOW/MEDIUM — the spec forbids only MANUAL/HIGH', () => {
    const p = clone(prioritization);
    p.cases[2].automationPriority = 'LOW';
    assert.deepEqual(check(p), []);
  });

  it('rejects an invented route inside a reason', () => {
    const p = clone(prioritization);
    p.cases[0].reason = 'Covers the /admin page';
    assert.ok(has(check(p), 'UNSUPPORTED_FACT', '/admin'));
  });

  it('summarizes counts from the prioritization alone', () => {
    assert.deepEqual(summarize(prioritization), {
      total: 3, manual: 1, automation: 2, automationHigh: 1, automationMedium: 1, automationLow: 0,
    });
  });
});

describe('test-cases-review invariants', () => {
  const good: TestCasesReview = {
    status: 'CHANGES_REQUESTED',
    issues: [{ testCaseId: 'TC-3', severity: 'MINOR', category: 'clarity', message: 'Expected result is vague' }],
    suggestedChanges: [{ testCaseId: 'SUITE', field: 'testCases', change: 'Add a blank-username case', rationale: 'Boundary of BEH-1' }],
    summary: summarize(prioritization),
  };
  const check = (r: TestCasesReview) => validateTestCasesReview(testCases, prioritization, r);

  it('accepts a review that references real test cases and true counts', () => {
    assert.deepEqual(check(good), []);
  });

  it('rejects references to test cases that do not exist', () => {
    const r = clone(good);
    r.issues[0].testCaseId = 'TC-42';
    assert.ok(has(check(r), 'UNKNOWN_TEST_CASE', 'TC-42'));
  });

  it('rejects a wrong summary and states the correct numbers', () => {
    const r = clone(good);
    r.summary.automation = 20;
    const errors = check(r);
    assert.ok(has(errors, 'SUMMARY_MISMATCH', '20'));
    assert.match(errors.find((e) => e.code === 'SUMMARY_MISMATCH')!.details!, /automation = 2/);
  });

  it('rejects APPROVED while a MAJOR issue is listed', () => {
    const r = clone(good);
    r.status = 'APPROVED';
    r.issues[0].severity = 'MAJOR';
    assert.ok(has(check(r), 'INCONSISTENT_STATUS', 'APPROVED'));
  });

  it('rejects CHANGES_REQUESTED with nothing requested', () => {
    const r = clone(good);
    r.issues = [];
    r.suggestedChanges = [];
    assert.ok(has(check(r), 'INCONSISTENT_STATUS', 'CHANGES_REQUESTED'));
  });
});

// ---------------------------------------------------------------------------

describe('write restriction is enforced by the tool, not the prompt', () => {
  let tools: typeof import('../src/tools/qa-artifacts.ts');
  before(async () => {
    tools = await import('../src/tools/qa-artifacts.ts');
  });

  for (const [role, own] of [
    ['Test Case Reviewer', 'test-cases-review'],
    ['Automation Prioritizer', 'automation-prioritization'],
  ] as const) {
    it(`${role} cannot write test-cases`, () => {
      const tool = tools.writeQaArtifactToolFor([own]);
      assert.equal(v.safeParse(tool.input!, { name: 'test-cases', data: {} }).success, false);
      assert.equal(v.safeParse(tool.input!, { name: own, data: {} }).success, true);
    });
  }

  it('no agent tool can name the approval file at all', () => {
    const tool = tools.writeQaArtifactTool;
    assert.equal(v.safeParse(tool.input!, { name: 'phase1-approval', data: {} }).success, false);
  });
});

// ---------------------------------------------------------------------------

describe('human approval gate', () => {
  const root = ROOT;
  let gate: typeof import('../src/lib/phase1-gate.ts');

  const write = (name: string, data: unknown) => writeFileSync(join(root, `${name}.json`), JSON.stringify(data, null, 2));
  const writeAll = () => {
    write('discovered-behavior', discovery);
    write('requirements-analysis', requirements);
    write('test-cases', testCases);
    write('automation-prioritization', prioritization);
  };

  before(async () => {
    gate = await import('../src/lib/phase1-gate.ts');
  });
  beforeEach(() => {
    // Fresh, empty artifact root for every test.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('refuses Phase 2 with no approval, with the operator message', () => {
    writeAll();
    const result = gate.checkPhase2Gate();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'NOT_APPROVED');
    assert.match(!result.ok ? result.message : '', /Phase 1 is not approved\.\nReview\/edit the test cases and run:\nnpm run qa:approve/);
  });

  it('refuses to approve an incomplete Phase 1', () => {
    write('test-cases', testCases);
    const result = gate.approvePhase1();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'INCOMPLETE');
  });

  it('approves, records hashes of the exact bytes, and opens the gate', () => {
    writeAll();
    const approved = gate.approvePhase1();
    assert.equal(approved.ok, true);
    const record = JSON.parse(readFileSync(gate.APPROVAL_PATH, 'utf8'));
    assert.equal(record.status, 'APPROVED');
    assert.equal(record.testCasesSha256, gate.sha256Of('test-cases'));
    assert.equal(record.automationPrioritizationSha256, gate.sha256Of('automation-prioritization'));
    const opened = gate.checkPhase2Gate();
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.ok && opened.automationCases.map((c) => c.testCaseId), ['TC-1', 'TC-2']);
  });

  it('goes stale when test-cases.json changes after approval — even whitespace', () => {
    writeAll();
    gate.approvePhase1();
    writeFileSync(join(root, 'test-cases.json'), JSON.stringify(testCases)); // same data, different bytes
    const result = gate.checkPhase2Gate();
    assert.equal(!result.ok && result.code, 'STALE');
    assert.deepEqual(!result.ok && result.changed, ['test-cases.json']);
    assert.match(!result.ok ? result.message : '', /Phase 1 approval is stale because the approved artifacts changed\.\n.*\nReview and approve again\./);
  });

  it('goes stale when the prioritization changes after approval', () => {
    writeAll();
    gate.approvePhase1();
    const p = clone(prioritization);
    p.cases[1].automationPriority = 'LOW';
    write('automation-prioritization', p);
    const result = gate.checkPhase2Gate();
    assert.equal(!result.ok && result.code, 'STALE');
    assert.deepEqual(!result.ok && result.changed, ['automation-prioritization.json']);
  });

  it('refuses Phase 2 when nothing is marked AUTOMATION', () => {
    writeAll();
    const allManual: AutomationPrioritization = {
      cases: prioritization.cases.map((c) => ({ ...c, executionMode: 'MANUAL', automationPriority: 'NONE' })),
    };
    write('automation-prioritization', allManual);
    gate.approvePhase1();
    assert.equal((gate.checkPhase2Gate() as { code: string }).code, 'NOTHING_TO_AUTOMATE');
  });

  it('never approves a structurally broken result, even with --accept-findings', () => {
    writeAll();
    const p = clone(prioritization);
    p.cases.pop(); // TC-3 dropped
    write('automation-prioritization', p);
    const result = gate.approvePhase1({ acceptFindings: true });
    assert.equal(!result.ok && result.reason, 'INVALID');
  });

  it('blocks on semantic findings from a hand edit, unless the operator accepts them — and records them', () => {
    writeAll();
    const edited = clone(testCases);
    edited.testCases[0].steps[0].expected = 'The user is sent to /settings';
    write('test-cases', edited);

    const refused = gate.approvePhase1();
    assert.equal(!refused.ok && refused.reason, 'FINDINGS');

    const accepted = gate.approvePhase1({ acceptFindings: true });
    assert.equal(accepted.ok, true);
    assert.ok(accepted.ok && accepted.approval.acceptedFindings.some((f) => f.value === '/settings'));
  });
});
