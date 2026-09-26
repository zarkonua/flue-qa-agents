#!/usr/bin/env node
// A person's review of the bug reports defect analysis produced. Trusted host
// code — not an LLM decision.
//
//   npm run qa:defects                                   list every report
//   npm run qa:defects -- show BUG-001                   print one report
//   npm run qa:defects -- accept BUG-001 [--note "…"]
//   npm run qa:defects -- reject BUG-001 [--note "…"]
//   npm run qa:defects -- downgrade BUG-001 [--note "…"]  CONFIRMED -> POTENTIAL
//   npm run qa:defects -- request-changes BUG-001 --note "…"
//   npm run qa:defects -- edit BUG-001 [--title "…"] [--severity MINOR] [--priority P2] [--step "…" …]
//
// Every change is re-validated against the Phase 1 evidence before it is
// written, and makes an existing approval stale: run `npm run qa:approve` again.

import { resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';

const qa = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const review = await import(resolve(ROOT, 'src/lib/defect-review.ts'));

const args = process.argv.slice(2);
const [command, id] = args;

function option(name) {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
}
function options(name) {
  const out = [];
  args.forEach((a, i) => { if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]); });
  return out;
}

function line(bug) {
  const decision = bug.review.decision + (bug.review.downgradedFrom ? ' (downgraded)' : '');
  return `${bug.id}  ${bug.status.padEnd(9)}  ${bug.severity.padEnd(8)}  ${bug.priority.padEnd(10)}  ${decision.padEnd(22)}  ${bug.title}`;
}

function fail(message, code = EXIT.BAD_CONFIG) {
  console.error(`\n${message}\n`);
  process.exit(code);
}

try {
  if (command === undefined || command === 'list') {
    const ids = qa.listBugReportIds();
    if (ids.length === 0) {
      const analysis = qa.readQaArtifact('defect-analysis');
      console.log(analysis ? '\nDefect analysis produced no bug reports.\n' : '\nNo defect analysis yet. Run: npm run qa:manual\n');
      process.exit(EXIT.OK);
    }
    console.log(`\n${'ID'.padEnd(7)}  ${'STATUS'.padEnd(9)}  ${'SEVERITY'.padEnd(8)}  ${'PRIORITY'.padEnd(10)}  ${'DECISION'.padEnd(22)}  TITLE`);
    for (const bugId of ids) console.log(line(qa.readBugReport(bugId)));
    console.log(`\nDetails: npm run qa:defects -- show <id>    Files: ${qa.BUGS_DIR}\n`);
    process.exit(EXIT.OK);
  }

  if (id === undefined) fail(`"${command}" needs a bug report id, e.g. npm run qa:defects -- ${command} BUG-001`);

  if (command === 'show') {
    const bug = qa.readBugReport(id);
    if (!bug) fail(`No bug report ${id}.`);
    console.log(JSON.stringify(bug, null, 2));
    process.exit(EXIT.OK);
  }

  let bug;
  if (command === 'edit') {
    const steps = options('step');
    bug = review.edit(id, {
      title: option('title'),
      severity: option('severity'),
      priority: option('priority'),
      steps: steps.length > 0 ? steps : undefined,
    });
  } else if (review.DECISIONS.includes(command)) {
    bug = review.decide(id, command, { note: option('note') });
  } else {
    fail(`Unknown command "${command}". Use: list, show, ${review.DECISIONS.join(', ')}, edit.`);
  }
  console.log(`\n${line(bug)}`);
  console.log('\nRecorded. Any existing Phase 1 approval is now stale — approve again with: npm run qa:approve\n');
  process.exit(EXIT.OK);
} catch (error) {
  if (error instanceof review.DefectReviewError) fail(error.message);
  if (error instanceof qa.SemanticValidationError) fail(`Not saved — the edited report is not supported by the evidence:\n${error.message}`, EXIT.GATE_REFUSED);
  throw error;
}
