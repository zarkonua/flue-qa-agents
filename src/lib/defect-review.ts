// A person's decisions about bug reports. Trusted host code only — nothing here
// is mounted as a tool, and no agent can read or write a bug report file.
//
// Every change goes through `writeBugReport`, so an edited report is redacted
// and re-checked against the evidence exactly like the analyzer's own: a person
// may downgrade CONFIRMED to POTENTIAL or reword a title, but an edit that
// invents a route or claims an unsupported expectation is refused. Each change
// alters the file, which makes an existing Phase 1 approval stale.

import { userInfo } from 'node:os';
import { readBugReport, writeBugReport } from './qa-artifacts.ts';
import { PRIORITIES, SEVERITIES, type BugReport, type Priority, type Severity } from './defects.ts';

export const DECISIONS = ['accept', 'reject', 'downgrade', 'request-changes'] as const;
export type DecisionAction = (typeof DECISIONS)[number];

export class DefectReviewError extends Error {
  name = 'DefectReviewError';
}

function load(id: string): BugReport {
  let bug: BugReport | undefined;
  try {
    bug = readBugReport(id);
  } catch (error) {
    throw new DefectReviewError((error as Error).message);
  }
  if (bug === undefined) throw new DefectReviewError(`No bug report ${id}. List them with: npm run qa:defects`);
  return bug;
}

function stamp(bug: BugReport, by: string): BugReport['review'] {
  return { ...bug.review, by, at: new Date().toISOString() };
}

/** Record a decision. `request-changes` needs a note saying what should change. */
export function decide(id: string, action: DecisionAction, options: { note?: string; by?: string } = {}): BugReport {
  const bug = load(id);
  const by = options.by ?? userInfo().username;
  const note = options.note?.trim() || undefined;
  const review = { ...stamp(bug, by), ...(note ? { note } : {}) };
  let next: BugReport;
  switch (action) {
    case 'accept':
      next = { ...bug, review: { ...review, decision: 'ACCEPTED' } };
      break;
    case 'reject':
      next = { ...bug, review: { ...review, decision: 'REJECTED' } };
      break;
    case 'request-changes':
      if (!note) throw new DefectReviewError('request-changes needs --note saying what should change.');
      next = { ...bug, review: { ...review, decision: 'CHANGES_REQUESTED' } };
      break;
    case 'downgrade':
      if (bug.status !== 'CONFIRMED') throw new DefectReviewError(`${id} is ${bug.status}; only a CONFIRMED report can be downgraded.`);
      next = { ...bug, status: 'POTENTIAL', review: { ...review, downgradedFrom: 'CONFIRMED' } };
      break;
    default:
      throw new DefectReviewError(`Unknown decision "${action}". Use one of: ${DECISIONS.join(', ')}.`);
  }
  writeBugReport(next);
  return next;
}

export interface BugEdit {
  title?: string;
  severity?: string;
  priority?: string;
  steps?: string[];
}

/** Edit what a person may edit. Priority is only ever set here. */
export function edit(id: string, change: BugEdit, options: { by?: string } = {}): BugReport {
  if (change.title === undefined && change.severity === undefined && change.priority === undefined && change.steps === undefined) {
    throw new DefectReviewError('Nothing to edit. Use --title, --severity, --priority or --step.');
  }
  const bug = load(id);
  const edited = new Set(bug.review.editedFields ?? []);
  const next: BugReport = { ...bug };
  if (change.title !== undefined) {
    if (change.title.trim() === '') throw new DefectReviewError('--title cannot be empty.');
    next.title = change.title.trim();
    edited.add('title');
  }
  if (change.severity !== undefined) {
    if (!(SEVERITIES as readonly string[]).includes(change.severity)) throw new DefectReviewError(`--severity must be one of ${SEVERITIES.join(', ')}.`);
    next.severity = change.severity as Severity;
    edited.add('severity');
  }
  if (change.priority !== undefined) {
    if (!(PRIORITIES as readonly string[]).includes(change.priority)) throw new DefectReviewError(`--priority must be one of ${PRIORITIES.join(', ')}.`);
    next.priority = change.priority as Priority;
    edited.add('priority');
  }
  if (change.steps !== undefined) {
    const steps = change.steps.map((s) => s.trim()).filter(Boolean);
    if (steps.length === 0) throw new DefectReviewError('--step needs at least one non-empty step.');
    next.steps = steps;
    edited.add('steps');
  }
  next.review = { ...stamp(bug, options.by ?? userInfo().username), editedFields: [...edited].sort() };
  writeBugReport(next);
  return next;
}
