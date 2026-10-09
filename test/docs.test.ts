// Documentation drift guards.
//
//   npm test
//
// Cheap, deterministic checks that keep the docs describing the code as it is:
// every `npm run` script the docs name exists, local links and anchors resolve,
// the Mermaid sources are well-formed and in sync with both derived views
// (the architecture README and architecture-view.html),
// the pipeline diagrams name the stages the orchestrators actually run, and no
// brittle test count or runtime model configuration creeps back in.
//
// The Mermaid check is structural (header, balanced brackets and quotes,
// balanced subgraphs), not a full parser: it catches the mistakes hand edits
// make without adding Mermaid as a dependency.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGES } from '../scripts/lib/phase1-stages.mjs';
import { NOT_YET_WIRED, PHASE2_STAGES } from '../scripts/lib/phase2-stages.mjs';
import { ARCH_DIR, renderArchitectureReadme, renderArchitectureView, VIEW } from '../scripts/build-architecture-docs.mjs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(path, 'utf8');

const DOCS = [
  join(PROJECT, 'README.md'),
  ...readdirSync(join(PROJECT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join(PROJECT, 'docs', f)),
  join(ARCH_DIR, 'README.md'),
];
const DIAGRAMS = readdirSync(ARCH_DIR).filter((f) => f.endsWith('.mmd')).map((f) => join(ARCH_DIR, f));
const rel = (path: string) => relative(PROJECT, path);

/** Text outside fenced code blocks. */
const prose = (markdown: string) => markdown.replace(/^```[\s\S]*?^```/gm, '');

/** GitHub's heading anchors for a Markdown file. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of prose(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = heading
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

describe('documentation drift', () => {
  it('names only npm scripts that exist in package.json', () => {
    const scripts = new Set(Object.keys(JSON.parse(read(join(PROJECT, 'package.json'))).scripts));
    const missing: string[] = [];
    for (const file of [...DOCS, ...DIAGRAMS, VIEW]) {
      for (const [, name] of read(file).matchAll(/npm run(?:\s+-s)?\s+([a-z][\w:.-]*[\w])/g)) {
        if (!scripts.has(name)) missing.push(`${rel(file)}: npm run ${name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('has no broken local links or anchors', () => {
    const broken: string[] = [];
    for (const file of DOCS) {
      for (const [, target] of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue; // http:, https:, mailto:
        const [path, anchor] = target.split('#');
        const resolved = path === '' ? file : resolve(dirname(file), path);
        if (!existsSync(resolved)) {
          broken.push(`${rel(file)}: ${target} (no such file)`);
          continue;
        }
        if (anchor && resolved.endsWith('.md') && !anchors(read(resolved)).has(anchor)) {
          broken.push(`${rel(file)}: ${target} (no such heading)`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it('keeps every Mermaid source well-formed', () => {
    assert.ok(DIAGRAMS.length >= 6, 'expected the six architecture diagrams');
    const problems: string[] = [];
    const pairs: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
    for (const file of DIAGRAMS) {
      const lines = read(file).split('\n');
      const body = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('%%'));
      if (!/^(flowchart|graph)\s+(TD|TB|BT|LR|RL)$/.test(body[0]?.trim() ?? '')) {
        problems.push(`${rel(file)}: must start with "flowchart <direction>"`);
      }
      let depth = 0;
      lines.forEach((line, i) => {
        if (line.trim().startsWith('%%')) return;
        if ((line.match(/"/g) ?? []).length % 2 !== 0) problems.push(`${rel(file)}:${i + 1}: unbalanced quote`);
        // Brackets outside quoted labels must balance on each line.
        const stack: string[] = [];
        for (const ch of line.replace(/"[^"]*"/g, '""')) {
          if (ch in pairs) stack.push(pairs[ch]);
          else if (Object.values(pairs).includes(ch) && stack.pop() !== ch) {
            problems.push(`${rel(file)}:${i + 1}: unbalanced "${ch}"`);
            break;
          }
        }
        if (stack.length > 0) problems.push(`${rel(file)}:${i + 1}: unclosed bracket`);
        if (/^\s*subgraph\b/.test(line)) depth += 1;
        if (/^\s*end\s*$/.test(line)) depth -= 1;
        if (depth < 0) problems.push(`${rel(file)}:${i + 1}: "end" without "subgraph"`);
      });
      if (depth > 0) problems.push(`${rel(file)}: unclosed subgraph`);
    }
    assert.deepEqual(problems, []);
  });

  it('keeps docs/architecture/README.md and architecture-view.html in sync with their sources', () => {
    const readme = read(join(ARCH_DIR, 'README.md'));
    assert.equal(readme, renderArchitectureReadme(readme), 'README.md is stale — run: npm run docs:architecture');
    assert.equal(read(VIEW), renderArchitectureView(readme), 'architecture-view.html is stale — run: npm run docs:architecture');
    for (const file of DIAGRAMS) {
      const name = file.slice(ARCH_DIR.length + 1, -'.mmd'.length);
      assert.ok(readme.includes(`<!-- diagram:${name} -->`), `${name}.mmd is not embedded in the architecture README`);
    }
  });

  it('shows the Phase 1 stages the orchestrator runs, in order', () => {
    const diagram = read(join(ARCH_DIR, 'phase1-flow.mmd'));
    const positions = STAGES.map((s) => diagram.indexOf(s.label));
    STAGES.forEach((s, i) => assert.ok(positions[i] >= 0, `phase1-flow.mmd does not show ${s.label}`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'phase1-flow.mmd shows the stages out of order');

    const readme = read(join(PROJECT, 'README.md'));
    const table = [...readme.matchAll(/^\| \d \| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(table, STAGES.map((s) => s.key), 'the README Phase 1 table does not match the stage list');
  });

  it('shows only wired Phase 2 agents outside the planned section', () => {
    const diagram = read(join(ARCH_DIR, 'phase2-flow.mmd'));
    for (const stage of PHASE2_STAGES) assert.ok(diagram.includes(stage.label), `phase2-flow.mmd does not show ${stage.label}`);
    const planned = diagram.indexOf('subgraph planned');
    assert.ok(planned >= 0, 'phase2-flow.mmd needs a "planned" subgraph for unwired agents');
    const main = diagram.slice(0, planned).toLowerCase();
    for (const agent of NOT_YET_WIRED) {
      const label = agent.replace(/^src\/agents\/|\.ts$/g, '').replace(/-/g, ' '); // ui-explorer -> "ui explorer"
      assert.ok(!main.includes(label), `${agent} is not wired, but phase2-flow.mmd shows it in the pipeline`);
    }
  });

  it('carries no brittle test counts or runtime model configuration', () => {
    const problems: string[] = [];
    for (const file of [...DOCS, ...DIAGRAMS, VIEW]) {
      const text = read(file);
      for (const [m] of text.matchAll(/\b\d+ (?:unit )?tests\b(?! passing)/g)) problems.push(`${rel(file)}: "${m}"`);
    }
    // Model names and context sizes are configuration: they belong in .env.example
    // and the runbook's settings table, not in the overview or the architecture.
    for (const file of [join(PROJECT, 'README.md'), join(ARCH_DIR, 'README.md'), VIEW, ...DIAGRAMS]) {
      for (const [m] of read(file).matchAll(/qwen[\w.:-]*|gpt-oss[\w.:-]*|deepseek[\w./:-]*|\b\d{4,6} ctx\b|max output/gi)) {
        problems.push(`${rel(file)}: "${m}"`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
