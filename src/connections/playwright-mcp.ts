// Playwright MCP — the browser capability for the *exploration* agents
// (Product Discovery, UI Explorer, Failure Analyzer).
//
// The spec keeps browser exploration and test authoring apart on purpose:
// "Do not merge these into one unrestricted browser/shell capability." So the
// authoring agents (Automation Generator, Reviewer) get the Playwright CLI /
// `run_playwright_test` path instead of this, and this connection is never
// mounted on them by default.
//
// Run the server the Flue agents talk to as a standalone process:
//
//     npm run mcp:playwright        # npx @playwright/mcp@latest --port 8931 --headless
//
// Note that Claude Code's own `claude mcp add playwright ...` registration is a
// *separate* thing: it gives Claude Code (the operator layer) a browser. It is
// not the Flue runtime configuration, which is this module.

import { createMcpConnection, defineMcpConnection, type McpConnectionDefinition, type ToolDefinition } from '@flue/runtime';
import { envString } from '../config/env.ts';

/**
 * Default endpoint of the standalone server.
 *
 * `localhost`, not `127.0.0.1`: @playwright/mcp enforces a Host check and
 * answers `403 Access is only allowed at localhost:8931` to a request whose
 * Host header is the literal IP. (Use `--allowed-hosts` on the server if you
 * genuinely need the IP form.)
 */
export const DEFAULT_PLAYWRIGHT_MCP_URL = 'http://localhost:8931/mcp';

/**
 * Configured endpoint, or `undefined` when no browser is wired up. Agents mount
 * the connection conditionally on this, so the same agent code runs with a
 * browser (Milestone 3+) and without one (today, in a shell where the server
 * is not running) — a mount is allowed to be conditional in Flue, and the model
 * is told when a server's tools are not there.
 */
export function playwrightMcpUrl(): string | undefined {
  const configured = envString('PLAYWRIGHT_MCP_URL');
  if (configured === undefined || configured === '') return undefined;
  if (configured === 'default') return DEFAULT_PLAYWRIGHT_MCP_URL;
  return configured;
}

// ---------------------------------------------------------------------------
// Tool allowlists
// ---------------------------------------------------------------------------
//
// Two reasons these are narrow rather than "everything the server exposes":
//
// 1. Security. @playwright/mcp ships `browser_evaluate` and
//    `browser_run_code_unsafe`, which execute arbitrary JavaScript — inside the
//    page and, for the latter, against the Playwright objects themselves. That
//    is a general-purpose code-execution capability reachable from a browser
//    agent, i.e. exactly the "unrestricted browser/shell capability" the spec
//    rules out, and `storageState({ path })` through it would be a filesystem
//    write. `browser_file_upload` reads local files by path. None are mounted.
//
// 2. Budget. Every mounted tool spends context, and this system runs an
//    8192-token local model. The sets below are the smallest that still let
//    each role do its job.
//
// Names are the server's own tool names (Flue namespaces them to
// `mcp__playwright__<name>` when it mounts them). An allowlist entry the server
// does not expose fails the connection loudly, which is what we want.

/** Never mounted, for any role. See note 1 above. */
export const FORBIDDEN_BROWSER_TOOLS = [
  'browser_evaluate',
  'browser_run_code_unsafe',
  'browser_file_upload',
] as const;

/**
 * Product Discovery: the *minimum* set that still supports an autonomous
 * observe → reason → act → observe loop — navigate, read the accessibility
 * tree, and drive the three input primitives that move a page between states.
 *
 * Deliberately smaller than what the server offers. At 8192 tokens, tool
 * definitions were measured at ~3,195 tokens of a ~4,859-token pre-turn
 * prompt (59% of the window) with 13 browser tools mounted, and the agent
 * skipped browsing entirely. Everything not needed to reach a new page state
 * is cut: `navigate_back`, `fill_form`, `select_option`, `wait_for`,
 * `handle_dialog`, `console_messages`, `network_requests`, `close`.
 *
 * Those remain available to UI Explorer and Failure Analyzer, whose budgets
 * and jobs differ — this trim is Product Discovery's alone.
 */
export const DISCOVERY_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
] as const;

/**
 * UI Explorer: the same flow-walking set plus `browser_find`, which is how it
 * gathers *locator evidence* (role + accessible name) rather than guesses, and
 * a screenshot for the ambiguous cases a snapshot does not settle.
 */
export const UI_EXPLORER_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_close',
] as const;

/**
 * Failure Analyzer: reproduce one failing step and look at the evidence.
 * Deliberately the leanest set — diagnosis happens mostly in traces and
 * results, and the browser is for confirming a specific hypothesis.
 */
export const FAILURE_ANALYSIS_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_wait_for',
  'browser_console_messages',
  'browser_network_requests',
  'browser_take_screenshot',
  'browser_close',
] as const;

function connection(tools: readonly string[]): McpConnectionDefinition {
  return defineMcpConnection({
    name: 'playwright',
    url: playwrightMcpUrl() ?? DEFAULT_PLAYWRIGHT_MCP_URL,
    tools: [...tools],
    // A browser that is configured but unreachable is a real failure: the agent
    // would otherwise quietly fall back to inventing behaviour, which is the one
    // thing the evidence policy forbids. Fail the submission instead.
    optional: false,
    // A page load plus the server's settle delay can exceed a snapshot round
    // trip on a cold browser; 90s is comfortably above the server's own 60s
    // navigation timeout without hiding a hung browser forever.
    timeoutMs: 90_000,
  });
}

export const discoveryBrowser = connection(DISCOVERY_BROWSER_TOOLS);
export const uiExplorerBrowser = connection(UI_EXPLORER_BROWSER_TOOLS);
export const failureAnalysisBrowser = connection(FAILURE_ANALYSIS_BROWSER_TOOLS);

// ---------------------------------------------------------------------------
// Subagent-compatible mounting
// ---------------------------------------------------------------------------
//
// `useMcpConnection()` throws inside a delegate render — Flue requires MCP
// connections on the root agent. That would force the browser onto the QA
// Manager and, through it, onto every delegate including Behavior Analyst and
// Test Designer, which breaks least privilege.
//
// `useTool()` *is* allowed in a delegate, so we take Pi's documented
// lower-level path instead: connect once here, then let each agent mount only
// its own allowlist. The browser stays on the agents that need it, whether they
// run standalone or as a subagent.

const connectionCache = new Map<string, Promise<readonly ToolDefinition[]>>();

/**
 * Adapted tools for one role's allowlist, or `[]` when no browser is
 * configured. A *configured but unreachable* server throws: an agent quietly
 * losing its browser would fall back to inventing behaviour, which is the one
 * outcome the evidence policy cannot tolerate. `scripts/qa.mjs` guarantees the
 * server is up before any agent loads.
 */
export async function browserTools(tools: readonly string[]): Promise<readonly ToolDefinition[]> {
  const url = playwrightMcpUrl();
  if (url === undefined) return [];

  const key = `${url}::${tools.join(',')}`;
  let pending = connectionCache.get(key);
  if (pending === undefined) {
    pending = createMcpConnection({ name: 'playwright', url, tools: [...tools], timeoutMs: 90_000 })
      .then((connection) => connection.tools)
      .catch((error) => {
        throw new Error(
          `Playwright MCP is configured (${url}) but unreachable: ${error.message}. ` +
            'Start it with `npm run mcp:playwright`, or unset PLAYWRIGHT_MCP_URL to run without a browser.',
        );
      });
    connectionCache.set(key, pending);
  }
  return pending;
}
