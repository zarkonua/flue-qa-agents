// What the review agent sees for one change request — only what that request
// needs, assembled by the host. The agent never names an artifact or a path.

import { apiOperations, type Behavior, type CoverageContext, type DiscoveredBehavior, type EvidencedItem, type RequirementsAnalysis, type TestCase, type TestCases } from '../lib/semantic-validate.ts';
import { allowedTestLevels, DEFAULT_COVERAGE_MODE, testLevelOf, type CoverageMode, type TestLevel } from '../lib/coverage-mode.ts';
import type { ChangeProposal, ChangeRequest } from './review-store.ts';

export interface FocusedContext {
  request: {
    id: string;
    operation: ChangeRequest['operation'];
    targetTestCaseId?: string;
    humanComment?: string;
    manualEdits?: ChangeRequest['manualEdits'];
    /** Earlier rounds: what was proposed and what the person said about it. */
    earlierRounds: { proposalRationale: string; unresolvedIssues: string[]; feedback?: string }[];
  };
  targetCase?: TestCase;
  /** Behaviors this change can rest on. For a new case, all of them. */
  behaviors: Pick<Behavior, 'id' | 'area' | 'statement' | 'status' | 'suspectedIssue'>[];
  requirements: (Pick<EvidencedItem, 'id' | 'statement' | 'evidenceIds'> & { kind: 'acceptancePoint' | 'businessRule' })[];
  /**
   * Documented API operations this change can rest on — the only API facts
   * there are. Empty when the run read no API documentation, or is UI only.
   */
  apiOperations: { id: string; method: string; path: string; summary?: string; responses: string[]; requiresAuthentication: boolean }[];
  /** Every other active case, briefly — for duplicate awareness. */
  otherCases: { id: string; title: string; covers: string[]; testLevel: TestLevel }[];
  /** The run's coverage mode; `testLevels` in the vocabulary is what it allows. */
  coverageMode: CoverageMode;
  vocabulary: { priority: string[]; types: string[]; testLevels: TestLevel[] };
}

export function focusedContext(input: {
  request: ChangeRequest;
  suite: TestCases;
  discovery?: DiscoveredBehavior;
  requirements?: RequirementsAnalysis;
  proposals: ChangeProposal[];
  types: string[];
  /** The run's coverage mode and API documentation. Absent: AUTOMATIC, no API. */
  coverage?: CoverageContext;
}): FocusedContext {
  const { request, suite, discovery, requirements, proposals } = input;
  const target = suite.testCases.find((tc) => tc.id === request.targetTestCaseId);
  const reqs = [
    ...(requirements?.acceptancePoints ?? []).map((r) => ({ ...r, kind: 'acceptancePoint' as const })),
    ...(requirements?.businessRules ?? []).map((r) => ({ ...r, kind: 'businessRule' as const })),
  ];

  // An update is judged against what its case covers and cites; a new case
  // may need anything that was observed.
  let relevantReqs = reqs;
  let relevantBehaviorIds: Set<string> | undefined;
  if (target) {
    relevantReqs = reqs.filter((r) => target.covers?.includes(r.id));
    relevantBehaviorIds = new Set([...(target.evidenceIds ?? []), ...relevantReqs.flatMap((r) => r.evidenceIds)]);
  }
  const behaviors = (discovery?.behaviors ?? [])
    .filter((b) => relevantBehaviorIds === undefined || relevantBehaviorIds.has(b.id))
    .map(({ id, area, statement, status, suspectedIssue }) => ({ id, area, statement, status, suspectedIssue }));

  // Same narrowing for documented operations: an update sees the ones its case rests on.
  const operations = [...apiOperations(input.coverage).values()]
    .filter((o) => relevantBehaviorIds === undefined || relevantBehaviorIds.has(o.id))
    .map((o) => ({
      id: o.id, method: o.method, path: o.path, ...(o.summary ? { summary: o.summary } : {}),
      responses: o.responses.map((r) => r.status), requiresAuthentication: o.security.length > 0,
    }));
  const mode = input.coverage?.mode ?? DEFAULT_COVERAGE_MODE;

  const feedback = request.history.filter((h) => h.event === 'changes_requested');
  const earlierRounds = proposals
    .filter((p) => p.status === 'REJECTED' || p.status === 'SUPERSEDED')
    .map((p) => ({
      proposalRationale: p.rationale,
      unresolvedIssues: p.unresolvedIssues,
      feedback: feedback.find((h) => h.proposalId === p.id)?.note,
    }));

  return {
    request: {
      id: request.id,
      operation: request.operation,
      ...(request.targetTestCaseId ? { targetTestCaseId: request.targetTestCaseId } : {}),
      ...(request.humanComment ? { humanComment: request.humanComment } : {}),
      ...(request.manualEdits ? { manualEdits: request.manualEdits } : {}),
      earlierRounds,
    },
    ...(target ? { targetCase: target } : {}),
    behaviors,
    requirements: relevantReqs.map(({ id, statement, evidenceIds, kind }) => ({ id, statement, evidenceIds, kind })),
    apiOperations: operations,
    otherCases: suite.testCases.filter((tc) => tc.id !== target?.id).map((tc) => ({ id: tc.id, title: tc.title, covers: tc.covers ?? [], testLevel: testLevelOf(tc) })),
    coverageMode: mode,
    vocabulary: { priority: ['P0', 'P1', 'P2', 'P3'], types: input.types, testLevels: [...allowedTestLevels(mode)] },
  };
}
