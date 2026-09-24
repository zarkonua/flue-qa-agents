// The automation project contract: what a later agent needs in order to write
// a test that belongs in THIS repository, rather than a generic one.
//
// Why it exists. `repo-analysis.json` is a description of a repository, written
// for a person: layout, conventions, risks, unknowns, prose. A Generator does
// not need the prose, and asking it to re-read the analysis and decide which
// parts matter is asking it to re-derive a judgement that has already been
// made — which is where invented conventions come from.
//
// So the host projects the analysis into a narrow, machine-shaped contract:
// where tests live, what to import, how to authenticate, what to name things.
// Nothing here is new information. Every field is carried across from the
// analysis, and every path and script is re-checked against the repository on
// disk before it is written.
//
// Deliberately NOT an agent's job. A second model reading the first model's
// output and summarising it would launder unverified claims into a document
// that looks authoritative. This module is a projection with a validator, not
// a summary.
//
// Unknown stays unknown. A field the analysis did not establish is absent, and
// what the analysis listed as unknown is carried through verbatim. An absent
// field means "nobody verified this", which a Generator must treat as a reason
// to ask rather than a licence to invent.

import type { RepoEvidence } from './repo-evidence.ts';
import type { RepoAnalysis } from './semantic-validate.ts';

/** A value carried from the analysis, with the file that evidences it. */
export interface TracedValue<T> {
  value: T;
  /** Repo-relative path the analysis cited. Absent when the field needs none. */
  evidencePath?: string;
  evidenceLine?: number;
}

export interface AutomationContract {
  generatedAt: string;
  /** Ties this contract to the exact analysis it was projected from. */
  sourceAnalysisSha256: string;
  repository: {
    language?: string;
    packageManager?: string;
    testRunner?: string;
  };
  /** Where tests live. Absent when the analysis never identified a test root. */
  testRoot?: TracedValue<string>;
  framework?: {
    configPath?: TracedValue<string>;
    testDir?: TracedValue<string>;
    baseURL?: TracedValue<string>;
    usesStorageState?: TracedValue<boolean>;
  };
  /**
   * Directories a Generator would place or import things from, keyed by the
   * analysis's own `layout.kind`. Only kinds the analysis actually reported.
   */
  locations: Partial<Record<LayoutKind, TracedValue<string>>>;
  /** Rules a new test must follow, carried across with their evidence. */
  conventions: { topic: string; rule: string; evidencePath: string; evidenceLine?: number }[];
  /** Scripts that exist in the repository's own package.json. */
  scripts: { name: string; command: string; purpose?: string }[];
  /** What the analysis could not establish. Carried through verbatim. */
  unknowns: string[];
  /** What the host re-checked when building this, so a reader can weigh it. */
  verification: {
    pathsChecked: number;
    /** Paths the analysis cited that are NOT present on disk. Always empty in a valid contract. */
    pathsMissing: string[];
    scriptsChecked: number;
    scriptsMissing: string[];
  };
}

export type LayoutKind =
  | 'testDir' | 'pageObjects' | 'fixtures' | 'helpers' | 'apiClients'
  | 'testData' | 'auth' | 'config' | 'ci' | 'other';

/** Layout kinds worth putting in the contract. `other` and `ci` are not a Generator's concern. */
const CONTRACT_KINDS: LayoutKind[] = [
  'testDir', 'pageObjects', 'fixtures', 'helpers', 'apiClients', 'testData', 'auth', 'config',
];

/**
 * Project a repo analysis into the contract.
 *
 * `evidence` is the repository on disk. A path or script the analysis mentions
 * that is not actually there is dropped and recorded in `verification`, never
 * carried into the contract — the whole value of this document is that a
 * Generator can act on it without checking.
 */
export function buildAutomationContract(
  analysis: RepoAnalysis,
  evidence: RepoEvidence,
  options: { sourceAnalysisSha256: string; now?: Date },
): AutomationContract {
  const pathsMissing: string[] = [];
  let pathsChecked = 0;

  /** Keep a path only when it is really there. */
  const verifiedPath = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    pathsChecked += 1;
    if (evidence.exists(path)) return path;
    pathsMissing.push(path);
    return undefined;
  };

  const traced = (value: string | undefined, evidencePath?: string): TracedValue<string> | undefined => {
    const kept = verifiedPath(value);
    return kept === undefined ? undefined : { value: kept, ...(evidencePath ? { evidencePath } : {}) };
  };

  // --- locations, from the analysis's own layout ---------------------------
  const locations: AutomationContract['locations'] = {};
  for (const entry of analysis.layout ?? []) {
    const kind = entry?.kind as LayoutKind | undefined;
    if (kind === undefined || !CONTRACT_KINDS.includes(kind)) continue;
    // First wins: the analysis lists the canonical one first, and a second
    // entry of the same kind is a variant rather than a replacement.
    if (locations[kind] !== undefined) continue;
    const value = traced(entry.path, entry.path);
    if (value) locations[kind] = value;
  }

  // --- framework -----------------------------------------------------------
  const pw = analysis.playwright;
  const framework = pw
    ? {
        configPath: traced(pw.configPath, pw.configPath),
        testDir: traced(pw.testDir, pw.configPath),
        // A baseURL is a value read out of the config, not a path on disk.
        baseURL: pw.baseURL ? { value: pw.baseURL, evidencePath: pw.configPath } : undefined,
        usesStorageState:
          pw.usesStorageState === undefined
            ? undefined
            : { value: Boolean(pw.usesStorageState), evidencePath: pw.configPath },
      }
    : undefined;

  // --- conventions ---------------------------------------------------------
  // Only rules whose cited evidence exists. A rule pointing at a file that is
  // not there is exactly the invented convention this is meant to exclude.
  const conventions = (analysis.conventions ?? [])
    .filter((c) => c?.rule && c?.evidencePath && verifiedPath(c.evidencePath) !== undefined)
    .map((c) => ({
      topic: String(c.topic ?? ''),
      rule: String(c.rule),
      evidencePath: String(c.evidencePath),
      ...(typeof c.evidenceLine === 'number' ? { evidenceLine: c.evidenceLine } : {}),
    }));

  // --- scripts -------------------------------------------------------------
  const scriptsMissing: string[] = [];
  let scriptsChecked = 0;
  const scripts = (analysis.scripts ?? [])
    .filter((s) => {
      if (!s?.name) return false;
      scriptsChecked += 1;
      const real = evidence.scripts?.has(s.name) ?? false;
      if (!real) scriptsMissing.push(s.name);
      return real;
    })
    .map((s) => ({ name: String(s.name), command: String(s.command ?? ''), ...(s.purpose ? { purpose: String(s.purpose) } : {}) }));

  // The framework config wins over the layout entry. `playwright.config.ts`
  // declares the real `testDir`; a layout entry of kind `testDir` is often a
  // feature subfolder the analyst happened to list first — a real run produced
  // `tests/auth` there while the config said `tests`, which would have sent
  // every new spec into the auth folder.
  const testRootPath = framework?.testDir?.value ?? locations.testDir?.value;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    sourceAnalysisSha256: options.sourceAnalysisSha256,
    repository: {
      language: analysis.repository?.language,
      packageManager: analysis.repository?.packageManager,
      testRunner: analysis.repository?.testRunner,
    },
    ...(testRootPath ? { testRoot: { value: testRootPath } } : {}),
    ...(framework && Object.values(framework).some((v) => v !== undefined) ? { framework } : {}),
    locations,
    conventions,
    scripts,
    unknowns: [...(analysis.unknowns ?? [])].map(String),
    verification: { pathsChecked, pathsMissing, scriptsChecked, scriptsMissing },
  };
}

