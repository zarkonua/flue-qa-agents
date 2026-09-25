import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readQaArtifact, writeQaArtifact, type QaArtifactName } from '../lib/qa-artifacts.ts';
import { COMPLETION_LOG, DiscoveryIncompleteError, type DiscoveryCompletionResult } from '../lib/discovery-completion.ts';

/** Flat, machine-readable attributes of one verdict. Codes, never messages. */
export function completionAttributes(result: DiscoveryCompletionResult): Record<string, unknown> {
  const codes = [...new Set(result.reasons.map((r) => r.code))];
  return {
    canFinalize: result.canFinalize,
    reasonCodes: codes.join(','),
    reasonCount: result.reasons.length,
    exhausted: result.exhausted,
    ...result.metrics,
  };
}

/** Artifacts an agent may WRITE. `discovery-evidence` is deliberately absent. */
const ARTIFACT_NAMES = [
  'discovered-behavior',
  'requirements-analysis',
  'test-cases',
  'automation-prioritization',
  'test-cases-review',
  'repo-analysis',
  'ui-exploration',
  'automation-plan',
] as const satisfies readonly QaArtifactName[];

/**
 * Artifacts an agent may READ: everything writable, plus the host-collected
 * browser evidence.
 *
 * `discovery-evidence` is readable but not writable, and that asymmetry is the
 * point. The host reads console and network facts out of the browser itself;
 * a model may interpret them, and may not author, amend or contradict them.
 * Leaving it out of the write picklist is what enforces that — the tool's
 * input schema rejects the name before `run` executes, so it does not depend
 * on any instruction the model could ignore.
 */
const READABLE_ARTIFACT_NAMES = [
  ...ARTIFACT_NAMES,
  'discovery-evidence',
  'automation-project-contract',
] as const satisfies readonly QaArtifactName[];

// Note: `phase1-approval.json` is deliberately absent from both lists. Approval
// is written only by trusted host code (`npm run qa:approve`); no agent can
// read or write it.

export const readQaArtifactTool = defineTool({
  name: 'read_qa_artifact',
  description:
    'Read one QA hand-off artifact by its logical name (not a filesystem path). Returns the ' +
    'parsed JSON, or { exists: false } if that artifact has not been written yet.',
  input: v.object({
    name: v.picklist(READABLE_ARTIFACT_NAMES, 'name must be one of: ' + READABLE_ARTIFACT_NAMES.join(', ')),
  }),
  async run({ data }) {
    const artifact = readQaArtifact(data.name as QaArtifactName);
    if (artifact === undefined) return { output: { exists: false } };
    return { output: { exists: true, data: artifact } };
  },
});

/**
 * A `write_qa_artifact` tool that can write only the listed artifacts.
 *
 * Each agent gets the narrowest one: the Reviewer can write its review but not
 * the test cases it reviews; the Prioritizer can write priorities but cannot
 * alter a single test case. This is enforced by the tool's input schema, not by
 * asking the model — a name outside the list is rejected before `run` executes.
 */
export function writeQaArtifactToolFor<const T extends readonly QaArtifactName[]>(allowed: T) {
  const names = [...allowed] as [T[number], ...T[number][]];
  return defineTool({
    name: 'write_qa_artifact',
    description:
      `Write your QA hand-off artifact by its logical name (not a filesystem path). You may write: ` +
      `${names.join(', ')}. Before anything is written the object is checked twice: against the ` +
      "artifact's JSON schema, and against the upstream artifacts — every ID you reference must exist " +
      'upstream, and no route, credential, quoted UI text, or product feature may appear unless upstream ' +
      'evidence contains it. A rejected write returns the exact problems; fix every one and retry. ' +
      'Always pass the complete object (this replaces the file, it does not merge).',
    input: v.object({
      name: v.picklist(names, 'you may only write: ' + names.join(', ')),
      data: v.record(v.string(), v.unknown()),
    }),
    async run({ data, log }) {
      try {
        const { completion } = writeQaArtifact(data.name as QaArtifactName, data.data);
        if (completion) log.info(COMPLETION_LOG, completionAttributes(completion));
      } catch (error) {
        // A completion-gate rejection is a finalization attempt, not a broken
        // write: logged with its reason codes so a trace can show it.
        if (error instanceof DiscoveryIncompleteError) log.warn(COMPLETION_LOG, completionAttributes(error.result));
        throw error;
      }
      return { output: { written: true, name: data.name } };
    },
  });
}

/** Unrestricted — kept only for the experimental QA Manager path and Phase 2 agents. */
export const writeQaArtifactTool = writeQaArtifactToolFor(ARTIFACT_NAMES);
