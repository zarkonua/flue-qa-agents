// Read-only repository tools for the target product repo.
//
// These take a *repo-relative* path, never an absolute one, and every path goes
// through `resolveInsideRoot()` in trusted host code before any I/O. The model
// cannot name a root, cannot escape one with `..`, and cannot reach `.claude/`,
// `.git/`, `.env`, keys, or `node_modules` at any depth.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { PathNotAllowedError, resolveInsideRoot, TARGET_REPO_ROOT, targetRepoProblem } from '../lib/trusted-roots.ts';

/** Keep one file from eating an 8192-token budget whole. */
const MAX_FILE_BYTES = 60_000;
const MAX_SEARCH_HITS = 40;
const MAX_SEARCH_FILES = 4_000;

/** Text-ish extensions worth searching; anything else is skipped as binary. */
const SEARCHABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.md', '.yml', '.yaml', '.html', '.css', '.scss', '.txt', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.next', '.cache']);

function toolError(error: unknown) {
  if (error instanceof PathNotAllowedError) return { output: { ok: false, error: error.message } };
  throw error;
}

export const listRepoDirectoryTool = defineTool({
  name: 'list_repo_directory',
  description:
    'List the entries of one directory in the target repository. `relativePath` is relative to ' +
    'the repository root ("." for the root itself) — absolute paths and ".." are rejected. ' +
    'Read-only.',
  input: v.object({
    relativePath: v.pipe(v.string(), v.description('Repo-relative directory, e.g. "tests/e2e" or "."')),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      const absolute = resolveInsideRoot(TARGET_REPO_ROOT, data.relativePath || '.');
      const entries = readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }));
      return { output: { ok: true, path: data.relativePath, entries } };
    } catch (error) {
      return toolError(error);
    }
  },
});

export const readRepoFileTool = defineTool({
  name: 'read_repo_file',
  description:
    'Read one text file from the target repository. `relativePath` is relative to the repository ' +
    'root — absolute paths, ".." escapes, and secret files (.env, keys) are rejected. Large files ' +
    'are truncated; read a specific file rather than browsing broadly.',
  input: v.object({
    relativePath: v.pipe(v.string(), v.description('Repo-relative file, e.g. "playwright.config.ts"')),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      const absolute = resolveInsideRoot(TARGET_REPO_ROOT, data.relativePath);
      const stat = statSync(absolute);
      if (!stat.isFile()) return { output: { ok: false, error: `"${data.relativePath}" is not a file.` } };
      const raw = readFileSync(absolute, 'utf8');
      const truncated = raw.length > MAX_FILE_BYTES;
      return {
        output: {
          ok: true,
          path: data.relativePath,
          truncated,
          content: truncated ? raw.slice(0, MAX_FILE_BYTES) : raw,
        },
      };
    } catch (error) {
      return toolError(error);
    }
  },
});

function* walk(dir: string, budget: { files: number }): Generator<string> {
  if (budget.files <= 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files <= 0) return;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, budget);
    } else if (entry.isFile() && SEARCHABLE_EXTENSIONS.has(extname(entry.name))) {
      budget.files -= 1;
      yield full;
    }
  }
}

export const searchRepoTool = defineTool({
  name: 'search_repo',
  description:
    'Search the target repository for a literal string (case-insensitive) and return matching ' +
    'file paths with line numbers and the matching line. Use it to find existing fixtures, page ' +
    'objects, helpers, and locator conventions BEFORE writing anything new. Optionally restrict ' +
    'the search to a repo-relative subdirectory.',
  input: v.object({
    query: v.pipe(v.string(), v.minLength(2), v.description('Literal text to find, e.g. "getByRole"')),
    inDirectory: v.optional(
      v.pipe(v.string(), v.description('Repo-relative subdirectory to search, e.g. "tests". Defaults to the whole repo.')),
    ),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      const root = resolveInsideRoot(TARGET_REPO_ROOT, data.inDirectory || '.');
      const needle = data.query.toLowerCase();
      const hits: { file: string; line: number; text: string }[] = [];
      const budget = { files: MAX_SEARCH_FILES };

      for (const file of walk(root, budget)) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!content.toLowerCase().includes(needle)) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push({ file: relative(TARGET_REPO_ROOT, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      }

      return {
        output: {
          ok: true,
          query: data.query,
          hitCount: hits.length,
          truncated: hits.length >= MAX_SEARCH_HITS,
          hits,
        },
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
