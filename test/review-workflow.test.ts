// Interactive test-case review: requests, proposals, and the host-side apply.
//
//   npm test
//
// Real host code over a temporary artifact root seeded with the approved
// Phase 1 fixture. Only the model is faked, at the agent boundary: the fake
// submits through the same `submitAgentProposal` the real tool uses.

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-review-workflow-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.TARGET_URL = 'http://localhost:4444/';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
const PHASE1 = ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis'];

const { FileReviewStore, ReviewStoreError } = await import('../src/review/review-store.ts');
const changes = await import('../src/review/test-case-changes.ts');
const { artifactWorkspace, REVIEWS_DIR } = await import('../src/review/workspace.ts');
const gate = await import('../src/lib/phase1-gate.ts');
const qa = await import('../src/lib/qa-artifacts.ts');
const { atomicWriteFile } = await import('../src/lib/atomic-write.ts');
type ChangeRequest = import('../src/review/review-store.ts').ChangeRequest;
type AgentDraft = import('../src/review/test-case-changes.ts').AgentDraft;

after(() => rmSync(ROOT, { recursive: true, force: true }));

const suite = () => qa.readQaArtifact('test-cases') as { testCases: Record<string, any>[] };
const suiteBytes = () => readFileSync(qa.qaArtifactPath('test-cases'), 'utf8');
const caseById = (id: string) => suite().testCases.find((tc) => tc.id === id);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  for (const name of PHASE1) copyFileSync(join(FIXTURES, `${name}.json`), join(ROOT, `${name}.json`));
}

let store: InstanceType<typeof FileReviewStore>;
beforeEach(() => {
  seed();
  store = new FileReviewStore(REVIEWS_DIR);
});

/** The fake model: whatever `draft` says, submitted through the real host path. */
const agent = (draft: (request: ChangeRequest) => AgentDraft) => async (request: ChangeRequest) => {
  await changes.submitAgentProposal(store, artifactWorkspace, request, draft(request));
};

const updatedTc1 = (patch: Record<string, unknown> = {}) => () => ({
  cases: [{ ...caseById('TC-1'), expectedResult: 'An error message is shown for the invalid credentials.', ...patch }],
  rationale: 'Sharpened the expected result to what BEH-2 shows.',
  evidenceRefs: ['BEH-2'],
  unresolvedIssues: [],
});

async function proposalFor(request: ChangeRequest) {
  const r = (await store.getRequest(request.id))!;
  return (await store.getProposal(r.latestProposalId!))!;
}

// ---------------------------------------------------------------------------

describe('FileReviewStore', () => {
  it('creates, reads, moves through states and survives a restart', async () => {
    const base = 'a'.repeat(64);
    const r = await store.createRequest({ operation: 'update', targetTestCaseId: 'TC-1', baseTestCasesSha256: base, humanComment: 'Tighten it.' });
    assert.equal(r.id, 'REQ-0001');
    assert.equal(r.status, 'PENDING');
    await store.updateRequestStatus(r.id, 'PROCESSING');
    const p = await store.saveProposal({
      requestId: r.id, operation: 'update', targetTestCaseId: 'TC-1', baseTestCasesSha256: base, author: 'agent',
      proposedCases: [{ id: 'TC-1' }], removedTestCaseIds: [], rationale: 'x', evidenceRefs: [], unresolvedIssues: [],
    });
    await store.updateRequestStatus(r.id, 'PROPOSAL_READY', { proposalId: p.id });

    const reopened = new FileReviewStore(REVIEWS_DIR);
    const again = (await reopened.getRequest(r.id))!;
    assert.equal(again.status, 'PROPOSAL_READY');
    assert.equal(again.latestProposalId, 'PRP-0001');
    assert.deepEqual(again.history.map((h) => h.event), ['created', 'processing', 'proposal']);
    assert.equal((await reopened.rejectProposal(p.id)).status, 'REJECTED');
    assert.equal((await reopened.markProposalApplied(p.id)).status, 'APPLIED');
    assert.equal((await reopened.addComment(r.id, 'noted')).history.at(-1)!.event, 'comment');
  });

  it('a newer proposal supersedes the earlier one', async () => {
    const base = 'b'.repeat(64);
    const r = await store.createRequest({ operation: 'create', baseTestCasesSha256: base, humanComment: 'x' });
    const draft = { requestId: r.id, operation: 'create' as const, baseTestCasesSha256: base, author: 'agent' as const, proposedCases: [], removedTestCaseIds: [], rationale: 'r', evidenceRefs: [], unresolvedIssues: ['?'] };
    const first = await store.saveProposal(draft);
    await store.saveProposal(draft);
    assert.equal((await store.getProposal(first.id))!.status, 'SUPERSEDED');
  });

  it('refuses a bad id, and a record that does not match its schema', async () => {
    await assert.rejects(store.getRequest('../../etc/passwd'), ReviewStoreError);
    await assert.rejects(store.getProposal('PRP-1'), ReviewStoreError);
    mkdirSync(join(REVIEWS_DIR, 'requests'), { recursive: true });
    writeFileSync(join(REVIEWS_DIR, 'requests', 'REQ-0009.json'), JSON.stringify({ id: 'REQ-0009', operation: 'rm -rf' }));
    await assert.rejects(store.getRequest('REQ-0009'), /is invalid/);
    assert.deepEqual((await store.listRequests()).map((r) => r.id), [], 'an invalid file is never listed');
  });
});

