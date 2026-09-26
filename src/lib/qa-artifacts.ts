// Trusted host module for reading/writing .qa/*.json hand-off artifacts.
//
// Security model (see docs/AGENT_SANDBOX_AND_TOOLS.md in the spec pack): the
// model never supplies a filesystem path. It supplies a *logical artifact name*
// from a fixed picklist; this module alone maps that name to a real path under
// a trusted, host-configured root that lives OUTSIDE the Claude Code project
// directory (so a runtime agent has no path back to `.claude/`). Every write is
// validated against the artifact's JSON Schema before touching disk.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema, type JsonSchemaNode } from './schema-validate.ts';
import { collectRepoEvidence } from './repo-evidence.ts';
import { expectedLocations, readSurface, recordCompletionAttempt, writeSurface } from './discovery-surface.ts';
import {
  completionTracked,
  DiscoveryIncompleteError,
  evaluateDiscoveryCompletion,
  type DiscoveryCompletionResult,
} from './discovery-completion.ts';
import { maskValues, redactDeep } from './redaction.ts';
import { AUTH_SECRET_ENV_NAMES } from '../config/auth-bootstrap.ts';
import { auxiliaryOrigins } from '../config/auxiliary-origins.ts';
import {
  BUG_ID_PATTERN,
  buildBugReports,
  normaliseDefectAnalysis,
  validateBugReport,
  validateDefectAnalysis,
  type BugReport,
  type DefectAnalysis,
  type DefectContext,
} from './defects.ts';
import { readLedger } from './observation-ledger.ts';
import {
  formatSemanticErrors,
  validateDiscoveredBehavior,
  validateRequirementsAnalysis,
  validateTestCases,
  validateAutomationPrioritization,
  observedCapabilities,
  validateTestCasesReview,
  validateRepoAnalysis,
  type AutomationPrioritization,
  type TestCasesReview,
  type DiscoveredBehavior,
  type RepoAnalysis,
  type RequirementsAnalysis,
  type SemanticError,
  type TestCases,
} from './semantic-validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(here, '..', '..', 'schemas');

/**
 * The Claude Code control plane: this project, which contains `.claude/`, the
 * agent source, and the security configuration itself. The runtime workspace
 * must be a *sibling* of this, never inside it.
 */
const CONTROL_PLANE_ROOT = resolve(here, '..', '..');

/** `child` is `parent` itself or lies beneath it — a real containment test, not a string prefix. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Host-configured trusted root. Overridable via env for testing/deployment, but
 * never derived from model input. The default is the sibling runtime workspace
 * the spec prescribes: `<parent of this project>/qa-workspace/.qa`.
 *
 * Resolved relative to this module rather than to `process.cwd()`, so the root
 * does not move when the agent is launched from a different directory.
 */
function resolveArtifactRoot(): string {
  const configured = process.env.QA_ARTIFACT_ROOT;
  const root = configured
    ? resolve(configured)
    : resolve(CONTROL_PLANE_ROOT, '..', 'qa-workspace', '.qa');

  // Fail fast rather than silently relocating artifacts. A non-absolute value
  // (for example a Windows `C:\...` path evaluated on Linux, which `resolve()`
  // would treat as a relative segment) would otherwise land the runtime
  // workspace inside the control plane.
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error(
      `QA_ARTIFACT_ROOT must be an absolute path for this platform; got "${configured}". ` +
        'A Windows-style path such as "C:\\LLM\\qa-workspace\\.qa" is not absolute on Linux/WSL — ' +
        'use "/home/<user>/projects/qa-workspace/.qa" instead.',
    );
  }

  // Trust-zone separation: the runtime workspace may never sit inside the
  // Claude Code control plane, which holds `.claude/` and this security code.
  if (isInside(root, CONTROL_PLANE_ROOT)) {
    throw new Error(
      `QA_ARTIFACT_ROOT (${root}) is inside the control plane (${CONTROL_PLANE_ROOT}). ` +
        'The runtime QA workspace must be a separate sibling directory.',
    );
  }

  return root;
}

export const QA_ARTIFACT_ROOT = resolveArtifactRoot();

export type QaArtifactName =
  | 'discovered-behavior'
  | 'requirements-analysis'
  | 'test-cases'
  | 'automation-prioritization'
  | 'test-cases-review'
  // Written by the Defect Analyzer. Its bug reports are fanned out by the host
  // to `bugs/<id>.json`; see writeBugReports().
  | 'defect-analysis'
  | 'repo-analysis'
  | 'ui-exploration'
  | 'automation-plan'
  // Host-written only. Collected by `scripts/lib/evidence.mjs` from the
  // browser; deliberately absent from the agents' write picklist, so no model
  // can author, amend or contradict it. See `src/tools/qa-artifacts.ts`.
  | 'discovery-evidence'
  // Host-projected from repo-analysis; see src/lib/automation-contract.ts.
  // Readable by the automation agents, writable by none of them.
  | 'automation-project-contract';

