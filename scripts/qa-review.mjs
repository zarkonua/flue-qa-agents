#!/usr/bin/env node
// Optional Phase 1 review of the manual suite and its automation priorities.
//
//   npm run qa:review
//
// The Test Case Reviewer PROPOSES changes into test-cases-review.json. It
// cannot modify test-cases.json (its write tool accepts only its own review),
// and an AI review is never approval: only `npm run qa:approve` is.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, ROOT, runAgent } from './lib/runtime.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { PHASE1_LOCKED, sha256Of } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));

const missing = PHASE1_LOCKED.filter((name) => qa.readQaArtifact(name) === undefined);
if (missing.length > 0) {
  console.error(`\nNothing to review yet — missing: ${missing.map((n) => `${n}.json`).join(', ')}\nRun: npm run qa:manual\n`);
  process.exit(EXIT.BAD_CONFIG);
}

// Hash the reviewed inputs before and after: the reviewer must not change them.
const before = Object.fromEntries(PHASE1_LOCKED.map((n) => [n, sha256Of(n)]));

console.log('\nPHASE 1 — Test Case Review (advisory; edits nothing)\n');
const path = qa.qaArtifactPath('test-cases-review');
const attempts = Math.max(1, Number(process.env.QA_STAGE_ATTEMPTS ?? 4));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let id;
let written = false;
let code = EXIT.FAILED;
// Same retry policy as qa:manual: one conversation, continued with a precise
// nudge, so a turn that ends without writing is recovered rather than repeated.
for (let attempt = 1; attempt <= attempts && !written; attempt += 1) {
  const resume = attempt % 2 === 0; // alternate, as in qa:manual
  if (!resume) id = `p1-review-${stamp}-${attempt}`;
  const started = Date.now();
  const message =
    !resume
      ? 'Review the four Phase 1 artifacts and write the test-cases-review artifact.'
      : 'Nothing was saved: your last turn ended without a successful write_qa_artifact call. Call write_qa_artifact now with name "test-cases-review" and the complete object.';
  code = await runAgent('src/agents/test-case-reviewer.ts', message, id, { resume });
  written = existsSync(path) && statSync(path).mtimeMs >= started - 1000;
  if (!written && attempt < attempts) console.log(`\n--- review not written; retrying (attempt ${attempt + 1}/${attempts})\n`);
}

const tampered = PHASE1_LOCKED.filter((n) => sha256Of(n) !== before[n]);
if (tampered.length > 0) {
  console.error(`\nSECURITY: reviewed artifacts changed during review: ${tampered.join(', ')}. Treat this run as untrusted.\n`);
  process.exit(EXIT.FAILED);
}

if (!written) {
  console.error(`\nThe reviewer did not write a review (agent exit ${code}). Re-run: npm run qa:review\n`);
  process.exit(EXIT.FAILED);
}
const review = qa.readQaArtifact('test-cases-review');
const bySeverity = review.issues.reduce((acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] ?? 0) + 1 }), {});

console.log('\n==============================================================');
console.log(` REVIEW: ${review.status}`);
console.log('==============================================================');
console.log(`Issues          : ${review.issues.length} ${JSON.stringify(bySeverity)}`);
console.log(`Suggested edits : ${review.suggestedChanges.length}`);
for (const issue of review.issues.slice(0, 10)) console.log(`  [${issue.severity}] ${issue.testCaseId}: ${issue.message}`);
console.log(`\ntest-cases.json was NOT modified. You decide what to apply:`);
console.log(`  jq . ${path}`);
console.log('  edit test-cases.json yourself (then: npm run qa:manual -- --from prioritization)');
console.log('  npm run qa:approve     # when you are satisfied\n');
process.exit(EXIT.OK);
