#!/usr/bin/env node
// Check the run history against the archives on disk. Reads only.
//
//   npm run qa:history:verify
//
// Reports archives the history does not know, indexed files that are missing or
// changed, archived files that are not indexed, and runs still RUNNING.

import { resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';

const { QA_ARTIFACT_ROOT } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { runHistory, ownerAlive } = await import(resolve(ROOT, 'src/history/service.ts'));
const { historyDbPath } = await import(resolve(ROOT, 'src/history/database.ts'));
const { verifyHistory } = await import(resolve(ROOT, 'src/history/importer.ts'));

let store;
try {
  store = runHistory();
} catch (error) {
  console.error(`\nCannot open the run history at ${historyDbPath(QA_ARTIFACT_ROOT)}:\n  ${error.message}\n`);
  process.exit(EXIT.FAILED);
}
const report = verifyHistory(store, QA_ARTIFACT_ROOT);
const stale = report.running.filter((id) => !ownerAlive(store.getRun(id)));

console.log('\nRUN HISTORY VERIFY');
console.log(`Database        : ${historyDbPath(QA_ARTIFACT_ROOT)}`);
console.log(`Runs recorded   : ${report.runs}`);
console.log(`Running         : ${report.running.length}${stale.length ? ` (${stale.length} with no live process — opening the workspace or the next run marks them INTERRUPTED)` : ''}`);
console.log(`Not recorded    : ${report.archivesNotRecorded.length}${report.archivesNotRecorded.length ? ' archive(s) — run: npm run qa:history:import' : ''}`);
for (const id of report.archivesNotRecorded) console.log(`  ${id}`);
console.log(`Problems        : ${report.problems.length}`);
for (const p of report.problems) console.log(`  ${p.runId}: ${p.problem}`);
console.log('');
process.exit(report.problems.length > 0 || report.archivesNotRecorded.length > 0 ? EXIT.FAILED : EXIT.OK);