// ---------------------------------------------------------------------------

describe('UPDATE', () => {
  it('request -> proposal -> diff -> apply; nothing changes before apply; Phase 1 goes stale', async () => {
    const approved = gate.approvePhase1({ acceptFindings: true });
    assert.equal(approved.ok, true, JSON.stringify(!approved.ok && approved.state.hard));
    const before = suiteBytes();

    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'Make the expected result precise.' });
    assert.equal(r.status, 'PENDING');
    const processed = await changes.processChangeRequest(store, r.id, agent(updatedTc1()));
    assert.equal(processed.status, 'PROPOSAL_READY');
    assert.equal(suiteBytes(), before, 'the canonical suite is untouched by a proposal');

    const proposal = await proposalFor(r);
    assert.equal(proposal.proposedCases[0].id, 'TC-1', 'an update keeps its id');
    assert.deepEqual(proposal.baseCase, caseById('TC-1'), 'the case it was made from is kept, so its diff never drifts');
    const v = changes.validateProposal(artifactWorkspace, proposal);
    assert.equal(v.status, 'VALID', v.problems.join('\n'));

    await changes.applyProposal(store, artifactWorkspace, proposal.id);
    assert.equal(caseById('TC-1')!.expectedResult, 'An error message is shown for the invalid credentials.');
    assert.equal((await store.getRequest(r.id))!.status, 'APPLIED');
    assert.equal((await store.getProposal(proposal.id))!.status, 'APPLIED');
    if (approved.ok) assert.deepEqual(gate.changedSinceApproval(approved.approval), ['test-cases.json'], 'the earlier approval is now stale');
  });

  it('a comment-only request is persisted, handed to the agent, and changes nothing until applied', async () => {
    const before = suiteBytes();
    let seen: ChangeRequest | undefined;
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-2', humanComment: 'Add empty-value boundary coverage.' });
    assert.equal((await new FileReviewStore(REVIEWS_DIR).getRequest(r.id))!.humanComment, 'Add empty-value boundary coverage.');
    await changes.processChangeRequest(store, r.id, async (req) => {
      seen = req;
      await changes.submitAgentProposal(store, artifactWorkspace, req, { cases: [caseById('TC-2')!], rationale: 'r', evidenceRefs: [], unresolvedIssues: [] });
    });
    assert.equal(seen?.humanComment, 'Add empty-value boundary coverage.');
    assert.equal((await store.listProposals(r.id)).length, 1);
    assert.equal(suiteBytes(), before);
  });

  it('request changes, then a second round; history keeps both', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'Rewrite the expected result.' });
    await changes.processChangeRequest(store, r.id, agent(updatedTc1()));
    const first = await proposalFor(r);
    await changes.requestProposalChanges(store, first.id, 'Keep the precondition; only rewrite the expected result.');
    assert.equal((await store.getRequest(r.id))!.status, 'CHANGES_REQUESTED');
    await changes.processChangeRequest(store, r.id, agent(updatedTc1({ title: caseById('TC-1')!.title })));
    const second = await proposalFor(r);
    assert.notEqual(second.id, first.id);
    assert.equal((await store.getProposal(first.id))!.status, 'REJECTED');
    const events = (await store.getRequest(r.id))!.history.map((h) => h.event);
    assert.deepEqual(events, ['created', 'processing', 'proposal', 'changes_requested', 'processing', 'proposal']);
  });

  it('an agent that submits nothing leaves the request FAILED and retryable', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    assert.equal((await changes.processChangeRequest(store, r.id, async () => {})).status, 'FAILED');
    assert.equal((await changes.processChangeRequest(store, r.id, async () => { throw new Error('model down'); })).error, 'The review agent failed: model down');
    assert.equal((await changes.processChangeRequest(store, r.id, agent(updatedTc1()))).status, 'PROPOSAL_READY');
  });
});

