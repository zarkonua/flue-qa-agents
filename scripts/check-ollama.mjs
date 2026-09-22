#!/usr/bin/env node
// Diagnoses the Ollama connection this project depends on, and the two things
// that silently break agent runs: an unreachable host (WSL networking) and a
// server context window smaller than the one Flue budgets against.
//
// Usage: npm run check:ollama

import { readFileSync } from 'node:fs';

const MODEL = 'qwen3:14b';
const DECLARED_CONTEXT = Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 8192);

/** WSL2 NAT: the Windows host is the default gateway. See src/providers/ollama.ts. */
function wslHostAddress() {
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== '00000000' || !gateway) continue;
      const bytes = gateway.match(/../g);
      if (bytes?.length === 4) return bytes.reverse().map((b) => parseInt(b, 16)).join('.');
    }
  } catch {
    /* not Linux, or no route table */
  }
  return undefined;
}

async function get(url, init, ms = 4000) {
  const signal = AbortSignal.timeout(ms);
  try {
    const res = await fetch(url, { ...init, signal });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

const candidates = [];
const push = (url, label) => {
  if (url && !candidates.some((c) => c.url === url)) candidates.push({ url, label });
};
push(process.env.OLLAMA_BASE_URL?.replace(/\/+$/, ''), 'OLLAMA_BASE_URL (configured)');
push('http://127.0.0.1:11434/v1', 'loopback — native Ollama, or WSL mirrored networking');
const gateway = wslHostAddress();
push(gateway && `http://${gateway}:11434/v1`, 'WSL default gateway — Windows host under NAT networking');

console.log('Probing Ollama endpoints:\n');
let reachable;
for (const c of candidates) {
  const root = c.url.replace(/\/v1$/, '');
  const tags = await get(`${root}/api/tags`);
  const ok = tags !== undefined;
  console.log(`  ${ok ? 'OK  ' : 'dead'}  ${c.url}\n        ${c.label}`);
  if (ok && !reachable) reachable = { ...c, root, tags };
}

if (!reachable) {
  console.error(`
No Ollama endpoint responded.

If Ollama runs on the Windows host and WSL uses NAT networking, WSL cannot reach
Windows' loopback. Fix it with mirrored networking (no LAN exposure):

  1. In C:\\Users\\<you>\\.wslconfig put:

       [wsl2]
       networkingMode=mirrored

  2. From Windows PowerShell:  wsl --shutdown
  3. Reopen WSL and re-run:    npm run check:ollama

Otherwise start Ollama, or set OLLAMA_BASE_URL to the right endpoint.`);
  process.exit(1);
}

console.log(`\nUsing: ${reachable.url}`);
if (reachable.url !== 'http://127.0.0.1:11434/v1' && !process.env.OLLAMA_BASE_URL) {
  console.log(`\n  This is NOT the built-in default. Export it so the agents use it:\n    export OLLAMA_BASE_URL=${reachable.url}`);
}

const models = (reachable.tags.models ?? []).map((m) => m.name);
console.log(`\nModel "${MODEL}": ${models.includes(MODEL) ? 'present' : `MISSING (have: ${models.join(', ') || 'none'})`}`);

// Effective context: Ollama reports a loaded model's real window in /api/ps.
const ps = await get(`${reachable.root}/api/ps`);
const loaded = ps?.models?.find((m) => m.name === MODEL);
const serverContext = loaded?.context_length;
console.log(`\nContext window:`);
console.log(`  declared to Flue : ${DECLARED_CONTEXT}`);
if (serverContext) {
  console.log(`  Ollama server    : ${serverContext}`);
  if (serverContext < DECLARED_CONTEXT) {
    console.log(`\n  WARNING: the server window is SMALLER than the declared one. Ollama will\n  silently truncate prompts, dropping the tail of the system prompt — tool\n  definitions included. Raise OLLAMA_CONTEXT_LENGTH where Ollama runs, or\n  lower OLLAMA_CONTEXT_WINDOW here.`);
  } else if (serverContext > DECLARED_CONTEXT) {
    console.log(`\n  Note: the server allows more than this project budgets for. Set\n  OLLAMA_CONTEXT_WINDOW=${serverContext} to actually use it.`);
  }
} else {
  console.log(`  Ollama server    : unknown (model not currently loaded — run a prompt first)`);
}

// The failure mode the README documents: prose instead of a tool call.
process.stdout.write('\nTool-calling probe... ');
const probe = await get(
  `${reachable.url}/chat/completions`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ollama-local' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Record the value 42 using the tool. Call the tool; do not reply in prose.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'record_value',
          description: 'Record a numeric value.',
          parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        },
      }],
      stream: false,
    }),
  },
  120000,
);
const message = probe?.choices?.[0]?.message;
if (!message) console.log('FAILED (no response)');
else if (message.tool_calls?.length) console.log(`OK — model emitted tool_calls: ${message.tool_calls[0].function?.name}`);
else console.log(`PROSE INSTEAD OF TOOL CALL — this is the known limitation.\n  Model replied: ${JSON.stringify((message.content ?? '').slice(0, 160))}`);
