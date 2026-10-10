// Test coverage modes: at which level a run designs its test cases.
//
//   AUTOMATIC  each scenario gets the level that fits it best — UI or API —
//              and the same scenario is not written twice at both levels
//   UI_ONLY    every test case is driven through the interface; the API
//              documentation is not read at all
//   API_ONLY   every test case is a request and its response, and each one
//              rests on an operation the API documentation actually declares
//
// The mode is chosen by a person when a run starts (New Run, or `--coverage-mode`)
// and written by the host to `run-config.json` beside the artifacts, so every
// later step — a validator inside an agent's write tool, a refresh, an edit
// applied from the workspace, the approval — judges the suite by the same mode
// without anyone having to pass it along.
//
// Pure: no I/O. `qa-artifacts.ts` reads and writes the file.

export const COVERAGE_MODES = ['AUTOMATIC', 'UI_ONLY', 'API_ONLY'] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

/** What a run without a recorded mode is: every run before modes existed, and every run that names none. */
export const DEFAULT_COVERAGE_MODE: CoverageMode = 'AUTOMATIC';

export const TEST_LEVELS = ['UI', 'API'] as const;
export type TestLevel = (typeof TEST_LEVELS)[number];

export const COVERAGE_MODE_LABEL: Record<CoverageMode, string> = {
  AUTOMATIC: 'Automatic',
  UI_ONLY: 'UI only',
  API_ONLY: 'API only',
};

/** The run's configuration as the host persists it (`run-config.json`). */
export interface RunConfigRecord {
  coverageMode: CoverageMode;
  /** The API documentation the run was given, without credentials, query or fragment. Absent when none was. */
  apiDocsUrl?: string;
  runId?: string;
  writtenAt?: string;
  /** Live API validation, as this run was configured: whether real requests were allowed, where, and what a person approved. */
  apiValidation?: { enabled: boolean; baseUrl?: string; environment?: string; approvedOperations?: string[] };
  /**
   * How this run discovered the product: through the interface, through its API, or both —
   * each workflow with its own outcome. Absent on a run from before the two were independent,
   * which explored the interface.
   */
  discovery?: {
    methods: ('UI' | 'API')[];
    ui?: { status: 'PLANNED' | 'SKIPPED'; reason?: string };
    api?: { status: 'COMPLETE' | 'BLOCKED' | 'NOT_REQUESTED'; reason?: string; evidence: 'LIVE' | 'DOCUMENTATION_ONLY' | 'NONE'; criteria: { name: string; met: boolean; required: boolean; detail: string }[] };
  };
}

/** `automatic`, `ui`, `ui-only`, `UI_ONLY`, `api only` … -> the mode, or undefined when it is none of them. */
export function parseCoverageMode(raw: unknown): CoverageMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (key === 'AUTO' || key === 'AUTOMATIC') return 'AUTOMATIC';
  if (key === 'UI' || key === 'UI_ONLY') return 'UI_ONLY';
  if (key === 'API' || key === 'API_ONLY') return 'API_ONLY';
  return undefined;
}

/** Does this mode read API documentation at all? */
export const usesApiDocs = (mode: CoverageMode): boolean => mode !== 'UI_ONLY';

/** The levels a test case may have in this mode. */
export function allowedTestLevels(mode: CoverageMode): readonly TestLevel[] {
  return mode === 'UI_ONLY' ? ['UI'] : mode === 'API_ONLY' ? ['API'] : TEST_LEVELS;
}

/**
 * A test case's level. Absent means UI: every suite written before levels
 * existed was designed from what a browser observed.
 */
export function testLevelOf(testCase: { testLevel?: unknown } | undefined | null): TestLevel {
  return testCase?.testLevel === 'API' ? 'API' : 'UI';
}

export const MAX_API_DOCS_URL = 500;

/**
 * An API documentation URL as it may be fetched: http(s) only, no embedded
 * credentials, no fragment, bounded. Returns undefined for anything else.
 */
export function normalizeApiDocsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text === '' || text.length > MAX_API_DOCS_URL || /[\u0000- ]/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  url.hash = '';
  return url.toString();
}

/** The same URL as it may be stored and shown: without its query, which is where a key would be. */
export function displayApiDocsUrl(raw: unknown): string | undefined {
  const normalized = normalizeApiDocsUrl(raw);
  if (normalized === undefined) return undefined;
  const url = new URL(normalized);
  url.search = '';
  return url.toString();
}

/** What the host tells an agent about API discovery, in a stage briefing. */
export interface ApiBriefingFacts {
  available: boolean;
  endpoints: number;
  /** Why there is none, when there is none. */
  reason?: string;
  /** What the host found when it called the API, when live validation was asked for. */
  live?: {
    /** True when at least one real response was captured. */
    executed: boolean;
    validated: number; observed: number; documented: number; contractViolations: number; potentialIssues: number;
    /** Why nothing, or not everything, was called. */
    reason?: string;
  };
}