interface ArtifactDef {
  fileName: string;
  schemaFile: string;
}

const ARTIFACTS: Record<QaArtifactName, ArtifactDef> = {
  'discovered-behavior': { fileName: 'discovered-behavior.json', schemaFile: 'discovered-behavior.schema.json' },
  'requirements-analysis': { fileName: 'requirements-analysis.json', schemaFile: 'requirements-analysis.schema.json' },
  'test-cases': { fileName: 'test-cases.json', schemaFile: 'test-cases.schema.json' },
  'automation-prioritization': { fileName: 'automation-prioritization.json', schemaFile: 'automation-prioritization.schema.json' },
  'test-cases-review': { fileName: 'test-cases-review.json', schemaFile: 'test-cases-review.schema.json' },
  'defect-analysis': { fileName: 'defect-analysis.json', schemaFile: 'defect-analysis.schema.json' },
  'repo-analysis': { fileName: 'repo-analysis.json', schemaFile: 'repo-analysis.schema.json' },
  'ui-exploration': { fileName: 'ui-exploration.json', schemaFile: 'ui-exploration.schema.json' },
  'automation-plan': { fileName: 'automation-plan.json', schemaFile: 'automation-plan.schema.json' },
  'discovery-evidence': { fileName: 'discovery-evidence.json', schemaFile: 'discovery-evidence.schema.json' },
  'automation-project-contract': { fileName: 'automation-project-contract.json', schemaFile: 'automation-project-contract.schema.json' },
};

function loadSchema(schemaFile: string): JsonSchemaNode {
  const raw = readFileSync(join(SCHEMAS_DIR, schemaFile), 'utf8');
  return JSON.parse(raw) as JsonSchemaNode;
}

function resolveArtifactPath(name: QaArtifactName): string {
  const def = ARTIFACTS[name];
  if (!def) throw new Error(`Unknown QA artifact name: ${name}`);
  const path = resolve(join(QA_ARTIFACT_ROOT, def.fileName));
  // Defense in depth: the resolved path must still land inside the trusted root.
  if (!isInside(path, QA_ARTIFACT_ROOT)) {
    throw new Error(`Refusing to access a path outside the QA artifact root: ${path}`);
  }
  return path;
}

/** Absolute path of an artifact file — for trusted host code (hashing, archiving) only. */
export function qaArtifactPath(name: QaArtifactName): string {
  return resolveArtifactPath(name);
}

/**
 * The scenario-type vocabulary, read from the test-cases schema.
 *
 * Exported so the Test Designer's prompt can state the real enum instead of a
 * second copy of it. The prompt once named no vocabulary at all and the model
 * inferred one from the coverage-matrix row categories, collapsing a six-kind
 * classification to `positive`/`negative`. A hard-coded list in the prompt
 * would fix that until the schema changed; deriving it means the two cannot
 * disagree.
 */
export function scenarioTypeVocabulary(): string[] {
  const schema = loadSchema(ARTIFACTS['test-cases'].schemaFile) as JsonSchemaNode & {
    properties?: { testCases?: { items?: { properties?: { types?: { items?: { enum?: string[] } } } } } };
  };
  const values = schema.properties?.testCases?.items?.properties?.types?.items?.enum;
  if (!values || values.length === 0) {
    throw new Error('test-cases.schema.json no longer declares a types enum; the Test Designer prompt depends on it.');
  }
  return [...values];
}

/** Schema errors for `data` as artifact `name`, without writing anything. */
export function schemaErrorsFor(name: QaArtifactName, data: unknown): string[] {
  const def = ARTIFACTS[name];
  if (!def) throw new Error(`Unknown QA artifact name: ${name}`);
  return validateAgainstSchema(data, loadSchema(def.schemaFile));
}

