#!/usr/bin/env node
// Drives the browser path end to end WITHOUT the model: Flue → Playwright MCP →
// Chromium → a real page → a schema-validated `.qa` artifact.
//
// This exists to separate two failure modes that look identical from a failed
// agent run: "the wiring is broken" and "the local model did not call the
// tools".
//
// It proves: the allowlist in src/connections/playwright-mcp.ts is valid for
// the running server (createMcpConnection rejects an unknown name), the server
// drives a real Chromium against a real page, and the snapshot it returns
// round-trips into a schema-validated artifact through the same
// write_qa_artifact host code an agent uses.
//
// It does NOT prove the model will call any of it. Flue executes adapted MCP
// tools through an internal adapter that is not callable from outside an agent
// run, so the calls below go through the MCP client directly.
//
// Usage: npm run probe:browser [url]

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpConnection } from '@flue/runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'https://demo.playwright.dev/todomvc';

const { DEFAULT_PLAYWRIGHT_MCP_URL, DISCOVERY_BROWSER_TOOLS, playwrightMcpUrl } = await import(
  resolve(ROOT, 'src/connections/playwright-mcp.ts')
);
const { writeQaArtifact, QA_ARTIFACT_ROOT } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));

const endpoint = playwrightMcpUrl() ?? DEFAULT_PLAYWRIGHT_MCP_URL;
console.log(`MCP endpoint : ${endpoint}`);
console.log(`Artifact root: ${QA_ARTIFACT_ROOT}`);
console.log(`Target page  : ${url}\n`);

// Step 1: let Flue validate the allowlist exactly as an agent mount would — an
// entry the server does not expose throws here rather than silently narrowing
// the agent's tool set.
const conn = await createMcpConnection({
  name: 'playwright',
  url: endpoint,
  tools: [...DISCOVERY_BROWSER_TOOLS],
});
console.log(`Allowlist validated: ${conn.tools.length} tools adapted (of the server's full set).`);
await conn.close();

// Step 2: drive those same tools over the wire.
const client = new Client({ name: 'flue-qa-probe', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

const allowed = new Set(DISCOVERY_BROWSER_TOOLS);

/** Call one tool from the agent's allowlist — proving the agent could make the same call. */
async function call(name, args) {
  if (!allowed.has(name)) throw new Error(`"${name}" is not in the discovery allowlist`);
  return raw(name, args);
}

/**
 * Host-side housekeeping, deliberately outside the agent allowlist. Product
 * Discovery is not granted `browser_close` (see DISCOVERY_BROWSER_TOOLS), but
 * this script is trusted host code cleaning up after itself, not an agent.
 */
async function hostCall(name, args) {
  return raw(name, args);
}

async function raw(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

console.log('\n1. browser_navigate …');
const navigated = await call('browser_navigate', { url });
console.log(`   ${navigated.split('\n').find((l) => /Page URL|url/i.test(l))?.trim() ?? 'navigated'}`);

console.log('2. browser_snapshot …');
const snapshot = await call('browser_snapshot', {});

// Pull the accessibility facts straight out of the snapshot the agent would see.
const headings = [...snapshot.matchAll(/heading "([^"]+)"/g)].map((m) => m[1]);
const textboxes = [...snapshot.matchAll(/textbox "([^"]+)"/g)].map((m) => m[1]);
const buttons = [...snapshot.matchAll(/button "([^"]+)"/g)].map((m) => m[1]);
const links = [...snapshot.matchAll(/link "([^"]+)"/g)].map((m) => m[1]);

console.log(`   headings : ${JSON.stringify(headings)}`);
console.log(`   textboxes: ${JSON.stringify(textboxes)}`);
console.log(`   buttons  : ${JSON.stringify(buttons)}`);
console.log(`   links    : ${JSON.stringify(links)}`);

console.log('3. browser_close (host cleanup) …');
await hostCall('browser_close', {});
await client.close();

// Write the artifact through the same validated, path-free tool an agent uses.
// Everything below is OBSERVED, not CONFIRMED: the evidence policy's point is
// that seeing a control is not the same as knowing it is correct.
const observedAt = new Date().toISOString();
const artifact = {
  product: `Browser probe of ${url}`,
  areas: [
    {
      name: 'Initial page',
      routes: [url],
      notes: ['Captured by scripts/probe-browser.mjs — host-driven, no model involved.'],
    },
  ],
  behaviors: [
    ...headings.map((name, i) => ({
      id: `BEH-H${i + 1}`,
      area: 'Initial page',
      statement: `The page exposes a heading with accessible name "${name}".`,
      status: 'OBSERVED',
      source: [`accessibility snapshot via Playwright MCP, ${observedAt}`],
      confidence: 'high',
      suspectedIssue: false,
    })),
    ...textboxes.map((name, i) => ({
      id: `BEH-T${i + 1}`,
      area: 'Initial page',
      statement: `The page exposes a textbox with accessible name "${name}".`,
      status: 'OBSERVED',
      source: [`accessibility snapshot via Playwright MCP, ${observedAt}`],
      confidence: 'high',
      suspectedIssue: false,
    })),
  ],
  openQuestions: [
    {
      id: 'OQ-1',
      question:
        'This probe records only the initial page state. What are the flows, validation rules, and error states?',
      relatedBehaviorIds: [],
      impact: 'Test design cannot proceed from this artifact alone; real discovery is still required.',
    },
  ],
  conflicts: [],
};

console.log('4. write_qa_artifact("discovered-behavior") …');
try {
  writeQaArtifact('discovered-behavior', artifact);
  console.log(`   written and schema-validated → ${QA_ARTIFACT_ROOT}/discovered-behavior.json`);
} catch (error) {
  // The schema in this repo may differ from the shape above; report rather than
  // pretend the round trip succeeded.
  console.log(`   REJECTED by schema validation:\n     ${error.message.split('\n').join('\n     ')}`);
  process.exit(1);
}

console.log('\nPASS — Flue → Playwright MCP → Chromium → real page → validated artifact.');
console.log('If an agent run produces no artifact, the browser path is not the cause.');
process.exit(0);
