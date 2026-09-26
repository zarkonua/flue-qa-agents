#!/usr/bin/env node
// EXPERIMENTAL — model-driven orchestration via the QA Manager.
//
// This was the default `npm run qa` until 2026-09-22. It is kept for
// experiments with higher-level workflow decisions, but it is NOT the critical
// path any more: letting a 14B model decide whether to call the next stage
// completed the chain cleanly in only some runs. The default Phase 1 command is
// `npm run qa:manual`, which sequences the stages in host code.
//
//   export TARGET_URL="https://..."
//   npm run qa:agentic [-- -m "custom brief"] [-- --id my-run]
//
// Note: when a browser is configured, QA Manager also registers ui-explorer and
// automation-generator as delegates. Phase 1's approval gate does not apply here.

import { spawn } from 'node:child_process';
import { EXIT, ROOT, ensureMcp, preflightTarget, requireTarget, stopMcp } from './lib/runtime.mjs';

const target = requireTarget();

const DEFAULT_BRIEF =
  `Run QA discovery and test design for the application at ${target}. ` +
  'No written requirements exist, so this is the undocumented-product workflow: ' +
  'delegate to product-discovery, then behavior-analyst, then test-designer. ' +
  'Each specialist reads and writes its own .qa artifact; do not write artifacts yourself.';

const passthrough = process.argv.slice(2);
const hasMessage = passthrough.some((a) => a === '-m' || a === '--message' || a.startsWith('--message='));
const hasId = passthrough.some((a) => a === '--id' || a.startsWith('--id='));
const args = ['flue', 'run', 'src/agents/qa-manager.ts', ...passthrough];
if (!hasMessage) args.push('-m', DEFAULT_BRIEF);
if (!hasId) args.push('--new', '--id', `qa-agentic-${Date.now().toString(36)}`);

console.log('Mode            : EXPERIMENTAL model-driven orchestration (QA Manager)');
console.log(`Target          : ${target}`);

await ensureMcp();
await preflightTarget(target);

const run = spawn('npx', args, { cwd: ROOT, stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => run.kill(signal));
run.on('close', (code) => {
  stopMcp();
  process.exit(code ?? EXIT.FAILED);
});
