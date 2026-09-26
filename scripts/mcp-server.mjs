#!/usr/bin/env node
// The single launcher for the Playwright MCP server. `npm run mcp:playwright`,
// `npm run mcp:playwright:headed`, and the qa:* wrappers all start it through
// here, so the security-relevant launch settings exist in exactly one place.
//
// SECURITY: the server's working directory is MCP_OUTPUT_ROOT, outside the
// control plane. `browser_snapshot` / `browser_take_screenshot` take a
// model-chosen `filename` resolved against that directory, so this is what
// keeps a browser agent from writing into this project (including `.claude/`).
//
//   node scripts/mcp-server.mjs [--headed] [--port 8931]

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { MCP_OUTPUT_ROOT } = await import(resolve(ROOT, 'src/lib/trusted-roots.ts'));

/**
 * Server args; must stay Chromium + isolated profile, headless unless asked.
 * `authArgs` is the auth bootstrap's (src/config/auth-bootstrap.ts): with
 * `--isolated`, a `--storage-state` seeds every new context and is never
 * written back.
 */
export function mcpServerArgs({ port = '8931', headed = false, authArgs = [] } = {}) {
  return [
    '--yes', '@playwright/mcp@latest',
    '--port', String(port),
    '--isolated',
    '--browser', 'chromium',
    '--output-dir', MCP_OUTPUT_ROOT,
    ...(headed ? [] : ['--headless']),
    ...authArgs,
  ];
}

/**
 * Spawn the server confined to MCP_OUTPUT_ROOT, as the leader of its own
 * process group. `npx` is only a wrapper: the real server is a grandchild, so
 * signalling the npx pid alone leaves it running, orphaned. Stop it with
 * `stopProcessGroup(child)`, which signals the whole group.
 */
export function spawnMcpServer(options = {}, stdio = 'inherit') {
  mkdirSync(MCP_OUTPUT_ROOT, { recursive: true });
  return spawn('npx', mcpServerArgs(options), { cwd: MCP_OUTPUT_ROOT, stdio, detached: true });
}

/** Signal every process in the child's group (npx, its shell, and the server). */
export function stopProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone.
  }
}

export { MCP_OUTPUT_ROOT };

// Run directly: behave like the old `npx @playwright/mcp …` npm script.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const headed = process.argv.includes('--headed');
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex > 0 ? process.argv[portIndex + 1] : '8931';
  console.error(`Playwright MCP: cwd and output confined to ${MCP_OUTPUT_ROOT}`);
  const child = spawnMcpServer({ port, headed });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopProcessGroup(child, signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}
