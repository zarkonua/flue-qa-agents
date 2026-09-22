#!/usr/bin/env node
// Diagnoses the Playwright integration end to end: the Test runner, the browser
// binary and its Linux system deps, the CLI, the official CLI skill, and — the
// part that actually gates the Flue browser agents — the standalone Playwright
// MCP server and the tool allowlist the agents mount from it.
//
// Usage: npm run check:playwright

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (label, detail = '') => console.log(`  OK       ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, detail) => console.log(`  WARN     ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`  MISSING  ${label}${detail ? ` — ${detail}` : ''}`);
};

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', cwd: ROOT, timeout: 120_000, ...opts });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(), error: res.error };
}

console.log('\n== Playwright Test ==');
try {
  const version = execFileSync('npx', ['playwright', '--version'], { cwd: ROOT, encoding: 'utf8' }).trim();
  ok('@playwright/test', version);
} catch {
  bad('@playwright/test', 'run: npm install -D @playwright/test');
}

console.log('\n== Chromium ==');
const launch = run('node', [
  '-e',
  `const { chromium } = require('playwright');
   chromium.launch().then(async (b) => { await b.close(); console.log('LAUNCH_OK'); })
     .catch((e) => { console.error(e.message); process.exit(1); });`,
]);
if (launch.out.includes('LAUNCH_OK')) {
  ok('chromium launches headless');
} else if (/error while loading shared libraries|libnspr4|libnss3/.test(launch.out)) {
  bad('chromium system dependencies', 'run: sudo npx playwright install-deps chromium');
} else if (/Executable doesn't exist/.test(launch.out)) {
  bad('chromium browser binary', 'run: npx playwright install chromium');
} else {
  bad('chromium launch', launch.out.split('\n')[0] ?? 'unknown failure');
}

console.log('\n== Display (headed exploration) ==');
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
  ok('WSLg/X display available', `DISPLAY=${process.env.DISPLAY ?? '-'} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '-'}`);
} else {
  warn('no display', 'headed exploration unavailable; headless still works');
}

console.log('\n== Playwright CLI ==');
const cli = run('playwright-cli', ['--version']);
if (cli.code === 0) {
  ok('playwright-cli', cli.out.split('\n')[0]);
} else {
  bad('playwright-cli', 'run: sudo npm install -g @playwright/cli@latest');
}

console.log('\n== Official Playwright CLI skill ==');
if (existsSync(resolve(ROOT, '.claude/skills/playwright-cli'))) {
  ok('.claude/skills/playwright-cli');
} else {
  bad('.claude/skills/playwright-cli', 'run: playwright-cli install --skills');
}

console.log('\n== Playwright MCP (Flue browser agents) ==');

// Resolve the endpoint exactly as the agents do, so this check cannot pass
// against a URL the runtime would not actually use.
const { DEFAULT_PLAYWRIGHT_MCP_URL, DISCOVERY_BROWSER_TOOLS, UI_EXPLORER_BROWSER_TOOLS, FORBIDDEN_BROWSER_TOOLS, playwrightMcpUrl } =
  await import(resolve(ROOT, 'src/connections/playwright-mcp.ts'));

const configured = playwrightMcpUrl();
const url = configured ?? DEFAULT_PLAYWRIGHT_MCP_URL;
if (configured === undefined) {
  warn('PLAYWRIGHT_MCP_URL not set', `browser agents run without a browser; probing the default ${url}`);
}
if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) {
  warn('endpoint uses 127.0.0.1', '@playwright/mcp rejects it with 403; use localhost or pass --allowed-hosts');
}

try {
  const { createMcpConnection } = await import('@flue/runtime');
  const conn = await createMcpConnection({ name: 'playwright', url });
  const served = new Set(conn.tools.map((t) => t.name.replace(/^mcp__playwright__/, '')));
  ok('MCP server reachable', `${url} — ${served.size} tools`);

  const missing = [...new Set([...DISCOVERY_BROWSER_TOOLS, ...UI_EXPLORER_BROWSER_TOOLS])].filter((t) => !served.has(t));
  if (missing.length === 0) ok('every allowlisted tool is served by this server version');
  else bad('allowlisted tools not served', missing.join(', '));

  const exposed = FORBIDDEN_BROWSER_TOOLS.filter((t) => served.has(t));
  console.log(
    exposed.length > 0
      ? `  NOTE     server exposes ${exposed.join(', ')} — deliberately NOT mounted on any agent (arbitrary code / local file access)`
      : '  NOTE     server exposes none of the arbitrary-code tools',
  );
} catch (error) {
  bad('MCP server', `${error.message.split('\n')[0]} — start it with: npm run mcp:playwright`);
}

console.log(
  failures === 0
    ? '\nAll Playwright checks passed.\n'
    : `\n${failures} check(s) failed — see the suggested command beside each.\n`,
);
process.exit(failures === 0 ? 0 : 1);
