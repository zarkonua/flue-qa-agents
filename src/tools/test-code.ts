// Test-authoring and test-execution tools.
//
// The spec's rule for execution: "The model must not provide an arbitrary shell
// command. Host code builds `npx playwright test <validated-test-path>`." So
// these tools take at most a validated relative path — never a command, never
// arguments, never a shell string — and this module assembles the argv itself
// and spawns it without a shell.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, relative } from 'node:path';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  isUnderAllowedRoots,
  PathNotAllowedError,
  resolveInsideRoot,
  TARGET_REPO_ROOT,
  targetRepoProblem,
  TEST_RESULTS_ROOTS,
  TEST_WRITE_ROOTS,
} from '../lib/trusted-roots.ts';

/** Extensions automation code may be written as. Anything else is refused. */
const WRITABLE_EXTENSIONS = new Set(['.ts', '.tsx']);

const MAX_OUTPUT_CHARS = 8_000;
const RUN_TIMEOUT_MS = Number(process.env.QA_TEST_RUN_TIMEOUT_MS ?? 10 * 60_000);

function toolError(error: unknown) {
  if (error instanceof PathNotAllowedError) return { output: { ok: false, error: error.message } };
  throw error;
}

/** Trim command output to something an 8192-token model can actually read. */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  // Keep the tail: Playwright puts the failure summary at the end.
  return { text: text.slice(-MAX_OUTPUT_CHARS), truncated: true };
}

/**
 * Run a fixed argv in the target repo. No shell (`shell: false` is the default
 * for `spawn` with an argv array), so there is no metacharacter surface even if
 * a validated path contained something odd.
 */
