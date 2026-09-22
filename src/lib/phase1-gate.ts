// The human approval gate between Phase 1 (manual QA design) and Phase 2
// (automation engineering).
//
// Trusted host code only. No runtime agent can read or write the approval:
// `phase1-approval.json` is not in the artifact registry the agent tools
// expose, and nothing here is mounted as a tool. Approval is a person running
// `npm run qa:approve`, not a model deciding it is done.
//
// Approval is bound to content, not to time: it records the SHA-256 of every
// Phase 1 artifact. Change any of them — including by hand — and the approval
// is stale, and Phase 2 refuses to start until someone approves again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { QA_ARTIFACT_ROOT, qaArtifactPath, readQaArtifact, schemaErrorsFor, type QaArtifactName } from './qa-artifacts.ts';
import {
  summarize,
  validateAutomationPrioritization,
  validateDiscoveredBehavior,
  validateRequirementsAnalysis,
  validateTestCases,
  type AutomationPrioritization,
  type DiscoveredBehavior,
  type RequirementsAnalysis,
  type ReviewSummary,
  type SemanticError,
  type TestCases,
  type TestCasesReview,
} from './semantic-validate.ts';

/** Every Phase 1 artifact an approval covers. The review is advisory and deliberately excluded. */
export const PHASE1_LOCKED = [
  'discovered-behavior',
  'requirements-analysis',
  'test-cases',
  'automation-prioritization',
] as const satisfies readonly QaArtifactName[];

export const APPROVAL_PATH = join(QA_ARTIFACT_ROOT, 'phase1-approval.json');

/** Structural problems Phase 2 cannot work around. Never overridable. */
const HARD_CODES = new Set([
  'MISSING_UPSTREAM',
  'UNKNOWN_TEST_CASE',
  'MISSING_PRIORITIZATION',
  'DUPLICATE_PRIORITIZATION',
  'INCONSISTENT_PRIORITY',
  'DUPLICATE_ID',
]);

export interface Finding extends SemanticError {
  artifact: QaArtifactName;
}

export interface Phase1State {
  missing: QaArtifactName[];
  schemaErrors: { artifact: QaArtifactName; errors: string[] }[];
  /** Always block approval and Phase 2. */
  hard: Finding[];
  /** Block approval unless explicitly accepted by the operator. */
  findings: Finding[];
  counts?: ReviewSummary;
  prioritization?: AutomationPrioritization;
}

export interface Phase1Approval {
  status: 'APPROVED';
  approvedAt: string;
  approvedBy: string;
  testCasesSha256: string;
  automationPrioritizationSha256: string;
  discoveredBehaviorSha256: string;
  requirementsAnalysisSha256: string;
  counts: ReviewSummary;
  review: { status: TestCasesReview['status']; olderThanTestCases: boolean } | null;
  acceptedFindings: { artifact: string; code: string; path: string; value?: string }[];
}

const HASH_FIELD: Record<(typeof PHASE1_LOCKED)[number], keyof Phase1Approval> = {
  'discovered-behavior': 'discoveredBehaviorSha256',
  'requirements-analysis': 'requirementsAnalysisSha256',
  'test-cases': 'testCasesSha256',
  'automation-prioritization': 'automationPrioritizationSha256',
};

