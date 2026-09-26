// Evidence-grounded defect analysis and bug reports.
//
//   npm test
//
// A small synthetic product whose evidence has every shape the rules care
// about: a rule the product states on screen, a requirement the run was given,
// suspected issues, an inference, and a mailbox that is test infrastructure.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The artifact root is resolved once, at import: set it before anything loads.
const ROOT = mkdtempSync(join(tmpdir(), 'qa-defects-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
process.env.QA_DISCOVERY_AUX_ORIGINS = 'http://localhost:8025';

const {
  buildBugReports,
  defectMetrics,
  duplicateDefects,
  expectedBasisOf,
  normaliseDefectAnalysis,
  validateBugReport,
  validateDefectAnalysis,
} = await import('../src/lib/defects.ts');
type DefectFinding = import('../src/lib/defects.ts').DefectFinding;
type DefectContext = import('../src/lib/defects.ts').DefectContext;
const qa = await import('../src/lib/qa-artifacts.ts');
const { validateTestCasesReview } = await import('../src/lib/semantic-validate.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const APP = 'http://localhost:4444';
const MAIL = 'http://localhost:8025';

const discovery = {
  product: 'Notes Console',
  locations: [{ url: `${APP}/notes`, status: 'EXPLORED' as const }],
  areas: [
    { name: 'Notes', routes: [`${APP}/notes`], notes: [] },
    { name: 'Mailbox', routes: [`${MAIL}/`], notes: [] },
  ],
  behaviors: [
    { id: 'BEH-1', area: 'Notes', statement: "The Title field shows the hint 'Title must be at least 3 characters'.", status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false },
    { id: 'BEH-2', area: 'Notes', statement: "Saving a note with a 1-character Title creates the note and shows 'Note created.'", status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: true },
    { id: 'BEH-3', area: 'Notes', statement: 'Submitting with an empty Title creates no note and shows no validation message.', status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: true },
    { id: 'BEH-4', area: 'Notes', statement: "Submitting with empty Content shows the message 'Content is required.'", status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false },
    { id: 'BEH-5', area: 'Notes', statement: 'Notes are probably sorted by title.', status: 'INFERRED' as const, source: ['browser snapshot'], confidence: 'low' as const, suspectedIssue: false },
    { id: 'BEH-6', area: 'Mailbox', statement: 'The mailbox list shows no confirmation mail after sign up.', status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false },
    { id: 'BEH-7', area: 'Notes', statement: 'A saved note remains listed after the page is reloaded.', status: 'CONFIRMED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false },
    { id: 'BEH-8', area: 'Notes', statement: 'After reloading the page, a note saved moments earlier is no longer listed.', status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: true },
    { id: 'BEH-9', area: 'Notes', statement: 'Reloading the Notes page drops the most recently saved note from the list.', status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false },
  ],
  openQuestions: [{ id: 'OQ-1', question: 'Is there a title length limit?', relatedBehaviorIds: ['BEH-1'], impact: 'low' }],
  conflicts: [],
};

const requirements = {
  feature: 'Notes',
  acceptancePoints: [
    { id: 'AP-1', statement: 'The Title must be at least 3 characters.', evidenceIds: ['BEH-1'] },
    { id: 'AP-2', statement: "Submitting with empty Content shows the message 'Content is required.'", evidenceIds: ['BEH-4'] },
    { id: 'AP-3', statement: 'A saved note remains listed after the page is reloaded.', evidenceIds: ['BEH-7'] },
  ],
  businessRules: [{ id: 'BR-1', statement: 'Notes are listed.', evidenceIds: ['BEH-9'] }],
  openQuestions: [],
  risks: [],
};

const tc = (id: string, covers: string[], title: string) => ({
  id, title, evidenceIds: [], covers, preconditions: [], testData: {}, steps: [{ action: 'Open the Notes page', expected: 'The list is shown' }],
  expectedResult: title, automationReason: '', priority: 'P1', types: ['positive'], automationCandidate: false, tags: [],
});
const testCases = {
  feature: 'Notes',
  testCases: [tc('TC-1', ['AP-1'], 'Title shorter than 3 characters is rejected'), tc('TC-2', ['AP-3'], 'Saved note survives reload'), tc('TC-3', ['AP-3'], 'Several saved notes survive reload')],
  openQuestions: [],
};

const ctx: DefectContext = { discovery, requirements, testCases, auxiliaryOrigins: [MAIL] };

/** Findings that account for every suspected issue, plus whatever a test adds. */
const base = (): DefectFinding[] => [
  {
    id: 'DEF-001', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: ['BEH-2'], sourceAcceptancePointIds: ['AP-1'], sourceTestCaseIds: ['TC-1'],
    reason: 'The product states a minimum title length and then accepts a shorter one.',
    title: 'A 1-character title is accepted despite the stated minimum', severity: 'MINOR',
    steps: ['Open the Notes page', 'Enter a 1-character Title', 'Save the note'],
    expected: 'The Title must be at least 3 characters; a shorter one is rejected.',
    actual: 'A note with a 1-character Title is created and a success message is shown.',
  },
  {
    id: 'DEF-002', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-3'],
    reason: 'An empty Content gets a message; an empty Title gets none. Nothing states that it should.',
    title: 'Empty Title gives no validation feedback', severity: 'MINOR',
    steps: ['Open the Notes page', 'Leave the Title empty', 'Submit'],
    expected: 'A validation message explains why no note was created.',
    actual: 'Submitting with an empty Title creates no note and shows no validation message.',
  },
  {
    id: 'DEF-003', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: ['BEH-8', 'BEH-9'], sourceAcceptancePointIds: ['AP-3'], sourceTestCaseIds: ['TC-2', 'TC-3'],
    reason: 'A given requirement says saved notes persist; reloading drops one.',
    title: 'Saved note disappears after page reload', severity: 'MAJOR',
    preconditions: ['VALID_USERNAME is signed in'],
    steps: ['Create a note', 'Save the note', 'Reload the page'],
    expected: 'A saved note remains listed after the page is reloaded.',
    actual: 'After reloading the page, the most recently saved note is no longer listed.',
  },
];

const analysis = (findings: DefectFinding[]) => normaliseDefectAnalysis({ findings }, ctx);
const codes = (errors: { code: string }[]) => [...new Set(errors.map((e) => e.code))].sort();
const errorsFor = (findings: DefectFinding[]) => validateDefectAnalysis(analysis(findings), ctx);
const replace = (id: string, patch: Partial<DefectFinding>) => base().map((f) => (f.id === id ? { ...f, ...patch } : f));

// ---------------------------------------------------------------------------
// Classification and the evidence threshold
// ---------------------------------------------------------------------------

describe('defect classification', () => {
  it('explicit expected + contradictory observed -> CONFIRMED_DEFECT', () => {
    assert.deepEqual(errorsFor(base()), []);
    const a = analysis(base());
    assert.equal(a.findings[0].expectedBasis, 'EVIDENCED_REQUIREMENT', 'the rule is on screen, observed separately from the actual');
    assert.equal(a.findings[2].expectedBasis, 'CONFIRMED_REQUIREMENT', 'a requirement the run was given');
    assert.deepEqual(a.summary, { confirmed: 2, potential: 1, notDefect: 0, insufficientEvidence: 0, bugReports: 3 });
  });

  it('inferred expected + contradictory observed -> POTENTIAL_DEFECT, never CONFIRMED', () => {
    const promoted = replace('DEF-002', { classification: 'CONFIRMED_DEFECT' });
    assert.deepEqual(codes(errorsFor(promoted)), ['UNSUPPORTED_EXPECTED']);
    // A requirement that only restates the actual behavior is not an expectation.
    const circular = [...base(), {
      id: 'DEF-004', classification: 'CONFIRMED_DEFECT' as const, sourceBehaviorIds: ['BEH-4'], sourceAcceptancePointIds: ['AP-2'],
      reason: 'r', title: 't', severity: 'MINOR' as const, steps: ['Submit with empty Content'],
      expected: 'Submitting with empty Content succeeds.', actual: 'Submitting with empty Content shows a message.',
    }];
    assert.equal(expectedBasisOf(circular[3], ctx), 'INFERRED');
    assert.ok(codes(errorsFor(circular)).includes('UNSUPPORTED_EXPECTED'));
  });

  it('no contradiction -> NOT_A_DEFECT, which carries no bug report', () => {
    const findings = [...base(), { id: 'DEF-004', classification: 'NOT_A_DEFECT' as const, sourceBehaviorIds: ['BEH-4'], sourceAcceptancePointIds: ['AP-2'], reason: 'Behaves as stated.' }];
    assert.deepEqual(errorsFor(findings), []);
    const a = analysis(findings);
    assert.equal(a.findings[3].bugReportId, undefined);
    assert.equal(a.summary!.notDefect, 1);
    // A NOT_A_DEFECT dressed up as a bug is refused.
    const dressed = [...base(), { ...findings[3], title: 'x', steps: ['y'] }];
    assert.deepEqual(codes(errorsFor(dressed)), ['INCOMPLETE_DEFECT']);
  });

  it('missing expected evidence / no observed actual -> INSUFFICIENT_EVIDENCE', () => {
    const inferredOnly = { id: 'DEF-004', sourceBehaviorIds: ['BEH-5'], reason: 'Only an inference.' };
    const asPotential = [...base(), { ...inferredOnly, classification: 'POTENTIAL_DEFECT' as const, title: 't', severity: 'TRIVIAL' as const, steps: ['s'], expected: 'Sorted by title.', actual: 'Notes are probably sorted by title.' }];
    assert.ok(codes(errorsFor(asPotential)).includes('UNOBSERVED_ACTUAL'));
    assert.deepEqual(errorsFor([...base(), { ...inferredOnly, classification: 'INSUFFICIENT_EVIDENCE' as const }]), []);
  });

  it('a defect needs its bug report fields', () => {
    const bare = replace('DEF-002', { title: undefined, steps: [], expected: '  ' });
    const errors = errorsFor(bare);
    assert.deepEqual(codes(errors), ['INCOMPLETE_DEFECT']);
    assert.match(errors[0].value ?? '', /title, steps, expected/);
  });

  it('every suspected issue is accounted for', () => {
    const errors = errorsFor(base().filter((f) => f.id !== 'DEF-002'));
    assert.deepEqual(codes(errors), ['UNANALYZED_SUSPECTED_ISSUE']);
    assert.equal(errors[0].value, 'BEH-3');
  });
});

describe('defect evidence lineage', () => {
  it('rejects unknown evidence ids, and open questions as evidence', () => {
    const errors = errorsFor(replace('DEF-001', { sourceBehaviorIds: ['BEH-2', 'BEH-99'], sourceAcceptancePointIds: ['AP-99'], sourceTestCaseIds: ['TC-99'] }));
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_EVIDENCE_ID' && e.value === 'BEH-99'));
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_EVIDENCE_ID' && e.value === 'AP-99'));
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_TEST_CASE' && e.value === 'TC-99'));
    const question = errorsFor(replace('DEF-001', { sourceBehaviorIds: ['BEH-2', 'OQ-1'] }));
    assert.ok(question.some((e) => e.code === 'NOT_EVIDENCE' && e.value === 'OQ-1'));
  });

  it('rejects a fabricated route, message, feature or credential', () => {
    const errors = errorsFor(replace('DEF-001', {
      steps: ['Open /admin/notes', "Enter the password 'hunter22'", 'Save the note'],
      actual: "The note is created and the message 'Title accepted anyway' is shown.",
      expected: 'The Title must be at least 3 characters, as the dashboard explains.',
    }));
    const values = errors.map((e) => `${e.code}:${e.value}`);
    assert.ok(values.includes('UNSUPPORTED_FACT:/admin/notes'), values.join('\n'));
    assert.ok(values.includes('UNSUPPORTED_FACT:Title accepted anyway'), values.join('\n'));
    assert.ok(values.includes('UNSUPPORTED_FACT:dashboard'), values.join('\n'));
    assert.ok(values.includes('FABRICATED_CREDENTIAL:hunter22'), values.join('\n'));
  });

  it('the actual must be what the cited behavior says, the expected what the requirement says', () => {
    const errors = errorsFor(replace('DEF-001', { actual: 'Unrelated widgets flicker.', expected: 'Graphs render quickly.' }));
    assert.ok(errors.some((e) => e.code === 'EVIDENCE_MISMATCH' && e.path.endsWith('.actual')));
    assert.ok(errors.some((e) => e.code === 'EVIDENCE_MISMATCH' && e.path.endsWith('.expected')));
  });

  it('auxiliary-origin behavior cannot become a product bug by itself', () => {
    const aux = [...base(), {
      id: 'DEF-004', classification: 'POTENTIAL_DEFECT' as const, sourceBehaviorIds: ['BEH-6'], reason: 'The mail did not arrive.',
      title: 'Confirmation mail missing', severity: 'MAJOR' as const, steps: ['Sign up', 'Open the mailbox'],
      expected: 'A confirmation mail is listed.', actual: 'The mailbox list shows no confirmation mail.',
    }];
    assert.ok(codes(errorsFor(aux)).includes('AUXILIARY_AS_PRODUCT'));
    // …but it may support a product finding, and appear in its steps.
    const supporting = replace('DEF-001', { steps: [`Open ${MAIL}/ to read the mail`, 'Enter a 1-character Title', 'Save the note'] });
    assert.ok(!codes(errorsFor(supporting)).includes('AUXILIARY_AS_PRODUCT'));
  });

  it('a valid report can reference several behaviors and test cases', () => {
    const [, , bug] = buildBugReports(analysis(base()), ctx, { target: process.env.TARGET_URL! });
    assert.deepEqual(bug.sourceBehaviorIds, ['BEH-8', 'BEH-9']);
    assert.deepEqual(bug.sourceTestCaseIds, ['TC-2', 'TC-3']);
    assert.deepEqual(bug.evidence, [
      { type: 'OBSERVED', sourceId: 'BEH-8' },
      { type: 'OBSERVED', sourceId: 'BEH-9' },
      { type: 'REQUIREMENT', sourceId: 'AP-3' },
      { type: 'TEST_CASE', sourceId: 'TC-2' },
      { type: 'TEST_CASE', sourceId: 'TC-3' },
    ]);
    assert.deepEqual(validateBugReport(bug, ctx), []);
  });
});

describe('duplicate defects', () => {
  it('two findings about the same observed actual collapse into one', () => {
    const twice = [...base(), { ...base()[0], id: 'DEF-004', title: 'Short titles are saved', severity: 'MAJOR' as const }];
    const errors = errorsFor(twice);
    assert.deepEqual(codes(errors), ['DUPLICATE_DEFECT']);
    assert.match(errors[0].details ?? '', /both cite BEH-2/);
  });

  it('"login fails", "sign-in fails", "authentication fails" in one area are one defect', () => {
    const f = (id: string, verb: string, beh: string): DefectFinding => ({
      id, classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: [beh], reason: 'r', title: `${verb} fails for a valid account`, severity: 'BLOCKER',
      steps: ['Submit valid credentials'], expected: `${verb} succeeds for a valid account.`, actual: `${verb} fails for a valid account.`,
    });
    const pairs = duplicateDefects([f('DEF-010', 'Login', 'BEH-2'), f('DEF-011', 'Sign-in', 'BEH-9'), f('DEF-012', 'Authentication', 'BEH-8')], ctx);
    assert.equal(pairs.length, 3, pairs.map((p) => p[2]).join('; '));
    // Different mismatches in the same area are not merged.
    assert.deepEqual(duplicateDefects(base(), ctx), []);
  });
});

// ---------------------------------------------------------------------------
// Artifacts on disk
// ---------------------------------------------------------------------------

describe('defect-analysis and bug report files', () => {
  const put = (name: string, data: unknown) => writeFileSync(join(ROOT, `${name}.json`), JSON.stringify(data, null, 2));
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    put('discovered-behavior', discovery);
    put('requirements-analysis', requirements);
    put('test-cases', testCases);
  });

  it('host fields are recomputed: summary, ids, basis — whatever the model wrote', () => {
    const lying = base().map((f, i) => ({ ...f, bugReportId: `BUG-9${i}9`, expectedBasis: 'CONFIRMED_REQUIREMENT' as const }));
    qa.writeQaArtifact('defect-analysis', { summary: { confirmed: 9, potential: 9, notDefect: 9, insufficientEvidence: 9, bugReports: 9 }, findings: lying });
    const written = qa.readQaArtifact('defect-analysis') as { summary: unknown; bugReports: string[]; findings: DefectFinding[] };
    assert.deepEqual(written.summary, { confirmed: 2, potential: 1, notDefect: 0, insufficientEvidence: 0, bugReports: 3 });
    assert.deepEqual(written.bugReports, ['BUG-001', 'BUG-002', 'BUG-003']);
    assert.equal(written.findings[1].expectedBasis, 'NONE');
    assert.deepEqual(qa.listBugReportIds(), ['BUG-001', 'BUG-002', 'BUG-003']);
    // The file on disk re-validates exactly as the write did.
    assert.deepEqual(qa.semanticErrorsFor('defect-analysis', written), []);
  });

  it('priority defaults to UNASSIGNED and cannot be written by the analyzer', () => {
    qa.writeQaArtifact('defect-analysis', { findings: base() });
    const bug = qa.readBugReport('BUG-001')!;
    assert.equal(bug.priority, 'UNASSIGNED');
    assert.equal(bug.review.decision, 'PENDING');
    assert.deepEqual(bug.environment, { target: 'http://localhost:4444/', browser: 'Chromium' });
    const withPriority = base().map((f) => ({ ...f, priority: 'P0' }));
    assert.throws(() => qa.writeQaArtifact('defect-analysis', { findings: withPriority }), /unexpected property "priority"/);
    // A priority on the file that no person set is refused.
    assert.ok(validateBugReport({ ...bug, priority: 'P1' }, ctx).some((e) => e.path.endsWith('.priority')));
  });

  it('severity is accepted only from the enum', () => {
    const bad = replace('DEF-001', { severity: 'HUGE' as never });
    assert.throws(() => qa.writeQaArtifact('defect-analysis', { findings: bad }), /severity: must be one of/);
    assert.ok(qa.schemaErrorsFor('defect-analysis', { findings: bad }).some((e) => e.includes('severity')));
    // Ids are patterned, and a report needs at least one step.
    assert.ok(qa.schemaErrorsFor('defect-analysis', { findings: [{ ...base()[0], id: 'D1' }] }).some((e) => e.includes('must match pattern')));
    const [bug] = buildBugReports(analysis(base()), ctx, { target: 'http://localhost:4444/' });
    assert.ok(qa.bugReportErrors({ ...bug, steps: [] }).schema.some((e) => e.includes('fewer than 1 items')));
  });

  it('one-time values never reach a bug report or the analysis', () => {
    const leaky = replace('DEF-001', {
      steps: [`Open ${APP}/notes?confirm_code=987654&token=abcdef123456`, 'Enter a 1-character Title', 'Save the note'],
      reason: `Seen after ${MAIL}/api/v1/messages/AbC123dEf456GhI789jKl0=@mailhog.example/download`,
    });
    qa.writeQaArtifact('defect-analysis', { findings: leaky });
    const disk = readFileSync(qa.bugReportPath('BUG-001'), 'utf8') + readFileSync(qa.qaArtifactPath('defect-analysis'), 'utf8');
    for (const secret of ['987654', 'abcdef123456', 'AbC123dEf456GhI789jKl0']) {
      assert.ok(!disk.includes(secret), `persisted ${secret}`);
    }
    assert.match(disk, /confirm_code=<redacted>/);
  });

  it('a rejected write touches nothing, and a rewrite removes reports it no longer makes', () => {
    qa.writeQaArtifact('defect-analysis', { findings: base() });
    assert.equal(qa.listBugReportIds().length, 3);
    const invalid = replace('DEF-002', { classification: 'CONFIRMED_DEFECT' });
    assert.throws(() => qa.writeQaArtifact('defect-analysis', { findings: invalid }), /UNSUPPORTED_EXPECTED/);
    assert.equal(qa.listBugReportIds().length, 3, 'a refused write left the earlier reports alone');
    const fewer = base().map((f) => (f.id === 'DEF-001' ? { id: f.id, classification: 'NOT_A_DEFECT' as const, sourceBehaviorIds: f.sourceBehaviorIds, reason: 'On reflection, fine.' } : f));
    qa.writeQaArtifact('defect-analysis', { findings: fewer });
    assert.deepEqual(qa.listBugReportIds(), ['BUG-001', 'BUG-002']);
    assert.equal(qa.readBugReport('BUG-001')!.origin.findingId, 'DEF-002');
  });

  it('a clean target yields zero reports, and that is a valid result', () => {
    // No suspected issues in this product.
    put('discovered-behavior', { ...discovery, behaviors: discovery.behaviors.map((b) => ({ ...b, suspectedIssue: false })) });
    qa.writeQaArtifact('defect-analysis', { findings: [] });
    assert.deepEqual((qa.readQaArtifact('defect-analysis') as { summary: unknown }).summary, { confirmed: 0, potential: 0, notDefect: 0, insufficientEvidence: 0, bugReports: 0 });
    assert.deepEqual(qa.listBugReportIds(), []);
  });

  it('bug report paths are parameterised by a validated id only', () => {
    for (const bad of ['../x', 'BUG-1', 'BUG-001/../../etc', 'bug-001', 'BUG-001.json']) {
      assert.throws(() => qa.bugReportPath(bad), /Not a bug report id/, bad);
    }
    assert.equal(qa.bugReportPath('BUG-042'), join(ROOT, 'bugs', 'BUG-042.json'));
  });

  it('metrics come from the artifact', () => {
    assert.deepEqual(defectMetrics(analysis(base())), {
      defects_confirmed: 2, defects_potential: 1, defects_not_a_defect: 0, defects_insufficient_evidence: 0, bug_reports_created: 3,
    });
    assert.deepEqual(defectMetrics(undefined), {});
  });
});

// ---------------------------------------------------------------------------
// Human review and approval
// ---------------------------------------------------------------------------

describe('human review of bug reports', () => {
  let review: typeof import('../src/lib/defect-review.ts');
  let gate: typeof import('../src/lib/phase1-gate.ts');
  const put = (name: string, data: unknown) => writeFileSync(join(ROOT, `${name}.json`), JSON.stringify(data, null, 2));
  before(async () => {
    review = await import('../src/lib/defect-review.ts');
    gate = await import('../src/lib/phase1-gate.ts');
  });
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    put('discovered-behavior', discovery);
    put('requirements-analysis', requirements);
    put('test-cases', testCases);
    qa.writeQaArtifact('defect-analysis', { findings: base() });
  });

  it('accept, reject, downgrade and request changes are recorded', () => {
    assert.equal(review.decide('BUG-001', 'accept', { by: 'qa-lead' }).review.decision, 'ACCEPTED');
    assert.equal(review.decide('BUG-002', 'reject', { by: 'qa-lead', note: 'By design.' }).review.decision, 'REJECTED');
    const down = review.decide('BUG-003', 'downgrade', { by: 'qa-lead' });
    assert.equal(down.status, 'POTENTIAL');
    assert.equal(down.review.downgradedFrom, 'CONFIRMED');
    assert.throws(() => review.decide('BUG-003', 'downgrade'), /only a CONFIRMED report/);
    assert.throws(() => review.decide('BUG-003', 'request-changes'), /needs --note/);
    assert.equal(review.decide('BUG-003', 'request-changes', { note: 'Add the reload timing.' }).review.decision, 'CHANGES_REQUESTED');
    assert.equal(qa.readBugReport('BUG-001')!.review.by, 'qa-lead');
  });

  it('title, steps, severity and priority can be edited; an unsupported edit is refused', () => {
    const edited = review.edit('BUG-001', { title: 'Short title accepted', severity: 'MAJOR', priority: 'P2', steps: ['Open the Notes page', 'Save a 1-character Title'] });
    assert.deepEqual(edited.review.editedFields, ['priority', 'severity', 'steps', 'title']);
    assert.deepEqual(validateBugReport(qa.readBugReport('BUG-001')!, ctx), [], 'a human-set priority is valid');
    const before = readFileSync(qa.bugReportPath('BUG-001'), 'utf8');
    assert.throws(() => review.edit('BUG-001', { steps: ['Open /admin/notes'] }), /UNSUPPORTED_FACT/);
    assert.throws(() => review.edit('BUG-001', { severity: 'HUGE' }), /--severity must be one of/);
    assert.equal(readFileSync(qa.bugReportPath('BUG-001'), 'utf8'), before, 'a refused edit changes nothing');
  });

  it('approval shows the defects, does not require zero of them, and goes stale on a later decision', () => {
    put('automation-prioritization', { cases: testCases.testCases.map((t) => ({ testCaseId: t.id, executionMode: 'MANUAL', automationPriority: 'NONE', reason: 'r', blockingFactors: [] })) });
    const state = gate.inspectPhase1();
    assert.deepEqual(state.missing, []);
    assert.equal(state.defects!.bugs.length, 3);
    const approved = gate.approvePhase1({ acceptFindings: true });
    assert.equal(approved.ok, true, JSON.stringify(!approved.ok && approved.state.hard));
    if (!approved.ok) return;
    assert.equal(approved.approval.defects.summary.confirmed, 2);
    assert.deepEqual(approved.approval.defects.reports.map((r) => r.decision), ['PENDING', 'PENDING', 'PENDING']);
    assert.deepEqual(gate.changedSinceApproval(approved.approval), []);
    review.decide('BUG-002', 'reject', { note: 'By design.' });
    assert.deepEqual(gate.changedSinceApproval(approved.approval), ['bugs/BUG-002.json']);
  });

  it('approval refuses a Phase 1 without defect analysis', () => {
    rmSync(qa.qaArtifactPath('defect-analysis'));
    put('automation-prioritization', { cases: [] });
    const result = gate.approvePhase1({ acceptFindings: true });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.state.missing.includes('defect-analysis'));
  });

  it('an edited bug file that breaks lineage is a finding at approval', () => {
    const path = qa.bugReportPath('BUG-001');
    const bug = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...bug, sourceBehaviorIds: ['BEH-404'] }));
    const state = gate.inspectPhase1();
    assert.ok([...state.findings, ...state.hard].some((f) => f.code === 'UNKNOWN_EVIDENCE_ID' && f.value === 'BEH-404'));
    assert.ok(existsSync(path));
  });
});

