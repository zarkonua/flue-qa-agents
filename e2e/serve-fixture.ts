// A QA Review Workspace for the browser tests: the real host server and the
// built UI, over a temporary artifact root seeded with the approved Phase 1
// fixture and two bug reports. Only the model is replaced — by a function that
// submits through the same host path the real review agent's tool uses.
//
//   node e2e/serve-fixture.ts          (Playwright starts it; see playwright.config.ts)

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');
const ROOT = mkdtempSync(join(tmpdir(), 'qa-ui-e2e-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
mkdirSync(ROOT, { recursive: true });
for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
  copyFileSync(join(PROJECT, 'test', 'fixtures', 'phase1-approved', `${name}.json`), join(ROOT, `${name}.json`));
}

const qa = await import('../src/lib/qa-artifacts.ts');
const gate = await import('../src/lib/phase1-gate.ts');
const { createUiServer } = await import('../src/ui-server/server.ts');
const { submitAgentProposal } = await import('../src/review/test-case-changes.ts');
const { artifactWorkspace, defaultStore } = await import('../src/review/workspace.ts');

const deps = await import('../src/lib/phase1-dependencies.ts');
const { refreshDependents, readRefreshStatus } = await import('../scripts/lib/refresh.mjs');

/** The findings the fake Defect Analyzer produces — the same defects every time, as a stable model would. */
const findings = () => [
  {
    id: 'DEF-001', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-2'],
    ...(suite().testCases.some((tc) => tc.id === 'TC-1') ? { sourceTestCaseIds: ['TC-1'] } : {}),
    reason: 'The message may not say which credential is wrong.', title: 'Invalid-credentials error is generic', severity: 'MINOR',
    steps: ['Submit the login form with INVALID_PASSWORD'], expected: 'The message says which credential is wrong.',
    actual: 'An error message is shown for invalid credentials.',
  },
  {
    id: 'DEF-002', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: ['BEH-3'], sourceAcceptancePointIds: ['AC-1'],
    reason: 'Editing is possible although the login button rule says otherwise.', title: 'Notes editable too early', severity: 'MAJOR',
    steps: ['Log in', 'Open the notes area'], expected: 'With no credentials the login button is disabled and nothing is editable.',
    actual: 'The notes area becomes editable after a successful login.',
  },
];
const suite = () => qa.readQaArtifact('test-cases') as { testCases: Record<string, unknown>[] };
qa.writeQaArtifact('defect-analysis', { findings: findings() });
deps.stampDependency('automation-prioritization');
deps.stampDependency('defect-analysis');
const approved = gate.approvePhase1({ acceptFindings: true });
if (!approved.ok) throw new Error(`fixture does not approve: ${approved.reason}`);

const store = defaultStore();
type Request = import('../src/review/review-store.ts').ChangeRequest;

/** The stand-in for the two model stages of a refresh: valid output for the CURRENT suite. */
async function fakeStage({ stage, entry }: { stage: { artifact: string }; entry: { attempts: unknown[] } }) {
  await new Promise((r) => setTimeout(r, 600)); // long enough to see RUNNING
  if (stage.artifact === 'automation-prioritization') {
    qa.writeQaArtifact('automation-prioritization', {
      cases: suite().testCases.map((tc) => ({ testCaseId: tc.id, executionMode: 'AUTOMATION', automationPriority: 'MEDIUM', reason: 'Deterministic.', blockingFactors: [] })),
    });
  } else {
    qa.writeQaArtifact('defect-analysis', { findings: findings() });
  }
  entry.attempts.push({ attempt: 1, passed: true, problem: null });
  return true;
}

/** The stand-in for the model: deterministic, and honest about missing evidence. */
async function fakeReviewAgent(request: Request) {
  await new Promise((r) => setTimeout(r, 400)); // long enough to see PROCESSING
  const comment = request.humanComment ?? '';
  if (request.operation === 'create') {
    if (/empty title/i.test(comment)) {
      return void (await submitAgentProposal(store, artifactWorkspace, request, {
        cases: [], rationale: 'No observed behavior shows what happens with an empty title.', evidenceRefs: [],
        unresolvedIssues: ['No evidence of empty-title handling; targeted verification is needed.'],
      }));
    }
    return void (await submitAgentProposal(store, artifactWorkspace, request, {
      cases: [{
        title: 'Login button stays disabled with only a username entered', evidenceIds: ['AC-1'], covers: ['AC-1'], priority: 'P2',
        types: ['boundary'], preconditions: ['Requires configured test credentials'], testData: { username: 'VALID_USERNAME' },
        steps: [{ action: 'Enter VALID_USERNAME and leave the password empty', expected: 'The Login button is disabled' }],
        expectedResult: 'The Login button is disabled', automationCandidate: true, automationReason: 'Deterministic', tags: ['auth'],
      }],
      rationale: 'A boundary of AC-1: one of the two credentials missing.', evidenceRefs: ['AC-1'], unresolvedIssues: [],
    }));
  }
  const current = suite().testCases.find((tc) => tc.id === request.targetTestCaseId)!;
  const rounds = request.history.filter((h) => h.event === 'changes_requested').length;
  await submitAgentProposal(store, artifactWorkspace, request, {
    cases: [{
      ...current,
      ...request.manualEdits,
      // Round one changes the title and the expected result; round two, asked to keep the title, only the result.
      title: rounds === 0 ? `${current.title} (reviewed)` : String(current.title),
      expectedResult: rounds === 0 ? 'Error message shown for invalid credentials, and the form stays open' : 'Error message shown for invalid credentials; the form stays open',
    }],
    rationale: rounds === 0 ? 'Made the expected result specific.' : 'Kept the title; rewrote only the expected result.',
    evidenceRefs: ['AC-2'],
    unresolvedIssues: [],
  });
}

// ---------------------------------------------------------------------------
// Run history: three archived Phase 1 runs, imported through the real importer
// ---------------------------------------------------------------------------

const history = await import('../src/history/service.ts');
const { importArchives } = await import('../src/history/importer.ts');
const { openHistoryDatabase } = await import('../src/history/database.ts');
const { SqliteRunHistoryStore } = await import('../src/history/run-history-store.ts');

function archiveRun(id: string, meta: Record<string, unknown>, copy: string[], extra: Record<string, unknown> = {}) {
  const dir = join(ROOT, 'runs', id);
  mkdirSync(join(dir, 'bugs'), { recursive: true });
  for (const f of copy) copyFileSync(join(PROJECT, 'test', 'fixtures', 'phase1-approved', f), join(dir, f));
  writeFileSync(join(dir, 'run-metadata.json'), JSON.stringify({ runId: id, kind: 'PHASE1_MANUAL', target: 'http://localhost:4444/', ...meta }));
  for (const [f, v] of Object.entries(extra)) writeFileSync(join(dir, f), JSON.stringify(v));
}
const stage = (key: string, passed: boolean, durationMs: number, attempts = 1) => ({
  stage: key, passed, attempts: Array.from({ length: attempts }, (_, i) => ({ attempt: i + 1, passed: passed && i === attempts - 1, durationMs, problem: passed && i === attempts - 1 ? null : `${key} artifact was not written by this attempt.` })),
});
const ALL = ['discovery', 'analysis', 'design', 'prioritization', 'defects'];
archiveRun('2026-09-24T19-41-08-042Z', { model: 'ollama/gpt-oss-20b-q5-49k', outcome: 'completed', startedAt: '2026-09-24T19:41:08.042Z', finishedAt: '2026-09-24T19:45:15.722Z', durationMs: 247680 },
  ['discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json', 'automation-prioritization.json'],
  { 'phase1-run.json': { phase: 1, result: 'COMPLETE', stages: ALL.slice(0, 4).map((k) => stage(k, true, 30_000)) } });
archiveRun('2026-09-25T20-06-11-699Z', { model: 'ollama/gpt-oss-20b-q5-49k', outcome: 'failed', failedStage: 'design', startedAt: '2026-09-25T20:06:11.699Z', finishedAt: '2026-09-25T20:15:00.000Z', durationMs: 528301 },
  ['discovered-behavior.json', 'requirements-analysis.json'],
  { 'phase1-run.json': { phase: 1, result: 'FAILED', failedStage: 'design', stages: [stage('discovery', true, 184_000), stage('analysis', true, 42_000), stage('design', false, 14_000, 4)] } });
archiveRun('2026-09-26T14-33-36-698Z', { model: 'openrouter/deepseek/deepseek-v4-flash-0731', outcome: 'completed', startedAt: '2026-09-26T14:33:36.698Z', finishedAt: '2026-09-26T15:33:25.216Z', durationMs: 3588518 },
  ['discovered-behavior.json', 'requirements-analysis.json', 'test-cases.json', 'automation-prioritization.json'], {
    'phase1-run.json': { phase: 1, result: 'COMPLETE', stages: ALL.map((k) => stage(k, true, 60_000)) },
    'defect-analysis.json': { findings: [
      { id: 'DEF-001', classification: 'CONFIRMED_DEFECT', bugReportId: 'BUG-001' },
      { id: 'DEF-002', classification: 'POTENTIAL_DEFECT', bugReportId: 'BUG-002' },
    ] },
    // The archived reports as they were then — the current workspace's decisions never reach them.
    'bugs/BUG-001.json': { id: 'BUG-001', status: 'CONFIRMED', title: 'Archived: notes editable too early', severity: 'MAJOR', priority: 'P1', expectedBasis: 'EVIDENCED_REQUIREMENT',
      steps: ['Log in', 'Open the notes area'], expected: 'Nothing is editable before login.', actual: 'The notes area is editable.', evidence: [{ type: 'behavior', sourceId: 'BEH-3' }],
      sourceTestCaseIds: ['TC-1'], review: { decision: 'PENDING' } },
    'bugs/BUG-002.json': { id: 'BUG-002', status: 'POTENTIAL', title: 'Archived: generic error message', severity: 'MINOR', priority: 'UNASSIGNED', expectedBasis: 'INFERRED',
      steps: ['Submit invalid credentials'], expected: 'The message names the field.', actual: 'A generic message is shown.', evidence: [{ type: 'behavior', sourceId: 'BEH-2' }],
      sourceTestCaseIds: [], review: { decision: 'PENDING' } },
  });
importArchives(history.runHistory(), ROOT, { stageLabels: { discovery: 'Product Discovery', analysis: 'Behavior Analyst', design: 'Test Designer', prioritization: 'Automation Prioritizer', defects: 'Defect Analyzer' } });

const server = await createUiServer({
  store,
  workspace: artifactWorkspace,
  runReviewAgent: fakeReviewAgent,
  refresh: {
    start: async () => {
      void refreshDependents({ runStageFn: fakeStage, log: () => {} });
      await new Promise((r) => setTimeout(r, 50));
    },
    status: () => readRefreshStatus(),
  },
  uiDir: join(PROJECT, 'ui', 'dist'),
  history: () => history.runHistory(),
});
const port = Number(process.env.QA_UI_PORT ?? 4555);
server.listen(port, '127.0.0.1', () => console.log(`e2e workspace on http://127.0.0.1:${port} (artifacts ${ROOT})`));

// A second workspace over the same artifacts with an EMPTY run history — the
// state of a fresh install — for the Runs page's empty state.
const EMPTY = mkdtempSync(join(tmpdir(), 'qa-ui-e2e-empty-history-'));
const emptyHistory = new SqliteRunHistoryStore(openHistoryDatabase(join(EMPTY, 'history.sqlite')));
const emptyServer = await createUiServer({
  store, workspace: artifactWorkspace, runReviewAgent: fakeReviewAgent,
  refresh: { start: async () => {}, status: () => readRefreshStatus() },
  uiDir: join(PROJECT, 'ui', 'dist'),
  history: () => emptyHistory,
  artifactRoot: EMPTY,
});
emptyServer.listen(port + 1, '127.0.0.1');
