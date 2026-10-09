// A QA Review Workspace for the run-control browser tests: the real host server,
// the real RunController and run history, over its own temporary artifact root —
// so starting and cancelling runs never touches the other browser tests' workspace.
// The runner the controller forks is test/fixtures/fake-phase1-runner.mjs: the
// same contract and host modules as scripts/qa-manual.mjs, without a model or browser.
// The model name picks its behaviour: ollama/fake-complete, -slow, -fail.

import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');
const ROOT = mkdtempSync(join(tmpdir(), 'qa-ui-e2e-run-control-'));
Object.assign(process.env, {
  QA_ARTIFACT_ROOT: ROOT,
  TARGET_URL: 'http://localhost:4444/',
  QA_MODEL: 'ollama/fake-complete',
  QA_UI_MODELS: 'ollama/fake-slow,ollama/fake-fail',
  QA_DISCOVERY_AUX_ORIGINS: 'http://localhost:8025',
  FAKE_STAGE_MS: '1200',
});
mkdirSync(ROOT, { recursive: true });
for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization']) {
  copyFileSync(join(PROJECT, 'test', 'fixtures', 'phase1-approved', `${name}.json`), join(ROOT, `${name}.json`));
}

const { createUiServer } = await import('../src/ui-server/server.ts');
const { artifactWorkspace, defaultStore } = await import('../src/review/workspace.ts');
const history = await import('../src/history/service.ts');
const { RunController } = await import('../src/run-control/run-controller.ts');

const server = await createUiServer({
  store: defaultStore(),
  workspace: artifactWorkspace,
  runReviewAgent: async () => {},
  refresh: { start: async () => {}, status: () => ({ status: 'IDLE' as const }) },
  uiDir: join(PROJECT, 'ui', 'dist'),
  history: () => history.runHistory(),
  runController: new RunController({
    artifactRoot: ROOT, projectRoot: PROJECT, history: () => history.runHistory(),
    runnerScript: 'test/fixtures/fake-phase1-runner.mjs', graceMs: { cancel: 5000, term: 3000 },
  }),
});
const port = Number(process.env.QA_UI_PORT ?? 4557);
server.listen(port, '127.0.0.1', () => console.log(`e2e run-control workspace on http://127.0.0.1:${port} (artifacts ${ROOT})`));