describe('test case review summarises defects', () => {
  const suite = { feature: 'x', testCases: [tc('TC-1', [], 't')], openQuestions: [] } as never;
  const prioritization = { cases: [{ testCaseId: 'TC-1', executionMode: 'MANUAL', automationPriority: 'NONE', reason: 'r', blockingFactors: [] }] } as never;
  const summary = { total: 1, manual: 1, automation: 0, automationHigh: 0, automationMedium: 0, automationLow: 0 };
  const reviewOf = (extra: object) => ({ status: 'APPROVED' as const, issues: [], suggestedChanges: [], summary: { ...summary, ...extra } });

  it('requires the defect counts once defect analysis has run, and approves with defects present', () => {
    const defects = { confirmed: 1, potential: 2 };
    assert.deepEqual(validateTestCasesReview(suite, prioritization, reviewOf({ confirmedDefects: 1, potentialDefects: 2 }), defects), []);
    const wrong = validateTestCasesReview(suite, prioritization, reviewOf({ confirmedDefects: 0 }), defects);
    assert.deepEqual(wrong.map((e) => e.path), ['summary.confirmedDefects', 'summary.potentialDefects']);
    // Before defect analysis existed, a review without the counts is still valid.
    assert.deepEqual(validateTestCasesReview(suite, prioritization, reviewOf({}), undefined), []);
  });
});
