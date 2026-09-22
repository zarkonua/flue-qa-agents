// Shared host-side runtime for the qa:* commands: target validation, Playwright
// MCP lifecycle (with confinement verification), target preflight, and running
// one agent as its own root process.
//
// Everything here is trusted host code. No runtime agent can call any of it.

import { spawn, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { requireTargetUrl, TargetUrlError } = await import(resolve(ROOT, 'src/lib/target.ts'));
const { DEFAULT_PLAYWRIGHT_MCP_URL, playwrightMcpUrl } = await import(resolve(ROOT, 'src/connections/playwright-mcp.ts'));
const { CONTROL_PLANE_ROOT, MCP_OUTPUT_ROOT } = await import(resolve(ROOT, 'src/lib/trusted-roots.ts'));
const { spawnMcpServer, stopProcessGroup } = await import(resolve(ROOT, 'scripts/mcp-server.mjs'));

export { MCP_OUTPUT_ROOT };

/** Exit codes, so a script calling `npm run qa:*` can tell failures apart. */
export const EXIT = { OK: 0, FAILED: 1, BAD_CONFIG: 2, TARGET_UNREACHABLE: 3, GATE_REFUSED: 4 };

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** Validated TARGET_URL, or print the reason and exit(2). */
export function requireTarget() {
  try {
    return requireTargetUrl();
  } catch (error) {
    if (error instanceof TargetUrlError) {
      console.error(`\n${error.message}\n`);
      process.exit(EXIT.BAD_CONFIG);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Playwright MCP lifecycle
// ---------------------------------------------------------------------------

/** Resolve the endpoint and export it, so every agent this process spawns sees it. */
export function mcpUrl() {
  const url = playwrightMcpUrl() ?? DEFAULT_PLAYWRIGHT_MCP_URL;
  process.env.PLAYWRIGHT_MCP_URL = url;
  return url;
}

async function mcpReachable(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      signal: AbortSignal.timeout(2000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** PID listening on `port`, via `ss` (Linux) or `lsof` (macOS). */
function listenerPid(port) {
  const ss = spawnSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8' });
  const fromSs = ss.stdout?.match(/pid=(\d+)/)?.[1];
  if (fromSs) return Number(fromSs);
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const fromLsof = lsof.stdout?.trim().split('\n')[0];
  return fromLsof ? Number(fromLsof) : undefined;
}

/** Working directory of a process, via /proc (Linux) or `lsof` (macOS). */
function processCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    return lsof.stdout?.split('\n').find((l) => l.startsWith('n'))?.slice(1);
  }
}

/**
 * An already-running server is only reused if we can prove its working
 * directory is outside the control plane. `browser_snapshot` writes a
 * model-chosen filename relative to that directory, so a server launched from
 * this project lets a browser agent write into it. Fail closed: if the cwd
 * cannot be determined, do not trust the server.
 */
function verifyConfined(port) {
  const pid = listenerPid(port);
  const cwd = pid === undefined ? undefined : processCwd(pid);
  if (cwd === undefined) {
    return {
      ok: false,
      reason:
        `cannot verify where the MCP server on port ${port} writes files` +
        (pid ? ` (pid ${pid})` : '') +
        '. Stop it and re-run; this command will start a confined one.',
    };
  }
  if (isInside(cwd, CONTROL_PLANE_ROOT)) {
    return {
      ok: false,
      reason:
        `the MCP server on port ${port} (pid ${pid}) runs inside the control plane (${cwd}). ` +
        "Browser agents could write files there, including .claude/. Stop it (kill " + pid + ') and re-run; ' +
        `this command will start one confined to ${MCP_OUTPUT_ROOT}.`,
    };
  }
  return { ok: true, pid, cwd };
}

let startedMcp;

/** Make sure a confined MCP server is listening. Returns whether we started it. */
export async function ensureMcp() {
  const url = mcpUrl();
  const port = new URL(url).port || '8931';

  if (await mcpReachable(url)) {
    const check = verifyConfined(port);
    if (!check.ok) {
      console.error(`\nRefusing to use the running Playwright MCP server: ${check.reason}\n`);
      process.exit(EXIT.BAD_CONFIG);
    }
    console.log(`Playwright MCP  : already running at ${url}, confined to ${check.cwd} (left alone on exit)`);
    return false;
  }

  console.log(`Playwright MCP  : not running — starting one at ${url}`);
  const child = spawnMcpServer({ port }, ['ignore', 'pipe', 'pipe']);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('error', (error) => {
    console.error(`Failed to start Playwright MCP: ${error.message}`);
    process.exit(EXIT.FAILED);
  });
  startedMcp = child;

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error('Playwright MCP exited while starting up.');
      process.exit(EXIT.FAILED);
    }
    if (await mcpReachable(url)) {
      console.log(`Playwright MCP  : ready, confined to ${MCP_OUTPUT_ROOT}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('Playwright MCP did not become ready within 120s.');
  stopMcp();
  process.exit(EXIT.FAILED);
}

/**
 * Stop the MCP server only if this process started it — the whole process
 * group, since the real server is a grandchild of the npx we spawned.
 */
export function stopMcp() {
  if (!startedMcp) return;
  stopProcessGroup(startedMcp, 'SIGTERM');
  startedMcp = undefined;
}

/** Stop our server and wait until its port is actually free. Returns whether it is. */
export async function stopMcpAndWait(timeoutMs = 10_000) {
  const child = startedMcp;
  if (!child) return true;
  const url = mcpUrl();
  stopMcp();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await mcpReachable(url))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  stopProcessGroup(child, 'SIGKILL');
  return !(await mcpReachable(url));
}

// Clean up on every way out. Node does not run 'exit' handlers when a signal
// kills the process, so signals are handled explicitly.
let activeAgent;
process.on('exit', () => {
  activeAgent?.kill('SIGTERM');
  stopMcp();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    activeAgent?.kill(signal);
    stopMcp();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Target preflight
// ---------------------------------------------------------------------------

/**
 * Drive the browser to the target once, from host code, before any agent runs:
 * fail fast on a dead target, and leave the shared browser on the right page
 * rather than on whatever a previous run left open.
 */
export async function preflightTarget(target) {
  const parsed = new URL(target);
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  // Raw TCP first: `fetch` against a closed port on WSL's dual-stack
  // `localhost` hangs instead of returning ECONNREFUSED.
  const open = await new Promise((done) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const settle = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(3000);
    socket.on('connect', () => settle(true));
    socket.on('timeout', () => settle(false));
    socket.on('error', () => settle(false));
  });
  if (!open) {
    console.error(`\nNothing is accepting connections at ${parsed.hostname}:${port}.`);
    console.error('Start the application, or check the port and that it is reachable from WSL.\n');
    stopMcp();
    process.exit(EXIT.TARGET_UNREACHABLE);
  }

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'flue-qa-preflight', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl())));
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: target } }, undefined, { timeout: 30_000 });
    const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
    if (result.isError) {
      console.error(`\nThe browser could not open ${target}:\n${text.split('\n').slice(0, 4).join('\n')}\n`);
      stopMcp();
      process.exit(EXIT.TARGET_UNREACHABLE);
    }
    const title = text.split('\n').find((l) => /Page Title/i.test(l))?.replace(/^[-\s]*Page Title:\s*/i, '').trim();
    console.log(`Target          : reachable${title ? ` — "${title}"` : ''}`);
  } catch (error) {
    console.error(`\nTarget preflight failed: ${error.message}\n`);
    stopMcp();
    process.exit(EXIT.TARGET_UNREACHABLE);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Running one agent
// ---------------------------------------------------------------------------

/**
 * Run one agent module as its own root process via `flue run`. Resolves with
 * the exit code. Output is streamed so the operator can watch.
 *
 * `resume: true` continues an existing conversation (same `id`, no `--new`)
 * instead of starting a fresh one — used to retry a stage with a corrective
 * message while keeping everything the agent already read.
 */
export function runAgent(agentPath, message, id, { extraEnv = {}, resume = false } = {}) {
  return new Promise((resolvePromise) => {
    const args = ['flue', 'run', agentPath, '--id', id, '-m', message];
    if (!resume) args.splice(3, 0, '--new');
    const child = spawn('npx', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    activeAgent = child;
    child.on('error', (error) => {
      console.error(`Failed to start ${agentPath}: ${error.message}`);
      activeAgent = undefined;
      resolvePromise(EXIT.FAILED);
    });
    child.on('close', (code) => {
      activeAgent = undefined;
      resolvePromise(code ?? EXIT.FAILED);
    });
  });
}