function runInRepo(command: string, args: string[]): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: TARGET_REPO_ROOT,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    const onChunk = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // Bound memory as well as the model's view of it.
      if (output.length > MAX_OUTPUT_CHARS * 4) output = output.slice(-MAX_OUTPUT_CHARS * 2);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, output: `${output}\nFailed to start "${command}": ${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, output, timedOut });
    });
  });
}

export const writeTestFileTool = defineTool({
  name: 'write_test_file',
  description:
    'Create or replace one Playwright TypeScript file in the target repository. `relativePath` is ' +
    `relative to the repository root and must sit under an allowed test-authoring root (${TEST_WRITE_ROOTS.join(', ')}) ` +
    'and end in .ts/.tsx. Product source, config, and .claude/ are not writable. Pass the complete ' +
    'file content — this replaces the file, it does not patch it.',
  input: v.object({
    relativePath: v.pipe(v.string(), v.description('Repo-relative test file, e.g. "tests/login.spec.ts"')),
    content: v.pipe(v.string(), v.description('The complete file content')),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      if (!isUnderAllowedRoots(data.relativePath, TEST_WRITE_ROOTS)) {
        return {
          output: {
            ok: false,
            error:
              `"${data.relativePath}" is outside the allowed test-authoring roots. ` +
              `Write only under: ${TEST_WRITE_ROOTS.join(', ')}.`,
          },
        };
      }
      if (!WRITABLE_EXTENSIONS.has(extname(data.relativePath))) {
        return { output: { ok: false, error: `Only ${[...WRITABLE_EXTENSIONS].join('/')} files may be written.` } };
      }

      const absolute = resolveInsideRoot(TARGET_REPO_ROOT, data.relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      const existed = existsSync(absolute);
      writeFileSync(absolute, data.content, 'utf8');
      return { output: { ok: true, path: data.relativePath, replaced: existed, bytes: data.content.length } };
    } catch (error) {
      return toolError(error);
    }
  },
});

export const runPlaywrightTestTool = defineTool({
  name: 'run_playwright_test',
  description:
    'Run the Playwright test suite in the target repository, headless. Optionally pass one ' +
    'repo-relative test path to run just that file — you cannot pass a shell command, extra ' +
    'arguments, or flags; the host builds "npx playwright test <path>" itself. Returns the exit ' +
    'code and the tail of the output.',
  input: v.object({
    relativeTestPath: v.optional(
      v.pipe(v.string(), v.description('Repo-relative spec file to run, e.g. "tests/login.spec.ts". Omit to run all tests.')),
    ),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      const args = ['playwright', 'test', '--reporter=list'];

      if (data.relativeTestPath) {
        if (!isUnderAllowedRoots(data.relativeTestPath, TEST_WRITE_ROOTS)) {
          return {
            output: {
              ok: false,
              error:
                `"${data.relativeTestPath}" is outside the configured test roots ` +
                `(${TEST_WRITE_ROOTS.join(', ')}), so it is not runnable through this tool.`,
            },
          };
        }
        const absolute = resolveInsideRoot(TARGET_REPO_ROOT, data.relativeTestPath);
        if (!existsSync(absolute)) {
          return { output: { ok: false, error: `No such test file: "${data.relativeTestPath}".` } };
        }
        // Pass the repo-relative form, which is what Playwright's filter expects.
        args.push(relative(TARGET_REPO_ROOT, absolute));
      }

      const { exitCode, output, timedOut } = await runInRepo('npx', args);
      const clipped = clip(output);
      return {
        output: {
          ok: exitCode === 0,
          command: `npx ${args.join(' ')}`,
          exitCode,
          timedOut,
          outputTruncated: clipped.truncated,
          output: clipped.text,
        },
      };
    } catch (error) {
      return toolError(error);
    }
  },
});

export const runTypecheckTool = defineTool({
  name: 'run_typecheck',
  description:
    'Type-check the target repository with the host-configured command (no arguments, no shell ' +
    'command input). Run it after writing test code and fix what it reports.',
  input: v.object({}),
  async run() {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };

    // Fixed argv chosen by trusted host code, overridable only by the operator.
    const configured = process.env.QA_TYPECHECK_SCRIPT?.trim();
    const args = configured ? ['run', configured] : ['tsc', '--noEmit'];
    const command = configured ? 'npm' : 'npx';

    const { exitCode, output, timedOut } = await runInRepo(command, args);
    const clipped = clip(output);
    return {
      output: {
        ok: exitCode === 0,
        command: `${command} ${args.join(' ')}`,
        exitCode,
        timedOut,
        outputTruncated: clipped.truncated,
        output: clipped.text,
      },
    };
  },
});

export const readTestResultsTool = defineTool({
  name: 'read_test_results',
  description:
    'List or read Playwright output (results, reports, traces) from the target repository. Call ' +
    'with no path to list what exists; pass a repo-relative path under a configured results root ' +
    `(${TEST_RESULTS_ROOTS.join(', ')}) to read one text file. Trace and screenshot binaries are ` +
    'listed, not decoded — open those with the Playwright trace viewer.',
  input: v.object({
    relativePath: v.optional(
      v.pipe(v.string(), v.description('Repo-relative file under a results root. Omit to list available output.')),
    ),
  }),
  async run({ data }) {
    const problem = targetRepoProblem();
    if (problem) return { output: { ok: false, error: problem } };
    try {
      if (!data.relativePath) {
        const found: { path: string; type: string; bytes?: number }[] = [];
        for (const root of TEST_RESULTS_ROOTS) {
          const absolute = join(TARGET_REPO_ROOT, root);
          if (!existsSync(absolute)) continue;
          const stack = [absolute];
          while (stack.length > 0 && found.length < 200) {
            const dir = stack.pop()!;
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) stack.push(full);
              else found.push({ path: relative(TARGET_REPO_ROOT, full), type: 'file', bytes: statSync(full).size });
            }
          }
        }
        return { output: { ok: true, roots: TEST_RESULTS_ROOTS, entries: found } };
      }

      if (!isUnderAllowedRoots(data.relativePath, TEST_RESULTS_ROOTS)) {
        return {
          output: {
            ok: false,
            error: `"${data.relativePath}" is outside the results roots (${TEST_RESULTS_ROOTS.join(', ')}).`,
          },
        };
      }
      const absolute = resolveInsideRoot(TARGET_REPO_ROOT, data.relativePath);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        return { output: { ok: false, error: `No such results file: "${data.relativePath}".` } };
      }
      const raw = readFileSync(absolute, 'utf8');
      const clipped = clip(raw);
      return { output: { ok: true, path: data.relativePath, truncated: clipped.truncated, content: clipped.text } };
    } catch (error) {
      return toolError(error);
    }
  },
});
