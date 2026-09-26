// Evidence-grounded defect analysis: classification, bug reports, and the
// deterministic checks that keep both honest.
//
//   SUPPORTED EXPECTED  +  OBSERVED ACTUAL  +  CLEAR CONTRADICTION  =  CONFIRMED_DEFECT
//   INFERRED EXPECTED   +  OBSERVED ACTUAL                          =  POTENTIAL_DEFECT
//
// The Defect Analyzer proposes; this module decides what the evidence allows.
// Two judgements are never taken from the model:
//
//   - the EXPECTED BASIS of a finding — how strongly its expectation is
//     supported — is derived here from the requirements and behaviors it
//     cites, and CONFIRMED_DEFECT is refused unless that basis is supported;
//   - every number and id the host owns: the summary, the bug report ids, the
//     evidence list, the environment, and priority (always UNASSIGNED until a
//     person sets it).
//
// A finding's `sourceBehaviorIds` are the behaviors that show the ACTUAL
// result. Its expectation is supported through `sourceAcceptancePointIds` /
// `sourceBusinessRuleIds`, and a requirement whose only evidence is the actual
// behavior itself supports nothing — that is the behavior restated, not an
// expectation it violates.
//
// The bug report is shared contract: Phase 1's Defect Analyzer writes it now,
// and a Phase 2 Failure Analyzer can later emit the same shape with
// `origin.phase = 2` and TEST_RESULT evidence.
//
// Pure: no I/O. `src/lib/qa-artifacts.ts` reads the upstream artifacts and
// writes the files.

import {
  buildCorpus,
  canonical,
  checkDuplicateIds,
  checkEmails,
  checkFacts,
  checkOverlap,
  contentWords,
  urlsIn,
  type Behavior,
  type Corpus,
  type DiscoveredBehavior,
  type EvidencedItem,
  type RequirementsAnalysis,
  type SemanticError,
  type TestCase,
  type TestCases,
} from './semantic-validate.ts';

