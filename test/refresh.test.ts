// Phase 1 dependency lifecycle: what goes stale, the all-or-nothing refresh,
// and carrying human bug decisions across a regenerated defect analysis.
//
//   npm test
//
// Real host code over a temporary artifact root. The model stages are replaced
// by a fake stage runner that writes (or fails to write) the artifact exactly
// where the agent would.

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-refresh-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
delete process.env.QA_DISCOVERY_AUX_ORIGINS;
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');

const qa = await import('../src/lib/qa-artifacts.ts');
const gate = await import('../src/lib/phase1-gate.ts');
const deps = await import('../src/lib/phase1-dependencies.ts');
const recon = await import('../src/lib/bug-reconciliation.ts');
const review = await import('../src/lib/defect-review.ts');
const changes = await import('../src/review/test-case-changes.ts');
const { artifactWorkspace, defaultStore } = await import('../src/review/workspace.ts');
const { refreshDependents, readRefreshStatus, reconcileBugDecisions } = await import('../scripts/lib/refresh.mjs');
type BugReport = import('../src/lib/defects.ts').BugReport;

after(() => rmSync(ROOT, { recursive: true, force: true }));

const suite = () => qa.readQaArtifact('test-cases') as { testCases: Record<string, any>[] };
const bytes = (name: string) => readFileSync(join(ROOT, name), 'utf8');

/** Two findings: a POTENTIAL on BEH-2 (naming TC-1) and a CONFIRMED on BEH-3. */
const findings = (overrides: Record<string, Record<string, unknown>> = {}) => [
  {
    id: 'DEF-001', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-2'], sourceTestCaseIds: ['TC-1'],
    reason: 'The message may not say which credential is wrong.', title: 'Invalid-credentials error is generic', severity: 'MINOR',
    steps: ['Submit the login form with INVALID_PASSWORD'], expected: 'The message says which credential is wrong.',
    actual: 'An error message is shown for invalid credentials.', ...overrides['DEF-001'],
  },
  {
    id: 'DEF-002', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: ['BEH-3'], sourceAcceptancePointIds: ['AC-1'],
    reason: 'Editing is possible although the login button rule says otherwise.', title: 'Notes editable too early', severity: 'MAJOR',
    steps: ['Log in', 'Open the notes area'], expected: 'With no credentials the login button is disabled and nothing is editable.',
    actual: 'The notes area becomes editable after a successful login.', ...overrides['DEF-002'],
  },
];

const prioritization = () => ({
  cases: suite().testCases.map((tc) => ({ testCaseId: tc.id, executionMode: 'MANUAL', automationPriority: 'NONE', reason: 'Fixture.', blockingFactors: [] })),
});

/** A fake model stage: writes a valid artifact for the CURRENT suite, like a successful agent. */
const passing = (defectOverrides: Record<string, Record<string, unknown>> = {}) => async ({ stage, entry }: any) => {
  if (stage.artifact === 'automation-prioritization') qa.writeQaArtifact('automation-prioritization', prioritization());
  else qa.writeQaArtifact('defect-analysis', { findings: findings(defectOverrides) });
  entry.attempts.push({ attempt: 1, passed: true, problem: null });
  return true;
};

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization']) {
    copyFileSync(join(FIXTURES, `${name}.json`), join(ROOT, `${name}.json`));
  }
  qa.writeQaArtifact('defect-analysis', { findings: findings() });
  deps.stampDependency('automation-prioritization');
  deps.stampDependency('defect-analysis');
  const approved = gate.approvePhase1({ acceptFindings: true });
  assert.equal(approved.ok, true);
  return approved.ok ? approved.approval : undefined;
}

let approval: ReturnType<typeof seed>;
beforeEach(() => {
  approval = seed();
});

async function applyCaseChange() {
  const store = defaultStore();
  const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
  await changes.processChangeRequest(store, r.id, async (req) => {
    await changes.submitAgentProposal(store, artifactWorkspace, req, {
      cases: [{ ...suite().testCases[0], expectedResult: 'Error message shown for invalid credentials, and the form stays open' }],
      rationale: 'r', evidenceRefs: [], unresolvedIssues: [],
    });
  });
  await changes.applyProposal(store, artifactWorkspace, (await store.getRequest(r.id))!.latestProposalId!);
}

// ---------------------------------------------------------------------------

