// A person's decisions about bug reports — the one implementation behind both
// `npm run qa:defects` and the review workspace. Trusted host code only:
// nothing here is mounted as a tool, and no agent can read or write a bug
// report file.
//
// Every change goes through `writeBugReport`, so an edited report is redacted
// and re-checked against the evidence exactly like the analyzer's own: a person
// may downgrade CONFIRMED to POTENTIAL or reword a title, but an edit that
// invents a route or claims an unsupported expectation is refused and nothing
// is written. Each change alters the file, which makes an existing Phase 1
// approval stale; nothing else depends on bug reports, so nothing else goes
// stale.
//
// The decision itself lives in the bug file (it is a QA result the approval
// hashes). Each round is also appended to the review history in the
// ReviewStore, when one is given, so earlier rounds stay visible.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { bugReportErrors, bugReportPath, readBugReport, writeBugReport } from './qa-artifacts.ts';
import { PRIORITIES, SEVERITIES, type BugReport, type Priority, type Severity } from './defects.ts';
import type { BugAction, BugReviewEvent, BugReviewState, ReviewStore } from '../review/review-store.ts';

export const DECISIONS = ['accept', 'reject', 'downgrade', 'request-changes'] as const;
export type DecisionAction = (typeof DECISIONS)[number];

/** The fields a person may edit. Ids, evidence, sources and environment stay host-controlled. */
export const EDITABLE_BUG_FIELDS = ['title', 'severity', 'priority', 'steps'] as const;

export class DefectReviewError extends Error {
  name = 'DefectReviewError';
}
/** The report changed since the person looked at it. */
export class DefectReviewConflictError extends DefectReviewError {
  name = 'DefectReviewConflictError';
}

export interface ReviewOptions {
  note?: string;
  by?: string;
  via?: 'cli' | 'ui';
  /** Where review history is kept. Without it, only the bug file records the latest decision. */
  store?: ReviewStore;
  /** SHA-256 of the bug file the person was looking at; a different file is a conflict. */
  baseSha256?: string;
  /** Called after a change is written — for metrics. Must not throw. */
  onEvent?: (event: BugReviewEvent & { bugId: string }) => void | Promise<void>;
}

export interface ReviewResult {
  bug: BugReport;
  event: BugReviewEvent;
}

