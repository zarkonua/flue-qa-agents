// Trusted host configuration: every filesystem root the runtime agents can
// reach, resolved once, here, from the environment — never from model input.
//
// The spec pack's docs/AGENT_SANDBOX_AND_TOOLS.md requires distinct roots
// (QA_ARTIFACT_ROOT, TARGET_REPO_ROOT, TEST_WRITE_ROOTS, TEST_RESULTS_ROOT)
// rather than one working directory, and requires that none of them be
// inferred from what the model says. This module is that configuration; the
// tool modules import it and resolve model-supplied *relative* paths against
// it with `resolveInsideRoot()`.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Claude Code control plane: this project, which holds `.claude/`, the
 * agent source, and the security configuration itself. Every runtime root must
 * live outside it. Same constant as `qa-artifacts.ts` guards against — kept
 * here too so the repo/test roots get the identical check.
 */
export const CONTROL_PLANE_ROOT = resolve(here, '..', '..');

/** `child` is `parent` itself or lies beneath it — separator-aware, not a string prefix. */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Read an absolute path from the environment, failing loudly on a value that
 * is not absolute *for this platform*. A leftover Windows `C:\...` value is a
 * relative segment on Linux, and `resolve()` would silently land it inside the
 * control plane — exactly the trust-zone collapse the spec forbids.
 */
function requireAbsoluteEnv(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (!isAbsolute(value)) {
    throw new Error(
      `${name} must be an absolute path for this platform; got "${value}". ` +
        'A Windows-style path such as "C:\\LLM\\qa-workspace" is not absolute on Linux/WSL — ' +
        'use "/home/<user>/projects/qa-workspace" instead.',
    );
  }
  return resolve(value);
}

function requireOutsideControlPlane(name: string, root: string): string {
  if (isInside(root, CONTROL_PLANE_ROOT)) {
    throw new Error(
      `${name} (${root}) is inside the control plane (${CONTROL_PLANE_ROOT}). ` +
        'The runtime workspace must be a separate sibling directory, so that no runtime tool ' +
        'can resolve to `.claude/` or to the agent source that defines these restrictions.',
    );
  }
  return root;
}

/**
 * The product repository the QA agents analyse and write tests into. Defaults
 * to the sibling runtime workspace the spec prescribes. Note this is normally
 * NOT this control-plane repo: "Do not put product test specs into the Flue
 * control-plane repo unless that is intentionally the target repo."
 */
export const TARGET_REPO_ROOT = requireOutsideControlPlane(
  'QA_TARGET_REPO_ROOT',
  requireAbsoluteEnv(
    'QA_TARGET_REPO_ROOT',
    process.env.QA_TARGET_REPO_ROOT,
    resolve(CONTROL_PLANE_ROOT, '..', 'qa-workspace', 'target-repo'),
  ),
);

/**
 * Working directory for the Playwright MCP server, and where it writes output.
 *
 * This is a security boundary, not housekeeping. `browser_snapshot` and
 * `browser_take_screenshot` accept a model-chosen `filename`, and the server
 * resolves it against its working directory. Launched from this project, that
 * let a browser agent write into the control plane — including `.claude/` and
 * this file. Confining the server's cwd to a runtime directory outside the
 * control plane confines every such write with it.
 */
export const MCP_OUTPUT_ROOT = requireOutsideControlPlane(
  'QA_MCP_OUTPUT_ROOT',
  requireAbsoluteEnv(
    'QA_MCP_OUTPUT_ROOT',
    process.env.QA_MCP_OUTPUT_ROOT,
    resolve(CONTROL_PLANE_ROOT, '..', 'qa-workspace', '.mcp-output'),
  ),
);

/**
 * Directories inside the target repo where automation code may be created or
 * changed, as repo-relative prefixes. The spec's example allowlist; override
 * with a comma-separated `QA_TEST_WRITE_ROOTS` once repo analysis says what
 * this particular repository actually uses.
 */
export const TEST_WRITE_ROOTS: readonly string[] = (
  process.env.QA_TEST_WRITE_ROOTS ?? 'tests,e2e,pages,fixtures,helpers'
)
  .split(',')
  .map((s) => s.trim().replace(/^[./]+|\/+$/g, ''))
  .filter(Boolean);

