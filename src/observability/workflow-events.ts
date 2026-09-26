// One short Langfuse trace per human workflow action — a bug decision, a bug
// edit — named after the action (`bug_accept`, `bug_edit`, …). Ids, states and
// field names only: never a title, a step, a note or any other report content.
//
// A no-op unless LANGFUSE_ENABLED=true, and never throws: metrics must not undo
// or block a decision a person made. Wired in at the edges (the `qa:defects`
// command and the workspace server), never inside the trusted defect service.

import { QA_MODEL } from '../config/env.ts';
import type { BugReviewEvent } from '../review/review-store.ts';
import { createRunObservability } from './host.ts';

type Metadata = Record<string, string | number | boolean | null | undefined>;

export async function recordWorkflowEvent(name: string, metadata: Metadata): Promise<void> {
  try {
    const obs = await createRunObservability();
    if (!obs.enabled) return;
    obs.startRun({ command: name, runId: `${name}-${Date.now().toString(36)}`, model: QA_MODEL, metadata, input: { event: name } });
    await obs.endRun({ outcome: 'COMPLETE' });
  } catch {
    // Misconfigured or unreachable tracing is reported by the runs; not here.
  }
}

/** Metadata for a bug review event: which report, what moved, which fields — nothing it says. */
export function bugEventMetadata(event: BugReviewEvent & { bugId: string }): Metadata {
  return {
    bugId: event.bugId,
    action: event.action,
    via: event.via ?? null,
    statusBefore: event.before.status,
    statusAfter: event.after.status,
    decisionBefore: event.before.decision,
    decisionAfter: event.after.decision,
    severityAfter: event.after.severity,
    priorityAfter: event.after.priority,
    editedFields: event.editedFields?.join(',') ?? null,
    notePresent: event.note !== undefined,
  };
}

/** The `onEvent` hook for the defect service: one trace per action. */
export const traceBugEvent = (event: BugReviewEvent & { bugId: string }) =>
  recordWorkflowEvent(`bug_${event.action.replace('-', '_')}`, bugEventMetadata(event));
