// What a run archive (`.qa/runs/<run-id>/`) says about its run, derived by host
// code from the files themselves. One derivation serves both a run finishing
// now and an old archive being imported, so their numbers mean the same thing.
//
// Only counts an archived file actually supports are produced. A metric whose
// source file is absent is absent — never zero.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isInside } from '../lib/trusted-roots.ts';
import { ARTIFACT_FILES, BUG_ID, type ArtifactRow, type ImportedRun, type SingleArtifactType, type StageStatus } from './types.ts';

type Json = Record<string, unknown>;

/** A regular file directly inside `dir` (never a symlink, never outside it), or undefined. */
function fileIn(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return undefined;
    return isInside(realpathSync(path), realpathSync(dir)) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Parsed JSON from an archived file; undefined when absent or unreadable. */
export function readArchived(dir: string, name: string): Json | undefined {
  const path = fileIn(dir, name);
  if (!path) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Bug report ids present in the archive, in order. */
export function archivedBugIds(dir: string): string[] {
  const bugs = join(dir, 'bugs');
  if (!existsSync(bugs) || !lstatSync(bugs).isDirectory()) return [];
  return readdirSync(bugs)
    .filter((f) => f.endsWith('.json') && BUG_ID.test(f.slice(0, -5)) && fileIn(bugs, f))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Every known file in the archive, hashed. Unknown files are not indexed. */
export function indexArchive(dir: string): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  const add = (artifactType: ArtifactRow['artifactType'], relativePath: string, path: string) => {
    const bytes = readFileSync(path);
    rows.push({ artifactType, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length });
  };
  for (const [type, name] of Object.entries(ARTIFACT_FILES) as [SingleArtifactType, string][]) {
    const path = fileIn(dir, name);
    if (path) add(type, name, path);
  }
  for (const id of archivedBugIds(dir)) add('BUG_REPORT', `bugs/${id}.json`, join(dir, 'bugs', `${id}.json`));
  return rows;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : undefined);

/** Per-run counts from the archive. Keys are only present when their source exists. */
export function metricsFromArchive(dir: string): Record<string, number> {
  const m: Record<string, number> = {};
  const put = (name: string, value: number | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) m[name] = value;
  };

  const discovery = readArchived(dir, ARTIFACT_FILES.DISCOVERED_BEHAVIOR);
  if (discovery) {
    put('discovered_behaviors', count(discovery.behaviors));
    put('product_locations', count(discovery.locations));
    if (Array.isArray(discovery.locations)) {
      put('product_locations_explored', discovery.locations.filter((l) => (l as Json)?.status === 'EXPLORED').length);
    }
  }

  const surface = readArchived(dir, ARTIFACT_FILES.DISCOVERY_SURFACE);
  if (surface) {
    put('product_states', count(surface.states));
    const aux = new Set(list(surface.auxiliaryOrigins).filter((o): o is string => typeof o === 'string'));
    if (Array.isArray(surface.observedLocations)) {
      put('auxiliary_visits', surface.observedLocations.filter((u) => {
        try { return typeof u === 'string' && aux.has(new URL(u).origin); } catch { return false; }
      }).length);
    }
  }

  const requirements = readArchived(dir, ARTIFACT_FILES.REQUIREMENTS_ANALYSIS);
  if (requirements) {
    put('acceptance_points', count(requirements.acceptancePoints));
    put('business_rules', count(requirements.businessRules));
    put('open_questions', count(requirements.openQuestions));
  }

  const suite = readArchived(dir, ARTIFACT_FILES.TEST_CASES);
  if (suite) {
    put('test_cases_total', count(suite.testCases));
    // Per level. A case that states none is UI — every suite from before levels was.
    if (Array.isArray(suite.testCases)) {
      const api = suite.testCases.filter((tc) => (tc as Json)?.testLevel === 'API').length;
      put('test_cases_api', api);
      put('test_cases_ui', suite.testCases.length - api);
    }
  }

  // Only when the documentation was actually read: an absent or unavailable one records no count.
  const apiDocs = readArchived(dir, ARTIFACT_FILES.API_DISCOVERY);
  if (apiDocs && apiDocs.status === 'AVAILABLE') {
    put('api_endpoints', count(apiDocs.endpoints));
    put('api_schemas', count(apiDocs.schemas));
  }

  const prioritization = readArchived(dir, ARTIFACT_FILES.AUTOMATION_PRIORITIZATION);
  if (prioritization && Array.isArray(prioritization.cases)) {
    const cases = prioritization.cases as Json[];
    const auto = cases.filter((c) => c?.executionMode === 'AUTOMATION');
    put('manual_cases', cases.filter((c) => c?.executionMode === 'MANUAL').length);
    put('automation_candidates', auto.length);
    put('automation_high', auto.filter((c) => c.automationPriority === 'HIGH').length);
    put('automation_medium', auto.filter((c) => c.automationPriority === 'MEDIUM').length);
    put('automation_low', auto.filter((c) => c.automationPriority === 'LOW').length);
  }

  const defects = readArchived(dir, ARTIFACT_FILES.DEFECT_ANALYSIS);
  if (defects && Array.isArray(defects.findings)) {
    const by = (c: string) => (defects.findings as Json[]).filter((f) => f?.classification === c).length;
    put('defects_confirmed', by('CONFIRMED_DEFECT'));
    put('defects_potential', by('POTENTIAL_DEFECT'));
    put('defects_not_a_defect', by('NOT_A_DEFECT'));
    put('defects_insufficient_evidence', by('INSUFFICIENT_EVIDENCE'));
    put('bug_reports_created', archivedBugIds(dir).length);
  }

  const review = readArchived(dir, ARTIFACT_FILES.TEST_CASE_REVIEW);
  if (review) {
    put('review_issues', count(review.issues));
    put('review_suggested_changes', count(review.suggestedChanges));
  }

  // The host's own run record: attempts and tool calls as the orchestrator counted them.
  const record = readArchived(dir, ARTIFACT_FILES.RUN_RECORD);
  if (record && Array.isArray(record.stages)) {
    const attempts = (record.stages as Json[]).flatMap((s) => list(s?.attempts) as Json[]);
    const problem = (a: Json) => (typeof a.problem === 'string' ? a.problem : '');
    put('stage_attempts_total', attempts.length);
    put('semantic_rejections', attempts.filter((a) => /fails semantic validation/.test(problem(a))).length);
    put('artifact_not_written_attempts', attempts.filter((a) => /was not written by this attempt/.test(problem(a))).length);
    const byTool = attempts.map((a) => (a.toolCallsByTool ?? {}) as Record<string, unknown>);
    if (byTool.some((t) => Object.keys(t).length > 0)) {
      put('browser_tool_calls', byTool.reduce((n, t) => n + Object.entries(t).filter(([k]) => k.startsWith('browser_')).reduce((s, [, v]) => s + (Number(v) || 0), 0), 0));
    }
    const gate = (record.stages as Json[]).find((s) => s?.stage === 'discovery')?.completionGate as Json | undefined;
    if (gate) put('discovery_finalization_rejections', Number(gate.finalizationRejectedCount));
    put('observations_recorded', Number((record.observations as Json | undefined)?.recorded ?? NaN));
  }
  return m;
}

/** Stage history from an archived `phase1-run.json`: what each stage did, attempt by attempt. */
export function stagesFromRecord(record: Json | undefined, labels: Record<string, string>): ImportedRun['stages'] {
  if (!record || !Array.isArray(record.stages)) return [];
  return (record.stages as Json[]).filter((s) => typeof s?.stage === 'string').map((s) => {
    const attempts = list(s.attempts) as Json[];
    const passed = s.passed === true || attempts.some((a) => a?.passed === true);
    const durations = attempts.map((a) => Number(a?.durationMs)).filter(Number.isFinite);
    const failedStage = record.failedStage === s.stage;
    const status: StageStatus = passed ? 'COMPLETED' : failedStage || attempts.length > 0 ? 'FAILED' : 'INTERRUPTED';
    const last = attempts.at(-1);
    return {
      stageName: s.stage as string,
      label: labels[s.stage as string] ?? null,
      status,
      durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      attemptCount: attempts.length,
      errorCode: status === 'FAILED' ? 'STAGE_FAILED' : null,
      errorSummary: status === 'FAILED' && typeof last?.problem === 'string' ? last.problem : null,
    };
  });
}

/** Stage history from an archived `phase1-refresh.json` (a dependency refresh). */
export function stagesFromRefresh(status: Json | undefined, labels: Record<string, string>): ImportedRun['stages'] {
  if (!status || !Array.isArray(status.stages)) return [];
  return (status.stages as Json[]).filter((s) => typeof s?.stage === 'string').map((s) => ({
    stageName: s.stage as string,
    label: labels[s.stage as string] ?? null,
    status: s.passed === true ? 'COMPLETED' : 'FAILED',
    durationMs: null,
    attemptCount: Number.isInteger(s.attempts) ? (s.attempts as number) : 0,
  }));
}
