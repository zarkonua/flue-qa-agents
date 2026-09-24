// Trusted host module for reading/writing .qa/*.json hand-off artifacts.
//
// Security model (see docs/AGENT_SANDBOX_AND_TOOLS.md in the spec pack): the
// model never supplies a filesystem path. It supplies a *logical artifact name*
// from a fixed picklist; this module alone maps that name to a real path under
// a trusted, host-configured root that lives OUTSIDE the Claude Code project
// directory (so a runtime agent has no path back to `.claude/`). Every write is
// validated against the artifact's JSON Schema before touching disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema, type JsonSchemaNode } from './schema-validate.ts';
import { collectRepoEvidence } from './repo-evidence.ts';
import { expectedLocations, readSurface } from './discovery-surface.ts';
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
  | 'repo-analysis'
  | 'ui-exploration'
  | 'automation-plan'
  // Host-written only. Collected by `scripts/lib/evidence.mjs` from the
  // browser; deliberately absent from the agents' write picklist, so no model
  // can author, amend or contradict it. See `src/tools/qa-artifacts.ts`.
  | 'discovery-evidence';

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
  'repo-analysis': { fileName: 'repo-analysis.json', schemaFile: 'repo-analysis.schema.json' },
  'ui-exploration': { fileName: 'ui-exploration.json', schemaFile: 'ui-exploration.schema.json' },
  'automation-plan': { fileName: 'automation-plan.json', schemaFile: 'automation-plan.schema.json' },
  'discovery-evidence': { fileName: 'discovery-evidence.json', schemaFile: 'discovery-evidence.schema.json' },
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
        surface && { expected: expectedLocations(surface), origin: surface.origin },
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
      return validateTestCasesReview(
        testCases,
        readQaArtifact('automation-prioritization') as AutomationPrioritization | undefined,
        data as TestCasesReview,
      );
    }

    // Phase 2. Checked against the repository on disk, not against a Phase 1
    // artifact: the facts come from the filesystem the agent just read.
    case 'repo-analysis':
      return validateRepoAnalysis(data as RepoAnalysis, collectRepoEvidence());

    default:
      return [];
  }
}

export function writeQaArtifact(name: QaArtifactName, data: unknown): void {
  const def = ARTIFACTS[name];
  if (!def) throw new Error(`Unknown QA artifact name: ${name}`);
  const schema = loadSchema(def.schemaFile);
  const errors = validateAgainstSchema(data, schema);
  if (errors.length > 0) {
    throw new Error(`"${name}" does not match ${def.schemaFile}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const semantic = semanticErrorsFor(name, data);
  if (semantic.length > 0) throw new SemanticValidationError(name, semantic);

  const path = resolveArtifactPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}
