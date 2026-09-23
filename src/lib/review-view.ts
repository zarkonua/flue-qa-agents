// The read model behind `npm run qa:ui`.
//
// One place that merges the Phase 1 artifacts into something a person can read,
// so the browser never has to understand five schemas — and never touches the
// filesystem. Pure assembly over the existing host libraries: it validates
// nothing itself, approves nothing itself, and computes no coverage of its own.
//
// Every optional artifact is genuinely optional. A workspace with only the four
// Phase 1 files must render; so must an empty one.

import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  qaArtifactPath,
  readQaArtifact,
  schemaErrorsFor,
  type QaArtifactName,
} from './qa-artifacts.ts';
import { APPROVAL_PATH, inspectPhase1, PHASE1_LOCKED, sha256Of, type Phase1Approval } from './phase1-gate.ts';
import {
  coverageSummary,
  summarize,
  testableRequirements,
  type AutomationPrioritization,
  type CoverageSummary,
  type RequirementsAnalysis,
  type ReviewSummary,
  type TestCases,
  type TestCasesReview,
} from './semantic-validate.ts';

export interface ReviewCase {
  id: string;
  title: string;
  priority: string;
  types: string[];
  tags: string[];
  preconditions: string[];
  testData: Record<string, unknown>;
  steps: { action: string; expected: string }[];
  expectedResult: string;
  evidenceIds: string[];
  /** Requirement IDs this case covers, paired with their statements where known. */
  covers: { id: string; statement?: string }[];
  automationCandidate: boolean;
  automationReason: string;
  /** From automation-prioritization; undefined when that stage has not run. */
  executionMode?: string;
  automationPriority?: string;
  prioritizationReason?: string;
  blockingFactors?: string[];
  /** Advisory reviewer issues that name this case. */
  reviewIssues: { severity: string; category?: string; message: string }[];
}

export interface ReviewModel {
  /** False when Phase 1 has not produced its artifacts yet. */
  hasPhase1: boolean;
  missing: string[];
  /** Schema problems, per artifact. Data is not rendered as valid when these exist. */
  schemaErrors: { artifact: string; errors: string[] }[];
  /** Semantic findings that would block approval, and structural ones that can never be approved. */
  findings: { artifact: string; code: string; path: string; value?: string; details?: string }[];
  blocking: { artifact: string; code: string; path: string; value?: string; details?: string }[];
  approval: {
    state: 'NONE' | 'APPROVED' | 'STALE';
    approvedBy?: string;
    approvedAt?: string;
    /** Which approved artifacts changed since approval — why it is stale. */
    changed: string[];
    acceptedFindings: number;
  };
  counts?: ReviewSummary;
  coverage?: CoverageSummary;
  priorityCounts: Record<string, number>;
  feature?: string;
  testCases: ReviewCase[];
  review?: {
    status: string;
    summary: ReviewSummary;
    issues: { testCaseId: string; severity: string; category?: string; message: string }[];
    suggestedChanges: { testCaseId: string; field?: string; change: string; rationale?: string }[];
    olderThanTestCases: boolean;
  };
}

/** Read an artifact only if it is present and schema-valid; never throw. */
function readValid<T>(name: QaArtifactName): { data?: T; schemaErrors: string[] } {
  let raw: unknown;
  try {
    raw = readQaArtifact(name);
  } catch (error) {
    return { schemaErrors: [`not valid JSON: ${(error as Error).message}`] };
  }
  if (raw === undefined) return { schemaErrors: [] };
  const errors = schemaErrorsFor(name, raw);
  return errors.length > 0 ? { schemaErrors: errors } : { data: raw as T };
}

function readApproval(): Phase1Approval | undefined {
  if (!existsSync(APPROVAL_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(APPROVAL_PATH, 'utf8')) as Phase1Approval;
  } catch {
    return undefined;
  }
}

const HASH_FIELD = {
  'discovered-behavior': 'discoveredBehaviorSha256',
  'requirements-analysis': 'requirementsAnalysisSha256',
  'test-cases': 'testCasesSha256',
  'automation-prioritization': 'automationPrioritizationSha256',
} as const;

