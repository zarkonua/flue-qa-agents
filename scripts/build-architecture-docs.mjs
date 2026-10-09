#!/usr/bin/env node
// Builds the two derived architecture views from their sources:
//
//   docs/architecture/README.md              each `<!-- diagram:<name> -->` block
//                                            is replaced by <name>.mmd, so the
//                                            diagrams render on GitHub
//   docs/architecture/architecture-view.html  the same diagrams and section text as
//                                            one styled page, plus the capability
//                                            matrix read from src/agents/*.ts
//
// The .mmd files, the prose in README.md and the source code are the only
// inputs; neither output is edited by hand. Node colours come from the
// `class <ids> <kind>` lines in each .mmd (agent, host, artifact, person, gate,
// runtime, entry, plan, …), styled by the page; GitHub ignores them.
//
//   npm run docs:architecture            rewrite both
//   npm run docs:architecture -- --check exit 1 if either is out of date

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES } from './lib/phase1-stages.mjs';
import { NOT_YET_WIRED, PHASE2_STAGES } from './lib/phase2-stages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARCH_DIR = join(ROOT, 'docs', 'architecture');
const README = join(ARCH_DIR, 'README.md');
export const VIEW = join(ARCH_DIR, 'architecture-view.html');
const BLOCK = /<!-- diagram:([a-z0-9-]+) -->[\s\S]*?<!-- \/diagram -->/g;
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

const read = (path) => readFileSync(path, 'utf8');
const diagram = (name) => read(join(ARCH_DIR, `${name}.mmd`)).trimEnd();

/** README.md with every marked block replaced by its .mmd source. */
export function renderArchitectureReadme(readme = read(README)) {
  return readme.replace(BLOCK, (_match, name) => `<!-- diagram:${name} -->\n\`\`\`mermaid\n${diagram(name)}\n\`\`\`\n<!-- /diagram -->`);
}

// ---------------------------------------------------------------------------
// Capability matrix, read statically from the agent sources
// ---------------------------------------------------------------------------

const TOOL_GROUPS = { 'qa-artifacts.ts': 'QA artifacts', 'observations.ts': 'QA artifacts', 'review-proposals.ts': 'Review', 'repo.ts': 'Repo', 'test-code.ts': 'Test code' };

