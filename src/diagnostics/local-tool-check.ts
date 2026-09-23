'use agent';

// REGRESSION CHECK — not a production agent.
//
// Verifies the narrowest possible tool-calling path: Flue reaches the model
// with a tool definition, the model emits a tool call, Flue parses it, and the
// tool body actually runs. One trivial local tool; no MCP, no subagents, no
// skills.
//
// This exists because a duplicate `@earendil-works/pi-ai` install once made
// Flue send requests with NO system prompt and NO tools array, which looks
// exactly like "the model refuses to call tools". Run this first whenever an
// agent mysteriously stops using its tools, and before blaming the model.
//
//   npm run check:tools
//
// PASS: output contains "[check] get_magic_number EXECUTED" and the reply says 42.

import { QA_MODEL } from '../providers/model.ts';
import { defineTool, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

export const getMagicNumberTool = defineTool({
  name: 'get_magic_number',
  description: 'Returns the magic number. The magic number cannot be known any other way.',
  input: v.object({}),
  async run() {
    console.error('[check] get_magic_number EXECUTED');
    return { output: { magicNumber: 42 } };
  },
});

export function LocalToolCheck() {
  useModel(QA_MODEL);
  useTool(getMagicNumberTool);
  return 'You answer questions about the magic number. You must call get_magic_number before answering.';
}

LocalToolCheck.agentName = 'local-tool-check';
