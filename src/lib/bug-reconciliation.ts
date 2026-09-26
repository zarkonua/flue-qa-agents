// Carrying a person's bug decisions across a regenerated defect analysis.
//
// Re-running the Defect Analyzer produces fresh bug reports with fresh ids
// (BUG-001, BUG-002, …) and every decision PENDING. Where a regenerated report
// is materially the same defect as one a person already reviewed, their review
// carries over; otherwise it starts again. Deterministic host logic — no model
// decides whether two reports are the same bug.
//
// Material identity, never the bug id:
//
//   match key   area + the behaviors, acceptance points and business rules it
//               rests on + its ORIGINAL status (a person's downgrade counts as
//               the CONFIRMED it was generated as). Must be equal.
//   same claim  expected and actual, compared as canonical content words by
//               containment (the share of the shorter text's words the other
//               has too), so a model rewording its prose does not break
//               identity: actual >= SAME_ACTUAL, expected >= SAME_EXPECTED.
//
// The actual side is anchored to the cited behavior, so it stays close when
// reworded; the expected side is free prose and needs only a clear partial
// overlap. Measured on a real refresh: two reworded reports scored 0.83 / 0.82
// (actual) and 0.36 / 0.60 (expected); a genuinely different claim on the same
// evidence 0.25 / 0.00. The match key has already required the same evidence.
//
// Title, severity, priority and steps are presentation a person may edit;
// they are never part of identity.
//
//   materially same            -> PRESERVED: decision, note, downgrade and the
//                                 person's edits carry over (re-validated)
//   same key, different text   -> RESET to PENDING
//   no counterpart             -> NEW (PENDING)
//   old report not regenerated -> REMOVED from the active set (archived)
//
// A REJECTED report is preserved only under the same rule: a materially
// changed finding is a new question, and a person answers it again.

import { canonical, contentWords } from './semantic-validate.ts';
import type { BugReport } from './defects.ts';

/** Containment of the actual text at or above which two reports describe the same outcome. */
export const SAME_ACTUAL = 0.5;
/** Containment of the expected text at or above which two reports make the same claim. */
export const SAME_EXPECTED = 0.25;

const EDITABLE = ['title', 'severity', 'priority', 'steps'] as const;

const sorted = (ids: string[] | undefined) => [...(ids ?? [])].sort();

/** The part of a report that says WHICH defect it is. Never the id, never presentation. */
export function materialKey(b: BugReport): string {
  return JSON.stringify({
    area: b.area ?? '',
    status: b.review.downgradedFrom ?? b.status,
    behaviors: sorted(b.sourceBehaviorIds),
    acceptancePoints: sorted(b.sourceAcceptancePointIds),
    businessRules: sorted(b.sourceBusinessRuleIds),
  });
}

/** Share of the shorter text's content words that the other text also has. */
export function containment(a: string, b: string): number {
  const x = contentWords(canonical(a));
  const y = contentWords(canonical(b));
  if (x.size === 0 || y.size === 0) return x.size === y.size ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

/** Whether two reports on the same evidence make the same claim. */
export function sameClaim(a: BugReport, b: BugReport): boolean {
  return containment(a.actual, b.actual) >= SAME_ACTUAL && containment(a.expected, b.expected) >= SAME_EXPECTED;
}

/** How alike two reports' expected and actual are — for choosing between candidates. */
export function textSimilarity(a: BugReport, b: BugReport): number {
  return containment(a.expected, b.expected) + containment(a.actual, b.actual);
}

export interface ReconciliationPlan {
  preserved: { from: BugReport; to: BugReport; similarity: number }[];
  reset: { from: BugReport; to: BugReport; similarity: number }[];
  added: BugReport[];
  removed: BugReport[];
}

/**
 * Pair regenerated reports with earlier ones, one to one. Among candidates
 * with the same key the most similar wins; ties go to the lower id, so the
 * result never depends on file order.
 */
export function planReconciliation(previous: BugReport[], regenerated: BugReport[]): ReconciliationPlan {
  const byId = (a: BugReport, b: BugReport) => a.id.localeCompare(b.id);
  const unmatched = [...previous].sort(byId);
  const plan: ReconciliationPlan = { preserved: [], reset: [], added: [], removed: [] };
  for (const fresh of [...regenerated].sort(byId)) {
    const key = materialKey(fresh);
    let best: { old: BugReport; similarity: number } | undefined;
    for (const old of unmatched) {
      if (materialKey(old) !== key) continue;
      const similarity = textSimilarity(old, fresh);
      if (!best || similarity > best.similarity) best = { old, similarity };
    }
    if (!best) {
      plan.added.push(fresh);
      continue;
    }
    unmatched.splice(unmatched.indexOf(best.old), 1);
    (sameClaim(best.old, fresh) ? plan.preserved : plan.reset).push({ from: best.old, to: fresh, similarity: best.similarity });
  }
  plan.removed = unmatched;
  return plan;
}

/**
 * The regenerated report with the earlier review carried over: decision,
 * note, reviewer and time, a downgrade, and every field the person edited.
 * The caller re-validates it; `withEdits: false` carries the decision only.
 */
export function carryOver(from: BugReport, to: BugReport, { withEdits = true } = {}): BugReport {
  const next: BugReport = { ...to, review: { ...from.review } };
  if (!withEdits) delete next.review.editedFields;
  if (from.review.downgradedFrom) next.status = 'POTENTIAL';
  if (withEdits) {
    for (const field of from.review.editedFields ?? []) {
      if ((EDITABLE as readonly string[]).includes(field)) (next as unknown as Record<string, unknown>)[field] = from[field as (typeof EDITABLE)[number]];
    }
  }
  return next;
}

/** What a person reads after a refresh. Ids only; no report content. */
export interface ReconciliationSummary {
  preserved: { from: string; to: string; decision: string; editsCarried: boolean }[];
  reset: { from: string; to: string; previousDecision: string }[];
  added: string[];
  removed: { id: string; previousDecision: string }[];
}