export function readQaArtifact(name: QaArtifactName): unknown {
  const path = resolveArtifactPath(name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Thrown when an artifact is schema-valid but unsupported by upstream evidence. */
export class SemanticValidationError extends Error {
  // Explicit fields, not constructor parameter properties: Node's built-in type
  // stripping (used by `npm test` and the scripts/) rejects the latter.
  readonly artifact: QaArtifactName;
  readonly errors: SemanticError[];

  constructor(artifact: QaArtifactName, errors: SemanticError[]) {
    super(formatSemanticErrors(artifact, errors));
    this.artifact = artifact;
    this.errors = errors;
  }
}

/**
 * Cross-artifact checks, run after schema validation and before any write. The
 * upstream artifacts are read from disk here — never supplied by the model —
 * so an agent cannot validate against evidence of its own invention.
 */
export function semanticErrorsFor(name: QaArtifactName, data: unknown): SemanticError[] {
  switch (name) {
    case 'discovered-behavior': {
      // The surface host code established before the agent ran, when there is
      // one. Absent (no browser, or a run that never built it) means the
      // completeness rules are skipped rather than guessed at.
      const surface = readSurface();
      // What the agent recorded while exploring. Nothing it saw may be quietly
      // dropped during synthesis.
      const ledger = readLedger();
      const observed = ledger && {
        ids: ledger.observations.map((o) => o.id),
        describe: (id: string) => {
          const o = ledger.observations.find((x) => x.id === id);
          return o ? `${o.action} -> ${o.outcome}` : id;
        },
      };
      return validateDiscoveredBehavior(
        data as DiscoveredBehavior,
        surface && {
          expected: expectedLocations(surface),
          origin: surface.origin,
          auxiliaryOrigins: surface.auxiliaryOrigins ?? [],
        },
        observed,
      );
    }

    case 'requirements-analysis': {
      const discovery = readQaArtifact('discovered-behavior') as DiscoveredBehavior | undefined;
      // Requirements-driven workflow: no discovery ran, so there is no
      // evidence set to check against. See docs/VALIDATION.md.
      if (discovery === undefined) return [];
      return validateRequirementsAnalysis(discovery, data as RequirementsAnalysis);
    }

    case 'test-cases': {
      const requirements = readQaArtifact('requirements-analysis') as RequirementsAnalysis | undefined;
      if (requirements === undefined) {
        return [
          {
            code: 'MISSING_UPSTREAM',
            path: '$',
            details: 'requirements-analysis does not exist yet. Test cases need it as their evidence. Stop and report this.',
          },
        ];
      }
      const discovery = readQaArtifact('discovered-behavior') as DiscoveredBehavior | undefined;

      // The upstream artifact may itself be stale — written against an earlier
      // discovery run. Building tests on it would launder its problems, so
      // refuse and say which stage has to re-run. Not the Test Designer's to fix.
      if (discovery !== undefined) {
        const upstream = validateRequirementsAnalysis(discovery, requirements);
        if (upstream.length > 0) {
          return [
            {
              code: 'UPSTREAM_INVALID',
              path: '$',
              details:
                `requirements-analysis is not consistent with the current discovered-behavior ` +
                `(${upstream.length} problem${upstream.length === 1 ? '' : 's'}, first: ${upstream[0].code} at ` +
                `${upstream[0].path}). Behavior Analyst must re-run. You cannot fix this — stop and report it.`,
            },
          ];
        }
      }
      return validateTestCases(discovery, requirements, data as TestCases);
    }

    case 'automation-prioritization': {
      const testCases = readQaArtifact('test-cases') as TestCases | undefined;
      if (testCases === undefined) {
        return [{ code: 'MISSING_UPSTREAM', path: '$', details: 'test-cases does not exist yet. Stop and report this.' }];
      }
      // Validated against the test cases as they are NOW, which may include the
      // operator's hand edits — the prioritization must cover exactly those.
      const priorRequirements = readQaArtifact('requirements-analysis') as RequirementsAnalysis | undefined;
      return validateAutomationPrioritization(
        testCases,
        data as AutomationPrioritization,
        readQaArtifact('discovered-behavior') as DiscoveredBehavior | undefined,
        priorRequirements,
        // What this run actually observed, worked out host-side from the
        // analyst's validation types and the browser evidence. An automation
        // strategy may not claim a capability that is not in here.
        observedCapabilities({
          requirements: priorRequirements,
          evidence: readQaArtifact('discovery-evidence') as { findings?: { type?: string }[] } | undefined,
        }),
      );
    }

    case 'test-cases-review': {
      const testCases = readQaArtifact('test-cases') as TestCases | undefined;
      if (testCases === undefined) {
        return [{ code: 'MISSING_UPSTREAM', path: '$', details: 'test-cases does not exist yet. Stop and report this.' }];
      }
      const defects = readQaArtifact('defect-analysis') as DefectAnalysis | undefined;
      return validateTestCasesReview(
        testCases,
        readQaArtifact('automation-prioritization') as AutomationPrioritization | undefined,
        data as TestCasesReview,
        defects?.summary,
      );
    }

    case 'defect-analysis': {
      const ctx = defectContext();
      if (typeof ctx === 'string') return [{ code: 'MISSING_UPSTREAM', path: '$', details: ctx }];
      const analysis = data as DefectAnalysis;
      const errors = validateDefectAnalysis(analysis, ctx);
      // Re-read from disk after a write: the reports it names must exist and hold.
      if (analysis.bugReports !== undefined) {
        for (const id of analysis.bugReports) {
          const bug = readBugReport(id);
          if (bug === undefined) {
            errors.push({ code: 'INCOMPLETE_DEFECT', path: 'bugReports', value: id, details: `bugs/${id}.json does not exist.` });
            continue;
          }
          errors.push(...validateBugReport(bug, ctx));
        }
      }
      return errors;
    }

    // Phase 2. Checked against the repository on disk, not against a Phase 1
    // artifact: the facts come from the filesystem the agent just read.
    case 'repo-analysis':
      return validateRepoAnalysis(data as RepoAnalysis, collectRepoEvidence());

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Defect analysis and bug reports
// ---------------------------------------------------------------------------

/** Where bug reports live: one file per report, named by its validated id. */
export const BUGS_DIR = join(QA_ARTIFACT_ROOT, 'bugs');

/** The file of one bug report. The id is checked, never trusted: it becomes a file name. */
export function bugReportPath(id: string): string {
  if (!BUG_ID_PATTERN.test(id)) throw new Error(`Not a bug report id: ${JSON.stringify(id)}`);
  const path = resolve(join(BUGS_DIR, `${id}.json`));
  if (!isInside(path, BUGS_DIR)) throw new Error(`Refusing to access a path outside the bug report directory: ${path}`);
  return path;
}

export function readBugReport(id: string): BugReport | undefined {
  const path = bugReportPath(id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as BugReport;
}

/** Ids of the bug report files present, in order. Anything else in the directory is ignored. */
export function listBugReportIds(): string[] {
  if (!existsSync(BUGS_DIR)) return [];
  return readdirSync(BUGS_DIR)
    .map((f) => f.replace(/\.json$/, ''))
    .filter((id) => BUG_ID_PATTERN.test(id))
    .sort();
}

/** Schema + evidence errors for a bug report, against the upstream artifacts on disk. */
export function bugReportErrors(bug: unknown): { schema: string[]; semantic: SemanticError[] } {
  const schema = validateAgainstSchema(bug, loadSchema('bug-report.schema.json'));
  if (schema.length > 0) return { schema, semantic: [] };
  const ctx = defectContext();
  if (typeof ctx === 'string') return { schema, semantic: [{ code: 'MISSING_UPSTREAM', path: '$', details: ctx }] };
  return { schema, semantic: validateBugReport(bug as BugReport, ctx) };
}

/**
 * Write one bug report: redacted, schema-checked and evidence-checked, exactly
 * like an artifact. Used by the host for the analyzer's reports and for a
 * person's decisions and edits (`npm run qa:defects`).
 */
export function writeBugReport(rawBug: BugReport): void {
  const bug = scrub(rawBug);
  const { schema, semantic } = bugReportErrors(bug);
  if (schema.length > 0) throw new Error(`bug report ${bug.id} does not match bug-report.schema.json:\n${schema.map((e) => `  - ${e}`).join('\n')}`);
  if (semantic.length > 0) throw new SemanticValidationError('defect-analysis', semantic);
  const path = bugReportPath(bug.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(bug, null, 2), 'utf8');
}

/** What defect analysis is judged against, read from disk — or why it cannot be. */
function defectContext(): DefectContext | string {
  const discovery = readQaArtifact('discovered-behavior') as DiscoveredBehavior | undefined;
  const requirements = readQaArtifact('requirements-analysis') as RequirementsAnalysis | undefined;
  if (discovery === undefined || requirements === undefined) {
    return 'discovered-behavior and requirements-analysis must exist before defect analysis. Stop and report this.';
  }
  return {
    discovery,
    requirements,
    testCases: readQaArtifact('test-cases') as TestCases | undefined,
    // The origins this run was allowed to treat as test infrastructure.
    auxiliaryOrigins: readSurface()?.auxiliaryOrigins ?? auxiliaryOrigins(),
  };
}

/**
 * Validate and persist a defect analysis and its bug reports, all or nothing:
 * every report is built and checked before any file is touched. Reports from
 * an earlier write that this one no longer produces are removed, so the
 * directory always matches the analysis.
 */
function writeDefectAnalysis(data: DefectAnalysis): DefectAnalysis {
  const ctx = defectContext();
  if (typeof ctx === 'string') throw new SemanticValidationError('defect-analysis', [{ code: 'MISSING_UPSTREAM', path: '$', details: ctx }]);
  // Host-owned fields (summary, ids, expected basis) are recomputed first, so
  // whatever the model put there is replaced rather than argued with.
  const normalised = normaliseDefectAnalysis(data, ctx);
  const semantic = validateDefectAnalysis(normalised, ctx);
  if (semantic.length > 0) throw new SemanticValidationError('defect-analysis', semantic);

  const bugs = buildBugReports(normalised, ctx, { target: process.env.TARGET_URL ?? '', runId: process.env.QA_RUN_ID || undefined }).map(scrub);
  const problems: SemanticError[] = [];
  for (const bug of bugs) {
    const { schema, semantic: errors } = bugReportErrors(bug);
    problems.push(...schema.map((e) => ({ code: 'INCOMPLETE_DEFECT' as const, path: bug.id, details: e })), ...errors);
  }
  if (problems.length > 0) throw new SemanticValidationError('defect-analysis', problems);

  mkdirSync(BUGS_DIR, { recursive: true });
  for (const bug of bugs) writeFileSync(bugReportPath(bug.id), JSON.stringify(bug, null, 2), 'utf8');
  const keep = new Set(bugs.map((b) => b.id));
  for (const id of listBugReportIds()) if (!keep.has(id)) rmSync(bugReportPath(id));
  return normalised;
}

/**
 * Redaction applied to everything persisted: one-time URL values and opaque
 * ids, and the values of a configured test account.
 */
function scrub<T>(value: T): T {
  const secrets = AUTH_SECRET_ENV_NAMES.map((n) => process.env[n]).filter((v): v is string => typeof v === 'string' && v.trim().length >= 4);
  return maskValues(redactDeep(value), secrets);
}

/**
 * Completion-gate rejections returned in this process. Each Product Discovery
 * attempt is its own `flue run` process, so this is a per-attempt count.
 */
let finalizationRejections = 0;

/**
 * The Discovery Completion Gate, applied to a discovered-behavior write that
 * has already passed schema and semantic validation. Kept apart from both:
 * those judge the artifact, this judges whether exploration is finished.
 * Every verdict is recorded on the surface for the run log and for tracing.
 */
function gateDiscoveryFinalization(data: unknown): DiscoveryCompletionResult | undefined {
  const surface = readSurface();
  // Only a run whose orchestrator turned tracking on is gated; no browser, or
  // a surface built without tracking, is not judged on evidence it never had.
  if (!completionTracked(surface)) return undefined;
  const result = evaluateDiscoveryCompletion({
    surface,
    artifact: data as { locations?: [] },
    rejectionsSoFar: finalizationRejections,
  });
  recordCompletionAttempt(surface, {
    at: new Date().toISOString(),
    canFinalize: result.canFinalize,
    reasonCodes: [...new Set(result.reasons.map((r) => r.code))],
    metrics: { ...result.metrics },
  });
  writeSurface(surface);
  if (!result.canFinalize) {
    finalizationRejections += 1;
    throw new DiscoveryIncompleteError(result);
  }
  return result;
}

export interface WriteResult {
  /** The completion verdict, for a discovered-behavior write that was gated. */
  completion?: DiscoveryCompletionResult;
}

export function writeQaArtifact(name: QaArtifactName, rawData: unknown): WriteResult {
  const def = ARTIFACTS[name];
  if (!def) throw new Error(`Unknown QA artifact name: ${name}`);

  // Redact before anything else looks at it, so the validated object and the
  // bytes on disk are the same object. A run that confirms an account carries
  // a one-time code through the browser; it has no business reaching a route,
  // a behavior statement, a quoted observation or a test case. Deterministic
  // and host-side: the model is never asked to redact its own output.
  let data = scrub(rawData);

  const schema = loadSchema(def.schemaFile);
  const errors = validateAgainstSchema(data, schema);
  if (errors.length > 0) {
    throw new Error(`"${name}" does not match ${def.schemaFile}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  if (name === 'defect-analysis') {
    // Checked against upstream, then persisted with its host-owned fields
    // recomputed and its bug reports fanned out to bugs/<id>.json.
    data = writeDefectAnalysis(data as DefectAnalysis);
  } else {
    const semantic = semanticErrorsFor(name, data);
    if (semantic.length > 0) throw new SemanticValidationError(name, semantic);
  }

  // Well-formed and supported by evidence — but is exploration finished?
  const completion = name === 'discovered-behavior' ? gateDiscoveryFinalization(data) : undefined;

  const path = resolveArtifactPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return completion ? { completion } : {};
}