describe('CREATE', () => {
  const newCase = (patch: Record<string, unknown> = {}) => ({
    id: 'whatever-the-model-said', title: 'Invalid credentials show an error message', evidenceIds: ['BEH-2'], covers: ['AC-2'],
    priority: 'P2', types: ['negative'], preconditions: [], testData: {}, steps: [{ action: 'Submit invalid credentials', expected: 'An error message is shown' }],
    expectedResult: 'An error message is shown for invalid credentials.', automationCandidate: true, automationReason: 'Deterministic.', tags: [], ...patch,
  });

  it('natural language -> complete candidate with a new, unique id; inactive until applied', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'create', humanComment: 'Add a case for invalid credentials.' });
    await changes.processChangeRequest(store, r.id, agent(() => ({ cases: [newCase()], rationale: 'From BEH-2.', evidenceRefs: ['BEH-2'], unresolvedIssues: [] })));
    const p = await proposalFor(r);
    assert.equal(p.proposedCases[0].id, 'TC-3', 'the host assigns the id, in the suite\'s style');
    assert.equal(caseById('TC-3'), undefined, 'not active before apply');
    const v = changes.validateProposal(artifactWorkspace, p);
    assert.equal(v.status, 'VALID', v.problems.join('\n'));
    assert.deepEqual(v.duplicates, [{ testCaseId: 'TC-3', similarTo: 'TC-1' }], 'a likely duplicate is flagged, not removed');
    await changes.applyProposal(store, artifactWorkspace, p.id);
    assert.ok(caseById('TC-3'));
  });

  it('ids skip holes and never reuse a deleted id', () => {
    const next = changes.idAllocator({ feature: 'x', openQuestions: [], testCases: [{ id: 'TC-001' }, { id: 'TC-005' }] as never }, new Set(['TC-001', 'TC-005', 'TC-009']));
    assert.equal(next(), 'TC-010');
    assert.equal(next(), 'TC-011');
  });

  it('an unsupported request is unresolved, fabricates nothing, and cannot be applied', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'create', humanComment: 'Prove that an empty title is rejected.' });
    await changes.processChangeRequest(store, r.id, agent(() => ({
      cases: [], rationale: 'No observed behavior shows what happens with an empty title.', evidenceRefs: [],
      unresolvedIssues: ['No evidence of empty-title handling; targeted verification is needed.'],
    })));
    const p = await proposalFor(r);
    const v = changes.validateProposal(artifactWorkspace, p);
    assert.equal(v.status, 'UNRESOLVED');
    assert.equal(v.applicable, false);
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, p.id), /UNRESOLVED/);
  });
});

