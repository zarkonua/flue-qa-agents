#!/usr/bin/env node
// The human approval gate. Trusted host code — not an LLM decision.
//
//   npm run qa:approve                    approve the current Phase 1 result
//   npm run qa:approve -- --accept-findings
//                                         approve despite semantic findings (for
//                                         deliberate hand edits); they are recorded
//
// Writes .qa/phase1-approval.json with the SHA-256 of every Phase 1 artifact.
// Any later change to those files makes the approval stale automatically.

import { resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';

const { approvePhase1, APPROVAL_PATH } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const acceptFindings = process.argv.includes('--accept-findings');
const result = approvePhase1({ acceptFindings });

const line = (f) => `  - ${f.artifact}: [${f.code}] ${f.path}${f.value !== undefined ? ` = ${JSON.stringify(f.value).slice(0, 80)}` : ''}`;

if (!result.ok) {
  const { state } = result;
  if (result.reason === 'INCOMPLETE') {
    console.error(`\nCannot approve — Phase 1 is incomplete. Missing: ${state.missing.map((n) => `${n}.json`).join(', ')}\nRun: npm run qa:manual\n`);
  } else if (result.reason === 'INVALID') {
    console.error('\nCannot approve — Phase 1 artifacts are structurally invalid (this cannot be overridden):');
    for (const s of state.schemaErrors) for (const e of s.errors.slice(0, 5)) console.error(`  - ${s.artifact}: schema: ${e}`);
    for (const f of state.hard) console.error(line(f));
    console.error('\nFix them (after editing test cases: npm run qa:manual -- --from prioritization), then approve again.\n');
  } else {
    console.error(`\nNot approved — ${state.findings.length} semantic finding(s) in the Phase 1 artifacts:`);
    for (const f of state.findings.slice(0, 20)) console.error(line(f));
    if (state.findings.length > 20) console.error(`  ... and ${state.findings.length - 20} more`);
    console.error('\nIf these come from your own deliberate edits, approve with:');
    console.error('  npm run qa:approve -- --accept-findings');
    console.error('Otherwise fix the artifacts first.\n');
  }
  process.exit(EXIT.GATE_REFUSED);
}

const { approval } = result;
const c = approval.counts;
console.log('\n==============================================================');
console.log(' PHASE 1 APPROVED');
console.log('==============================================================');
console.log(`Approved by     : ${approval.approvedBy} at ${approval.approvedAt}`);
console.log(`Test cases      : ${c.total}  (${c.manual} MANUAL, ${c.automation} AUTOMATION: ${c.automationHigh} high / ${c.automationMedium} medium / ${c.automationLow} low)`);
console.log(`AI review       : ${approval.review ? `${approval.review.status}${approval.review.olderThanTestCases ? ' (older than the current test cases)' : ''}` : 'none run'}`);
if (approval.acceptedFindings.length > 0) console.log(`Accepted        : ${approval.acceptedFindings.length} semantic finding(s), recorded in the approval`);
console.log(`test-cases      : sha256 ${approval.testCasesSha256}`);
console.log(`prioritization  : sha256 ${approval.automationPrioritizationSha256}`);
console.log(`Written         : ${APPROVAL_PATH}`);
console.log('\nAny change to the approved artifacts makes this approval stale. Next:\n  npm run qa:automation\n');
process.exit(EXIT.OK);
