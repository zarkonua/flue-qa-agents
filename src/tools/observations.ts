// The one way Product Discovery records what it saw, while it is still seeing it.
//
// Deliberately the narrowest tool in the project: three strings in, a
// host-assigned ID out. It cannot update an entry, cannot delete one, cannot
// choose an ID, and cannot name a file. Everything it writes goes to the
// ledger inside the artifact root — see `src/lib/observation-ledger.ts`.

import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { appendObservation } from '../lib/observation-ledger.ts';

export const recordObservationTool = defineTool({
  name: 'record_observation',
  description:
    'Record ONE thing you just observed, immediately after observing it — do not wait until the ' +
    'end of the session. Use it for a meaningful product outcome: a validation or error message ' +
    'appearing, a successful transition to another state, a control becoming enabled or disabled, ' +
    'a dialog opening or closing, a filter changing what is listed, a form submission and its ' +
    'result. Not for trivial UI noise. Returns the observation id to cite later. Recording the ' +
    'same thing twice is harmless: you get the original id back.',
  input: v.object({
    area: v.pipe(v.string(), v.minLength(1), v.description('Where you saw it — the area or page name')),
    action: v.pipe(v.string(), v.minLength(1), v.description('What you did, or the state you entered')),
    outcome: v.pipe(v.string(), v.minLength(1), v.description('What you then observed happen')),
    evidence: v.optional(v.pipe(v.string(), v.description('Optional: the URL or the snapshot ref that shows it'))),
  }),
  async run({ data }) {
    const result = appendObservation(data);
    if (!result.ok) return { output: { recorded: false, error: result.error } };
    return {
      output: {
        recorded: true,
        id: result.observation.id,
        ...(result.duplicateOf ? { alreadyRecorded: true } : {}),
      },
    };
  },
});