describe('what goes stale', () => {
  it('a fresh Phase 1 is current throughout', () => {
    assert.equal(deps.dependencyState('automation-prioritization').state, 'CURRENT');
    assert.equal(deps.dependencyState('defect-analysis').state, 'CURRENT');
    assert.deepEqual(gate.changedSinceApproval(approval!), []);
  });

  it('applying a test-case change: prioritization, defect analysis and approval STALE — naming the case', async () => {
    await applyCaseChange();
    const p = deps.dependencyState('automation-prioritization');
    const d = deps.dependencyState('defect-analysis');
    assert.equal(p.state, 'STALE');
    assert.deepEqual(p.changedCases.modified, ['TC-1']);
    assert.deepEqual(p.reasons, ['TC-1 was modified after this was generated.']);
    assert.equal(d.state, 'STALE');
    assert.deepEqual(d.changedInputs, ['test-cases']);
    assert.deepEqual(gate.changedSinceApproval(approval!), ['test-cases.json']);
  });

  it('a bug-only edit: approval STALE, test cases, prioritization and defect analysis stay CURRENT', async () => {
    const tc = bytes('test-cases.json');
    await review.edit('BUG-001', { title: 'The invalid-credentials message is generic' });
    assert.equal(deps.dependencyState('automation-prioritization').state, 'CURRENT');
    assert.equal(deps.dependencyState('defect-analysis').state, 'CURRENT');
    assert.equal(bytes('test-cases.json'), tc);
    assert.deepEqual(gate.changedSinceApproval(approval!), ['bugs/BUG-001.json']);
  });

  it('adding or removing a case is named too', async () => {
    const s = suite();
    qa.replaceTestCases({ ...s, testCases: [s.testCases[0], { ...s.testCases[1], id: 'TC-9' }] } as never, { allowCodes: ['UNCOVERED_ACCEPTANCE_POINT'] });
    const p = deps.dependencyState('automation-prioritization');
    assert.deepEqual(p.changedCases, { added: ['TC-9'], modified: [], removed: ['TC-2'] });
  });
});