/** SHA-256 of the exact bytes on disk — whitespace edits count, deliberately. */
export function sha256Of(name: QaArtifactName): string | undefined {
  const path = qaArtifactPath(name);
  if (!existsSync(path)) return undefined;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function tag(artifact: QaArtifactName, errors: SemanticError[]): Finding[] {
  return errors.map((e) => ({ ...e, artifact }));
}

/** Everything the gate knows about the current Phase 1 artifacts, without changing anything. */
export function inspectPhase1(): Phase1State {
  const state: Phase1State = { missing: [], schemaErrors: [], hard: [], findings: [] };
  const data: Partial<Record<QaArtifactName, unknown>> = {};

  for (const name of PHASE1_LOCKED) {
    let value: unknown;
    try {
      value = readQaArtifact(name);
    } catch (error) {
      state.schemaErrors.push({ artifact: name, errors: [`not valid JSON: ${(error as Error).message}`] });
      continue;
    }
    if (value === undefined) {
      state.missing.push(name);
      continue;
    }
    const errors = schemaErrorsFor(name, value);
    if (errors.length > 0) state.schemaErrors.push({ artifact: name, errors });
    else data[name] = value;
  }

  const discovery = data['discovered-behavior'] as DiscoveredBehavior | undefined;
  const requirements = data['requirements-analysis'] as RequirementsAnalysis | undefined;
  const testCases = data['test-cases'] as TestCases | undefined;
  const prioritization = data['automation-prioritization'] as AutomationPrioritization | undefined;

  const all: Finding[] = [];
  if (discovery) all.push(...tag('discovered-behavior', validateDiscoveredBehavior(discovery)));
  if (discovery && requirements) all.push(...tag('requirements-analysis', validateRequirementsAnalysis(discovery, requirements)));
  if (requirements && testCases) all.push(...tag('test-cases', validateTestCases(discovery, requirements, testCases)));
  if (testCases && prioritization) {
    all.push(...tag('automation-prioritization', validateAutomationPrioritization(testCases, prioritization, discovery, requirements)));
    state.counts = summarize(prioritization);
    state.prioritization = prioritization;
  }

  state.hard = all.filter((f) => HARD_CODES.has(f.code));
  state.findings = all.filter((f) => !HARD_CODES.has(f.code));
  return state;
}

function readReview(): Phase1Approval['review'] {
  const review = readQaArtifact('test-cases-review') as TestCasesReview | undefined;
  if (!review) return null;
  const reviewPath = qaArtifactPath('test-cases-review');
  const casesPath = qaArtifactPath('test-cases');
  return { status: review.status, olderThanTestCases: statSync(reviewPath).mtimeMs < statSync(casesPath).mtimeMs };
}

export type ApproveResult =
  | { ok: true; approval: Phase1Approval }
  | { ok: false; reason: 'INCOMPLETE' | 'INVALID' | 'FINDINGS'; state: Phase1State };

/** Record the operator's approval of the current Phase 1 artifacts. */
export function approvePhase1({ acceptFindings = false } = {}): ApproveResult {
  const state = inspectPhase1();
  if (state.missing.length > 0) return { ok: false, reason: 'INCOMPLETE', state };
  if (state.schemaErrors.length > 0 || state.hard.length > 0) return { ok: false, reason: 'INVALID', state };
  if (state.findings.length > 0 && !acceptFindings) return { ok: false, reason: 'FINDINGS', state };

  const approval: Phase1Approval = {
    status: 'APPROVED',
    approvedAt: new Date().toISOString(),
    approvedBy: userInfo().username,
    testCasesSha256: sha256Of('test-cases')!,
    automationPrioritizationSha256: sha256Of('automation-prioritization')!,
    discoveredBehaviorSha256: sha256Of('discovered-behavior')!,
    requirementsAnalysisSha256: sha256Of('requirements-analysis')!,
    counts: state.counts!,
    review: readReview(),
    acceptedFindings: state.findings.map(({ artifact, code, path, value }) => ({ artifact, code, path, value })),
  };
  mkdirSync(dirname(APPROVAL_PATH), { recursive: true });
  writeFileSync(APPROVAL_PATH, JSON.stringify(approval, null, 2), 'utf8');
  return { ok: true, approval };
}

export type GateResult =
  | { ok: true; approval: Phase1Approval; automationCases: AutomationPrioritization['cases'] }
  | { ok: false; code: 'INVALID' | 'NOT_APPROVED' | 'STALE' | 'NOTHING_TO_AUTOMATE'; message: string; changed?: string[] };

/** The Phase 2 entry condition. Every check is deterministic host code. */
export function checkPhase2Gate(): GateResult {
  const state = inspectPhase1();

  // 1-2. The approved inputs exist and are structurally sound.
  for (const name of ['test-cases', 'automation-prioritization'] as const) {
    if (state.missing.includes(name)) {
      return { ok: false, code: 'INVALID', message: `${name}.json does not exist. Run Phase 1 first:\nnpm run qa:manual` };
    }
  }
  if (state.schemaErrors.length > 0 || state.hard.length > 0) {
    const first = state.schemaErrors[0]
      ? `${state.schemaErrors[0].artifact}: ${state.schemaErrors[0].errors[0]}`
      : `${state.hard[0].artifact}: ${state.hard[0].code} at ${state.hard[0].path}${state.hard[0].value ? ` (${state.hard[0].value})` : ''}`;
    return { ok: false, code: 'INVALID', message: `Phase 1 artifacts are not valid (${first}).\nFix them, then run:\nnpm run qa:approve` };
  }

  // 3-4. A human approved.
  if (!existsSync(APPROVAL_PATH)) {
    return { ok: false, code: 'NOT_APPROVED', message: 'Phase 1 is not approved.\nReview/edit the test cases and run:\nnpm run qa:approve' };
  }
  let approval: Phase1Approval;
  try {
    approval = JSON.parse(readFileSync(APPROVAL_PATH, 'utf8')) as Phase1Approval;
  } catch {
    return { ok: false, code: 'NOT_APPROVED', message: 'Phase 1 approval file is unreadable.\nReview/edit the test cases and run:\nnpm run qa:approve' };
  }
  if (approval.status !== 'APPROVED') {
    return { ok: false, code: 'NOT_APPROVED', message: 'Phase 1 is not approved.\nReview/edit the test cases and run:\nnpm run qa:approve' };
  }

  // 5. What was approved is exactly what is on disk now.
  const changed = PHASE1_LOCKED.filter((name) => approval[HASH_FIELD[name]] !== sha256Of(name)).map((n) => `${n}.json`);
  if (changed.length > 0) {
    return {
      ok: false,
      code: 'STALE',
      changed,
      message: `Phase 1 approval is stale because the approved artifacts changed.\nChanged since approval: ${changed.join(', ')}\nReview and approve again.`,
    };
  }

  // 6. There is something for Phase 2 to do.
  const automationCases = (state.prioritization?.cases ?? []).filter((c) => c.executionMode === 'AUTOMATION');
  if (automationCases.length === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_AUTOMATE',
      message: 'Phase 1 is approved, but no test case is marked AUTOMATION.\nThe manual suite is complete; there is nothing for Phase 2 to do.',
    };
  }
  return { ok: true, approval, automationCases };
}
