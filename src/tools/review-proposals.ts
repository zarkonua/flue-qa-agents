// The only two tools the focused review agent has.
//
//   read_change_request        the host-assembled context for ONE request
//   submit_test_case_proposal  store a proposal for that same request
//
// Which request is fixed by the host (QA_REVIEW_REQUEST_ID, set when it
// spawns the agent) — no tool input names a request, an artifact or a path.
// Neither tool can touch test-cases.json, the prioritization, bug reports or
// the Phase 1 approval: a proposal is stored as workflow state, and only a
// person's apply in the host changes the suite.

import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readQaArtifact, scenarioTypeVocabulary } from '../lib/qa-artifacts.ts';
import type { DiscoveredBehavior, RequirementsAnalysis, TestCases } from '../lib/semantic-validate.ts';
import { focusedContext } from '../review/context.ts';
import { REQUEST_ID } from '../review/review-store.ts';
import { submitAgentProposal, validateProposal } from '../review/test-case-changes.ts';
import { artifactWorkspace, defaultStore } from '../review/workspace.ts';

export const REQUEST_ENV = 'QA_REVIEW_REQUEST_ID';

async function currentRequest() {
  const id = process.env[REQUEST_ENV];
  if (!id || !REQUEST_ID.test(id)) throw new Error('No change request was assigned to this run.');
  const request = await defaultStore().getRequest(id);
  if (!request) throw new Error(`Change request ${id} does not exist.`);
  return request;
}

export const readChangeRequestTool = defineTool({
  name: 'read_change_request',
  description:
    'Read the change request you were assigned, with everything it needs: the person\'s comment and edits, ' +
    'the target test case if any, the behaviors and requirements it can rest on, the other active cases, ' +
    'and the allowed priority and type values. Takes no arguments.',
  input: v.object({}),
  async run() {
    const request = await currentRequest();
    const suite = readQaArtifact('test-cases') as TestCases | undefined;
    if (!suite) return { output: { error: 'There is no test suite.' } };
    return {
      output: focusedContext({
        request,
        suite,
        discovery: readQaArtifact('discovered-behavior') as DiscoveredBehavior | undefined,
        requirements: readQaArtifact('requirements-analysis') as RequirementsAnalysis | undefined,
        proposals: await defaultStore().listProposals(request.id),
        types: scenarioTypeVocabulary(),
      }),
    };
  },
});

const caseShape = v.record(v.string(), v.unknown());

export const submitProposalTool = defineTool({
  name: 'submit_test_case_proposal',
  description:
    'Submit your proposal for the assigned change request. `cases` holds COMPLETE test cases in the suite\'s ' +
    'schema — for an update, the whole resulting case first (the host keeps its id); further cases, or cases ' +
    'for a new test, get ids from the host. `rationale` explains what you did, including claims you dropped ' +
    'for lack of evidence. `unresolvedIssues` is ONLY for questions a person must answer before this can be ' +
    'applied — any entry disables Apply; leave it empty when the cases you submit are supported. ' +
    'Returns the host\'s validation; submitting again replaces your earlier proposal.',
  input: v.object({
    cases: v.pipe(v.array(caseShape), v.maxLength(5)),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
    evidenceRefs: v.pipe(v.array(v.string()), v.maxLength(50)),
    unresolvedIssues: v.pipe(v.array(v.string()), v.maxLength(20)),
  }),
  async run({ data }) {
    const store = defaultStore();
    const request = await currentRequest();
    const proposal = await submitAgentProposal(store, artifactWorkspace, request, data);
    const validation = validateProposal(artifactWorkspace, proposal);
    return {
      output: {
        submitted: true,
        proposalId: proposal.id,
        caseIds: proposal.proposedCases.map((c) => c.id),
        validation: { status: validation.status, problems: validation.problems.slice(0, 12), warnings: validation.warnings },
      },
    };
  },
});