/** SHA-256 of the bug file as it is on disk. */
export function bugReportSha256(id: string): string | undefined {
  const path = bugReportPath(id);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
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

const stateOf = (b: BugReport): BugReviewState => ({ status: b.status, decision: b.review.decision, severity: b.severity, priority: b.priority });

function checkBase(id: string, baseSha256: string | undefined) {
  if (baseSha256 !== undefined && bugReportSha256(id) !== baseSha256) {
    throw new DefectReviewConflictError(`${id} changed since you opened it. Reload it and try again.`);
  }
}

async function record(id: string, action: BugAction, before: BugReport, after: BugReport, opts: ReviewOptions, editedFields?: string[]): Promise<ReviewResult> {
  const event: BugReviewEvent = {
    at: after.review.at ?? new Date().toISOString(),
    action,
    by: after.review.by ?? opts.by ?? userInfo().username,
    ...(opts.via ? { via: opts.via } : {}),
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    ...(editedFields ? { editedFields } : {}),
    before: stateOf(before),
    after: stateOf(after),
  };
  await opts.store?.addBugReviewEvent(id, event);
  try {
    await opts.onEvent?.({ ...event, bugId: id });
  } catch {
    // Metrics must never undo a decision that was written.
  }
  return { bug: after, event };
}

/** Record a decision. `request-changes` needs a note saying what should change. */
export async function decide(id: string, action: DecisionAction, opts: ReviewOptions = {}): Promise<ReviewResult> {
  if (!(DECISIONS as readonly string[]).includes(action)) throw new DefectReviewError(`Unknown decision "${action}". Use one of: ${DECISIONS.join(', ')}.`);
  const bug = load(id);
  checkBase(id, opts.baseSha256);
  const by = opts.by ?? userInfo().username;
  const note = opts.note?.trim() || undefined;
  const review = { ...bug.review, by, at: new Date().toISOString(), ...(note ? { note } : {}) };
  let next: BugReport;
  switch (action) {
    case 'accept':
      next = { ...bug, review: { ...review, decision: 'ACCEPTED' } };
      break;
    case 'reject':
      next = { ...bug, review: { ...review, decision: 'REJECTED' } };
      break;
    case 'request-changes':
      if (!note) throw new DefectReviewError('request-changes needs a note saying what should change.');
      // The report itself is untouched: only its review state and note change.
      next = { ...bug, review: { ...review, decision: 'CHANGES_REQUESTED' } };
      break;
    case 'downgrade':
      if (bug.status !== 'CONFIRMED') throw new DefectReviewError(`${id} is ${bug.status}; only a CONFIRMED report can be downgraded.`);
      next = { ...bug, status: 'POTENTIAL', review: { ...review, downgradedFrom: 'CONFIRMED' } };
      break;
  }
  writeBugReport(next);
  return record(id, action, bug, next, opts);
}

export interface BugEdit {
  title?: string;
  severity?: string;
  priority?: string;
  steps?: string[];
}

export interface EditPreview {
  current: BugReport;
  next: BugReport;
  /** Fields whose value actually changes. */
  changedFields: string[];
  /** Why this edit would be refused; empty when it can be applied. */
  problems: string[];
  /** The bug file this preview was made from; pass it back to apply. */
  baseSha256: string;
}

/**
 * What an edit would produce, validated but not written. Priority is only
 * ever set here — the analyzer cannot set it.
 */
export function previewEdit(id: string, change: BugEdit): EditPreview {
  if (change.title === undefined && change.severity === undefined && change.priority === undefined && change.steps === undefined) {
    throw new DefectReviewError('Nothing to edit. Change the title, severity, priority or steps.');
  }
  const bug = load(id);
  const next: BugReport = { ...bug };
  const changed: string[] = [];
  if (change.title !== undefined) {
    if (change.title.trim() === '') throw new DefectReviewError('The title cannot be empty.');
    next.title = change.title.trim();
  }
  if (change.severity !== undefined) {
    if (!(SEVERITIES as readonly string[]).includes(change.severity)) throw new DefectReviewError(`Severity must be one of ${SEVERITIES.join(', ')}.`);
    next.severity = change.severity as Severity;
  }
  if (change.priority !== undefined) {
    if (!(PRIORITIES as readonly string[]).includes(change.priority)) throw new DefectReviewError(`Priority must be one of ${PRIORITIES.join(', ')}.`);
    next.priority = change.priority as Priority;
  }
  if (change.steps !== undefined) {
    const steps = change.steps.map((s) => s.trim()).filter(Boolean);
    if (steps.length === 0) throw new DefectReviewError('A bug report needs at least one step.');
    next.steps = steps;
  }
  for (const field of EDITABLE_BUG_FIELDS) {
    if (JSON.stringify(next[field]) !== JSON.stringify(bug[field])) changed.push(field);
  }
  const edited = new Set([...(bug.review.editedFields ?? []), ...changed]);
  next.review = { ...bug.review, editedFields: [...edited].sort() };
  const { schema, semantic } = bugReportErrors(next);
  const problems = [
    ...schema,
    ...semantic.map((e) => `[${e.code}] ${e.path}${e.value !== undefined ? ` = ${JSON.stringify(e.value)}` : ''}${e.details ? ` — ${e.details}` : ''}`),
    ...(changed.length === 0 ? ['Nothing would change.'] : []),
  ];
  return { current: bug, next, changedFields: changed, problems, baseSha256: bugReportSha256(id)! };
}

/** Apply an edit. Refused when invalid, unchanged, or made against an older version of the report. */
export async function edit(id: string, change: BugEdit, opts: ReviewOptions = {}): Promise<ReviewResult> {
  checkBase(id, opts.baseSha256);
  const preview = previewEdit(id, change);
  if (preview.problems.length > 0) throw new DefectReviewError(`Not saved — ${preview.problems.join('; ')}`);
  const next: BugReport = {
    ...preview.next,
    review: { ...preview.next.review, by: opts.by ?? userInfo().username, at: new Date().toISOString(), ...(opts.note?.trim() ? { note: opts.note.trim() } : {}) },
  };
  writeBugReport(next);
  return record(id, 'edit', preview.current, next, opts, preview.changedFields);
}
