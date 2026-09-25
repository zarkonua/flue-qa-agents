// QA-domain metrics for traces: counts read from the artifacts on disk.
//
// Langfuse knows tokens and latencies; it does not know what a behaviour or an
// acceptance point is. These numbers let a trace show WHERE a run narrowed —
// fourteen behaviours becoming two test cases reads very differently from two
// behaviours becoming two test cases. They are facts, never scores: nothing
// here labels a model or a stage good or bad.
//
// Everything is host-derived from validated artifacts, reusing the same
// summaries the run log prints, so a trace can never disagree with the run
// record about a count.

import { analysisCoverageSummary, coverageSummary, strategySummary } from '../lib/semantic-validate.ts';

type Read = (name: string) => any;
type Metrics = Record<string, number | string | boolean | Record<string, number>>;

const len = (list: unknown) => (Array.isArray(list) ? list.length : 0);

function countBy<T>(items: T[] | undefined, key: (item: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items ?? []) {
    const k = key(item);
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Rounded ratio, or undefined when the denominator is zero. */
function ratio(a: number, b: number): number | undefined {
  return b > 0 ? Math.round((a / b) * 100) / 100 : undefined;
}

function discoveryMetrics(read: Read, extra: { observationCount?: number }): Metrics {
  const d = read('discovered-behavior');
  if (!d) return {};
  const locations = d.locations ?? [];
  return {
    behaviourCount: len(d.behaviors),
    behaviourStatus: countBy<any>(d.behaviors, (b) => b?.status),
    areaCount: len(d.areas),
    openQuestionCount: len(d.openQuestions),
    conflictCount: len(d.conflicts),
    locationsVisited: locations.filter((l: any) => l?.status === 'EXPLORED').length,
    locationsBlocked: locations.filter((l: any) => l?.status === 'BLOCKED').length,
    locationsSkipped: locations.filter((l: any) => l?.status === 'SKIPPED_WITH_REASON').length,
    ...(extra.observationCount !== undefined ? { observationCount: extra.observationCount } : {}),
  };
}

function analysisMetrics(read: Read): Metrics {
  const r = read('requirements-analysis');
  if (!r) return {};
  const a = analysisCoverageSummary(read('discovered-behavior'), r);
  return {
    inputBehaviourCount: a.behaviors,
    behavioursAnalyzed: a.analyzed,
    behavioursExcluded: a.excluded,
    behavioursUnaccounted: a.unaccounted,
    acceptancePointCount: a.acceptancePoints,
    // Business rules are this schema's rules; there is no separate "rule" list.
    ruleCount: a.businessRules,
    requirementCount: a.acceptancePoints + a.businessRules,
    notTestableCount: a.notTestable,
    openQuestionCount: a.openQuestions,
    riskCount: len(r.risks),
    validationTypes: a.validationTypes,
  };
}

function designMetrics(read: Read): Metrics {
  const suite = read('test-cases');
  if (!suite) return {};
  const requirements = read('requirements-analysis');
  const discovery = read('discovered-behavior');
  const cases = suite.testCases ?? [];
  const behaviours = len(discovery?.behaviors);
  const acceptancePoints = len(requirements?.acceptancePoints);
  const out: Metrics = {
    inputBehaviourCount: behaviours,
    inputAcceptancePointCount: acceptancePoints,
    inputRuleCount: len(requirements?.businessRules),
    testCaseCount: cases.length,
    priority: countBy<any>(cases, (c) => c?.priority),
    automationCandidates: cases.filter((c: any) => c?.automationCandidate === true).length,
    openQuestionCount: len(suite.openQuestions),
  };
  // The schema's own `types` vocabulary, whatever it currently contains.
  if (requirements) {
    const c = coverageSummary(requirements, suite);
    out.scenarioTypes = c.scenarioTypes;
    out.distinctScenarioTypes = Object.keys(c.scenarioTypes).length;
    out.requirementsTestable = c.testable;
    out.requirementsCovered = c.covered;
    out.requirementsUncovered = c.uncovered;
  } else {
    const types: Record<string, number> = {};
    for (const tc of cases) for (const t of tc?.types ?? []) types[t] = (types[t] ?? 0) + 1;
    out.scenarioTypes = types;
    out.distinctScenarioTypes = Object.keys(types).length;
  }
  const perBehaviour = ratio(cases.length, behaviours);
  if (perBehaviour !== undefined) out.casesPerBehaviour = perBehaviour;
  const perAcceptancePoint = ratio(cases.length, acceptancePoints);
  if (perAcceptancePoint !== undefined) out.casesPerAcceptancePoint = perAcceptancePoint;
  return out;
}

function prioritizationMetrics(read: Read): Metrics {
  const p = read('automation-prioritization');
  if (!p) return {};
  return {
    caseCount: len(p.cases),
    executionMode: countBy<any>(p.cases, (c) => c?.executionMode),
    automationPriority: countBy<any>(p.cases, (c) => c?.automationPriority),
    automationStrategy: strategySummary(p),
  };
}

function repoMetrics(read: Read): Metrics {
  const r = read('repo-analysis');
  if (!r) return {};
  return {
    layoutCount: len(r.layout),
    conventionCount: len(r.conventions),
    keyFileCount: len(r.keyFiles),
    scriptCount: len(r.scripts),
    riskCount: len(r.risks),
    unknownCount: len(r.unknowns),
  };
}

/**
 * Metrics for one stage, keyed by the orchestrators' own stage keys. An
 * artifact that is absent (a failed stage) yields `{}` rather than zeros, so a
 * missing count is never mistaken for a real one.
 */
export function stageMetrics(stageKey: string, read: Read, extra: { observationCount?: number } = {}): Metrics {
  try {
    switch (stageKey) {
      case 'discovery':
        return discoveryMetrics(read, extra);
      case 'analysis':
        return analysisMetrics(read);
      case 'design':
        return designMetrics(read);
      case 'prioritization':
        return prioritizationMetrics(read);
      case 'repo-analyzer':
        return repoMetrics(read);
      default:
        return {};
    }
  } catch {
    // An unreadable artifact must never break a run over a telemetry count.
    return {};
  }
}

/**
 * The run-level funnel: one number per stage boundary, so a collapse is
 * visible on the trace itself without opening any stage.
 */
export function runFunnel(read: Read): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const d = read('discovered-behavior');
    const r = read('requirements-analysis');
    const t = read('test-cases');
    const p = read('automation-prioritization');
    if (d) out['discovery.behaviourCount'] = len(d.behaviors);
    if (r) {
      out['requirements.acceptancePointCount'] = len(r.acceptancePoints);
      out['requirements.ruleCount'] = len(r.businessRules);
    }
    if (t) out['testGeneration.testCaseCount'] = len(t.testCases);
    if (p) out['prioritization.caseCount'] = len(p.cases);
  } catch {
    /* see stageMetrics */
  }
  return out;
}
