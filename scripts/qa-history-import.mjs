#!/usr/bin/env node
// Import existing run archives (.qa/runs/<run-id>/) into the run history.
//
//   npm run qa:history:import
//
// Read-only on the archives; idempotent — a run already recorded is skipped
// (one whose index failed when it finished is re-indexed from its archive).
// New runs are recorded automatically; this is for archives made before the
// history existed, or to rebuild an index.

import { resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';
import { STAGES } from './lib/phase1-stages.mjs';
import { PHASE2_STAGES } from './lib/phase2-stages.mjs';

const { QA_ARTIFACT_ROOT } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));
const { runHistory, reconcileInterrupted } = await import(resolve(ROOT, 'src/history/service.ts'));
const { historyDbPath } = await import(resolve(ROOT, 'src/history/database.ts'));
const { importArchives } = await import(resolve(ROOT, 'src/history/importer.ts'));

let store;
try {
  store = runHistory();
} catch (error) {
  console.error(`\nCannot open the run history at ${historyDbPath(QA_ARTIFACT_ROOT)}:\n  ${error.message}\n`);
  process.exit(EXIT.FAILED);
}
const labels = Object.fromEntries([...STAGES, ...PHASE2_STAGES].map((s) => [s.key, s.label]));
const interrupted = reconcileInterrupted(store);
const report = importArchives(store, QA_ARTIFACT_ROOT, { stageLabels: { ...labels, review: 'Test Case Reviewer' } });

console.log('\nRUN HISTORY IMPORT');
console.log(`Database        : ${historyDbPath(QA_ARTIFACT_ROOT)}`);
console.log(`Archives found  : ${report.archivesFound}`);
console.log(`Imported        : ${report.imported.length}`);
console.log(`Skipped         : ${report.skipped.length} (already recorded)`);
if (report.reindexed.length) console.log(`Re-indexed      : ${report.reindexed.length} (${report.reindexed.join(', ')})`);
console.log(`Malformed       : ${report.malformed.length}`);
for (const m of report.malformed) console.log(`  ${m.id}: ${m.reason}`);
console.log(`Metrics         : ${report.metricsRecovered} recovered`);
console.log(`Artifacts       : ${report.artifactsIndexed} indexed`);
if (interrupted.length) console.log(`Interrupted     : ${interrupted.length} RUNNING run(s) whose process is gone were marked INTERRUPTED`);
console.log('');
process.exit(report.malformed.length > 0 ? EXIT.FAILED : EXIT.OK);