/** Every tool, in definition order: `export const fooTool = defineTool({ name: 'foo' ...` plus write_qa_artifact. */
function toolCatalog() {
  const tools = [];
  const dir = join(ROOT, 'src', 'tools');
  for (const file of Object.keys(TOOL_GROUPS)) {
    const src = read(join(dir, file));
    if (file === 'qa-artifacts.ts') tools.push({ id: null, name: 'write_qa_artifact', group: TOOL_GROUPS[file] });
    for (const [, id, name] of src.matchAll(/export const (\w+) = defineTool\(\{\s*name: '([\w-]+)'/g)) {
      const tool = { id, name, group: TOOL_GROUPS[file] };
      if (name === 'read_qa_artifact') tools.unshift(tool); // read before write
      else tools.push(tool);
    }
  }
  return tools;
}

/** `export const FOO_BROWSER_TOOLS = [ 'browser_x', ... ]` in the MCP connection. */
function browserLists() {
  const src = read(join(ROOT, 'src', 'connections', 'playwright-mcp.ts'));
  const lists = new Map();
  for (const [, id, body] of src.matchAll(/export const (\w+_BROWSER_TOOLS) = \[([\s\S]*?)\] as const/g)) {
    lists.set(id, [...body.replace(/\/\/.*$/gm, '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
  }
  return lists;
}

/** Which command starts an agent, from the stage lists and the scripts; and a sort rank. */
function startedBy(path) {
  const p1 = STAGES.findIndex((s) => s.agent === path);
  if (p1 >= 0) return { label: `Phase 1 · stage ${p1 + 1}`, rank: p1 };
  if (PHASE2_STAGES.some((s) => s.agent === path)) return { label: 'Phase 2 · qa:automation', rank: 30 };
  if (NOT_YET_WIRED.includes(path)) return { label: 'built, not wired', rank: 50 };
  const scripts = JSON.parse(read(join(ROOT, 'package.json'))).scripts;
  const commands = Object.entries(scripts)
    .filter(([, cmd]) => /^node scripts\/[\w-]+\.mjs$/.test(cmd) && read(join(ROOT, cmd.slice(5))).includes(path))
    .map(([name]) => name);
  if (commands.length === 0) return { label: 'not wired', rank: 50 };
  const rank = commands.includes('qa:agentic') ? 40 : 20;
  return { label: commands.join(' · '), rank };
}

export function capabilityMatrix() {
  const catalog = toolCatalog();
  const byId = new Map(catalog.filter((t) => t.id).map((t) => [t.id, t.name]));
  const browser = browserLists();
  const dir = join(ROOT, 'src', 'agents');
  const agents = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => {
      const src = read(join(dir, file));
      const path = `src/agents/${file}`;
      const writes = new Map([...src.matchAll(/const (\w+) = writeQaArtifactToolFor\(\[([^\]]*)\]\)/g)].map(([, id, list]) => [id, [...list.matchAll(/'([\w-]+)'/g)].map((m) => m[1])]));
      const tools = new Set();
      let own = [];
      for (const [, id] of src.matchAll(/useTool\((\w+)\)/g)) {
        if (byId.has(id)) tools.add(byId.get(id));
        else if (writes.has(id)) { tools.add('write_qa_artifact'); own = writes.get(id); }
      }
      const list = /browserTools\((\w+_BROWSER_TOOLS)\)/.exec(src)?.[1];
      const title = file.replace(/\.ts$/, '').split('-').map((w) => (w === 'qa' || w === 'ui' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
      return { title, path, ...startedBy(path), tools, own, browser: list ? browser.get(list) ?? [] : [], subagents: (src.match(/useSubagent\(/g) ?? []).length };
    })
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  return { catalog, agents, forbidden: browser.get('FORBIDDEN_BROWSER_TOOLS') ?? [] };
}

// ---------------------------------------------------------------------------
// The HTML view
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Just enough Markdown for the section prose: code spans, bold, links, paragraphs. */
const inline = (md) =>
  esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'); // same folder as README.md: relative links hold
const paragraphs = (md, cls = '') => md.trim().split(/\n\s*\n/).filter(Boolean).map((p) => `<p${cls ? ` class="${cls}"` : ''}>${inline(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('\n    ');

/** Each `## Heading` of README.md that holds a diagram: its prose and diagram name. */
function sections(readme) {
  return [...readme.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
    .map(([, title, body]) => ({ title, name: /<!-- diagram:([a-z0-9-]+) -->/.exec(body)?.[1], prose: body.split('<!-- diagram:')[0] }))
    .filter((s) => s.name);
}

function matrixHtml() {
  const { catalog, agents, forbidden } = capabilityMatrix();
  const used = new Set(agents.flatMap((a) => [...a.tools]));
  const groups = [];
  for (const t of catalog) {
    const last = groups.at(-1);
    if (last?.name === t.group) last.tools.push(t);
    else groups.push({ name: t.group, tools: [t] });
  }
  const split = (name) => esc(name).replace(/_/g, '_<wbr>');
  const head1 = `<tr class="grp"><th></th>${groups.map((g) => `<th colspan="${g.tools.length}">${esc(g.name)}</th>`).join('')}<th>MCP</th><th>Flue</th></tr>`;
  const head2 = `<tr><th class="ag">Agent</th>${groups.map((g) => g.tools.map((t, i) => `<th class="tn${i === 0 ? ' g0' : ''}${used.has(t.name) ? '' : ' unused'}">${split(t.name)}${t.name === 'write_qa_artifact' ? '<br>(only)' : ''}</th>`).join('')).join('')}<th class="tn g0">browser_*</th><th class="tn g0">subagents</th></tr>`;
  let prev;
  const rows = agents.map((a) => {
    const band = a.rank < 10 ? 0 : a.rank;
    const sep = prev !== undefined && band !== prev ? ' class="sep"' : '';
    prev = band;
    const cells = groups.map((g) => g.tools.map((t, i) => {
      const g0 = i === 0 ? ' class="g0"' : '';
      if (t.name === 'write_qa_artifact') return `<td${g0}>${a.own.length ? a.own.map((o) => `<span class="own">${esc(o)}</span>`).join(' ') : '<span class="none">·</span>'}</td>`;
      return `<td${g0}>${a.tools.has(t.name) ? '<span class="dot" role="img" aria-label="mounted"></span>' : '<span class="none" aria-label="not mounted">·</span>'}</td>`;
    }).join('')).join('');
    const count = (n) => (n ? `<span class="numv">${n}</span>` : '<span class="none">·</span>');
    return `<tr${sep}><th scope="row">${esc(a.title)}<small>${esc(a.label)}</small></th>${cells}<td class="g0">${count(a.browser.length)}</td><td class="g0">${count(a.subagents)}</td></tr>`;
  });
  const unused = catalog.filter((t) => !used.has(t.name)).map((t) => `<code>${esc(t.name)}</code>`);
  const cols = catalog.length + 3;
  const foot = `${unused.length ? `${unused.join(', ')} ${unused.length === 1 ? 'exists but is' : 'exist but are'} mounted on no agent. ` : ''}` +
    `${forbidden.map((t) => `<code>${esc(t)}</code>`).join(', ')} are never mounted for any role. No agent can read or write <code>phase1-approval.json</code>.`;
  return `<div class="board matrix-board"><div class="matrix-scroll"><table class="matrix">
        <thead>${head1}${head2}</thead>
        <tbody>
          ${rows.join('\n          ')}
        </tbody>
        <tfoot><tr><td colspan="${cols}">${foot}</td></tr></tfoot>
      </table></div></div>`;
}

const CSS = `
    :root {
      --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0efec; --text: #1d1d1b; --muted: #5f5e5a; --faint: #8a8984;
      --line: #d9d7d1; --edge: #b9b6ae; --focus: #2458d6;
      --agent: #6d4bd1; --agent-bg: #f2eefd; --gate: #a45a00; --gate-bg: #fdf3e4; --store: #0f7a55; --store-bg: #e7f6ef;
      --runtime: #1f63c2; --runtime-bg: #e8f0fc; --blocked: #b3261e; --blocked-bg: #fdecea; --entry: #4b4a46; --entry-bg: #efeeea;
      --human: #0e7490; --human-bg: #e4f5f8; --main: #26251f; --plan: #a3a19a; --dotgrid: #e3e1db;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #151514; --surface: #1e1e1c; --surface-2: #262624; --text: #ecebe6; --muted: #aeaca5; --faint: #85837c;
        --line: #3a3936; --edge: #57554f; --focus: #7ea2ff;
        --agent: #b29cff; --agent-bg: #2a2440; --gate: #f0b35c; --gate-bg: #372a17; --store: #5fd3a3; --store-bg: #16322a;
        --runtime: #7fb0ff; --runtime-bg: #1a2a44; --blocked: #ff8f86; --blocked-bg: #3d1f1d; --entry: #cfcdc6; --entry-bg: #2b2a28;
        --human: #6fd6e8; --human-bg: #14333a; --main: #ecebe6; --plan: #6d6b65; --dotgrid: #252523;
      }
    }
    :root[data-theme="dark"] {
      --bg: #151514; --surface: #1e1e1c; --surface-2: #262624; --text: #ecebe6; --muted: #aeaca5; --faint: #85837c;
      --line: #3a3936; --edge: #57554f; --focus: #7ea2ff;
      --agent: #b29cff; --agent-bg: #2a2440; --gate: #f0b35c; --gate-bg: #372a17; --store: #5fd3a3; --store-bg: #16322a;
      --runtime: #7fb0ff; --runtime-bg: #1a2a44; --blocked: #ff8f86; --blocked-bg: #3d1f1d; --entry: #cfcdc6; --entry-bg: #2b2a28;
      --human: #6fd6e8; --human-bg: #14333a; --main: #ecebe6; --plan: #6d6b65; --dotgrid: #252523;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    code, .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; font-size: 0.86em; }
    a { color: var(--focus); }
    main { max-width: 1320px; margin: 0 auto; padding: 32px 16px 64px; }
    header h1 { font-size: 1.6rem; margin: 0 0 6px; letter-spacing: -0.01em; }
    header p { margin: 0 0 6px; color: var(--muted); max-width: 84ch; }
    h2 { font-size: 1.15rem; margin: 48px 0 4px; }
    .lede { margin: 0 0 6px; color: var(--muted); max-width: 84ch; }

    /* legend */
    .clegend { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 0.78rem; color: var(--muted); align-items: center; margin: 18px 0 0; }
    .clegend > span { display: inline-flex; align-items: center; gap: 7px; }
    .clegend .grp { font-weight: 700; color: var(--faint); text-transform: uppercase; letter-spacing: .06em; font-size: 0.66rem; margin-right: -6px; }
    .sw { display: inline-block; flex: none; width: 22px; height: 13px; border-radius: 4px; }
    .sw-agent { border: 1.5px solid var(--agent); background: var(--surface); box-shadow: 2px 2px 0 color-mix(in srgb, var(--agent) 25%, transparent); }
    .sw-host { border: 1.5px solid var(--gate); background: var(--gate-bg); }
    .sw-human { border: 1.5px solid var(--human); background: var(--human-bg); }
    .sw-art { width: 26px; height: 12px; border-radius: 999px; background: var(--store-bg); border: 1px solid var(--store); }
    .sw-gate { width: 26px; border-radius: 3px; border: 2px solid var(--main); background: repeating-linear-gradient(135deg, var(--gate) 0 4px, var(--gate-bg) 4px 8px); }
    .sw-run { border: 1.5px solid var(--runtime); background: var(--runtime-bg); }
    .sw-entry { border-radius: 999px; border: 1.5px solid var(--entry); background: var(--entry-bg); }
    .sw-plan { border: 1.5px dashed var(--plan); }

    /* table of contents */
    nav.toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 0; }
    nav.toc a { text-decoration: none; font-size: 0.8rem; font-weight: 650; color: var(--text); background: var(--surface);
      border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; }
    nav.toc a:hover { border-color: var(--agent); color: var(--agent); }

    /* boards */
    .board { margin-top: 14px; border: 1px solid var(--line); border-radius: 14px; background-color: var(--surface);
      background-image: radial-gradient(var(--dotgrid) 1px, transparent 1.2px); background-size: 18px 18px;
      padding: 22px; overflow-x: auto; }
    .board pre.mermaid { margin: 0; display: flex; justify-content: center; background: none; }
    .board pre.mermaid:not([data-processed]) { font-size: 0.78rem; color: var(--muted); white-space: pre-wrap; display: block; }
    .board pre.mermaid svg { max-width: 100%; height: auto; }

    /* Mermaid, in the page palette. !important: Mermaid inlines id-scoped defaults. */
    .mermaid svg { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important; }
    .mermaid .nodeLabel, .mermaid .nodeLabel p, .mermaid .label { color: var(--text) !important; fill: var(--text) !important; }
    .mermaid .node :is(rect, path, polygon, circle, ellipse) { fill: var(--surface) !important; stroke: var(--edge) !important; stroke-width: 1.5px !important; }
    .mermaid .node.agent :is(rect, path, polygon) { stroke: var(--agent) !important; stroke-width: 2px !important;
      filter: drop-shadow(3px 4px 0 color-mix(in srgb, var(--agent) 22%, transparent)); }
    .mermaid .node.agent .nodeLabel { font-weight: 650; }
    .mermaid .node.host :is(rect, path, polygon) { fill: var(--gate-bg) !important; stroke: var(--gate) !important; }
    .mermaid .node.artifact :is(rect, path, polygon) { fill: var(--store-bg) !important; stroke: var(--store) !important; }
    .mermaid .node.artifact .nodeLabel { color: var(--store) !important; font-family: ui-monospace, Menlo, monospace; font-size: 0.86em; font-weight: 700; }
    .mermaid .node.person :is(rect, path, polygon) { fill: var(--human-bg) !important; stroke: var(--human) !important; stroke-width: 2px !important;
      filter: drop-shadow(3px 4px 0 color-mix(in srgb, var(--human) 24%, transparent)); }
    .mermaid .node.gate :is(rect, path, polygon) { fill: url(#stripes) var(--gate-bg) !important; stroke: var(--main) !important; stroke-width: 2.5px !important;
      filter: drop-shadow(4px 5px 0 color-mix(in srgb, var(--main) 20%, transparent)); }
    .mermaid .node.gate .nodeLabel { font-weight: 750; }
    .mermaid .node.runtime :is(rect, path, polygon) { fill: var(--runtime-bg) !important; stroke: var(--runtime) !important; }
    .mermaid .node.entry :is(rect, path, polygon) { fill: var(--entry-bg) !important; stroke: var(--entry) !important; }
    .mermaid .node.entry .nodeLabel { font-weight: 650; }
    .mermaid .node.blocked :is(rect, path, polygon) { fill: var(--blocked-bg) !important; stroke: var(--blocked) !important; }
    .mermaid .node:is(.plan, .optional) :is(rect, path, polygon) { fill: transparent !important; stroke: var(--plan) !important; stroke-dasharray: 6 4; }
    .mermaid .node:is(.plan, .optional) .nodeLabel { color: var(--muted) !important; }

    .mermaid .cluster rect { fill: color-mix(in srgb, var(--gate-bg) 30%, transparent) !important; stroke: color-mix(in srgb, var(--gate) 45%, var(--line)) !important;
      stroke-width: 1.5px !important; stroke-dasharray: 7 5; rx: 16px; ry: 16px; }
    .mermaid .cluster.band rect { fill: color-mix(in srgb, var(--surface-2) 70%, transparent) !important; stroke: var(--line) !important; stroke-dasharray: none; }
    .mermaid .cluster.plan rect { fill: transparent !important; stroke: var(--plan) !important; }
    .mermaid .cluster-label .nodeLabel, .mermaid .cluster-label span { color: var(--gate) !important; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .mermaid .cluster.band .cluster-label .nodeLabel, .mermaid .cluster.plan .cluster-label .nodeLabel { color: var(--muted) !important; }

    .mermaid .flowchart-link { stroke: var(--main) !important; stroke-width: 2px !important; }
    .mermaid .flowchart-link.edge-pattern-dotted { stroke: var(--muted) !important; stroke-width: 1.6px !important; stroke-dasharray: 5 4 !important; }
    .mermaid marker path, .mermaid .arrowheadPath, .mermaid .marker { fill: var(--main) !important; stroke: var(--main) !important; }
    .mermaid .edgeLabel, .mermaid .edgeLabel p, .mermaid .edgeLabel span { background: var(--surface) !important; background-color: var(--surface) !important;
      color: var(--muted) !important; font-size: 0.72rem; font-weight: 700; }
    .mermaid .edgeLabel rect { fill: var(--surface) !important; }

    /* capability matrix */
    .matrix-board { padding: 0; background-image: none; }
    .matrix-scroll { overflow-x: auto; }
    table.matrix { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
    .matrix th, .matrix td { padding: 7px 6px; border-bottom: 1px solid var(--line); text-align: center; vertical-align: middle; }
    .matrix thead th { font-weight: 600; color: var(--muted); }
    .matrix tr.grp th { font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .07em; color: var(--gate); border-bottom: none; padding-bottom: 2px; border-left: 1px solid var(--line); }
    .matrix tr.grp th:first-child { border-left: none; }
    .matrix th.tn { font-family: ui-monospace, Menlo, monospace; font-size: 0.7rem; font-weight: 500; color: var(--text); line-height: 1.35; }
    .matrix th.tn.unused { color: var(--faint); text-decoration: line-through; text-decoration-color: var(--edge); }
    .matrix th.ag, .matrix tbody th { text-align: left; }
    .matrix tbody th { font-weight: 700; white-space: nowrap; }
    .matrix tbody th small { display: block; font-weight: 400; color: var(--muted); font-size: 0.74rem; }
    .matrix .g0 { border-left: 1px solid var(--line); }
    .matrix tr.sep > * { border-top: 2px solid var(--line); }
    .matrix tbody tr:hover { background: var(--surface-2); }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--agent); }
    .none { color: var(--edge); }
    .own { font-family: ui-monospace, Menlo, monospace; font-size: 0.68rem; color: var(--store); background: var(--store-bg); border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
    .numv { font-weight: 800; color: var(--runtime); }
    .matrix tfoot td { text-align: left; font-size: 0.78rem; color: var(--muted); border-bottom: none; }

    footer { margin-top: 44px; font-size: 0.8rem; color: var(--faint); max-width: 110ch; }
`;

export function renderArchitectureView(readme = read(README)) {
  // The README's first paragraph describes the README; the page opens with its own.
  const intro = readme.split(/^## /m)[0].replace(/^# .+\n/, '').split(/^\| Diagram/m)[0].split(/^Legend/m)[0].trim().split(/\n\s*\n/).slice(1).join('\n\n');
  const secs = sections(readme);
  const sources = readdirSync(ARCH_DIR).filter((f) => f.endsWith('.mmd')).sort().map((f) => `<code>${esc(basename(f))}</code>`).join(', ');

  return `<!doctype html>
<!-- GENERATED by \`npm run docs:architecture\` from docs/architecture/*.mmd, docs/architecture/README.md and src/. Do not edit. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flue QA Architecture</title>
  <style>${CSS}  </style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <pattern id="stripes" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="10" height="10" style="fill: var(--gate-bg)"/><rect width="3" height="10" style="fill: color-mix(in srgb, var(--gate) 22%, transparent)"/>
  </pattern>
</defs></svg>
<main>
  <header>
    <h1>Flue QA Agents — architecture</h1>
    <p>A local-first QA workflow in two phases, with a human review workspace and approval gate between them. Host code sequences every stage; each AI agent runs as its own process, holds only narrow tools, and can write only its own schema- and semantically-validated JSON artifact. Models run on a local Ollama or on OpenRouter, selected by <code>QA_MODEL</code>.</p>
    ${paragraphs(intro)}
    <div class="clegend" aria-label="Legend">
      <span class="grp">Legend</span>
      <span><i class="sw sw-agent"></i>AI agent</span>
      <span><i class="sw sw-host"></i>Host code</span>
      <span><i class="sw sw-art"></i>Artifact / file</span>
      <span><i class="sw sw-human"></i>Person</span>
      <span><i class="sw sw-gate"></i>Gate</span>
      <span><i class="sw sw-run"></i>Runtime service</span>
      <span><i class="sw sw-entry"></i>Entry / exit</span>
      <span><i class="sw sw-plan"></i>Optional or not built</span>
    </div>
    <nav class="toc">${secs.map((s) => `<a href="#${s.name}">${esc(s.title)}</a>`).join('')}<a href="#capabilities">Capability matrix</a></nav>
  </header>
${secs.map((s) => `
  <section id="${s.name}">
    <h2>${esc(s.title)}</h2>
    ${paragraphs(s.prose, 'lede')}
    <div class="board"><pre class="mermaid">
${esc(diagram(s.name))}
</pre></div>
  </section>`).join('\n')}

  <section id="capabilities">
    <h2>Capability matrix</h2>
    <p class="lede">What each agent mounts with <code>useTool()</code>, read from <code>src/agents/*.ts</code>, and what starts it. The <code>write_qa_artifact</code> column names the <em>only</em> artifact that agent's write tool accepts; struck-through tools are mounted on no agent.</p>
    ${matrixHtml()}
  </section>

  <footer>Generated by <code>npm run docs:architecture</code> from ${sources}, the prose in <code>docs/architecture/README.md</code>,
  and <code>src/agents/</code>, <code>src/tools/</code>, <code>src/connections/playwright-mcp.ts</code> and the stage lists in <code>scripts/lib/</code>.
  Edit those, not this file; <code>npm test</code> fails when it is out of date. Diagrams are rendered by Mermaid, loaded from jsDelivr.</footer>
</main>
<script type="module">
  import mermaid from '${MERMAID}';
  // Colours come from the page's CSS variables, so light and dark need no re-render.
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fontSize: '14px' },
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 36, rankSpacing: 46, padding: 14, useMaxWidth: true },
  });
  await mermaid.run({ querySelector: 'pre.mermaid' });
</script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readme = renderArchitectureReadme(read(README));
  const outputs = [
    [README, readme],
    [VIEW, renderArchitectureView(readme)],
  ];
  const stale = outputs.filter(([path, next]) => {
    try { return read(path) !== next; } catch { return true; }
  });
  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      console.error(`Out of date: ${stale.map(([p]) => p.slice(ROOT.length + 1)).join(', ')}. Run: npm run docs:architecture`);
      process.exit(1);
    }
  } else {
    for (const [path, next] of stale) {
      writeFileSync(path, next);
      console.log(`Updated ${path.slice(ROOT.length + 1)}`);
    }
  }
}