export interface ContractProblem {
  code: 'MISSING_PATH' | 'MISSING_SCRIPT' | 'UNTRACED_CONVENTION' | 'STALE_SOURCE';
  detail: string;
}

/**
 * Re-check a contract against the repository.
 *
 * `buildAutomationContract` already drops anything unverified, so a contract it
 * produced validates by construction. This exists for the other case: a
 * contract read back later, against a repository that has since moved on.
 */
export function validateAutomationContract(
  contract: AutomationContract,
  evidence: RepoEvidence,
  currentAnalysisSha256?: string,
): ContractProblem[] {
  const problems: ContractProblem[] = [];

  const checkPath = (path: string | undefined, what: string) => {
    if (!path) return;
    if (!evidence.exists(path)) {
      problems.push({ code: 'MISSING_PATH', detail: `${what} points at "${path}", which is not in the repository.` });
    }
  };

  checkPath(contract.testRoot?.value, 'testRoot');
  checkPath(contract.framework?.configPath?.value, 'framework.configPath');
  checkPath(contract.framework?.testDir?.value, 'framework.testDir');
  for (const [kind, entry] of Object.entries(contract.locations)) {
    checkPath(entry?.value, `locations.${kind}`);
  }

  for (const c of contract.conventions) {
    if (!c.evidencePath) {
      problems.push({ code: 'UNTRACED_CONVENTION', detail: `Convention "${c.topic}" cites no evidence.` });
      continue;
    }
    checkPath(c.evidencePath, `convention "${c.topic}"`);
  }

  for (const s of contract.scripts) {
    if (!(evidence.scripts?.has(s.name) ?? false)) {
      problems.push({ code: 'MISSING_SCRIPT', detail: `Script "${s.name}" is no longer in package.json.` });
    }
  }

  if (currentAnalysisSha256 !== undefined && currentAnalysisSha256 !== contract.sourceAnalysisSha256) {
    problems.push({
      code: 'STALE_SOURCE',
      detail: 'repo-analysis.json has changed since this contract was built. Re-run the Repo Analyzer stage.',
    });
  }

  return problems;
}

/** A one-line host summary for the run log. */
export function contractSummary(contract: AutomationContract): string {
  const locations = Object.keys(contract.locations).length;
  const framework = contract.framework?.configPath?.value ? 'config found' : 'no framework config';
  return (
    `${contract.testRoot?.value ?? 'no test root'} · ${locations} location(s) · ` +
    `${contract.conventions.length} convention(s) · ${contract.scripts.length} script(s) · ` +
    `${framework} · ${contract.unknowns.length} unknown(s)`
  );
}

/**
 * What a Generator still cannot determine from this contract.
 *
 * Reported rather than filled in. The question the contract exists to answer is
 * "could a later agent start a correct test without rediscovering the repo?",
 * and the honest answer includes what is still missing.
 */
export function contractGaps(contract: AutomationContract): string[] {
  const gaps: string[] = [];
  if (!contract.testRoot) gaps.push('no verified test root — a Generator would not know where to put a new test');
  if (!contract.framework?.configPath) gaps.push('no framework config found — runner settings are unknown');
  if (!contract.locations.pageObjects) gaps.push('no page-object root — a Generator cannot follow an existing page-object convention');
  if (!contract.locations.fixtures) gaps.push('no fixtures location — the canonical test import is unknown');
  if (!contract.framework?.baseURL) gaps.push('no baseURL — a Generator would have to hard-code a URL');
  if (contract.framework?.usesStorageState === undefined) gaps.push('auth strategy unknown — storageState use was never established');
  if (contract.conventions.length === 0) gaps.push('no verified conventions — naming, tagging and locator rules are unknown');
  if (contract.scripts.length === 0) gaps.push('no verified scripts — how to run the suite is unknown');
  return gaps;
}