/** Everything the review screen shows, assembled from whatever exists on disk. */
export function buildReviewModel(): ReviewModel {
  const state = inspectPhase1();

  const testCases = readValid<TestCases>('test-cases');
  const prioritization = readValid<AutomationPrioritization>('automation-prioritization');
  const requirements = readValid<RequirementsAnalysis>('requirements-analysis');
  const review = readValid<TestCasesReview>('test-cases-review');

  // Approval state, read through the same fields the gate locks on.
  const approvalFile = readApproval();
  const changed = approvalFile
    ? PHASE1_LOCKED.filter((name) => approvalFile[HASH_FIELD[name]] !== sha256Of(name)).map((n) => `${n}.json`)
    : [];
  const approval: ReviewModel['approval'] = {
    state: !approvalFile || approvalFile.status !== 'APPROVED' ? 'NONE' : changed.length > 0 ? 'STALE' : 'APPROVED',
    approvedBy: approvalFile?.approvedBy,
    approvedAt: approvalFile?.approvedAt,
    changed,
    acceptedFindings: approvalFile?.acceptedFindings?.length ?? 0,
  };

  const model: ReviewModel = {
    hasPhase1: state.missing.length === 0,
    missing: state.missing.map((n) => `${n}.json`),
    schemaErrors: state.schemaErrors.map((s) => ({ artifact: s.artifact, errors: s.errors })),
    findings: state.findings.map(({ artifact, code, path, value, details }) => ({ artifact, code, path, value, details })),
    blocking: state.hard.map(({ artifact, code, path, value, details }) => ({ artifact, code, path, value, details })),
    approval,
    counts: state.counts,
    priorityCounts: {},
    feature: testCases.data?.feature,
    testCases: [],
  };

  if (!testCases.data) return model;

  // Index the optional artifacts by test case, so a missing one simply leaves
  // those fields undefined rather than breaking the merge.
  const byCase = new Map((prioritization.data?.cases ?? []).map((c) => [c.testCaseId, c]));
  const statements = new Map(
    [...(requirements.data?.acceptancePoints ?? []), ...(requirements.data?.businessRules ?? [])].map((r) => [r.id, r.statement]),
  );
  const issuesByCase = new Map<string, ReviewCase['reviewIssues']>();
  for (const issue of review.data?.issues ?? []) {
    const list = issuesByCase.get(issue.testCaseId) ?? [];
    list.push({ severity: issue.severity, category: (issue as { category?: string }).category, message: issue.message });
    issuesByCase.set(issue.testCaseId, list);
  }

  model.testCases = testCases.data.testCases.map((tc) => {
    const p = byCase.get(tc.id);
    return {
      id: tc.id,
      title: tc.title,
      priority: String(tc.priority ?? ''),
      types: (tc.types as string[]) ?? [],
      tags: (tc.tags as string[]) ?? [],
      preconditions: tc.preconditions ?? [],
      testData: (tc.testData ?? {}) as Record<string, unknown>,
      steps: tc.steps ?? [],
      expectedResult: tc.expectedResult,
      evidenceIds: tc.evidenceIds ?? [],
      covers: (tc.covers ?? []).map((id) => ({ id, statement: statements.get(id) })),
      automationCandidate: Boolean(tc.automationCandidate),
      automationReason: String(tc.automationReason ?? ''),
      executionMode: p?.executionMode,
      automationPriority: p?.automationPriority,
      prioritizationReason: p?.reason,
      blockingFactors: p?.blockingFactors,
      reviewIssues: issuesByCase.get(tc.id) ?? [],
    };
  });

  for (const tc of model.testCases) {
    model.priorityCounts[tc.priority] = (model.priorityCounts[tc.priority] ?? 0) + 1;
  }

  if (prioritization.data) model.counts ??= summarize(prioritization.data);
  if (requirements.data) model.coverage = coverageSummary(requirements.data, testCases.data);

  if (review.data) {
    let olderThanTestCases = false;
    try {
      olderThanTestCases =
        statSync(qaArtifactPath('test-cases-review')).mtimeMs < statSync(qaArtifactPath('test-cases')).mtimeMs;
    } catch {
      olderThanTestCases = false;
    }
    model.review = {
      status: review.data.status,
      summary: review.data.summary,
      issues: review.data.issues,
      suggestedChanges: review.data.suggestedChanges ?? [],
      olderThanTestCases,
    };
  }

  return model;
}

/** Requirement IDs with no covering test case — for the UI's coverage panel. */
export function uncoveredRequirements(): string[] {
  const requirements = readValid<RequirementsAnalysis>('requirements-analysis').data;
  const testCases = readValid<TestCases>('test-cases').data;
  if (!requirements || !testCases) return [];
  const claimed = new Set(testCases.testCases.flatMap((tc) => tc.covers ?? []));
  return testableRequirements(requirements)
    .filter((r) => !claimed.has(r.id))
    .map((r) => r.id);
}
