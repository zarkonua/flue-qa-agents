import { defineConfig } from '@playwright/test';

// Browser tests for the QA Review Workspace: `npm run test:ui-e2e`.
// Builds the UI, then serves it from the real host server over fixture artifacts.
const PORT = 4555;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, browserName: 'chromium' },
  webServer: {
    command: `npx vite build ui --logLevel warn && node e2e/serve-fixture.ts`,
    cwd: `${import.meta.dirname}/..`,
    url: `http://127.0.0.1:${PORT}/api/overview`,
    env: { QA_UI_PORT: String(PORT), QA_ENV_FILE: '/nonexistent', LANGFUSE_ENABLED: 'false' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
