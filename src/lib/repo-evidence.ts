// Ground truth about the target repository, gathered by trusted host code.
//
// `repo-analysis` is the first Phase 2 artifact, and the same rule applies to
// it as to every Phase 1 artifact: nothing the model asserts is taken on trust.
// Here that means every path, script and dependency it names must actually be
// in the repository. This module reads that evidence from disk; the validator
// in `semantic-validate.ts` stays pure and is handed the result.
//
// Paths go through `resolveInsideRoot()`, so a probe cannot be used to ask
// whether some file outside the trusted root exists.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { PathNotAllowedError, resolveInsideRoot, TARGET_REPO_ROOT } from './trusted-roots.ts';

/**
 * Directory names that hold automation in a JS/TS test repository. Used only to
 * notice a directory the analysis never mentioned — never to assert what a
 * directory *is*. Deliberately a fixed list: guessing from contents would make
 * the check subjective, and the validator does not infer architecture.
 */
const AUTOMATION_DIR_NAMES = new Set([
  'tests', 'test', 'e2e', 'specs', 'spec',
  'pages', 'pageobjects', 'page-objects', 'pom',
  'fixtures', 'helpers', 'utils', 'support',
  'api', 'clients', 'services',
  'data', 'testdata', 'test-data',
  'auth', 'config',
]);

/** Depth and breadth caps, so collecting evidence can never walk a whole monorepo. */
const MAX_SCAN_ENTRIES = 400;

export interface RepoEvidence {
  /** The repository is present at the configured root. */
  rootExists: boolean;
  /** True when `relativePath` exists inside the target repo. Blocked paths are never "existing". */
  exists(relativePath: string): boolean;
  /** True when `relativePath` exists and is a directory. */
  isDirectory(relativePath: string): boolean;
  /** True when this directory contains at least one file, at any depth (bounded). */
  hasFiles(relativePath: string): boolean;
  /**
   * Top-level directories whose name says they hold automation. What the
   * analysis is expected to have an opinion about — describe it, or say in
   * `unknowns` why not.
   */
  automationDirectories: string[];
  /** Script names from the repo's own package.json, or undefined when there is none. */
  scripts?: Set<string>;
  /** dependencies + devDependencies names, or undefined when there is no package.json. */
  dependencies?: Set<string>;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson | undefined {
  try {
    const path = resolveInsideRoot(TARGET_REPO_ROOT, 'package.json');
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    // Missing, unreadable or malformed: no evidence rather than a crash. The
    // validator then skips the script/dependency checks instead of rejecting
    // everything the agent wrote.
    return undefined;
  }
}

/** Snapshot the repository facts the validator needs. Read-only; touches nothing. */
export function collectRepoEvidence(): RepoEvidence {
  const rootExists = existsSync(TARGET_REPO_ROOT);

  const resolveSafe = (relativePath: string): string | undefined => {
    try {
      return resolveInsideRoot(TARGET_REPO_ROOT, relativePath);
    } catch (error) {
      if (error instanceof PathNotAllowedError) return undefined;
      throw error;
    }
  };

  const evidence: RepoEvidence = {
    rootExists,
    hasFiles: () => false,
    automationDirectories: [],
    exists(relativePath) {
      if (!rootExists) return false;
      const absolute = resolveSafe(relativePath);
      return absolute !== undefined && existsSync(absolute);
    },
    isDirectory(relativePath) {
      if (!rootExists) return false;
      const absolute = resolveSafe(relativePath);
      if (absolute === undefined || !existsSync(absolute)) return false;
      try {
        return statSync(absolute).isDirectory();
      } catch {
        return false;
      }
    },
  };

  /** Bounded: direct entries of one directory, or [] when it cannot be read. */
  const entriesOf = (relativePath: string) => {
    const absolute = resolveSafe(relativePath);
    if (absolute === undefined || !existsSync(absolute)) return [];
    try {
      return readdirSync(absolute, { withFileTypes: true }).slice(0, MAX_SCAN_ENTRIES);
    } catch {
      return [];
    }
  };

  evidence.hasFiles = (relativePath) => {
    if (!rootExists) return false;
    const queue = [relativePath];
    let budget = MAX_SCAN_ENTRIES;
    while (queue.length > 0 && budget > 0) {
      const dir = queue.shift()!;
      for (const entry of entriesOf(dir)) {
        budget -= 1;
        if (budget <= 0) break;
        if (entry.isFile()) return true;
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push(`${dir}/${entry.name}`);
        }
      }
    }
    return false;
  };

  const automation: string[] = [];
  if (rootExists) {
    for (const entry of entriesOf('.')) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (!AUTOMATION_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      // Top level only. A subdirectory is covered by whatever describes its
      // parent, so listing `tests/auth` separately would only cost cap space.
      automation.push(entry.name);
    }
  }
  evidence.automationDirectories = automation;

  const pkg = rootExists ? readPackageJson() : undefined;
  if (pkg) {
    evidence.scripts = new Set(Object.keys(pkg.scripts ?? {}));
    evidence.dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  }
  return evidence;
}
