// Coverage modes and test levels, as the pages show and filter them. Plain
// logic, shared by the React pages and tested without a browser.

export type CoverageMode = 'AUTOMATIC' | 'UI_ONLY' | 'API_ONLY';
export type TestLevel = 'UI' | 'API';
export type LevelFilter = 'ALL' | TestLevel;

export const COVERAGE_MODES: { id: CoverageMode; label: string; hint: string }[] = [
  { id: 'AUTOMATIC', label: 'Automatic', hint: 'The QA agents choose UI or API for each test case, and do not write the same scenario at both levels.' },
  { id: 'UI_ONLY', label: 'UI only', hint: 'Every test case is driven through the interface. API documentation is not read.' },
  { id: 'API_ONLY', label: 'API only', hint: 'Every test case is a request and its response, and rests on a documented operation.' },
];

export const coverageModeLabel = (mode: string | null | undefined): string =>
  COVERAGE_MODES.find((m) => m.id === mode)?.label ?? '—';

/** The API documentation field is shown for the modes that read it. */
export const showsApiDocs = (mode: CoverageMode): boolean => mode !== 'UI_ONLY';

/** A case's level; one that states none is UI, as every suite from before levels was. */
export const levelOf = (testCase: { testLevel?: unknown } | null | undefined): TestLevel =>
  (testCase?.testLevel === 'API' ? 'API' : 'UI');

export function matchesLevel(testCase: { testLevel?: unknown } | null | undefined, filter: LevelFilter): boolean {
  return filter === 'ALL' || levelOf(testCase) === filter;
}

export function levelCounts(cases: readonly ({ testLevel?: unknown } | null | undefined)[]): Record<TestLevel, number> {
  const counts: Record<TestLevel, number> = { UI: 0, API: 0 };
  for (const c of cases) counts[levelOf(c)] += 1;
  return counts;
}

/**
 * Why the form cannot start a run with this URL, or undefined when it can.
 * The host checks again; this only saves a round trip.
 */
export function apiDocsProblem(mode: CoverageMode, url: string): string | undefined {
  if (!showsApiDocs(mode)) return undefined;
  const text = url.trim();
  if (text === '') return mode === 'API_ONLY' ? 'API only needs the URL of the API documentation.' : undefined;
  if (text.length > 500) return 'That URL is too long.';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return 'Enter a full URL, starting with http:// or https://.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Enter a full URL, starting with http:// or https://.';
  if (parsed.username !== '' || parsed.password !== '') return 'The URL must not contain a user name or password.';
  return undefined;
}