const LIVE_EXECUTED = (live: NonNullable<ApiBriefingFacts['live']>) =>
  `The host also called the API and compared each response with the documentation: ${live.validated} operation(s) ` +
  `VALIDATED, ${live.observed} OBSERVED, ${live.documented} DOCUMENTED only; ${live.contractViolations} contract ` +
  `violation(s) and ${live.potentialIssues} potential issue(s). The results are in the "api-validation" artifact (read it): ` +
  'each operation\'s "evidence", each real request and response (PRB-n), and each mismatch (APF-n). Only what a probe ' +
  'shows was observed; a DOCUMENTED operation was never called, so say nothing about how it actually behaves.';

const LIVE_ABSENT = (live: NonNullable<ApiBriefingFacts['live']>) =>
  `The API was not called${live.reason ? ` (${live.reason})` : ''}, so every operation is DOCUMENTED only: ` +
  'the documentation says what it should do, and nothing is known about what it actually does.';

const API_AVAILABLE = (api: ApiBriefingFacts) =>
  `The host read the product's API documentation: ${api.endpoints} documented operation(s), in the ` +
  '"api-discovery" artifact (read it with read_qa_artifact). Each operation has an id such as API-1. ' +
  'It is the only source of API facts: an endpoint, method, parameter, field or status code that is ' +
  'not in it does not exist for this run.';

const API_ABSENT = (api: ApiBriefingFacts | undefined) =>
  `No API documentation is available to this run${api?.reason ? ` (${api.reason})` : ''}. ` +
  'Nothing is known about the product\'s API, so nothing may be designed or automated at API level.';

/**
 * The paragraph appended to a stage's opening message: which mode this run is
 * in and what that asks of this stage. The rules themselves live in the agent
 * prompts and are enforced by the write tool; this only states the run's facts.
 */
export function coverageBriefing(stageKey: string, mode: CoverageMode, api?: ApiBriefingFacts): string {
  const hasApi = usesApiDocs(mode) && api?.available === true && api.endpoints > 0;
  const lines: string[] = [`Coverage mode for this run: ${COVERAGE_MODE_LABEL[mode]} (${mode}).`];

  // Discovery observes the product through a browser and cannot read the
  // documentation, so it is told only what the mode changes about exploring.
  if (stageKey === 'discovery') {
    if (mode === 'UI_ONLY') {
      lines.push('Test cases will be UI level only. Explore the interface as usual.');
    } else if (hasApi) {
      lines.push(
        'The host read the product\'s API documentation for the later stages. It is not something you ' +
          'observed: explore the interface as usual and never record a documented operation as a behavior.' +
          (api?.live?.executed ? ' The host called the API itself; you do not need to.' : ''),
      );
    }
    return lines.join(' ');
  }

  if (mode === 'UI_ONLY') {
    lines.push('Every test case is UI level. API documentation was not read; do not design, classify or plan anything at API level.');
  } else {
    lines.push(hasApi ? API_AVAILABLE(api!) : API_ABSENT(api));
    if (hasApi && api!.live) lines.push(api!.live.executed ? LIVE_EXECUTED(api!.live) : LIVE_ABSENT(api!.live));
  }

  switch (stageKey) {
    case 'analysis':
      if (hasApi) {
        lines.push(
          'A requirement may cite documented operations (API-n) as evidence alongside, or instead of, discovered ' +
            'behaviors. Type such a requirement validationType "API" or "CONTRACT".' +
            (mode === 'API_ONLY'
              ? ' Only requirements that cite a documented operation will be tested in this run, so derive the ' +
                'requirements the documentation supports: one per operation outcome it declares.'
              : ''),
        );
      }
      break;
    case 'design':
      if (mode === 'UI_ONLY') lines.push('Set "testLevel": "UI" on every test case.');
      else if (mode === 'API_ONLY') {
        lines.push(
          hasApi
            ? 'Set "testLevel": "API" on every test case. Cover the requirements that cite a documented operation; ' +
              'a requirement that rests only on UI behavior is out of scope and owes no case. Where the documentation ' +
              'declares them, design positive, negative, boundary, authentication, authorization and schema-validation ' +
              'scenarios — a declared status code, a required field, a length or range limit, a security requirement.'
            : 'There is no documented operation to test, so no API-level case can be written. Say so and stop.',
        );
      } else if (hasApi) {
        lines.push(
          'Choose "testLevel" per case: "API" where a request and its response verify the requirement directly ' +
            '(rules, validation, status codes, data), "UI" where the outcome is what the interface renders or ' +
            'does. Do not write the same scenario at both levels.',
        );
      } else {
        lines.push('Set "testLevel": "UI" on every test case.');
      }
      break;
    case 'defects':
      if (hasApi) {
        lines.push(
          api!.live?.executed
            ? 'For API findings: cite the probe (PRB-n) that shows the actual response in sourceBehaviorIds, and a ' +
              'requirement resting on the documented operation (API-n) as the expectation. Every probe with a ' +
              'CONTRACT_VIOLATION must appear in a finding — classify it as the evidence allows; a mismatch may be a ' +
              'defect in the API or an error in its documentation, and the finding should say which the evidence supports.'
            : 'No API response was observed, so no defect can rest on API behavior.',
        );
      }
      break;
    case 'prioritization':
      lines.push(
        'Each test case carries "testLevel". The automation strategy must agree with it: an API-level case is ' +
          'automated through API (never UI or VISUAL); a UI-level case through UI, UI_API or VISUAL (never API).',
      );
      break;
    default:
      break;
  }
  return lines.join(' ');
}