describe('refresh dependent analysis', () => {
  it('success: prioritization and defect analysis CURRENT again; approval stays STALE', async () => {
    await applyCaseChange();
    const result = await refreshDependents({ runStageFn: passing(), log: () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.stages.map((s: any) => s.stage), ['prioritization', 'defects']);
    assert.equal(deps.dependencyState('automation-prioritization').state, 'CURRENT');
    assert.equal(deps.dependencyState('defect-analysis').state, 'CURRENT');
    assert.ok(gate.changedSinceApproval(approval!).includes('test-cases.json'), 'a refresh never restores approval');
    assert.ok(existsSync(gate.APPROVAL_PATH), 'the approval file is not archived or rewritten');
    assert.equal(readRefreshStatus().status, 'COMPLETED');
  });

  it('failure: the previous artifacts are restored byte for byte and stay STALE', async () => {
    await applyCaseChange();
    const before = ['automation-prioritization.json', 'defect-analysis.json', 'bugs/BUG-001.json', 'bugs/BUG-002.json'].map(bytes);
    const failing = async ({ stage, entry }: any) => {
      if (stage.artifact === 'automation-prioritization') return passing()({ stage, entry });
      // A half-written, invalid attempt at the second stage.
      writeFileSync(qa.qaArtifactPath('defect-analysis'), '{"findings": [');
      entry.attempts.push({ attempt: 1, passed: false, problem: 'defect-analysis.json is not valid JSON' });
      return false;
    };
    const result = await refreshDependents({ runStageFn: failing, log: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.message, /Defect Analyzer/);
    assert.deepEqual(['automation-prioritization.json', 'defect-analysis.json', 'bugs/BUG-001.json', 'bugs/BUG-002.json'].map(bytes), before);
    assert.equal(deps.dependencyState('automation-prioritization').state, 'STALE', 'not partially current');
    assert.equal(deps.dependencyState('defect-analysis').state, 'STALE');
    const status = readRefreshStatus();
    assert.equal(status.status, 'FAILED');
    assert.match(status.error, /Defect Analyzer/);
  });

  it('refuses to overlap another run', async () => {
    writeFileSync(join(ROOT, 'run.lock'), JSON.stringify({ pid: process.ppid, command: 'qa:manual' }));
    const result = await refreshDependents({ runStageFn: passing(), log: () => {} });
    rmSync(join(ROOT, 'run.lock'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'LOCKED');
    assert.equal(readRefreshStatus().status, 'FAILED');
  });

  it('an interrupted refresh reads as FAILED, retryable', () => {
    writeFileSync(join(ROOT, 'phase1-refresh.json'), JSON.stringify({ status: 'RUNNING', pid: 99999999, startedAt: 'x' }));
    assert.equal(readRefreshStatus().status, 'FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('bug decisions across a regenerated defect analysis', () => {
  const bug = (id: string) => qa.readBugReport(id)!;

  it('materially the same bug keeps its decision, note, downgrade and edits — even under a new id and new wording', async () => {
    await review.decide('BUG-001', 'reject', { note: 'By design.', store: defaultStore() });
    await review.decide('BUG-002', 'downgrade', { store: defaultStore() });
    await review.edit('BUG-002', { priority: 'P1', severity: 'CRITICAL' }, { store: defaultStore() });
    // The model reorders and rewords; the defects themselves are unchanged.
    const reworded = async ({ stage, entry }: any) => {
      if (stage.artifact === 'automation-prioritization') return passing()({ stage, entry });
      const [a, b] = findings({
        'DEF-001': { title: 'Generic error on bad credentials', actual: 'An error message is shown when the credentials are invalid.' },
        'DEF-002': { title: 'Notes can be edited', severity: 'MINOR' },
      });
      qa.writeQaArtifact('defect-analysis', { findings: [{ ...b, id: 'DEF-001' }, { ...a, id: 'DEF-002' }] });
      entry.attempts.push({ attempt: 1, passed: true, problem: null });
      return true;
    };
    const result = await refreshDependents({ runStageFn: reworded, log: () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    // Ids swapped: the old BUG-002 is now BUG-001 and vice versa.
    assert.equal(bug('BUG-001').origin.findingId, 'DEF-001');
    assert.deepEqual(bug('BUG-001').sourceBehaviorIds, ['BEH-3'], 'the new BUG-001 is the old BUG-002 defect');
    assert.equal(bug('BUG-001').title, 'Notes can be edited', 'a field the person never edited takes the regenerated value');
    assert.equal(bug('BUG-001').review.decision, 'PENDING', 'a downgrade is a decision state; the original decision was PENDING');
    assert.equal(bug('BUG-001').status, 'POTENTIAL', 'the downgrade carried');
    assert.equal(bug('BUG-001').priority, 'P1', 'the human-set priority carried');
    assert.equal(bug('BUG-001').severity, 'CRITICAL', 'the human edit wins over the regenerated severity');
    assert.equal(bug('BUG-002').review.decision, 'REJECTED');
    assert.equal(bug('BUG-002').review.note, 'By design.');
    const r = readRefreshStatus().reconciliation;
    assert.deepEqual(r.preserved.map((p: any) => `${p.from}->${p.to}`).sort(), ['BUG-001->BUG-002', 'BUG-002->BUG-001']);
    assert.deepEqual([r.reset, r.added, r.removed], [[], [], []]);
    // History moved with the bug, plus the host's note.
    const history = await defaultStore().listBugReviewEvents('BUG-002');
    assert.deepEqual(history.map((e) => e.action), ['reject', 'reconcile']);
  });

  it('a materially changed finding is reset — a REJECTED one included; new is PENDING; gone is removed', async () => {
    await review.decide('BUG-001', 'reject', { note: 'By design.', store: defaultStore() });
    await review.decide('BUG-002', 'accept', { store: defaultStore() });
    const changed = async ({ stage, entry }: any) => {
      if (stage.artifact === 'automation-prioritization') return passing()({ stage, entry });
      const [a] = findings({ 'DEF-001': { expected: 'Two attempts later the account is temporarily locked.', actual: 'Every wrong password shows the same error.' } });
      qa.writeQaArtifact('defect-analysis', { findings: [a] });
      entry.attempts.push({ attempt: 1, passed: true, problem: null });
      return true;
    };
    const result = await refreshDependents({ runStageFn: changed, log: () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(bug('BUG-001').review.decision, 'PENDING', 'same evidence, different defect: asked again');
    const r = readRefreshStatus().reconciliation;
    assert.deepEqual(r.reset, [{ from: 'BUG-001', to: 'BUG-001', previousDecision: 'REJECTED' }]);
    assert.deepEqual(r.removed, [{ id: 'BUG-002', previousDecision: 'ACCEPTED' }]);
    assert.equal(qa.readBugReport('BUG-002'), undefined, 'removed from the active set');
    assert.deepEqual(await defaultStore().listBugReviewEvents('BUG-001'), [], 'a reset report starts a fresh history');
    // …and nothing is lost: the previous reports and their histories are archived.
    const archive = readFileSync(join(ROOT, 'archive', readdirSync(join(ROOT, 'archive')).find((d) => d.endsWith('-refresh'))!, 'bugs', 'BUG-002.json'), 'utf8');
    assert.match(archive, /ACCEPTED/);
  });

  it('never matches by id alone: a different defect under the same id starts PENDING', () => {
    const base = bug('BUG-001');
    const other: BugReport = { ...base, sourceBehaviorIds: ['BEH-3'], area: 'Notes Management' };
    const plan = recon.planReconciliation([{ ...base, review: { ...base.review, decision: 'ACCEPTED' } }], [other]);
    assert.deepEqual([plan.preserved.length, plan.reset.length, plan.added.map((b) => b.id), plan.removed.map((b) => b.id)], [0, 0, ['BUG-001'], ['BUG-001']]);
  });

  it('real model rewording from a live refresh is still the same defect; a different claim is not', () => {
    const base = bug('BUG-001');
    const pair = (a: [string, string], b: [string, string]) =>
      recon.sameClaim({ ...base, expected: a[0], actual: a[1] }, { ...base, expected: b[0], actual: b[1] });
    // Captured from a live refresh (2026-09-26): same evidence, prose rewritten by the model.
    assert.equal(pair(
      ['A validation or error message indicating that the email and password are required (inferred from standard form-validation convention; no acceptance point or business rule states this explicitly).',
        'No visible change occurs and no validation or error message is displayed (BEH-1).'],
      ['Submitting the sign-up form with required fields empty should produce a validation message indicating the fields are required rather than silently doing nothing.',
        'Submitting the sign-up form with both fields empty produces no visible change and no validation or error message (BEH-1).'],
    ), true);
    assert.equal(pair(
      ["A distinct validation message prompting the user that the email and password must be provided, distinct from an authentication-failure message (inferred from convention; BR-1's generic-message rule covers wrong-password and non-existent-email cases, not empty fields).",
        "The status message 'Invalid credentials.' is displayed and the user stays on the landing page, identical to a real authentication failure (BEH-21)."],
      ['Signing in with empty required fields could be expected to prompt the user that the fields are required rather than presenting it as a generic authentication failure.',
        "Signing in with both Email and Password empty shows the same generic 'Invalid credentials.' message as a real auth failure and stays on the landing page (BEH-21)."],
    ), true);
    assert.equal(pair(
      ['The message says which credential is wrong.', 'An error message is shown for invalid credentials.'],
      ['Two attempts later the account is temporarily locked.', 'Every wrong password shows the same error.'],
    ), false);
  });

  it('title, severity, priority and steps are not identity', () => {
    const base = bug('BUG-001');
    assert.equal(recon.materialKey(base), recon.materialKey({ ...base, title: 'x', severity: 'BLOCKER', priority: 'P0', steps: ['y'] }));
    assert.notEqual(recon.materialKey(base), recon.materialKey({ ...base, sourceBehaviorIds: ['BEH-1'] }));
  });

  it('edits that no longer hold against the new evidence are dropped; the decision still carries', async () => {
    const old = { ...bug('BUG-001'), steps: ['Open /admin/login'], review: { decision: 'ACCEPTED' as const, editedFields: ['steps'] } };
    const dir = mkdtempSync(join(tmpdir(), 'qa-prev-bugs-'));
    writeFileSync(join(dir, 'BUG-001.json'), JSON.stringify(old));
    const summary = await reconcileBugDecisions(dir, defaultStore());
    assert.deepEqual(summary.preserved.map((p: any) => [p.from, p.decision, p.editsCarried]), [['BUG-001', 'ACCEPTED', false]]);
    assert.equal(bug('BUG-001').steps[0], 'Submit the login form with INVALID_PASSWORD', 'the unsupported edited step was not carried');
  });
});
