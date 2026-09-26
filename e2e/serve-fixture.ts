// A QA Review Workspace for the browser tests: the real host server and the
// built UI, over a temporary artifact root seeded with the approved Phase 1
// fixture and two bug reports. Only the model is replaced — by a function that
// submits through the same host path the real review agent's tool uses.
//
//   node e2e/serve-fixture.ts          (Playwright starts it; see playwright.config.ts)

import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
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

qa.writeQaArtifact('defect-analysis', {
  findings: [{
    id: 'DEF-001', classification: 'POTENTIAL_DEFECT', sourceBehaviorIds: ['BEH-2'], sourceTestCaseIds: ['TC-1'],
    reason: 'The message may not say which credential is wrong.', title: 'Invalid-credentials error is generic', severity: 'MINOR',
    steps: ['Submit the login form with INVALID_PASSWORD'], expected: 'The message says which credential is wrong.',
    actual: 'An error message is shown for invalid credentials.',
  }],
});
const approved = gate.approvePhase1({ acceptFindings: true });
if (!approved.ok) throw new Error(`fixture does not approve: ${approved.reason}`);

const store = defaultStore();
type Request = import('../src/review/review-store.ts').ChangeRequest;
const suite = () => qa.readQaArtifact('test-cases') as { testCases: Record<string, unknown>[] };

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

const server = await createUiServer({
  store,
  workspace: artifactWorkspace,
  runReviewAgent: fakeReviewAgent,
  refreshPrioritization: async () => ({ ok: true, output: 'not run in tests' }),
  uiDir: join(PROJECT, 'ui', 'dist'),
});
const port = Number(process.env.QA_UI_PORT ?? 4555);
server.listen(port, '127.0.0.1', () => console.log(`e2e workspace on http://127.0.0.1:${port} (artifacts ${ROOT})`));
