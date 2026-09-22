#!/usr/bin/env node
// PHASE 2 — Automation Engineering. Entry gate only, for now.
//
//   npm run qa:automation
//
// Refuses to start unless Phase 1 is complete, valid, approved by a person,
// and unchanged since that approval. Then selects executionMode == AUTOMATION.
//
// The Phase 2 pipeline itself (Repo Analyzer, UI Explorer, Automation
// Generator, Test Runner, Failure Analyzer) is deliberately not wired in yet:
// this command stops after verifying the boundary.

import { resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';

const { checkPhase2Gate } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const gate = checkPhase2Gate();

if (!gate.ok) {
  console.error(`\n${gate.message}\n`);
  process.exit(EXIT.GATE_REFUSED);
}

const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const selected = [...gate.automationCases].sort((a, b) => order[a.automationPriority] - order[b.automationPriority]);

console.log('\n==============================================================');
console.log(' PHASE 2 GATE: OPEN');
console.log('==============================================================');
console.log(`Approved by     : ${gate.approval.approvedBy} at ${gate.approval.approvedAt}`);
console.log('Integrity       : all approved artifacts unchanged since approval');
console.log(`Selected        : ${selected.length} AUTOMATION case(s); ${gate.approval.counts.manual} MANUAL case(s) stay in the manual suite`);
for (const c of selected) console.log(`  ${c.automationPriority.padEnd(6)} ${c.testCaseId}  ${c.reason}`);
console.log('\nPhase 2 pipeline is not implemented yet — prerequisites verified; nothing was generated.\n');
process.exit(EXIT.OK);
