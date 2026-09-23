'use agent';

// REGRESSION CHECK — not a production agent.
//
// Verifies the MCP adapter path with exactly ONE Playwright MCP tool: the
// connection resolves, the adapted tool reaches the model, and a real browser
// call round-trips. No local tools, no subagents, no skills.
//
// Requires the standalone server: npm run mcp:playwright
//
//   npm run check:mcp-tools
//
// PASS: the reply reports the real page title "React • TodoMVC", which the
// model can only know by actually calling browser_navigate.

import { QA_MODEL } from '../providers/model.ts';
import { defineMcpConnection, useMcpConnection, useModel } from '@flue/runtime';
import { DEFAULT_PLAYWRIGHT_MCP_URL, playwrightMcpUrl } from '../connections/playwright-mcp.ts';

export function McpToolCheck() {
  useModel(QA_MODEL);
  useMcpConnection(
    defineMcpConnection({
      name: 'playwright',
      url: playwrightMcpUrl() ?? DEFAULT_PLAYWRIGHT_MCP_URL,
      tools: ['browser_navigate'],
      timeoutMs: 90_000,
    }),
  );
  return 'You can browse the web. Use browser_navigate to visit a page before describing it.';
}

McpToolCheck.agentName = 'mcp-tool-check';
