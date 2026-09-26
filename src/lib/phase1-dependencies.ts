// Which Phase 1 artifacts are CURRENT and which are STALE, and why.
//
// Two artifacts are derived from others and can fall behind them:
//
//   automation-prioritization  <-  test-cases
//   defect-analysis            <-  discovered-behavior, requirements-analysis, test-cases
//
// When the host accepts one of them (a stage passed, or a refresh completed) it
// records the SHA-256 of every input it was generated from — and of each test
// case — in `phase1-dependencies.json`. Stale is then an exact comparison, and
// the reason is specific: "TC-005 was modified", not "something changed".
//
// Bug reports are human-edited OUTPUTS of defect analysis, not inputs to
// anything, so a bug decision or edit makes nothing stale here. The Phase 1
// approval, which hashes everything including bug reports, is judged by
// `changedSinceApproval` in phase1-gate.ts.
//
// Trusted host code; never mounted as a tool.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-write.ts';
import { QA_ARTIFACT_ROOT, qaArtifactPath, readQaArtifact, type QaArtifactName } from './qa-artifacts.ts';
import type { AutomationPrioritization, TestCases } from './semantic-validate.ts';

export const DEPENDENCIES_PATH = join(QA_ARTIFACT_ROOT, 'phase1-dependencies.json');

export type DerivedArtifact = 'automation-prioritization' | 'defect-analysis';

/** What each derived artifact is generated from. */
export const INPUTS: Record<DerivedArtifact, QaArtifactName[]> = {
  'automation-prioritization': ['test-cases'],
  'defect-analysis': ['discovered-behavior', 'requirements-analysis', 'test-cases'],
};

export interface Stamp {
  generatedAt: string;
  /** SHA-256 of each input file when this artifact was accepted. */
  inputs: Partial<Record<QaArtifactName, string>>;
  /** SHA-256 of each test case, so a change can be named by id. */
  testCases: Record<string, string>;
}

type Stamps = Partial<Record<DerivedArtifact, Stamp>>;

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function fileSha(name: QaArtifactName): string | undefined {
  const path = qaArtifactPath(name);
  return existsSync(path) ? sha(readFileSync(path)) : undefined;
}

function caseHashes(): Record<string, string> {
  const suite = readQaArtifact('test-cases') as TestCases | undefined;
  return Object.fromEntries((suite?.testCases ?? []).map((tc) => [tc.id, sha(JSON.stringify(tc))]));
}

export function readStamps(): Stamps {
  try {
    return JSON.parse(readFileSync(DEPENDENCIES_PATH, 'utf8')) as Stamps;
  } catch {
    return {};
  }
}

/** Record what `artifact` was just generated from. Call only after it passed validation. */
export function stampDependency(artifact: DerivedArtifact, at = new Date()): Stamp {
  const stamp: Stamp = {
    generatedAt: at.toISOString(),
    inputs: Object.fromEntries(INPUTS[artifact].map((n) => [n, fileSha(n)]).filter(([, v]) => v !== undefined)),
    testCases: caseHashes(),
  };
  atomicWriteFile(DEPENDENCIES_PATH, JSON.stringify({ ...readStamps(), [artifact]: stamp }, null, 2));
  return stamp;
}

export interface DependencyState {
  state: 'CURRENT' | 'STALE' | 'MISSING';
  /** Human-readable reasons, most specific first. Empty when CURRENT. */
  reasons: string[];
  /** Test cases added, changed or removed since this artifact was generated. */
  changedCases: { added: string[]; modified: string[]; removed: string[] };
  /** Upstream artifacts that changed since. */
  changedInputs: QaArtifactName[];
  generatedAt?: string;
  /** No stamp was recorded (a workspace from before stamps); judged by ids and file times. */
  legacy: boolean;
}

const noCases = () => ({ added: [] as string[], modified: [] as string[], removed: [] as string[] });

function describeCases(c: DependencyState['changedCases']): string[] {
  const out: string[] = [];
  if (c.modified.length) out.push(`${c.modified.join(', ')} ${c.modified.length === 1 ? 'was' : 'were'} modified after this was generated.`);
  if (c.added.length) out.push(`${c.added.join(', ')} ${c.added.length === 1 ? 'was' : 'were'} added after this was generated.`);
  if (c.removed.length) out.push(`${c.removed.join(', ')} ${c.removed.length === 1 ? 'was' : 'were'} removed after this was generated.`);
  return out;
}

/** Whether a derived artifact still matches its inputs, and what changed if not. */
export function dependencyState(artifact: DerivedArtifact): DependencyState {
  if (!existsSync(qaArtifactPath(artifact))) {
    return { state: 'MISSING', reasons: [`${artifact}.json does not exist.`], changedCases: noCases(), changedInputs: [], legacy: false };
  }
  const stamp = readStamps()[artifact];
  if (!stamp) return legacyState(artifact);

  const changedInputs = INPUTS[artifact].filter((n) => fileSha(n) !== stamp.inputs[n]);
  const now = caseHashes();
  const changedCases = {
    added: Object.keys(now).filter((id) => !(id in stamp.testCases)).sort(),
    modified: Object.keys(now).filter((id) => id in stamp.testCases && stamp.testCases[id] !== now[id]).sort(),
    removed: Object.keys(stamp.testCases).filter((id) => !(id in now)).sort(),
  };
  const reasons = [
    ...(changedInputs.includes('test-cases') ? describeCases(changedCases) : []),
    ...changedInputs.filter((n) => n !== 'test-cases').map((n) => `${n}.json changed after this was generated.`),
  ];
  if (changedInputs.includes('test-cases') && describeCases(changedCases).length === 0) reasons.unshift('test-cases.json changed after this was generated.');
  return { state: changedInputs.length ? 'STALE' : 'CURRENT', reasons, changedCases, changedInputs, generatedAt: stamp.generatedAt, legacy: false };
}

/** Before stamps existed: prioritization must cover exactly the cases, and neither may be older than its inputs. */
function legacyState(artifact: DerivedArtifact): DependencyState {
  const mtime = (n: QaArtifactName) => (existsSync(qaArtifactPath(n)) ? statSync(qaArtifactPath(n)).mtimeMs : 0);
  const reasons: string[] = [];
  const changedCases = noCases();
  if (artifact === 'automation-prioritization') {
    const suite = readQaArtifact('test-cases') as TestCases | undefined;
    const p = readQaArtifact('automation-prioritization') as AutomationPrioritization | undefined;
    const cases = new Set((suite?.testCases ?? []).map((tc) => tc.id));
    const prioritized = new Set((p?.cases ?? []).map((c) => c.testCaseId));
    changedCases.added = [...cases].filter((c) => !prioritized.has(c)).sort();
    changedCases.removed = [...prioritized].filter((c) => !cases.has(c)).sort();
    reasons.push(...describeCases(changedCases));
  }
  const changedInputs = INPUTS[artifact].filter((n) => mtime(n) > mtime(artifact));
  if (reasons.length === 0) reasons.push(...changedInputs.map((n) => `${n}.json is newer than this artifact.`));
  return { state: reasons.length ? 'STALE' : 'CURRENT', reasons, changedCases, changedInputs, legacy: true };
}
