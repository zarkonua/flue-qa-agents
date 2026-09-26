#!/usr/bin/env node
// Re-derive what a changed test suite invalidated: Automation Prioritizer, then
// Defect Analyzer. All or nothing; never restores the Phase 1 approval.
//
//   npm run qa:refresh
//
// See scripts/lib/refresh.mjs.

import { resolve } from 'node:path';
import { EXIT, ROOT, createObservabilityOrExit } from './lib/runtime.mjs';
import { refreshDependents } from './lib/refresh.mjs';

const observability = await createObservabilityOrExit();
const result = await refreshDependents({ observability, attempts: Math.max(1, Number(process.env.QA_STAGE_ATTEMPTS ?? 4)) });
void resolve(ROOT);
if (!result.ok) {
  console.error(`\n${result.message}\n`);
  process.exit(result.reason === 'LOCKED' ? EXIT.BAD_CONFIG : EXIT.FAILED);
}
process.exit(EXIT.OK);