describe('DELETE', () => {
  it('stays active until applied; Keep leaves it; Apply removes it; history remains', async () => {
    const first = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'delete', targetTestCaseId: 'TC-2', humanComment: 'Redundant.' });
    assert.equal(first.status, 'PROPOSAL_READY', 'the host proposes a deletion itself');
    assert.ok(caseById('TC-2'), 'still active before apply');
    const p1 = await proposalFor(first);
    const v = changes.validateProposal(artifactWorkspace, p1);
    assert.deepEqual(v.impact.coveredBefore, ['AC-1']);
    assert.deepEqual(v.impact.wouldBecomeUncovered, ['AC-1'], 'the impact is visible');
    assert.equal(v.status, 'VALID', 'worse coverage is not a reason to refuse');

    await changes.rejectProposal(store, p1.id);
    assert.ok(caseById('TC-2'), 'kept');

    const second = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'delete', targetTestCaseId: 'TC-2' });
    await changes.applyProposal(store, artifactWorkspace, (await proposalFor(second)).id);
    assert.equal(caseById('TC-2'), undefined);
    assert.equal((await store.getRequest(first.id))!.status, 'REJECTED', 'the earlier decision is kept');
    // A deleted id is never handed out again.
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'create', humanComment: 'x' });
    await changes.processChangeRequest(store, r.id, agent(() => ({ cases: [{ ...caseById('TC-1') }], rationale: 'r', evidenceRefs: [], unresolvedIssues: [] })));
    assert.equal((await proposalFor(r)).proposedCases[0].id, 'TC-3');
  });
});

describe('the host refuses what it cannot trust', () => {
  it('a stale proposal conflicts and overwrites nothing', async () => {
    const a = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'a' });
    const b = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-2', humanComment: 'b' });
    await changes.processChangeRequest(store, a.id, agent(updatedTc1()));
    await changes.processChangeRequest(store, b.id, agent(() => ({ cases: [{ ...caseById('TC-2'), title: 'Renamed' }], rationale: 'r', evidenceRefs: [], unresolvedIssues: [] })));
    await changes.applyProposal(store, artifactWorkspace, (await proposalFor(a)).id);
    const after = suiteBytes();
    const stale = await proposalFor(b);
    assert.equal(changes.validateProposal(artifactWorkspace, stale).status, 'STALE');
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, stale.id), /older version of the test suite/);
    assert.equal(suiteBytes(), after);
  });

  it('an invalid edit is refused: priority, type, covers and evidence', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await changes.processChangeRequest(store, r.id, agent(updatedTc1({ priority: 'P9', types: ['chaos'] })));
    const schemaBad = changes.validateProposal(artifactWorkspace, await proposalFor(r));
    assert.equal(schemaBad.status, 'INVALID');
    assert.ok(schemaBad.problems.some((p) => p.includes('priority')) && schemaBad.problems.some((p) => p.includes('types')), schemaBad.problems.join('\n'));

    const r2 = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-2', humanComment: 'y' });
    await changes.processChangeRequest(store, r2.id, agent(() => ({ cases: [{ ...caseById('TC-2'), covers: ['AC-99'], evidenceIds: ['BEH-99'] }], rationale: 'r', evidenceRefs: [], unresolvedIssues: [] })));
    const p = await proposalFor(r2);
    const semanticBad = changes.validateProposal(artifactWorkspace, p);
    assert.equal(semanticBad.status, 'INVALID');
    assert.ok(semanticBad.problems.some((x) => x.includes('AC-99')) && semanticBad.problems.some((x) => x.includes('BEH-99')), semanticBad.problems.join('\n'));
    const before = suiteBytes();
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, p.id), /INVALID/);
    assert.equal(suiteBytes(), before);
  });

  it('a proposal file tampered with on disk is re-checked, never trusted', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await changes.processChangeRequest(store, r.id, agent(updatedTc1()));
    const p = await proposalFor(r);
    const file = join(REVIEWS_DIR, 'proposals', `${p.id}.json`);
    const original = JSON.parse(readFileSync(file, 'utf8'));
    const before = suiteBytes();

    // Fabricated evidence, with the base hash still matching: semantic validation catches it.
    writeFileSync(file, JSON.stringify({ ...original, proposedCases: [{ ...original.proposedCases[0], evidenceIds: ['BEH-404'] }] }));
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, p.id), /BEH-404/);
    // Not a proposal at all: the store refuses to read it.
    writeFileSync(file, JSON.stringify({ ...original, status: 'READY', author: 'root' }));
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, p.id), /is invalid/);
    // A different base: stale.
    writeFileSync(file, JSON.stringify({ ...original, baseTestCasesSha256: 'f'.repeat(64) }));
    await assert.rejects(changes.applyProposal(store, artifactWorkspace, p.id), /older version/);
    assert.equal(suiteBytes(), before);
  });

  it('a failed write leaves the suite unchanged and the proposal applicable', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await changes.processChangeRequest(store, r.id, agent(updatedTc1()));
    const p = await proposalFor(r);
    const before = suiteBytes();
    const failing = { ...artifactWorkspace, writeTestCases: () => { throw new Error('disk full'); } };
    await assert.rejects(changes.applyProposal(store, failing, p.id), /disk full/);
    assert.equal(suiteBytes(), before);
    assert.equal((await store.getProposal(p.id))!.status, 'READY');
    assert.equal((await store.getRequest(r.id))!.status, 'PROPOSAL_READY');
    await changes.applyProposal(store, artifactWorkspace, p.id);
  });

  it('atomic replacement: a failed write never truncates or corrupts the target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-'));
    const target = join(dir, 'suite.json');
    atomicWriteFile(target, '{"ok":1}');
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => atomicWriteFile(target, '{"ok":2}'));
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(readFileSync(target, 'utf8'), '{"ok":1}');
    assert.deepEqual(readdirSync(dir), ['suite.json'], 'no temp file left behind');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the host re-validates on write: replaceTestCases refuses an invalid suite', () => {
    const before = suiteBytes();
    const bad = { ...suite(), testCases: [{ ...caseById('TC-1'), evidenceIds: ['BEH-77'] }, caseById('TC-2')] };
    assert.throws(() => qa.replaceTestCases(bad as never, { allowCodes: ['UNCOVERED_ACCEPTANCE_POINT'] }), /BEH-77/);
    assert.equal(suiteBytes(), before);
  });

  it('a request left PROCESSING by a dead process becomes retryable', async () => {
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await store.updateRequestStatus(r.id, 'PROCESSING');
    assert.equal(await changes.recoverInterrupted(store), 1);
    assert.equal((await store.getRequest(r.id))!.status, 'FAILED');
  });
});

