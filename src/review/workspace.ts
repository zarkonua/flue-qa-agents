// The canonical artifacts, through the same host library every stage uses.
// Reads are what is on disk; the one write goes through `replaceTestCases`,
// which redacts, validates and replaces test-cases.json atomically.

import { join } from 'node:path';
import {
  listBugReportIds,
  QA_ARTIFACT_ROOT,
  readBugReport,
  readQaArtifact,
  replaceTestCases,
  schemaErrorsFor,
  semanticErrorsFor,
} from '../lib/qa-artifacts.ts';
import { sha256Of } from '../lib/phase1-gate.ts';
import type { BugReport } from '../lib/defects.ts';
import type { TestCases } from '../lib/semantic-validate.ts';
import { FileReviewStore } from './review-store.ts';
import type { Workspace } from './test-case-changes.ts';

/** Where review workflow state lives: beside the artifacts, never among them. */
export const REVIEWS_DIR = join(QA_ARTIFACT_ROOT, 'reviews');

export function defaultStore(): FileReviewStore {
  return new FileReviewStore(REVIEWS_DIR);
}

export const artifactWorkspace: Workspace = {
  readTestCases: () => readQaArtifact('test-cases') as TestCases | undefined,
  testCasesSha256: () => sha256Of('test-cases'),
  schemaErrors: (candidate) => schemaErrorsFor('test-cases', candidate),
  semanticErrors: (candidate) => semanticErrorsFor('test-cases', candidate),
  // Coverage getting worse is impact a person accepted; everything else still refuses.
  writeTestCases: (candidate) => replaceTestCases(candidate, { allowCodes: ['UNCOVERED_ACCEPTANCE_POINT'] }),
  listBugs: () => listBugReportIds().map((id) => readBugReport(id)).filter((b): b is BugReport => b !== undefined),
};