/** Playwright output the Failure Analyzer and Reviewer read: reports, traces, results. */
export const TEST_RESULTS_ROOTS: readonly string[] = (
  process.env.QA_TEST_RESULTS_ROOTS ?? 'test-results,playwright-report,blob-report'
)
  .split(',')
  .map((s) => s.trim().replace(/^[./]+|\/+$/g, ''))
  .filter(Boolean);

/**
 * Path segments no repository tool may touch, at any depth. `.claude` and the
 * agent source are the control plane; `.git` config/credentials and `.env`
 * files are the spec's minimum secret blocklist; `node_modules` is excluded
 * because searching it wastes an 8192-token budget, not for security.
 */
const FORBIDDEN_SEGMENTS = new Set([
  '.claude',
  '.git',
  '.env',
  '.ssh',
  // Conventional home of Playwright auth state (`playwright/.auth`).
  '.auth',
  '.npmrc',
  'node_modules',
]);

/**
 * `.env`, `.env.local`, `id_rsa`, `*.pem`, Playwright storage state … —
 * secret-shaped files, blocked by name. Storage state holds live cookies and
 * tokens; the names match the ones `.gitignore` keeps out of the history.
 */
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|ed25519|ecdsa)$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^storage-?state.*\.json$/i,
  /\.storagestate\.json$/i,
];

export class PathNotAllowedError extends Error {}

/**
 * A target repo that is not there is an operator configuration problem, not a
 * model mistake. Report it to the agent as a tool error it can relay, rather
 * than letting an ENOENT escape as a crash mid-run.
 */
export function targetRepoProblem(): string | undefined {
  if (!existsSync(TARGET_REPO_ROOT)) {
    return (
      `The configured target repository does not exist at ${TARGET_REPO_ROOT}. ` +
      'This is a host configuration problem, not something you can fix: report it and stop. ' +
      'The operator must clone the product repo there or set QA_TARGET_REPO_ROOT.'
    );
  }
  return undefined;
}

/**
 * Resolve a model-supplied *relative* path against a trusted root and prove it
 * stays there. Implements the spec's path-security requirements in order:
 * reject absolute input, normalise, reject `..` escapes, reject control/secret
 * locations, and — where the file already exists — re-check after resolving
 * symlinks, so a symlink inside the root cannot point outside it.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathNotAllowedError('Path must be a non-empty relative path.');
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new PathNotAllowedError(
      `Absolute paths are not accepted ("${relativePath}"). Pass a path relative to the configured root.`,
    );
  }
  if (relativePath.includes('\0')) {
    throw new PathNotAllowedError('Path contains a null byte.');
  }

  const normalised = normalize(relativePath).replaceAll('\\', '/');
  const segments = normalised.split('/').filter((s) => s.length > 0 && s !== '.');

  for (const segment of segments) {
    if (segment === '..') {
      throw new PathNotAllowedError(`Path escapes its root via "..": "${relativePath}".`);
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      throw new PathNotAllowedError(
        `"${segment}" is a blocked location (control-plane, VCS, secret, or dependency directory).`,
      );
    }
  }

  const fileName = segments.at(-1) ?? '';
  if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
    throw new PathNotAllowedError(`"${fileName}" looks like a secret file and is never readable through these tools.`);
  }

  const absolute = resolve(join(root, ...segments));
  if (!isInside(absolute, root)) {
    throw new PathNotAllowedError(`Resolved path is outside the configured root: "${relativePath}".`);
  }

  // Symlink escape: a link *inside* the root may still target something outside
  // it. Only checkable for paths that exist; a new file is checked via its
  // parent directory instead.
  const probe = existsSync(absolute) ? absolute : dirname(absolute);
  if (existsSync(probe)) {
    const real = realpathSync(probe);
    const realRoot = realpathSync(root);
    if (!isInside(real, realRoot)) {
      throw new PathNotAllowedError(`Path resolves outside the configured root through a symlink: "${relativePath}".`);
    }
  }

  return absolute;
}

/** True when `relativePath` sits under one of the configured test-write roots. */
export function isUnderAllowedRoots(relativePath: string, roots: readonly string[]): boolean {
  const normalised = normalize(relativePath).replaceAll('\\', '/').replace(/^\/+/, '');
  return roots.some((root) => normalised === root || normalised.startsWith(root + '/'));
}