describe('the focused review agent cannot write protected artifacts', () => {
  it('mounts exactly two tools, neither of which can name a file or artifact', async () => {
    const tools = await import('../src/tools/review-proposals.ts');
    assert.deepEqual([tools.readChangeRequestTool.name, tools.submitProposalTool.name], ['read_change_request', 'submit_test_case_proposal']);
    const source = readFileSync(join(PROJECT, 'src', 'agents', 'test-case-change-reviewer.ts'), 'utf8');
    const mounted = [...source.matchAll(/useTool\((\w+)\)/g)].map((m) => m[1]);
    assert.deepEqual(mounted, ['readChangeRequestTool', 'submitProposalTool']);
    assert.ok(!/write_qa_artifact|writeQaArtifact|qa-artifacts/.test(source));
    const keys = Object.keys((tools.submitProposalTool.input as { entries: Record<string, unknown> }).entries);
    assert.deepEqual(keys.sort(), ['cases', 'evidenceRefs', 'rationale', 'unresolvedIssues']);
  });

  it('submitting a proposal leaves test cases, prioritization and approval byte-for-byte unchanged', async () => {
    gate.approvePhase1({ acceptFindings: true });
    const files = ['test-cases.json', 'automation-prioritization.json', 'phase1-approval.json'].map((f) => join(ROOT, f));
    const before = files.map((f) => readFileSync(f, 'utf8'));
    const r = await changes.createChangeRequest(store, artifactWorkspace, { operation: 'update', targetTestCaseId: 'TC-1', humanComment: 'x' });
    await changes.processChangeRequest(store, r.id, agent(updatedTc1()));
    assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before);
    assert.ok(existsSync(join(REVIEWS_DIR, 'proposals')));
  });
});