export const CLASSIFICATIONS = ['CONFIRMED_DEFECT', 'POTENTIAL_DEFECT', 'NOT_A_DEFECT', 'INSUFFICIENT_EVIDENCE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = ['UNASSIGNED', 'P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * How strongly a finding's expectation is supported. Host-derived.
 *
 *   CONFIRMED_REQUIREMENT  a cited requirement rests on a CONFIRMED behavior
 *                          (one the run was explicitly given)
 *   EVIDENCED_REQUIREMENT  a cited requirement rests on an OBSERVED behavior
 *                          other than the actual result
 *   INFERRED               requirements are cited, but rest only on inference
 *                          or on the actual behavior itself
 *   NONE                   no requirement is cited
 */
export type ExpectedBasis = 'CONFIRMED_REQUIREMENT' | 'EVIDENCED_REQUIREMENT' | 'INFERRED' | 'NONE';

const SUPPORTED_BASIS: ReadonlySet<ExpectedBasis> = new Set(['CONFIRMED_REQUIREMENT', 'EVIDENCED_REQUIREMENT']);

/** The fields a finding carries only when it is a defect. */
const BUG_FIELDS = ['title', 'severity', 'preconditions', 'steps', 'expected', 'actual'] as const;

export interface DefectFinding {
  id: string;
  classification: Classification;
  /** Behaviors showing the ACTUAL result. */
  sourceBehaviorIds: string[];
  sourceAcceptancePointIds?: string[];
  sourceBusinessRuleIds?: string[];
  sourceTestCaseIds?: string[];
  reason: string;
  title?: string;
  severity?: Severity;
  preconditions?: string[];
  steps?: string[];
  expected?: string;
  actual?: string;
  /** Host-assigned. */
  expectedBasis?: ExpectedBasis;
  /** Host-assigned, for CONFIRMED and POTENTIAL defects. */
  bugReportId?: string;
}

export interface DefectSummary {
  confirmed: number;
  potential: number;
  notDefect: number;
  insufficientEvidence: number;
  bugReports: number;
}

export interface DefectAnalysis {
  /** Host-computed. */
  summary?: DefectSummary;
  findings: DefectFinding[];
  /** Host-computed: the bug report files this analysis produced. */
  bugReports?: string[];
}

export type EvidenceType = 'OBSERVED' | 'CONFIRMED' | 'INFERRED' | 'REQUIREMENT' | 'TEST_CASE' | 'TEST_RESULT';

export interface BugReport {
  id: string;
  status: 'CONFIRMED' | 'POTENTIAL';
  origin: { phase: 1 | 2; stage: 'defect-analysis' | 'failure-analysis'; findingId: string; runId?: string };
  title: string;
  severity: Severity;
  /** Business priority. Never the model's: UNASSIGNED until a person sets it. */
  priority: Priority;
  area?: string;
  sourceBehaviorIds: string[];
  sourceAcceptancePointIds?: string[];
  sourceBusinessRuleIds?: string[];
  sourceTestCaseIds?: string[];
  preconditions: string[];
  steps: string[];
  expected: string;
  actual: string;
  expectedBasis: ExpectedBasis;
  evidence: { type: EvidenceType; sourceId: string }[];
  environment: { target: string; browser: string };
  review: {
    decision: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CHANGES_REQUESTED';
    by?: string;
    at?: string;
    note?: string;
    downgradedFrom?: 'CONFIRMED';
    editedFields?: string[];
  };
}

/** Everything a defect is judged against. Read from disk by the caller, never supplied by a model. */
export interface DefectContext {
  discovery: DiscoveredBehavior;
  requirements: RequirementsAnalysis;
  testCases?: TestCases;
  /** Host-configured test-infrastructure origins; never product. */
  auxiliaryOrigins?: string[];
}

export const BUG_ID_PATTERN = /^BUG-[0-9]{3,}$/;

export const isDefect = (c: Classification) => c === 'CONFIRMED_DEFECT' || c === 'POTENTIAL_DEFECT';

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

interface Lookup {
  behaviors: Map<string, Behavior>;
  requirements: Map<string, EvidencedItem>;
  acceptancePoints: Set<string>;
  businessRules: Set<string>;
  testCases: Map<string, TestCase>;
  questionIds: Set<string>;
}

function lookup(ctx: DefectContext): Lookup {
  return {
    behaviors: new Map(ctx.discovery.behaviors.map((b) => [b.id, b])),
    requirements: new Map([...ctx.requirements.acceptancePoints, ...ctx.requirements.businessRules].map((r) => [r.id, r])),
    acceptancePoints: new Set(ctx.requirements.acceptancePoints.map((r) => r.id)),
    businessRules: new Set(ctx.requirements.businessRules.map((r) => r.id)),
    testCases: new Map((ctx.testCases?.testCases ?? []).map((t) => [t.id, t])),
    questionIds: new Set(ctx.discovery.openQuestions.map((q) => q.id)),
  };
}

type Sourced = Pick<DefectFinding, 'sourceBehaviorIds' | 'sourceAcceptancePointIds' | 'sourceBusinessRuleIds' | 'sourceTestCaseIds'>;

const requirementIds = (f: Sourced) => [...(f.sourceAcceptancePointIds ?? []), ...(f.sourceBusinessRuleIds ?? [])];

/** Derived here, never taken from the finding. */
export function expectedBasisOf(finding: Sourced, ctx: DefectContext): ExpectedBasis {
  const l = lookup(ctx);
  const reqs = requirementIds(finding).map((id) => l.requirements.get(id)).filter((r): r is EvidencedItem => r !== undefined);
  if (reqs.length === 0) return 'NONE';
  const actual = new Set(finding.sourceBehaviorIds);
  const support = reqs.flatMap((r) => r.evidenceIds).map((id) => l.behaviors.get(id)).filter((b): b is Behavior => b !== undefined);
  if (support.some((b) => b.status === 'CONFIRMED')) return 'CONFIRMED_REQUIREMENT';
  // Independent of the actual result: a requirement that only restates the
  // behavior under suspicion cannot also be the thing it violates.
  if (support.some((b) => b.status === 'OBSERVED' && !b.suspectedIssue && !actual.has(b.id))) return 'EVIDENCED_REQUIREMENT';
  return 'INFERRED';
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A behavior of a product area whose every route is on a test-infrastructure origin. */
function isAuxiliaryBehavior(b: Behavior, ctx: DefectContext): boolean {
  const aux = ctx.auxiliaryOrigins ?? [];
  if (aux.length === 0) return false;
  const area = ctx.discovery.areas.find((a) => a.name === b.area);
  const origins = (area?.routes ?? []).map(originOf).filter((o): o is string => o !== undefined);
  return origins.length > 0 && origins.every((o) => aux.includes(o));
}

/** OBSERVED behaviors of the product itself among a finding's actual-result sources. */
function observedProductActuals(f: Sourced, ctx: DefectContext): Behavior[] {
  const l = lookup(ctx);
  return f.sourceBehaviorIds
    .map((id) => l.behaviors.get(id))
    .filter((b): b is Behavior => b !== undefined && b.status === 'OBSERVED' && !isAuxiliaryBehavior(b, ctx));
}

/** The evidence list of a bug report — derived from its sources, never written by a model. */
export function derivedEvidence(f: Sourced, ctx: DefectContext): BugReport['evidence'] {
  const l = lookup(ctx);
  const out: BugReport['evidence'] = [];
  for (const id of f.sourceBehaviorIds) {
    const b = l.behaviors.get(id);
    if (b) out.push({ type: b.status, sourceId: id });
  }
  for (const id of requirementIds(f)) if (l.requirements.has(id)) out.push({ type: 'REQUIREMENT', sourceId: id });
  for (const id of f.sourceTestCaseIds ?? []) if (l.testCases.has(id)) out.push({ type: 'TEST_CASE', sourceId: id });
  return out;
}

function corpusFor(f: Sourced, ctx: DefectContext): Corpus {
  const l = lookup(ctx);
  // Referenced test cases were already validated against discovery; their
  // wording may be repeated in steps.
  const extra = (f.sourceTestCaseIds ?? [])
    .map((id) => l.testCases.get(id))
    .filter((t): t is TestCase => t !== undefined)
    .flatMap((t) => [t.title, t.expectedResult, ...t.preconditions, ...t.steps.flatMap((s) => [s.action, s.expected])]);
  return buildCorpus(ctx.discovery, ctx.requirements, extra);
}

// ---------------------------------------------------------------------------
// Rules shared by findings and bug reports
// ---------------------------------------------------------------------------

function checkSources(f: Sourced, base: string, ctx: DefectContext, errors: SemanticError[]): void {
  const l = lookup(ctx);
  const valid = (ids: Iterable<string>) => [...ids].join(', ') || '(none)';
  f.sourceBehaviorIds.forEach((id, j) => {
    if (l.behaviors.has(id)) return;
    errors.push(
      l.questionIds.has(id)
        ? { code: 'NOT_EVIDENCE', path: `${base}.sourceBehaviorIds[${j}]`, value: id, details: `${id} is an open question — uncertainty, not an observed behavior.` }
        : { code: 'UNKNOWN_EVIDENCE_ID', path: `${base}.sourceBehaviorIds[${j}]`, value: id, details: `No discovered behavior has this ID. Valid: ${valid(l.behaviors.keys())}.` },
    );
  });
  const refs: [keyof Sourced, Set<string>, string][] = [
    ['sourceAcceptancePointIds', l.acceptancePoints, 'acceptance point'],
    ['sourceBusinessRuleIds', l.businessRules, 'business rule'],
  ];
  for (const [field, known, kind] of refs) {
    ((f[field] as string[] | undefined) ?? []).forEach((id, j) => {
      if (!known.has(id)) {
        errors.push({ code: 'UNKNOWN_EVIDENCE_ID', path: `${base}.${field}[${j}]`, value: id, details: `No ${kind} has this ID. Valid: ${valid(known)}.` });
      }
    });
  }
  (f.sourceTestCaseIds ?? []).forEach((id, j) => {
    if (!l.testCases.has(id)) {
      errors.push({ code: 'UNKNOWN_TEST_CASE', path: `${base}.sourceTestCaseIds[${j}]`, value: id, details: `No test case has this ID. Valid: ${valid(l.testCases.keys())}.` });
    }
  });
}

interface DefectText {
  title?: string;
  preconditions?: string[];
  steps?: string[];
  expected?: string;
  actual?: string;
}

/** Expected vs actual, and no invented routes, messages, features or credentials. */
function checkDefectText(
  f: Sourced & DefectText,
  base: string,
  ctx: DefectContext,
  basis: ExpectedBasis,
  errors: SemanticError[],
): void {
  const l = lookup(ctx);
  const corpus = corpusFor(f, ctx);
  const texts: [string, string][] = [
    [`${base}.title`, f.title ?? ''],
    [`${base}.expected`, f.expected ?? ''],
    [`${base}.actual`, f.actual ?? ''],
    ...(f.preconditions ?? []).map((t, i): [string, string] => [`${base}.preconditions[${i}]`, t]),
    ...(f.steps ?? []).map((t, i): [string, string] => [`${base}.steps[${i}]`, t]),
  ];
  for (const [path, text] of texts) {
    if (text === '') continue;
    checkFacts(text, path, corpus, errors);
    checkEmails(text, path, corpus, errors);
    // Test infrastructure is never the product: it may not be where the bug is.
    for (const url of urlsIn(text)) {
      const origin = originOf(url);
      if (origin && (ctx.auxiliaryOrigins ?? []).includes(origin) && !path.includes('steps') && !path.includes('preconditions')) {
        errors.push({ code: 'AUXILIARY_AS_PRODUCT', path, value: url, details: `${origin} is test infrastructure, not the product under test.` });
      }
    }
  }

  // The actual result is what the cited behaviors say happened.
  const actuals = observedProductActuals(f, ctx);
  if (f.actual && actuals.length > 0) {
    checkOverlap(f.actual, actuals.map((b) => b.statement), `${base}.actual`, actuals.map((b) => b.id), errors);
  }
  // A supported expectation is what the cited requirements say should happen.
  if (f.expected && SUPPORTED_BASIS.has(basis)) {
    const reqs = requirementIds(f).map((id) => l.requirements.get(id)).filter((r): r is EvidencedItem => r !== undefined);
    checkOverlap(f.expected, reqs.map((r) => r.statement), `${base}.expected`, reqs.map((r) => r.id), errors);
  }
  // No contradiction without two different sides.
  if (f.expected && f.actual && canonical(f.expected) === canonical(f.actual)) {
    errors.push({ code: 'INCOMPLETE_DEFECT', path: `${base}.expected`, details: 'Expected and actual say the same thing; there is no contradiction to report.' });
  }
}

/** Does a defect have a product actual, and is its classification one the evidence allows? */
function checkThreshold(
  f: Sourced,
  base: string,
  ctx: DefectContext,
  confirmed: boolean,
  basis: ExpectedBasis,
  errors: SemanticError[],
): void {
  const l = lookup(ctx);
  const observed = f.sourceBehaviorIds.map((id) => l.behaviors.get(id)).filter((b): b is Behavior => b?.status === 'OBSERVED');
  if (observed.length === 0) {
    errors.push({
      code: 'UNOBSERVED_ACTUAL',
      path: `${base}.sourceBehaviorIds`,
      value: f.sourceBehaviorIds.join(', '),
      details: 'None of these is an OBSERVED behavior, so nothing shows what actually happened.',
    });
  } else if (observedProductActuals(f, ctx).length === 0) {
    errors.push({
      code: 'AUXILIARY_AS_PRODUCT',
      path: `${base}.sourceBehaviorIds`,
      value: f.sourceBehaviorIds.join(', '),
      details: 'Every cited behavior belongs to trusted test infrastructure. That can support a flow; on its own it is not a product bug.',
    });
  }
  if (confirmed && !SUPPORTED_BASIS.has(basis)) {
    errors.push({
      code: 'UNSUPPORTED_EXPECTED',
      path: `${base}.classification`,
      value: 'CONFIRMED_DEFECT',
      details:
        basis === 'NONE'
          ? 'No acceptance point or business rule is cited, so the expectation is not supported.'
          : 'The cited requirements rest only on inference or on the actual behavior itself. Classify it POTENTIAL_DEFECT, or cite a requirement evidenced by a different observation.',
    });
  }
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Word overlap of expected + actual, above which two defects in one area are one defect. */
export const DUPLICATE_SIMILARITY = 0.5;

/**
 * Pairs of defect findings describing the same mismatch. Deterministic:
 *
 *   - they cite the same observed actual behavior — one thing happened; or
 *   - they concern the same area, and their expected + actual text overlaps by
 *     at least DUPLICATE_SIMILARITY, compared canonically — so "login fails",
 *     "sign-in fails" and "authentication fails" meet as the same words.
 */
export function duplicateDefects(findings: DefectFinding[], ctx: DefectContext): [DefectFinding, DefectFinding, string][] {
  const l = lookup(ctx);
  const defects = findings.filter((f) => isDefect(f.classification));
  const areaOf = (f: DefectFinding) => f.sourceBehaviorIds.map((id) => l.behaviors.get(id)?.area).find(Boolean);
  const words = (f: DefectFinding) => contentWords(`${f.title ?? ''} ${f.expected ?? ''} ${f.actual ?? ''}`);
  const out: [DefectFinding, DefectFinding, string][] = [];
  for (let i = 0; i < defects.length; i++) {
    for (let j = i + 1; j < defects.length; j++) {
      const [a, b] = [defects[i], defects[j]];
      const observedA = new Set(a.sourceBehaviorIds.filter((id) => l.behaviors.get(id)?.status === 'OBSERVED'));
      const shared = b.sourceBehaviorIds.find((id) => observedA.has(id));
      if (shared) {
        out.push([a, b, `both cite ${shared} as the actual result`]);
        continue;
      }
      const area = areaOf(a);
      if (area !== undefined && area === areaOf(b) && similarity(words(a), words(b)) >= DUPLICATE_SIMILARITY) {
        out.push([a, b, `same area (${area}) and the same expected/actual`]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The defect-analysis artifact
// ---------------------------------------------------------------------------

export function summariseDefects(findings: DefectFinding[]): DefectSummary {
  const n = (c: Classification) => findings.filter((f) => f.classification === c).length;
  return {
    confirmed: n('CONFIRMED_DEFECT'),
    potential: n('POTENTIAL_DEFECT'),
    notDefect: n('NOT_A_DEFECT'),
    insufficientEvidence: n('INSUFFICIENT_EVIDENCE'),
    bugReports: findings.filter((f) => isDefect(f.classification)).length,
  };
}

/**
 * The analysis with every host-owned field recomputed: expected basis, bug
 * report ids (BUG-001… in finding order), the list of reports, the summary.
 * Whatever the model put there is replaced. Idempotent.
 */
export function normaliseDefectAnalysis(analysis: DefectAnalysis, ctx: DefectContext): DefectAnalysis {
  let next = 0;
  const findings = analysis.findings.map((raw) => {
    const { bugReportId: _id, expectedBasis: _basis, ...f } = raw;
    const out: DefectFinding = { ...f, expectedBasis: expectedBasisOf(f, ctx) };
    if (isDefect(f.classification)) out.bugReportId = `BUG-${String(++next).padStart(3, '0')}`;
    return out;
  });
  return {
    summary: summariseDefects(findings),
    findings,
    bugReports: findings.map((f) => f.bugReportId).filter((id): id is string => id !== undefined),
  };
}

/**
 * Cross-artifact checks on a defect analysis. Applied to the normalised form,
 * so re-validating the file on disk gives the same verdict as the write did.
 */
export function validateDefectAnalysis(analysis: DefectAnalysis, ctx: DefectContext): SemanticError[] {
  const errors: SemanticError[] = [];
  checkDuplicateIds(analysis.findings, 'findings', errors);

  analysis.findings.forEach((f, i) => {
    const base = `findings[${i}]`;
    checkSources(f, base, ctx, errors);
    const defect = isDefect(f.classification);
    const basis = expectedBasisOf(f, ctx);

    if (!f.reason || f.reason.trim() === '') {
      errors.push({ code: 'MISSING_EVIDENCE', path: `${base}.reason`, details: 'Every finding needs a reason.' });
    }
    if (f.sourceBehaviorIds.length === 0 && f.classification !== 'INSUFFICIENT_EVIDENCE') {
      errors.push({ code: 'MISSING_EVIDENCE', path: `${base}.sourceBehaviorIds`, details: 'Cite the behavior(s) this finding is about.' });
    }

    if (defect) {
      const missing = BUG_FIELDS.filter((k) => k !== 'preconditions').filter((k) => {
        const v = f[k];
        return v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
      });
      if (missing.length > 0) {
        errors.push({ code: 'INCOMPLETE_DEFECT', path: base, value: missing.join(', '), details: `A ${f.classification} needs: ${missing.join(', ')}.` });
      }
      checkThreshold(f, base, ctx, f.classification === 'CONFIRMED_DEFECT', basis, errors);
      checkDefectText(f, base, ctx, basis, errors);
    } else {
      const present = BUG_FIELDS.filter((k) => f[k] !== undefined);
      if (present.length > 0) {
        errors.push({
          code: 'INCOMPLETE_DEFECT',
          path: base,
          value: present.join(', '),
          details: `A ${f.classification} is not a bug and carries no bug-report fields; remove ${present.join(', ')}.`,
        });
      }
    }

    // Host-owned fields must be exactly what the host would compute.
    if (f.expectedBasis !== undefined && f.expectedBasis !== basis) {
      errors.push({ code: 'EVIDENCE_MISMATCH', path: `${base}.expectedBasis`, value: f.expectedBasis, details: `The expected basis is derived by the host: ${basis}.` });
    }
  });

  for (const [a, b, why] of duplicateDefects(analysis.findings, ctx)) {
    errors.push({
      code: 'DUPLICATE_DEFECT',
      path: 'findings',
      value: `${a.id}, ${b.id}`,
      details: `${a.id} and ${b.id} describe the same mismatch (${why}). Merge them into one finding citing all their behaviors and test cases.`,
    });
  }

  // Nothing discovery flagged may be quietly dropped.
  const cited = new Set(analysis.findings.flatMap((f) => f.sourceBehaviorIds));
  for (const b of ctx.discovery.behaviors) {
    if (b.suspectedIssue && !cited.has(b.id)) {
      errors.push({
        code: 'UNANALYZED_SUSPECTED_ISSUE',
        path: 'findings',
        value: b.id,
        details: `${b.id} is marked suspectedIssue ("${b.statement.slice(0, 80)}") and no finding cites it.`,
      });
    }
  }

  // Host fields, when present, must match what normalisation computes.
  if (analysis.summary !== undefined || analysis.bugReports !== undefined || analysis.findings.some((f) => f.bugReportId !== undefined)) {
    const expected = normaliseDefectAnalysis(analysis, ctx);
    if (JSON.stringify(expected.summary) !== JSON.stringify(analysis.summary)) {
      errors.push({ code: 'SUMMARY_MISMATCH', path: 'summary', details: `The summary is computed by the host: ${JSON.stringify(expected.summary)}.` });
    }
    const ids = analysis.findings.map((f) => f.bugReportId ?? null);
    if (JSON.stringify(ids) !== JSON.stringify(expected.findings.map((f) => f.bugReportId ?? null)) ||
        JSON.stringify(analysis.bugReports) !== JSON.stringify(expected.bugReports)) {
      errors.push({ code: 'SUMMARY_MISMATCH', path: 'bugReports', details: 'Bug report ids are assigned by the host, in finding order.' });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Bug reports
// ---------------------------------------------------------------------------

/** The browser every Phase 1 observation came from; see scripts/mcp-server.mjs (`--browser chromium`). */
export const PHASE1_BROWSER = 'Chromium';

/** One bug report per defect finding of a normalised analysis. */
export function buildBugReports(
  analysis: DefectAnalysis,
  ctx: DefectContext,
  env: { target: string; browser?: string; runId?: string },
): BugReport[] {
  const l = lookup(ctx);
  return analysis.findings
    .filter((f): f is DefectFinding & { bugReportId: string } => isDefect(f.classification) && f.bugReportId !== undefined)
    .map((f) => {
      const area = f.sourceBehaviorIds.map((id) => l.behaviors.get(id)?.area).find(Boolean);
      const bug: BugReport = {
        id: f.bugReportId,
        status: f.classification === 'CONFIRMED_DEFECT' ? 'CONFIRMED' : 'POTENTIAL',
        origin: { phase: 1, stage: 'defect-analysis', findingId: f.id, ...(env.runId ? { runId: env.runId } : {}) },
        title: f.title ?? '',
        severity: f.severity as Severity,
        priority: 'UNASSIGNED',
        ...(area ? { area } : {}),
        sourceBehaviorIds: [...f.sourceBehaviorIds],
        ...(f.sourceAcceptancePointIds?.length ? { sourceAcceptancePointIds: [...f.sourceAcceptancePointIds] } : {}),
        ...(f.sourceBusinessRuleIds?.length ? { sourceBusinessRuleIds: [...f.sourceBusinessRuleIds] } : {}),
        ...(f.sourceTestCaseIds?.length ? { sourceTestCaseIds: [...f.sourceTestCaseIds] } : {}),
        preconditions: [...(f.preconditions ?? [])],
        steps: [...(f.steps ?? [])],
        expected: f.expected ?? '',
        actual: f.actual ?? '',
        expectedBasis: expectedBasisOf(f, ctx),
        evidence: derivedEvidence(f, ctx),
        environment: { target: env.target, browser: env.browser ?? PHASE1_BROWSER },
        review: { decision: 'PENDING' },
      };
      return bug;
    });
}

/**
 * A bug report on its own — as written, or after a person edited it. The same
 * lineage and fact rules as its finding; a person may downgrade CONFIRMED to
 * POTENTIAL, but not promote a defect past what the evidence supports.
 */
export function validateBugReport(bug: BugReport, ctx: DefectContext): SemanticError[] {
  const errors: SemanticError[] = [];
  const base = bug.id;
  checkSources(bug, base, ctx, errors);
  const basis = expectedBasisOf(bug, ctx);
  checkThreshold(bug, base, ctx, bug.status === 'CONFIRMED', basis, errors);
  checkDefectText(bug, base, ctx, basis, errors);

  if (bug.expectedBasis !== basis) {
    errors.push({ code: 'EVIDENCE_MISMATCH', path: `${base}.expectedBasis`, value: bug.expectedBasis, details: `The expected basis is derived from the sources: ${basis}.` });
  }
  const derived = derivedEvidence(bug, ctx);
  const key = (e: { type: string; sourceId: string }) => `${e.type}:${e.sourceId}`;
  if (JSON.stringify(bug.evidence.map(key).sort()) !== JSON.stringify(derived.map(key).sort())) {
    errors.push({ code: 'EVIDENCE_MISMATCH', path: `${base}.evidence`, details: `The evidence list is derived from the sources: ${JSON.stringify(derived)}.` });
  }
  if (bug.priority !== 'UNASSIGNED' && !(bug.review.editedFields ?? []).includes('priority')) {
    errors.push({
      code: 'UNSUPPORTED_FACT',
      path: `${base}.priority`,
      value: bug.priority,
      details: 'Business priority is set only by a person (npm run qa:defects -- edit <id> --priority <P0-P3>).',
    });
  }
  return errors;
}

/** Run metrics, flat, for phase1-run.json, the preserved run and the trace. */
export function defectMetrics(analysis: DefectAnalysis | undefined): Record<string, number> {
  if (!analysis) return {};
  const s = summariseDefects(analysis.findings);
  return {
    defects_confirmed: s.confirmed,
    defects_potential: s.potential,
    defects_not_a_defect: s.notDefect,
    defects_insufficient_evidence: s.insufficientEvidence,
    bug_reports_created: s.bugReports,
  };
}
