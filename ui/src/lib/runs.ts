import type { RunKind, RunStatus } from '../api/client.ts';

export const KIND_LABEL: Record<RunKind, string> = {
  PHASE1_MANUAL: 'Phase 1',
  DEPENDENCY_REFRESH: 'Refresh',
  PHASE1_REVIEW: 'AI review',
  PHASE2_AUTOMATION: 'Phase 2',
};

export const STATUSES: RunStatus[] = ['RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'];

/** 512345 -> "8:32"; 3723000 -> "1:02:03". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "2026-09-27 19:40" in the viewer's local time. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A metric the run recorded, or an em dash — a missing metric is never shown as 0. */
export const metric = (metrics: Record<string, number>, name: string) => (name in metrics ? String(metrics[name]) : '—');

export const METRIC_GROUPS: { title: string; metrics: [string, string][] }[] = [
  { title: 'Discovery', metrics: [['product_locations', 'Locations'], ['product_locations_explored', 'Locations explored'], ['product_states', 'States'], ['auxiliary_visits', 'Helper-origin visits'], ['observations_recorded', 'Observations'], ['discovered_behaviors', 'Behaviors'], ['discovery_finalization_rejections', 'Finalizations refused']] },
  { title: 'API documentation', metrics: [['api_endpoints', 'Operations'], ['api_schemas', 'Schemas']] },
  { title: 'Live API validation', metrics: [['api_requests', 'Requests sent'], ['api_endpoints_validated', 'Validated'], ['api_endpoints_observed', 'Observed'], ['api_endpoints_documented_only', 'Documented only'], ['api_contract_violations', 'Contract violations'], ['api_potential_issues', 'Potential issues']] },
  { title: 'Analysis and test design', metrics: [['acceptance_points', 'Acceptance points'], ['business_rules', 'Business rules'], ['open_questions', 'Open questions'], ['test_cases_total', 'Test cases'], ['test_cases_ui', 'UI level'], ['test_cases_api', 'API level']] },
  { title: 'Automation', metrics: [['manual_cases', 'Manual'], ['automation_candidates', 'Automation'], ['automation_high', 'High'], ['automation_medium', 'Medium'], ['automation_low', 'Low']] },
  { title: 'Defects', metrics: [['defects_confirmed', 'Confirmed'], ['defects_potential', 'Potential'], ['defects_not_a_defect', 'Not a defect'], ['defects_insufficient_evidence', 'Insufficient evidence'], ['bug_reports_created', 'Bug reports']] },
  { title: 'AI review', metrics: [['review_issues', 'Issues'], ['review_suggested_changes', 'Suggested changes']] },
  { title: 'Pipeline', metrics: [['stage_attempts_total', 'Stage attempts'], ['semantic_rejections', 'Semantic rejections'], ['artifact_not_written_attempts', 'Attempts that wrote nothing'], ['browser_tool_calls', 'Browser tool calls']] },
];

export const ARTIFACT_LABEL: Record<string, string> = {
  DISCOVERED_BEHAVIOR: 'Discovery',
  REQUIREMENTS_ANALYSIS: 'Requirements',
  AUTOMATION_PRIORITIZATION: 'Prioritization',
  DEFECT_ANALYSIS: 'Defect analysis',
  TEST_CASE_REVIEW: 'AI review',
  DISCOVERY_EVIDENCE: 'Browser evidence',
  API_DISCOVERY: 'API documentation',
  API_VALIDATION: 'Live API validation',
  REPO_ANALYSIS: 'Repo analysis',
  AUTOMATION_PROJECT_CONTRACT: 'Automation contract',
  RUN_RECORD: 'Run record',
};
