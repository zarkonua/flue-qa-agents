// Cross-artifact semantic validation: rejects downstream artifacts that are
// schema-valid but not grounded in upstream evidence.
//
//   discovered-behavior  ->  requirements-analysis  ->  test-cases
//
// Pure and deterministic: no I/O, no model calls. `qa-artifacts.ts` loads the
// upstream artifacts from disk and runs these before anything is written, so
// an agent whose artifact fails receives the errors and retries.
//
// What this can and cannot catch is deliberately narrow. It checks things that
// have a crisp answer — does this ID exist, does this route/credential/quoted
// UI string appear upstream, does this sentence negate something discovery
// observed. It does not attempt general natural-language entailment; the gaps
// that leaves are listed in docs/VALIDATION.md.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemanticErrorCode =
  | 'UNKNOWN_EVIDENCE_ID'
  | 'MISSING_EVIDENCE'
  | 'EVIDENCE_MISMATCH'
  | 'NOT_EVIDENCE'
  | 'UNSUPPORTED_FACT'
  | 'FABRICATED_CREDENTIAL'
  | 'CONTRADICTS_UPSTREAM'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_AREA'
  | 'MISSING_UPSTREAM'
  | 'UPSTREAM_INVALID'
  | 'UNKNOWN_TEST_CASE'
  | 'MISSING_PRIORITIZATION'
  | 'DUPLICATE_PRIORITIZATION'
  | 'INCONSISTENT_PRIORITY'
  | 'SUMMARY_MISMATCH'
  | 'INCONSISTENT_STATUS'
  | 'UNKNOWN_PATH'
  | 'BAD_PATH'
  | 'DUPLICATE_PATH'
  | 'UNKNOWN_SCRIPT'
  | 'UNKNOWN_DEPENDENCY'
  | 'EMPTY_ANALYSIS'
  | 'NOT_A_LITERAL'
  | 'UNEXPLORED_DIRECTORY'
  | 'UNINSPECTED_DIRECTORY'
  | 'UNKNOWN_COVERAGE_ID'
  | 'MISSING_COVERAGE'
  | 'UNCOVERED_ACCEPTANCE_POINT'
  | 'UNEXPLORED_LOCATION'
  | 'UNKNOWN_LOCATION'
  | 'UNKNOWN_OBSERVATION'
  | 'UNACCOUNTED_OBSERVATION'
  | 'UNANALYZED_BEHAVIOR'
  | 'UNKNOWN_BEHAVIOR_REFERENCE'
  | 'CONTRADICTORY_VALIDATION_TYPE'
  | 'COVERAGE_NOT_EVIDENCED'
  | 'CONTRADICTORY_STRATEGY'
  | 'UNSUPPORTED_STRATEGY';

export interface SemanticError {
  code: SemanticErrorCode;
  /** JSONPath-ish location in the artifact being validated, e.g. `testCases[0].evidenceIds[0]`. */
  path: string;
  /** The offending value, when there is a single one. */
  value?: string;
  /** Why it was rejected, phrased so the agent can act on it. */
  details?: string;
}

interface Behavior {
  id: string;
  area: string;
  statement: string;
  status: 'CONFIRMED' | 'OBSERVED' | 'INFERRED';
  confidence: 'low' | 'medium' | 'high';
  suspectedIssue: boolean;
  source?: string[];
  /** Ledger observation ids this behavior was synthesised from. */
  observations?: string[];
}

/** What host code proved about the product surface; see `src/lib/discovery-surface.ts`. */
/** What the host recorded during exploration; see `src/lib/observation-ledger.ts`. */
export interface ObservationFacts {
  /** Host-assigned ids, in the order they were observed. */
  ids: string[];
  /** For the error message: a short label per id. */
  describe(id: string): string;
}

export interface SurfaceFacts {
  /** Absolute URLs the run is expected to account for. */
  expected: string[];
  origin: string;
}

export interface DiscoveredBehavior {
  product: string;
  /** One terminal state per location the host put on the surface. */
  locations: { url: string; status: 'VISITED' | 'UNREACHABLE' | 'SKIPPED'; reason?: string; area?: string }[];
  /** Observations deliberately not turned into a behavior, each with a reason. */
  excludedObservations?: { id: string; reason: string }[];
  areas: { name: string; routes: string[]; notes: string[] }[];
  behaviors: Behavior[];
  openQuestions: { id: string; question: string; relatedBehaviorIds: string[]; impact: string }[];
  conflicts: { description: string; sources: string[] }[];
}

/**
 * An upstream requirement: an acceptance point or a business rule.
 *
 * `testable` absent means testable — coverage is the default obligation, not
 * the exception, so an analyst who says nothing still owes a test case.
 */
/** How a requirement can be verified, when the evidence settles it. */
export type ValidationType = 'UI' | 'API' | 'VISUAL' | 'CONTRACT' | 'MANUAL' | 'UNKNOWN';

export const VALIDATION_TYPES: readonly ValidationType[] = [
  'UI', 'API', 'VISUAL', 'CONTRACT', 'MANUAL', 'UNKNOWN',
];

export interface EvidencedItem {
  id: string;
  statement: string;
  evidenceIds: string[];
  testable?: boolean;
  notTestableReason?: string;
  /**
   * Optional. Absent means undecided, which is honest; `UNKNOWN` means
   * considered and not settled by the evidence. Both are acceptable — forcing
   * a type the evidence does not support is not.
   */
  validationType?: ValidationType;
  validationTypeReason?: string;
}

export interface RequirementsAnalysis {
  feature: string;
  acceptancePoints: EvidencedItem[];
  businessRules: EvidencedItem[];
  openQuestions: { id: string; question: string; impact: string }[];
  risks: { area: string; probability: string; impact: string; rationale: string }[];
  /**
   * Discovered behaviors deliberately not turned into a requirement, each with
   * a reason. The escape hatch that makes completeness enforceable: a behavior
   * may be left out, but only on the record.
   */
  excludedBehaviors?: { id: string; reason: string }[];
}

interface TestCase {
  id: string;
  title: string;
  evidenceIds: string[];
  /** Upstream requirement IDs this case demonstrates. Distinct from evidenceIds. */
  covers: string[];
  preconditions: string[];
  testData: Record<string, unknown>;
  steps: { action: string; expected: string }[];
  expectedResult: string;
  automationReason: string;
  [key: string]: unknown;
}

export interface TestCases {
  feature: string;
  testCases: TestCase[];
  openQuestions: string[];
}

export type ExecutionMode = 'AUTOMATION' | 'MANUAL';
export type AutomationPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * How a case would be automated, as distinct from whether and when.
 *
 * Three separate judgements travel together and must not be collapsed:
 *   - `priority` on the test case  — product importance (P0..P3), the Designer's call
 *   - `executionMode`              — AUTOMATION or MANUAL
 *   - `automationPriority`         — HIGH/MEDIUM/LOW/NONE, when to build it
 *   - `automationStrategy`         — through what, this type
 *
 * A P0 case can be MANUAL. A HIGH-priority automation can be UNKNOWN strategy.
 * Conflating them is how a business rule best checked against an API becomes a
 * brittle browser test purely because the discovery evidence came from a browser.
 */
export type AutomationStrategy = 'UI' | 'API' | 'UI_API' | 'VISUAL' | 'MANUAL' | 'UNKNOWN';

export const AUTOMATION_STRATEGIES: readonly AutomationStrategy[] = [
  'UI', 'API', 'UI_API', 'VISUAL', 'MANUAL', 'UNKNOWN',
];

export interface AutomationPrioritization {
  cases: {
    testCaseId: string;
    executionMode: ExecutionMode;
    automationPriority: AutomationPriority;
    reason: string;
    blockingFactors: string[];
    /**
     * Optional. Absent means undecided; `UNKNOWN` means considered and not
     * settled by the evidence. Claiming API or VISUAL requires that the
     * upstream evidence actually shows such a capability.
     */
    automationStrategy?: AutomationStrategy;
    strategyReason?: string;
  }[];
}

/**
 * The counts a Test Cases Review must reproduce exactly.
 *
 * Deliberately numbers only. `validateTestCasesReview` compares this field by
 * field against the reviewer's own summary, so anything added here becomes
 * something the reviewer is required to restate — and a nested value cannot be
 * compared that way. The strategy breakdown is run reporting, not part of the
 * review contract, and lives in `strategySummary()` instead.
 */
export interface ReviewSummary {
  total: number;
  manual: number;
  automation: number;
  automationHigh: number;
  automationMedium: number;
  automationLow: number;
}

export interface TestCasesReview {
  status: 'APPROVED' | 'CHANGES_REQUESTED';
  issues: { testCaseId: string; severity: 'BLOCKER' | 'MAJOR' | 'MINOR' | 'INFO'; category: string; message: string }[];
  suggestedChanges: { testCaseId: string; field: string; change: string; rationale: string }[];
  summary: ReviewSummary;
}

/** Reviewer's ID for a finding about the suite as a whole rather than one test case. */
/** Phase 2, stage 1. Everything it asserts about the repository must be checkable on disk. */
export interface RepoAnalysis {
  repository: { packageManager: string; language: string; testRunner: string; summary?: string };
  playwright?: { configPath?: string; testDir?: string; baseURL?: string; projects?: string[]; usesStorageState?: boolean };
  typescript?: { configPath?: string; strict?: boolean };
  layout: { path: string; kind: string; purpose: string; examples?: string[] }[];
  scripts?: { name: string; command?: string; purpose: string }[];
  dependencies?: { name: string; role: string }[];
  conventions: { topic: string; rule: string; evidencePath: string; evidenceLine?: number }[];
  keyFiles: { path: string; why: string }[];
  risks?: string[];
  unknowns: string[];
}

/** What the host proved about the repository; see `src/lib/repo-evidence.ts`. */
export interface RepoFacts {
  rootExists: boolean;
  exists(relativePath: string): boolean;
  isDirectory(relativePath: string): boolean;
  hasFiles(relativePath: string): boolean;
  /** Directories the analysis is expected to account for. */
  automationDirectories: string[];
  scripts?: Set<string>;
  dependencies?: Set<string>;
}

export const SUITE_ID = 'SUITE';

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical spellings for the few vocabulary splits that matter here. Applied
 * only where meaning, not exact wording, is being compared (overlap and
 * contradiction). Quoted UI strings are compared *without* this, because a
 * quote claims the exact text on screen.
 */
const SYNONYMS: [RegExp, string][] = [
  [/\bsign(?:ing)?\s?in\b/g, 'login'],
  [/\blog(?:ging)?\s?in\b/g, 'login'],
  [/\bauthenticat\w*/g, 'login'],
  [/\bsign(?:ing)?\s?out\b/g, 'logout'],
  [/\blog(?:ging)?\s?out\b/g, 'logout'],
  [/\bsign\s?up\b/g, 'signup'],
  [/\bregist(?:er|ration|ering)\b/g, 'signup'],
  [/\btext\s?box(?:es)?\b/g, 'textbox'],
  [/\be\s?mail\b/g, 'email'],
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―-]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonical(text: string): string {
  let out = normalize(text);
  for (const [pattern, replacement] of SYNONYMS) out = out.replace(pattern, replacement);
  return out;
}

const STOPWORDS = new Set(
  (
    'the a an is are was were be been being must should shall can could will would may might ' +
    'with without for and or but to of on in at by as from into onto via per than then that this ' +
    'these those it its there their they them he she his her you your we our not no nor does do did ' +
    'has have had when after before while if once so such each any all some both either also only ' +
    'user users page app application system verify check ensure confirm test able correctly ' +
    'shown show shows display displays displayed visible appear appears present properly'
  ).split(' '),
);

/** Crude but stable: enough to make "credentials" meet "credential". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function contentWords(text: string): Set<string> {
  const words = canonical(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
  return new Set(words);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

/**
 * A quoted string claims literal on-screen text. Openers must follow a space,
 * bracket or colon so that apostrophes ("user's name") are not read as quotes.
 */
const QUOTED = /(?:^|[\s(:\[])['"‘“]([^'"‘’“”\n]{1,80}?)['"’”](?=$|[\s.,;:!?)\]])/g;

const URL_PATTERN = /https?:\/\/[^\s'"<>)\]]+/gi;
/** A bare path: must start after whitespace/quote/bracket, so "username/password" is not a route. */
const PATH_PATTERN = /(?:^|[\s'"(\[])(\/[a-z0-9][\w\-./]*)/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** Non-global twin for `.test()` — a /g regex carries `lastIndex` between calls. */
const IS_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/** `VALID_USERNAME`, `<password>`, `{{user}}`, `${PASSWORD}` — the forms a test may use for unknown data. */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return (
    v === '' ||
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) ||
    /^[A-Z][A-Z0-9]{2,}$/.test(v) ||
    /^<[^<>]+>$/.test(v) ||
    /^\{\{[^{}]+\}\}$/.test(v) ||
    /^\$\{[^{}]+\}$/.test(v) ||
    /\bconfigured\b.*\b(credential|account|user)/i.test(v)
  );
}

function quotedLiterals(text: string): { literal: string; before: string }[] {
  const found: { literal: string; before: string }[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const start = match.index ?? 0;
    found.push({ literal: match[1].trim(), before: text.slice(Math.max(0, start - 30), start) });
  }
  return found;
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

function pathsIn(text: string): string[] {
  const withoutUrls = text.replace(URL_PATTERN, ' ');
  return [...withoutUrls.matchAll(PATH_PATTERN)].map((m) => m[1].replace(/[.,;:!?]+$/, ''));
}

function routeKey(route: string): string {
  try {
    const url = new URL(route);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${path}`;
  } catch {
    return route.replace(/\/+$/, '') || '/';
  }
}

function pathOf(route: string): string {
  try {
    return new URL(route).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return route.replace(/\/+$/, '') || '/';
  }
}

// ---------------------------------------------------------------------------
// Feature vocabulary that must never appear without upstream support
// ---------------------------------------------------------------------------

/**
 * Concrete product capabilities a downstream agent is tempted to add because
 * "login pages usually have them". Each group is supported if *any* of its
 * phrases occurs in upstream evidence. A trailing `*` matches as a prefix.
 */
const FEATURE_GROUPS: { name: string; phrases: string[] }[] = [
  { name: 'dashboard', phrases: ['dashboard'] },
  {
    name: 'password reset',
    phrases: ['forgot password', 'forgotten password', 'password reset', 'reset password', 'reset link', 'reset email', 'password recovery', 'recover password'],
  },
  {
    name: 'email verification',
    phrases: ['email verification', 'verify email', 'verification email', 'verification link', 'confirm email', 'confirmation email', 'verify your email'],
  },
  { name: 'account lockout', phrases: ['lockout', 'locked out', 'lock out', 'account lock*'] },
  { name: 'new-device checks', phrases: ['new device*', 'unrecognized device*', 'unknown device*', 'device verification'] },
  { name: 'multi-factor auth', phrases: ['two factor', '2fa', 'mfa', 'multi factor', 'one time password', 'otp'] },
  { name: 'captcha', phrases: ['captcha', 'recaptcha'] },
  { name: 'remember me', phrases: ['remember me'] },
  { name: 'login attempt limits', phrases: ['rate limit*', 'too many attempts', 'maximum attempts', 'max attempts', 'attempt limit*'] },
  { name: 'session timeout', phrases: ['session timeout', 'session expir*', 'idle timeout'] },
  { name: 'single sign-on', phrases: ['single sign on', 'sso', 'oauth'] },
  { name: 'account registration', phrases: ['signup', 'create account', 'create an account', 'new account'] },
  { name: 'profile / settings', phrases: ['profile page', 'my profile', 'account settings', 'user settings'] },
  { name: 'admin area', phrases: ['admin panel', 'admin page', 'admin dashboard', 'administrator'] },
];

function phraseRegex(phrase: string): RegExp {
  const prefix = phrase.endsWith('*');
  const body = escapeRegExp(prefix ? phrase.slice(0, -1) : phrase).replace(/\\?\s+/g, '\\s+');
  return new RegExp(`\\b${body}${prefix ? '\\w*' : '\\b'}`, 'i');
}

// ---------------------------------------------------------------------------
// Upstream evidence corpus
// ---------------------------------------------------------------------------

interface Corpus {
  /** Every evidence sentence, raw — used for literal and route matching. */
  texts: string[];
  /** Same, canonicalised — used for feature-phrase matching. */
  canonicalJoined: string;
  /** Lower-cased raw text, for literal phrase matching of quoted strings. */
  literalJoined: string;
  /** Strings upstream itself quoted — the only support for an exact-text claim. */
  quoted: Set<string>;
  routes: Set<string>;
  paths: Set<string>;
  hasRoutes: boolean;
}

/**
 * Evidence is what was observed or explicitly derived from observation. Open
 * questions are uncertainty and are deliberately excluded: a question in
 * discovery is not support for a test case.
 */
function buildCorpus(
  discovery: DiscoveredBehavior | undefined,
  requirements?: RequirementsAnalysis,
  extra: string[] = [],
): Corpus {
  const texts: string[] = [...extra];
  const routes = new Set<string>();

  if (discovery) {
    texts.push(discovery.product);
    for (const area of discovery.areas) {
      texts.push(area.name, ...area.notes);
      for (const route of area.routes) {
        texts.push(route);
        routes.add(routeKey(route));
      }
    }
    for (const behavior of discovery.behaviors) texts.push(behavior.statement);
    for (const conflict of discovery.conflicts) texts.push(conflict.description);
  }
  if (requirements) {
    for (const item of [...requirements.acceptancePoints, ...requirements.businessRules]) texts.push(item.statement);
  }

  for (const text of texts) for (const url of urlsIn(text)) routes.add(routeKey(url));

  const paths = new Set<string>();
  for (const route of routes) paths.add(pathOf(route));
  for (const text of texts) for (const path of pathsIn(text)) paths.add(path.replace(/\/+$/, '') || '/');

  const quoted = new Set<string>();
  for (const text of texts) for (const { literal } of quotedLiterals(text)) quoted.add(normalize(literal));

  return {
    texts,
    canonicalJoined: texts.map(canonical).join(' \n '),
    literalJoined: texts.map(normalize).join(' \n '),
    quoted,
    routes,
    paths,
    hasRoutes: routes.size > 0,
  };
}

function testCaseTexts(tc: TestCase): string[] {
  return [
    tc.title,
    tc.expectedResult,
    ...tc.preconditions,
    ...tc.steps.flatMap((step) => [step.action, step.expected]),
    ...Object.values(tc.testData ?? {}).filter((v): v is string => typeof v === 'string'),
  ];
}

function literalSupported(literal: string, corpus: Corpus): boolean {
  const needle = normalize(literal);
  if (needle === '') return true;
  if (corpus.quoted.has(needle)) return true;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`).test(corpus.literalJoined);
}

// ---------------------------------------------------------------------------
// Rule: no new facts
// ---------------------------------------------------------------------------

/** Words that turn a quoted string into a claim about exact on-screen text. */
const EXACT_TEXT_CONTEXT = /\b(message|error|text|reads|says|saying|label(?:led)?|titled|toast|banner|notification|alert|prompt)\s*(?:is|of|:)?\s*$/i;
/** Words that turn a quoted string into a claimed credential value. */
const CREDENTIAL_CONTEXT = /\b(pass(?:word|code|phrase)?|pwd|pin|secret|token|otp)\b[^'"‘“]{0,25}$/i;

function checkFacts(
  text: string,
  path: string,
  corpus: Corpus,
  errors: SemanticError[],
  knownCredentials: ReadonlySet<string> = new Set(),
): void {
  checkRoutes(text, path, corpus, errors);
  checkLiteralsAndFeatures(text, path, corpus, errors, knownCredentials);
}

function checkRoutes(text: string, path: string, corpus: Corpus, errors: SemanticError[]): void {
  for (const url of urlsIn(text)) {
    if (!corpus.routes.has(routeKey(url))) {
      errors.push({
        code: 'UNSUPPORTED_FACT',
        path,
        value: url,
        details: 'This URL does not appear in discovered-behavior. Use only routes discovery actually visited.',
      });
    }
  }

  for (const route of pathsIn(text)) {
    const key = route.replace(/\/+$/, '') || '/';
    if (key === '/' && corpus.hasRoutes) continue;
    if (!corpus.paths.has(key)) {
      errors.push({
        code: 'UNSUPPORTED_FACT',
        path,
        value: route,
        details: `No evidence that the route "${route}" exists. Describe the outcome without a route, or raise it as an open question.`,
      });
    }
  }
}

function checkLiteralsAndFeatures(
  text: string,
  path: string,
  corpus: Corpus,
  errors: SemanticError[],
  knownCredentials: ReadonlySet<string>,
): void {
  for (const { literal, before } of quotedLiterals(text)) {
    if (isPlaceholder(literal)) continue;
    const normalized = normalize(literal);

    if (CREDENTIAL_CONTEXT.test(before) || knownCredentials.has(normalized)) {
      if (!literalSupported(literal, corpus)) {
        errors.push({
          code: 'FABRICATED_CREDENTIAL',
          path,
          value: literal,
          details: 'Invented credential value. Use a placeholder such as VALID_PASSWORD or INVALID_PASSWORD.',
        });
      }
      continue;
    }

    if (EXACT_TEXT_CONTEXT.test(before)) {
      // Claiming the exact wording of a message needs discovery to have
      // recorded that wording verbatim; a description of it is not enough.
      if (!corpus.quoted.has(normalized)) {
        errors.push({
          code: 'UNSUPPORTED_FACT',
          path,
          value: literal,
          details:
            'Exact message text was never recorded by discovery. Say "an error message is displayed" ' +
            'instead of quoting it, or raise the exact wording as an open question.',
        });
      }
      continue;
    }

    if (!literalSupported(literal, corpus)) {
      errors.push({
        code: 'UNSUPPORTED_FACT',
        path,
        value: literal,
        details: `"${literal}" does not appear in upstream evidence. Name only controls and text discovery observed.`,
      });
    }
  }

  const canonicalText = canonical(text);
  for (const group of FEATURE_GROUPS) {
    const hit = group.phrases.find((phrase) => phraseRegex(phrase).test(canonicalText));
    if (!hit) continue;
    const supported = group.phrases.some((phrase) => phraseRegex(phrase).test(corpus.canonicalJoined));
    if (!supported) {
      errors.push({
        code: 'UNSUPPORTED_FACT',
        path,
        value: hit.replace(/\*$/, ''),
        details: `No evidence of ${group.name} in this product. Remove it, or raise it as an open question.`,
      });
    }
  }
}

/** Emails identify accounts, so an invented one is a fabricated credential wherever it appears. */
function checkEmails(text: string, path: string, corpus: Corpus, errors: SemanticError[]): void {
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (!literalSupported(match[0], corpus)) {
      errors.push({
        code: 'FABRICATED_CREDENTIAL',
        path,
        value: match[0],
        details: 'Invented account email. Use a placeholder such as VALID_USERNAME, or "requires configured test credentials".',
      });
    }
  }
}

const CREDENTIAL_KEY = /pass|pwd|secret|token|api.?key|otp|\bpin\b|e.?mail|user|login|account|credential/i;

/** Literal credential values in a test's testData — so the same value quoted in a step is recognised. */
function credentialValues(data: unknown, out = new Set<string>()): Set<string> {
  if (data === null || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string' && CREDENTIAL_KEY.test(key) && !isPlaceholder(value)) out.add(normalize(value));
    else if (typeof value === 'object') credentialValues(value, out);
  }
  return out;
}

function checkTestData(data: unknown, path: string, corpus: Corpus, errors: SemanticError[]): void {
  if (data === null || typeof data !== 'object') return;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const here = `${path}.${key}`;
    if (typeof value === 'string') {
      // Emails are reported by checkEmails below; don't report the same value twice.
      if (CREDENTIAL_KEY.test(key) && !isPlaceholder(value) && !IS_EMAIL.test(value) && !literalSupported(value, corpus)) {
        const name = key.toUpperCase().replace(/\W+/g, '_');
        errors.push({
          code: 'FABRICATED_CREDENTIAL',
          path: here,
          value,
          details: `Invented ${key}. Use a placeholder such as VALID_${name} or INVALID_${name}.`,
        });
      }
      checkEmails(value, here, corpus, errors);
    } else if (typeof value === 'object') {
      checkTestData(value, here, corpus, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Rule: no contradiction of what discovery observed
// ---------------------------------------------------------------------------

const UI_NOUN =
  'field|button|textbox|input|link|checkbox|form|message|area|heading|section|menu|dropdown|list|table|dialog|modal|tab|label|panel|column';
const EXISTENCE_PHRASE = new RegExp(`\\b((?:[a-z]+/)*[a-z]+)\\s+(${UI_NOUN})s?\\b`, 'g');
const NOT_A_MODIFIER = new Set(['the', 'a', 'an', 'with', 'and', 'or', 'of', 'no', 'is', 'are', 'has', 'for', 'this', 'that', 'each', 'shown', 'displayed', 'editable']);

interface Observation {
  id: string;
  text: string;
}

/** What discovery saw with confidence: high-confidence OBSERVED/CONFIRMED behaviours plus area notes. */
function observations(discovery: DiscoveredBehavior): Observation[] {
  const out: Observation[] = [];
  for (const b of discovery.behaviors) {
    if (b.status !== 'INFERRED' && b.confidence === 'high') out.push({ id: b.id, text: b.statement });
  }
  for (const area of discovery.areas) {
    for (const note of area.notes) out.push({ id: `area "${area.name}" notes`, text: note });
  }
  return out;
}

/** "Login form with username/password fields" -> login form, username field, password field. */
function observedThings(obs: Observation[]): { phrase: string; source: string }[] {
  const found = new Map<string, string>();
  for (const { id, text } of obs) {
    for (const match of canonical(text).matchAll(EXISTENCE_PHRASE)) {
      for (const modifier of match[1].split('/')) {
        if (NOT_A_MODIFIER.has(modifier)) continue;
        const phrase = `${modifier} ${match[2]}`;
        if (!found.has(phrase)) found.set(phrase, id);
      }
    }
  }
  return [...found].map(([phrase, source]) => ({ phrase, source }));
}

const ACTIONS: { name: string; mentions: RegExp }[] = [
  { name: 'login', mentions: /\blogin\b|\bcredential|\bpassword\b/ },
  { name: 'logout', mentions: /\blogout\b/ },
  { name: 'signup', mentions: /\bsignup\b/ },
  { name: 'submit', mentions: /\bsubmit\w*/ },
  { name: 'save', mentions: /\bsav(?:e|es|ed|ing)\b/ },
];
const HAS_EFFECT = /\b(error|message|shown|displayed|redirect\w*|becomes?|appears?|logged|success\w*|editable|navigat\w*|changes?|updated|saved|created|persist\w*)\b/;
const NO_EFFECT =
  /\b(does nothing|do nothing|nothing happens|no (?:effect|response|reaction|feedback)|(?:does not|doesn't|did not|didn't|fails? to|not)\s+(?:trigger|do anything|respond|react|work|submit|navigate|happen|change anything))\b/;
/** A sentence scoped to a specific state is not a blanket claim, so it cannot contradict one. */
const STATE_QUALIFIER = /\b(when|if|while|unless|until|before|empty|blank|disabled|without (?:credential|input|value|data)\w*|no credential\w*)\b/;

function checkContradictions(
  text: string,
  path: string,
  discovery: DiscoveredBehavior | undefined,
  errors: SemanticError[],
): void {
  if (!discovery) return;
  const obs = observations(discovery);

  for (const sentence of sentences(text)) {
    const s = canonical(sentence);

    // "missing password field" when discovery saw a password field.
    for (const { phrase, source } of observedThings(obs)) {
      const p = escapeRegExp(phrase);
      const negated = [
        new RegExp(`\\b(?:missing|absent|lacks?|lacking|without|no)\\s+(?:a\\s+|an\\s+|the\\s+|any\\s+)?${p}s?\\b`),
        new RegExp(`\\b${p}s?\\s+(?:is|are)\\s+(?:missing|absent|unavailable|not\\s+(?:present|shown|visible|displayed|available|rendered))\\b`),
        new RegExp(`\\b${p}s?\\s+(?:does\\s+not|doesn't|do\\s+not|don't)\\s+exist\\b`),
        new RegExp(`\\bthere\\s+(?:is|are)\\s+no\\s+${p}s?\\b`),
      ].some((re) => re.test(s));
      if (negated) {
        errors.push({
          code: 'CONTRADICTS_UPSTREAM',
          path,
          value: sentence,
          details: `Discovery observed a ${phrase} (${source}). Do not state it is missing.`,
        });
      }
    }

    // "Sign In does nothing" when discovery saw login produce an error.
    if (NO_EFFECT.test(s) && !STATE_QUALIFIER.test(s)) {
      for (const action of ACTIONS) {
        if (!action.mentions.test(s)) continue;
        const witness = obs.find((o) => {
          const t = canonical(o.text);
          return action.mentions.test(t) && HAS_EFFECT.test(t);
        });
        if (witness) {
          errors.push({
            code: 'CONTRADICTS_UPSTREAM',
            path,
            value: sentence,
            details:
              `Discovery observed ${action.name} producing an effect (${witness.id}: "${witness.text}"). ` +
              'A blanket "does nothing" contradicts that. If it only happens in one state, say which ' +
              '(for example "with empty credentials").',
          });
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rule: evidence references resolve, and actually support the claim
// ---------------------------------------------------------------------------

function checkDuplicateIds(items: { id: string }[], path: string, errors: SemanticError[]): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) {
      errors.push({ code: 'DUPLICATE_ID', path: `${path}[${i}].id`, value: item.id, details: 'IDs must be unique.' });
    }
    seen.add(item.id);
  });
}

function checkOverlap(claim: string, evidence: string[], path: string, ids: string[], errors: SemanticError[]): void {
  if (evidence.length === 0) return;
  const claimWords = contentWords(claim);
  if (claimWords.size === 0) return;
  const evidenceWords = contentWords(evidence.join(' '));
  const shared = [...claimWords].some((w) => evidenceWords.has(w));
  if (!shared) {
    errors.push({
      code: 'EVIDENCE_MISMATCH',
      path,
      value: ids.join(', '),
      details:
        `The cited evidence (${evidence.map((e) => `"${e}"`).join('; ')}) says nothing about this claim. ` +
        'Cite the behavior that actually supports it, or move the claim to openQuestions.',
    });
  }
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/** Internal consistency of discovery itself: unique IDs, known areas, resolvable question links. */
/** Same comparison the surface uses, so a trailing slash is not a new location. */
function sameLocation(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, '').replace(/\?$/, '').replace(/\/+$/, '').toLowerCase();
  return strip(a) === strip(b);
}

/**
 * `surface` is what host code established from the browser before the agent
 * ran. When it is absent — no browser, or a run that never built one — the
 * completeness rules are skipped rather than invented.
 */
export function validateDiscoveredBehavior(
  discovery: DiscoveredBehavior,
  surface?: SurfaceFacts,
  observed?: ObservationFacts,
): SemanticError[] {
  const errors: SemanticError[] = [];
  checkDuplicateIds(discovery.behaviors, 'behaviors', errors);
  checkDuplicateIds(discovery.openQuestions, 'openQuestions', errors);

  const areas = new Set(discovery.areas.map((a) => a.name));
  discovery.behaviors.forEach((b, i) => {
    if (!areas.has(b.area)) {
      errors.push({
        code: 'UNKNOWN_AREA',
        path: `behaviors[${i}].area`,
        value: b.area,
        details: `Not one of the declared areas: ${[...areas].join(', ') || '(none)'}.`,
      });
    }
  });

  // ---- completeness: the surface the host found must be accounted for -----
  //
  // Not "did you find enough" — that is a judgement no host can make — but
  // "did every location we know the browser rendered reach a terminal state".
  // UNREACHABLE and SKIPPED are answers; silence is not.
  const reported = discovery.locations ?? [];
  reported.forEach((l, i) => {
    if (typeof l?.url !== 'string') return;
    // A same-origin location that was not on the host's list is a genuine
    // find: most applications only reveal their real surface after signing in,
    // and the entry page's links are just the starting point. Only an
    // off-origin or malformed URL is rejected — that is invention, not
    // discovery.
    if (surface) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(l.url).origin === surface.origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        errors.push({
          code: 'UNKNOWN_LOCATION',
          path: `locations[${i}].url`,
          value: l.url,
          details: `outside the application (${surface.origin}). Report only locations of the product itself.`,
        });
      }
    }
    if ((l.status === 'UNREACHABLE' || l.status === 'SKIPPED') && !l.reason) {
      errors.push({
        code: 'MISSING_EVIDENCE',
        path: `locations[${i}].reason`,
        value: l.url,
        details: `${l.status} needs a reason — say what stopped you.`,
      });
    }
  });

  if (surface) {
    for (const url of surface.expected) {
      if (!reported.some((l) => typeof l?.url === 'string' && sameLocation(l.url, url))) {
        errors.push({
          code: 'UNEXPLORED_LOCATION',
          path: '$.locations',
          value: url,
          details: 'no terminal state reported. Visit it, or record it UNREACHABLE/SKIPPED with a reason.',
        });
      }
    }
  }

  // ---- behavioral observation completeness --------------------------------
  //
  // A different question from surface completeness. That asks whether the known
  // areas were reached; this asks whether what was seen there survived
  // synthesis. A measured run recorded ten meaningful observations and wrote
  // one behavior, and nothing noticed.
  //
  // Several observations may support one behavior — that is synthesis, not a
  // problem. What is not allowed is silence.
  if (observed && observed.ids.length > 0) {
    const known = new Set(observed.ids);
    const cited = new Set<string>();

    discovery.behaviors.forEach((b, i) => {
      (b.observations ?? []).forEach((id, j) => {
        if (!known.has(id)) {
          errors.push({
            code: 'UNKNOWN_OBSERVATION',
            path: `behaviors[${i}].observations[${j}]`,
            value: String(id),
            details: `no such observation was recorded. Valid: ${observed.ids.join(', ')}`,
          });
        } else {
          cited.add(id);
        }
      });
    });

    (discovery.excludedObservations ?? []).forEach((x, i) => {
      if (!x?.id) return;
      if (!known.has(x.id)) {
        errors.push({
          code: 'UNKNOWN_OBSERVATION',
          path: `excludedObservations[${i}].id`,
          value: x.id,
          details: `no such observation was recorded. Valid: ${observed.ids.join(', ')}`,
        });
      } else {
        cited.add(x.id);
      }
    });

    for (const id of observed.ids) {
      if (!cited.has(id)) {
        errors.push({
          code: 'UNACCOUNTED_OBSERVATION',
          path: '$.behaviors',
          value: id,
          details:
            `you recorded "${clip(observed.describe(id), 90)}" and no behavior represents it. ` +
            'Add or extend a behavior citing it, or list it in excludedObservations with a reason.',
        });
      }
    }
  }

  const ids = new Set(discovery.behaviors.map((b) => b.id));
  discovery.openQuestions.forEach((q, i) =>
    q.relatedBehaviorIds.forEach((id, j) => {
      if (!ids.has(id)) {
        errors.push({
          code: 'UNKNOWN_EVIDENCE_ID',
          path: `openQuestions[${i}].relatedBehaviorIds[${j}]`,
          value: id,
          details: `No behavior has this ID. Valid: ${[...ids].join(', ') || '(none)'}.`,
        });
      }
    }),
  );
  return errors;
}

/**
 * Requirements analysis against discovery. Every acceptance point and business
 * rule must cite real behaviors that actually say something about it, and no
 * field may introduce a product fact discovery did not record.
 */
export function validateRequirementsAnalysis(
  discovery: DiscoveredBehavior,
  requirements: RequirementsAnalysis,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const corpus = buildCorpus(discovery);
  const behaviors = new Map(discovery.behaviors.map((b) => [b.id, b]));
  const questionIds = new Set(discovery.openQuestions.map((q) => q.id));
  const validIds = [...behaviors.keys()].join(', ') || '(none)';

  checkDuplicateIds([...requirements.acceptancePoints, ...requirements.businessRules], 'acceptancePoints+businessRules', errors);

  const evidenced: [string, EvidencedItem[]][] = [
    ['acceptancePoints', requirements.acceptancePoints],
    ['businessRules', requirements.businessRules],
  ];
  for (const [field, items] of evidenced) {
    items.forEach((item, i) => {
      const base = `${field}[${i}]`;
      if (item.evidenceIds.length === 0) {
        errors.push({
          code: 'MISSING_EVIDENCE',
          path: `${base}.evidenceIds`,
          details: `Every ${field === 'acceptancePoints' ? 'acceptance point' : 'business rule'} must cite the behavior(s) that support it. If none do, move it to openQuestions.`,
        });
      }

      const cited: Behavior[] = [];
      item.evidenceIds.forEach((id, j) => {
        const behavior = behaviors.get(id);
        if (behavior) {
          cited.push(behavior);
        } else if (questionIds.has(id)) {
          errors.push({
            code: 'NOT_EVIDENCE',
            path: `${base}.evidenceIds[${j}]`,
            value: id,
            details: `${id} is a discovery open question — uncertainty, not evidence. Cite a behavior, or keep this as an open question.`,
          });
        } else {
          errors.push({
            code: 'UNKNOWN_EVIDENCE_ID',
            path: `${base}.evidenceIds[${j}]`,
            value: id,
            details: `No discovered behavior has this ID. Valid behavior IDs: ${validIds}.`,
          });
        }
      });

      if (cited.length > 0) {
        // The evidence policy: suspected issues and inferences never become
        // expected behavior on their own.
        if (cited.every((b) => b.suspectedIssue)) {
          errors.push({
            code: 'NOT_EVIDENCE',
            path: `${base}.evidenceIds`,
            value: item.evidenceIds.join(', '),
            details: 'Every cited behavior is a suspected issue. Observed-but-suspicious behavior cannot become a requirement; raise an open question instead.',
          });
        } else if (cited.every((b) => b.status === 'INFERRED')) {
          errors.push({
            code: 'NOT_EVIDENCE',
            path: `${base}.evidenceIds`,
            value: item.evidenceIds.join(', '),
            details: 'Every cited behavior is INFERRED. An inference cannot become a requirement on its own; raise an open question instead.',
          });
        }
        checkOverlap(item.statement, cited.map((b) => b.statement), `${base}.statement`, item.evidenceIds, errors);
      }

      checkFacts(item.statement, `${base}.statement`, corpus, errors);
      checkEmails(item.statement, `${base}.statement`, corpus, errors);
      checkContradictions(item.statement, `${base}.statement`, discovery, errors);
    });
  }

  requirements.risks.forEach((risk, i) => {
    checkFacts(risk.rationale, `risks[${i}].rationale`, corpus, errors);
    checkContradictions(risk.rationale, `risks[${i}].rationale`, discovery, errors);
  });

  // Open questions are where unknowns belong, so they may name things discovery
  // did not see — but they still may not contradict it or invent credentials.
  requirements.openQuestions.forEach((q, i) => {
    checkEmails(q.question, `openQuestions[${i}].question`, corpus, errors);
    checkContradictions(q.question, `openQuestions[${i}].question`, discovery, errors);
  });

  // ---- Validation type -----------------------------------------------------
  //
  // The type is optional on purpose. What is checked is only that a stated one
  // does not contradict the analyst's own `testable` judgement: a requirement
  // marked not testable cannot simultaneously claim an automatable route.
  for (const [field, items] of evidenced) {
    items.forEach((item, i) => {
      const type = item.validationType;
      if (type === undefined) return;
      if (item.testable === false && type !== 'MANUAL' && type !== 'UNKNOWN') {
        errors.push({
          code: 'CONTRADICTORY_VALIDATION_TYPE',
          path: `${field}[${i}].validationType`,
          value: type,
          details:
            `${item.id} is marked testable: false but claims a ${type} validation route. ` +
            'Either it can be verified that way, or it is not testable — not both. Use MANUAL or ' +
            'UNKNOWN, or remove testable: false.',
        });
      }
    });
  }

  // ---- Completeness: no discovered behavior may vanish ----------------------
  //
  // The same rule discovery itself follows for observations, applied one stage
  // later: everything upstream is either represented downstream or explicitly
  // accounted for. Without this a run can quietly analyse four of fifteen
  // behaviors and still validate, because every individual statement it DID
  // write was well evidenced. Silence was the failure mode, and silence is
  // exactly what a per-item check cannot see.
  const cited = new Set<string>();
  for (const [, items] of evidenced) {
    for (const item of items) for (const id of item.evidenceIds) cited.add(id);
  }

  const excluded = requirements.excludedBehaviors ?? [];
  const excludedIds = new Set<string>();
  excluded.forEach((entry, i) => {
    if (!behaviors.has(entry.id)) {
      errors.push({
        code: 'UNKNOWN_BEHAVIOR_REFERENCE',
        path: `excludedBehaviors[${i}].id`,
        value: entry.id,
        details: `No discovered behavior has this ID. Valid behavior IDs: ${validIds}.`,
      });
      return;
    }
    if (cited.has(entry.id)) {
      errors.push({
        code: 'UNKNOWN_BEHAVIOR_REFERENCE',
        path: `excludedBehaviors[${i}].id`,
        value: entry.id,
        details: `${entry.id} is both excluded and cited as evidence. Decide which: remove it from excludedBehaviors, or stop citing it.`,
      });
      return;
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      errors.push({
        code: 'UNANALYZED_BEHAVIOR',
        path: `excludedBehaviors[${i}].reason`,
        value: entry.id,
        details: `Excluding ${entry.id} requires a reason saying why it produces no requirement.`,
      });
      return;
    }
    excludedIds.add(entry.id);
  });

  for (const behavior of discovery.behaviors) {
    if (cited.has(behavior.id) || excludedIds.has(behavior.id)) continue;
    // A behavior that cannot become a requirement still has to be accounted
    // for — the exclusion list is where that is said, and the message names
    // the route so the fix is obvious rather than guessed at.
    const blocked = behavior.suspectedIssue
      ? ' It is a suspected issue, so it cannot become a requirement: exclude it and raise an open question.'
      : behavior.status === 'INFERRED'
        ? ' It is INFERRED, so it cannot become a requirement on its own: exclude it and raise an open question.'
        : '';
    errors.push({
      code: 'UNANALYZED_BEHAVIOR',
      path: 'acceptancePoints',
      value: behavior.id,
      details:
        `${behavior.id} ("${truncate(behavior.statement, 80)}") is neither cited as evidence by any ` +
        `acceptance point or business rule, nor listed in excludedBehaviors with a reason.${blocked}`,
    });
  }

  return errors;
}

/** Shorten a statement for an error message without hiding which one it is. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface AnalysisCoverageSummary {
  /** Behaviors discovery produced. */
  behaviors: number;
  /** Behaviors cited as evidence by at least one requirement. */
  analyzed: number;
  /** Behaviors explicitly excluded with a reason. */
  excluded: number;
  /** Behaviors neither analyzed nor excluded — always 0 in a valid artifact. */
  unaccounted: number;
  acceptancePoints: number;
  businessRules: number;
  openQuestions: number;
  /** Requirements the analyst marked not testable. */
  notTestable: number;
  /** How the testable requirements break down by stated validation type. */
  validationTypes: Record<string, number>;
  unaccountedIds: string[];
}

/**
 * Host-derived analysis coverage. Computed from the two artifacts, never from
 * a total the model reports about its own work.
 */
export function analysisCoverageSummary(
  discovery: DiscoveredBehavior | undefined,
  requirements: RequirementsAnalysis,
): AnalysisCoverageSummary {
  const items = [...(requirements.acceptancePoints ?? []), ...(requirements.businessRules ?? [])];
  const cited = new Set<string>();
  for (const item of items) for (const id of item.evidenceIds ?? []) cited.add(id);
  const excluded = new Set((requirements.excludedBehaviors ?? []).map((e) => e.id));

  const all = discovery?.behaviors ?? [];
  const analyzed = all.filter((b) => cited.has(b.id));
  const unaccounted = all.filter((b) => !cited.has(b.id) && !excluded.has(b.id));

  const validationTypes: Record<string, number> = {};
  for (const item of items) {
    if (item.testable === false) continue;
    const key = item.validationType ?? 'UNSPECIFIED';
    validationTypes[key] = (validationTypes[key] ?? 0) + 1;
  }

  return {
    behaviors: all.length,
    analyzed: analyzed.length,
    excluded: all.filter((b) => excluded.has(b.id)).length,
    unaccounted: unaccounted.length,
    acceptancePoints: requirements.acceptancePoints?.length ?? 0,
    businessRules: requirements.businessRules?.length ?? 0,
    openQuestions: requirements.openQuestions?.length ?? 0,
    notTestable: items.filter((i) => i.testable === false).length,
    validationTypes,
    unaccountedIds: unaccounted.map((b) => b.id),
  };
}

/**
 * Test cases against requirements analysis and discovery. Evidence IDs may
 * cite acceptance points, business rules, or behaviors directly; all must
 * resolve. Test data may not invent accounts or credentials.
 */
/**
 * The upstream requirements a suite owes a test case.
 *
 * Both acceptance points and business rules count: a business rule is a
 * testable statement about the product with its own evidence, and leaving them
 * out is how five of them went silently untested in a real run.
 *
 * `testable: false` opts one out — that is the analyst's judgement to record,
 * not the host's to infer. Open questions are never included: a question is
 * uncertainty, and demanding a test for it would invite invention.
 */
export function testableRequirements(requirements: RequirementsAnalysis): EvidencedItem[] {
  return [...(requirements.acceptancePoints ?? []), ...(requirements.businessRules ?? [])].filter(
    (r) => r?.testable !== false,
  );
}

export interface CoverageSummary {
  /** Requirements that owe a test case. */
  testable: number;
  covered: number;
  uncovered: number;
  /** Requirements the analyst marked `testable: false`. */
  exempt: number;
  testCases: number;
  uncoveredIds: string[];
  /**
   * Scenario shape, host-counted from the cases' own `types`. Coverage says
   * every requirement has a case; this says what kind of cases they are. A
   * suite that is entirely `positive` covers everything and tests nothing
   * interesting, and that is invisible in a coverage percentage.
   */
  scenarioTypes: Record<string, number>;
  /** Cases claiming more than one requirement — merging, if it is happening. */
  multiRequirementCases: number;
  /** Requirements demonstrated by more than one case. Not a fault; a fact. */
  requirementsWithMultipleCases: number;
}

/**
 * A suite big enough that a two-kind classification is worth a second look.
 * Below this, one or two kinds is perfectly normal.
 */
export const DIVERSITY_DIAGNOSTIC_MIN_CASES = 8;

/**
 * A non-blocking note when a large suite classifies itself very narrowly.
 *
 * This is a diagnostic, never a rule. A real run once produced 23 cases using
 * only `positive` and `negative`, one label each, because the prompt named no
 * vocabulary and the model inferred one from the coverage-matrix categories.
 * The collapse was the visible symptom of that.
 *
 * It deliberately does NOT become a validation error, and nothing anywhere
 * requires a minimum number of kinds or labels. A rule like "every suite needs
 * a boundary test" would be satisfied by inventing one, which is worse than
 * the narrow classification it replaced. This surfaces the pattern and leaves
 * the judgement to a person.
 */
export function scenarioDiversityDiagnostic(summary: CoverageSummary): string | undefined {
  if (summary.testCases < DIVERSITY_DIAGNOSTIC_MIN_CASES) return undefined;
  const kinds = Object.keys(summary.scenarioTypes);
  if (kinds.length === 0) {
    return `Scenario-type diversity is low: ${summary.testCases} cases carry no scenario classification at all.`;
  }
  if (kinds.length > 2) return undefined;
  return (
    `Scenario-type diversity is low: ${summary.testCases} cases use only ` +
    `${kinds.sort().join('/')} classifications. Review whether boundary, state-transition, ` +
    'regression, smoke or validation classifications were overlooked. This is a diagnostic, ' +
    'not a failure — a narrow suite can be correct.'
  );
}

/**
 * Coverage, computed from the two artifacts — never from a total the model
 * reports about itself. Used by the validator and by the run log.
 */
export function coverageSummary(requirements: RequirementsAnalysis, testCases: TestCases): CoverageSummary {
  const testable = testableRequirements(requirements);
  const claimed = new Set((testCases.testCases ?? []).flatMap((tc) => tc?.covers ?? []));
  const uncoveredIds = testable.filter((r) => !claimed.has(r.id)).map((r) => r.id);
  const all = [...(requirements.acceptancePoints ?? []), ...(requirements.businessRules ?? [])];
  const cases = testCases.testCases ?? [];
  const scenarioTypes: Record<string, number> = {};
  for (const tc of cases) {
    for (const type of tc?.types ?? []) scenarioTypes[type] = (scenarioTypes[type] ?? 0) + 1;
  }
  const casesPerRequirement = new Map<string, number>();
  for (const tc of cases) {
    for (const id of tc?.covers ?? []) casesPerRequirement.set(id, (casesPerRequirement.get(id) ?? 0) + 1);
  }

  return {
    testable: testable.length,
    covered: testable.length - uncoveredIds.length,
    uncovered: uncoveredIds.length,
    exempt: all.length - testable.length,
    testCases: cases.length,
    uncoveredIds,
    scenarioTypes,
    multiRequirementCases: cases.filter((tc) => (tc?.covers ?? []).length > 1).length,
    requirementsWithMultipleCases: [...casesPerRequirement.values()].filter((n) => n > 1).length,
  };
}

export function validateTestCases(
  discovery: DiscoveredBehavior | undefined,
  requirements: RequirementsAnalysis,
  testCases: TestCases,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const corpus = buildCorpus(discovery, requirements);

  const behaviors = new Map((discovery?.behaviors ?? []).map((b) => [b.id, b]));
  const derived = new Map([...requirements.acceptancePoints, ...requirements.businessRules].map((a) => [a.id, a]));
  const questionIds = new Set([
    ...requirements.openQuestions.map((q) => q.id),
    ...(discovery?.openQuestions ?? []).map((q) => q.id),
  ]);
  const validIds = [...derived.keys(), ...behaviors.keys()].join(', ') || '(none)';

  checkDuplicateIds(testCases.testCases, 'testCases', errors);

  // Coverage is a different claim from evidence: `evidenceIds` says "this is
  // supported by", `covers` says "this demonstrates". A case may cite a raw
  // behavior as evidence while demonstrating no requirement at all, which is
  // exactly how a suite passed while leaving requirements untested.
  const requirementById = new Map(
    [...(requirements.acceptancePoints ?? []), ...(requirements.businessRules ?? [])].map((r) => [r.id, r]),
  );
  const requirementIds = new Set(requirementById.keys());
  const requirementList = [...requirementIds].join(', ') || '(none)';

  testCases.testCases.forEach((tc, i) => {
    const base = `testCases[${i}]`;

    const covers = tc?.covers ?? [];
    if (covers.length === 0) {
      errors.push({
        code: 'MISSING_COVERAGE',
        path: `${base}.covers`,
        details: `name the requirement ID(s) this case demonstrates. Valid: ${requirementList}`,
      });
    }
    for (const [j, id] of covers.entries()) {
      if (!requirementIds.has(id)) {
        errors.push({
          code: 'UNKNOWN_COVERAGE_ID',
          path: `${base}.covers[${j}]`,
          value: String(id),
          details: `not an acceptance point or business rule. Valid: ${requirementList}`,
        });
      }
    }

    // A `covers` claim has to be traceable, not asserted. The case must either
    // cite the requirement itself, or cite a behavior that requirement rests
    // on. This is what stops independent requirements being swept into one
    // case to shorten the list: merging only survives when the scenario really
    // does exercise the same evidence.
    for (const [j, id] of covers.entries()) {
      const requirement = requirementById.get(id);
      if (requirement === undefined) continue;
      const cited = tc.evidenceIds ?? [];
      const sharesEvidence =
        cited.includes(id) || cited.some((e) => (requirement.evidenceIds ?? []).includes(e));
      if (!sharesEvidence) {
        errors.push({
          code: 'COVERAGE_NOT_EVIDENCED',
          path: `${base}.covers[${j}]`,
          value: String(id),
          details:
            `This case claims to cover ${id} but cites none of its evidence. Cite ${id} itself, or ` +
            `one of the behaviors it rests on (${(requirement.evidenceIds ?? []).join(', ') || 'none'}). ` +
            'If the scenario does not actually exercise this requirement, give it its own case.',
        });
      }
    }

    if (tc.evidenceIds.length === 0) {
      errors.push({
        code: 'MISSING_EVIDENCE',
        path: `${base}.evidenceIds`,
        details: 'Every test case must cite the acceptance point(s) or behavior(s) it verifies.',
      });
    }

    const evidenceTexts: string[] = [];
    tc.evidenceIds.forEach((id, j) => {
      const item = derived.get(id);
      const behavior = behaviors.get(id);
      if (item) {
        evidenceTexts.push(item.statement);
        for (const upstream of item.evidenceIds) {
          const b = behaviors.get(upstream);
          if (b) evidenceTexts.push(b.statement);
        }
      } else if (behavior) {
        evidenceTexts.push(behavior.statement);
      } else if (questionIds.has(id)) {
        errors.push({
          code: 'NOT_EVIDENCE',
          path: `${base}.evidenceIds[${j}]`,
          value: id,
          details: `${id} is an open question — uncertainty, not evidence. A test cannot verify an unknown; cite an acceptance point.`,
        });
      } else {
        errors.push({
          code: 'UNKNOWN_EVIDENCE_ID',
          path: `${base}.evidenceIds[${j}]`,
          value: id,
          details: `This ID does not exist upstream. Valid IDs: ${validIds}.`,
        });
      }
    });

    const claim = [tc.title, tc.expectedResult, ...tc.steps.map((s) => `${s.action} ${s.expected}`)].join(' ');
    checkOverlap(claim, evidenceTexts, `${base}`, tc.evidenceIds, errors);

    const fields: [string, string][] = [
      [`${base}.title`, tc.title],
      [`${base}.expectedResult`, tc.expectedResult],
      [`${base}.automationReason`, tc.automationReason],
      ...tc.preconditions.map((p, j): [string, string] => [`${base}.preconditions[${j}]`, p]),
      ...tc.steps.flatMap((s, j): [string, string][] => [
        [`${base}.steps[${j}].action`, s.action],
        [`${base}.steps[${j}].expected`, s.expected],
      ]),
    ];
    const credentials = credentialValues(tc.testData);
    for (const [path, text] of fields) {
      checkFacts(text, path, corpus, errors, credentials);
      checkEmails(text, path, corpus, errors);
      checkContradictions(text, path, discovery, errors);
    }
    checkTestData(tc.testData, `${base}.testData`, corpus, errors);
  });

  testCases.openQuestions.forEach((question, i) => {
    checkEmails(question, `openQuestions[${i}]`, corpus, errors);
    checkContradictions(question, `openQuestions[${i}]`, discovery, errors);
  });

  // The other direction: every test case being supported does not make a suite
  // complete. Each testable requirement must be demonstrated by some case, or
  // the analyst must have marked it `testable: false` with a reason.
  for (const requirement of testableRequirements(requirements)) {
    const covered = testCases.testCases.some((tc) => (tc?.covers ?? []).includes(requirement.id));
    if (!covered) {
      errors.push({
        code: 'UNCOVERED_ACCEPTANCE_POINT',
        path: '$.testCases',
        value: requirement.id,
        details: `"${clip(requirement.statement, 100)}" has no test case. Add one whose covers includes ${requirement.id}.`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Phase 1 end-state: automation prioritization and manual-suite review
// ---------------------------------------------------------------------------

/**
 * Counts derived from a prioritization. Used to check the reviewer's summary
 * and to report results; the single source of truth for "how many automated".
 */
export function summarize(prioritization: AutomationPrioritization): ReviewSummary {
  const auto = prioritization.cases.filter((c) => c.executionMode === 'AUTOMATION');
  return {
    total: prioritization.cases.length,
    manual: prioritization.cases.filter((c) => c.executionMode === 'MANUAL').length,
    automation: auto.length,
    automationHigh: auto.filter((c) => c.automationPriority === 'HIGH').length,
    automationMedium: auto.filter((c) => c.automationPriority === 'MEDIUM').length,
    automationLow: auto.filter((c) => c.automationPriority === 'LOW').length,
  };
}

/**
 * How many cases fall into each automation strategy, host-counted.
 *
 * Separate from `summarize()` on purpose — see `ReviewSummary`. Entries that
 * state no strategy are counted as 'UNSPECIFIED' rather than assigned one.
 */
export function strategySummary(prioritization: AutomationPrioritization): Record<string, number> {
  return (prioritization.cases ?? []).reduce<Record<string, number>>((acc, c) => {
    const key = c?.automationStrategy ?? 'UNSPECIFIED';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

/**
 * Structural invariants Phase 2 relies on. Every manual test case gets exactly
 * one entry; no entry points at a test case that does not exist; and the two
 * fields cannot contradict each other.
 */
/**
 * Which automation routes this run has actually SEEN evidence for.
 *
 * The rule the spec sets is "do not invent an API or visual-testing capability
 * if it has not been observed", so the host works out what was observed rather
 * than trusting a claim. Three independent signals, any one of which is enough:
 *
 *   - the analyst typed a requirement `API` or `CONTRACT` / `VISUAL`, which is
 *     itself evidence-checked one stage earlier;
 *   - the host's browser evidence recorded real HTTP requests, which proves
 *     there is an API surface to drive;
 *   - a repository analysis mentions an API surface (Phase 2 only).
 *
 * Nothing infers a capability from a test case's own wording: a case that
 * *says* "call the API" is the claim, not the evidence for it.
 */
export function observedCapabilities(input: {
  requirements?: RequirementsAnalysis;
  evidence?: { findings?: { type?: string; source?: string }[] };
}): { api: boolean; visual: boolean } {
  const items = [
    ...(input.requirements?.acceptancePoints ?? []),
    ...(input.requirements?.businessRules ?? []),
  ];
  const typed = new Set(items.map((i) => i.validationType).filter(Boolean) as string[]);

  // A recorded request — failed or not — proves requests are observable here.
  const sawRequests = (input.evidence?.findings ?? []).some(
    (f) => f?.type === 'REQUEST_FAILED' || f?.type === 'BROKEN_RESOURCE',
  );

  return {
    api: typed.has('API') || typed.has('CONTRACT') || sawRequests,
    visual: typed.has('VISUAL'),
  };
}

/** Strategies that are incompatible with each execution mode. */
const STRATEGY_CONFLICTS: Record<string, readonly AutomationStrategy[]> = {
  MANUAL: ['UI', 'API', 'UI_API', 'VISUAL'],
  AUTOMATION: ['MANUAL'],
};

export function validateAutomationPrioritization(
  testCases: TestCases,
  prioritization: AutomationPrioritization,
  discovery?: DiscoveredBehavior,
  requirements?: RequirementsAnalysis,
  capabilities?: { api: boolean; visual: boolean },
): SemanticError[] {
  const errors: SemanticError[] = [];
  const ids = testCases.testCases.map((tc) => tc.id);
  const known = new Set(ids);
  const counts = new Map<string, number>();

  prioritization.cases.forEach((entry, i) => {
    const base = `cases[${i}]`;
    counts.set(entry.testCaseId, (counts.get(entry.testCaseId) ?? 0) + 1);

    if (!known.has(entry.testCaseId)) {
      errors.push({
        code: 'UNKNOWN_TEST_CASE',
        path: `${base}.testCaseId`,
        value: entry.testCaseId,
        details: `No test case has this ID. Test case IDs: ${ids.join(', ') || '(none)'}.`,
      });
    }
    if (entry.executionMode === 'MANUAL' && entry.automationPriority === 'HIGH') {
      errors.push({
        code: 'INCONSISTENT_PRIORITY',
        path: `${base}.automationPriority`,
        value: `${entry.executionMode}/${entry.automationPriority}`,
        details: 'A MANUAL case cannot have HIGH automation priority. Use NONE, or change executionMode to AUTOMATION.',
      });
    }
    if (entry.executionMode === 'AUTOMATION' && entry.automationPriority === 'NONE') {
      errors.push({
        code: 'INCONSISTENT_PRIORITY',
        path: `${base}.automationPriority`,
        value: `${entry.executionMode}/${entry.automationPriority}`,
        details: 'An AUTOMATION case needs HIGH, MEDIUM, or LOW priority. Use NONE only with MANUAL.',
      });
    }

    const strategy = entry.automationStrategy;
    if (strategy !== undefined) {
      // The strategy answers "through what", the mode answers "automated at
      // all". They are separate judgements, but they cannot disagree.
      if ((STRATEGY_CONFLICTS[entry.executionMode] ?? []).includes(strategy)) {
        errors.push({
          code: 'CONTRADICTORY_STRATEGY',
          path: `${base}.automationStrategy`,
          value: `${entry.executionMode}/${strategy}`,
          details:
            entry.executionMode === 'MANUAL'
              ? `A MANUAL case cannot have a ${strategy} automation strategy. Use MANUAL or UNKNOWN, or set executionMode to AUTOMATION.`
              : 'An AUTOMATION case cannot have a MANUAL strategy. Pick the route it would be automated through, or UNKNOWN.',
        });
      }

      // Capabilities are only checked when the host worked them out; a run
      // without that context skips the check rather than guessing.
      if (capabilities !== undefined) {
        if ((strategy === 'API' || strategy === 'UI_API') && !capabilities.api) {
          errors.push({
            code: 'UNSUPPORTED_STRATEGY',
            path: `${base}.automationStrategy`,
            value: strategy,
            details:
              'No API surface was observed in this run — no requirement is typed API or CONTRACT and no HTTP ' +
              'request was recorded. Use UI for what was actually observed, or UNKNOWN. Do not assume an API exists.',
          });
        }
        if (strategy === 'VISUAL' && !capabilities.visual) {
          errors.push({
            code: 'UNSUPPORTED_STRATEGY',
            path: `${base}.automationStrategy`,
            value: strategy,
            details:
              'No requirement was typed VISUAL, so nothing upstream says appearance must be compared. ' +
              'Use UI, or UNKNOWN.',
          });
        }
      }
    }
  });

  for (const [id, n] of counts) {
    if (n > 1 && known.has(id)) {
      errors.push({
        code: 'DUPLICATE_PRIORITIZATION',
        path: 'cases',
        value: id,
        details: `${id} has ${n} entries. Every test case gets exactly one.`,
      });
    }
  }
  for (const id of ids) {
    if (!counts.has(id)) {
      errors.push({
        code: 'MISSING_PRIORITIZATION',
        path: 'cases',
        value: id,
        details: `${id} has no entry. Every test case must be prioritized — MANUAL cases too; none may be dropped.`,
      });
    }
  }

  // Reasons are judgements, so only hard facts are checked: an invented route
  // or account is still wrong even inside a rationale.
  const corpus = buildCorpus(discovery, requirements, testCases.testCases.flatMap(testCaseTexts));
  prioritization.cases.forEach((entry, i) => {
    for (const [path, text] of [[`cases[${i}].reason`, entry.reason], ...entry.blockingFactors.map((b, j): [string, string] => [`cases[${i}].blockingFactors[${j}]`, b])] as [string, string][]) {
      checkRoutes(text, path, corpus, errors);
      checkEmails(text, path, corpus, errors);
    }
  });

  return errors;
}

/**
 * The reviewer proposes; it never decides. So this checks only that the review
 * talks about real test cases, that its numbers are true, and that its verdict
 * is consistent with its own findings. Review prose is not fact-checked: a
 * reviewer flagging an invented route necessarily has to mention it.
 */
export function validateTestCasesReview(
  testCases: TestCases,
  prioritization: AutomationPrioritization | undefined,
  review: TestCasesReview,
): SemanticError[] {
  const errors: SemanticError[] = [];
  const known = new Set(testCases.testCases.map((tc) => tc.id));
  const validIds = [...known, SUITE_ID].join(', ');

  const refs: [string, string][] = [
    ...review.issues.map((x, i): [string, string] => [`issues[${i}].testCaseId`, x.testCaseId]),
    ...review.suggestedChanges.map((x, i): [string, string] => [`suggestedChanges[${i}].testCaseId`, x.testCaseId]),
  ];
  for (const [path, id] of refs) {
    if (id !== SUITE_ID && !known.has(id)) {
      errors.push({
        code: 'UNKNOWN_TEST_CASE',
        path,
        value: id,
        details: `No test case has this ID. Use one of: ${validIds} ("${SUITE_ID}" for suite-wide findings).`,
      });
    }
  }

  if (prioritization === undefined) {
    errors.push({ code: 'MISSING_UPSTREAM', path: 'summary', details: 'automation-prioritization does not exist yet. Stop and report this.' });
  } else {
    const actual = summarize(prioritization);
    for (const key of Object.keys(actual) as (keyof ReviewSummary)[]) {
      if (review.summary[key] !== actual[key]) {
        errors.push({
          code: 'SUMMARY_MISMATCH',
          path: `summary.${key}`,
          value: String(review.summary[key]),
          details: `The prioritization gives ${key} = ${actual[key]}. Use exactly: ${JSON.stringify(actual)}.`,
        });
      }
    }
  }

  const serious = review.issues.filter((x) => x.severity === 'BLOCKER' || x.severity === 'MAJOR');
  if (review.status === 'APPROVED' && serious.length > 0) {
    errors.push({
      code: 'INCONSISTENT_STATUS',
      path: 'status',
      value: 'APPROVED',
      details: `${serious.length} BLOCKER/MAJOR issue(s) are listed. Use CHANGES_REQUESTED, or downgrade them if they are not serious.`,
    });
  }
  if (review.status === 'CHANGES_REQUESTED' && review.issues.length === 0 && review.suggestedChanges.length === 0) {
    errors.push({
      code: 'INCONSISTENT_STATUS',
      path: 'status',
      value: 'CHANGES_REQUESTED',
      details: 'No issues or suggested changes are listed. Say what should change, or use APPROVED.',
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Formatting for the agent
// ---------------------------------------------------------------------------

/** Most fundamental first: an unresolvable ID or a missing upstream makes the rest moot. */
const ORDER: SemanticErrorCode[] = [
  'MISSING_UPSTREAM',
  'UPSTREAM_INVALID',
  'UNKNOWN_EVIDENCE_ID',
  'UNKNOWN_BEHAVIOR_REFERENCE',
  'NOT_EVIDENCE',
  'MISSING_EVIDENCE',
  'EVIDENCE_MISMATCH',
  'CONTRADICTS_UPSTREAM',
  'FABRICATED_CREDENTIAL',
  'UNSUPPORTED_FACT',
  'UNKNOWN_TEST_CASE',
  'MISSING_PRIORITIZATION',
  'DUPLICATE_PRIORITIZATION',
  'INCONSISTENT_PRIORITY',
  'SUMMARY_MISMATCH',
  'INCONSISTENT_STATUS',
  'DUPLICATE_ID',
  'UNKNOWN_AREA',
  'UNKNOWN_PATH',
  'BAD_PATH',
  'DUPLICATE_PATH',
  'UNKNOWN_SCRIPT',
  'UNKNOWN_DEPENDENCY',
  'EMPTY_ANALYSIS',
  'NOT_A_LITERAL',
  'UNEXPLORED_DIRECTORY',
  'UNINSPECTED_DIRECTORY',
  'UNEXPLORED_LOCATION',
  'UNKNOWN_OBSERVATION',
  'UNACCOUNTED_OBSERVATION',
  'UNANALYZED_BEHAVIOR',
  'CONTRADICTORY_VALIDATION_TYPE',
  'COVERAGE_NOT_EVIDENCED',
  'CONTRADICTORY_STRATEGY',
  'UNSUPPORTED_STRATEGY',
  'UNCOVERED_ACCEPTANCE_POINT',
  'MISSING_COVERAGE',
  'UNKNOWN_LOCATION',
  'UNKNOWN_COVERAGE_ID',
];

/** One fix instruction per rule, so it is said once rather than on every line. */
const HOW_TO_FIX: Record<SemanticErrorCode, string> = {
  MISSING_UPSTREAM: 'An input artifact is missing. You cannot fix this — stop and report it.',
  UPSTREAM_INVALID: 'An input artifact is inconsistent. You cannot fix this — stop and report it.',
  UNKNOWN_EVIDENCE_ID: 'cite only IDs that exist upstream',
  NOT_EVIDENCE: 'cite observed evidence, not questions, suspicions, or inferences',
  MISSING_EVIDENCE: 'cite the supporting ID(s), or move the point to openQuestions',
  EVIDENCE_MISMATCH: 'cite the behavior that actually supports the claim, or move it to openQuestions',
  CONTRADICTS_UPSTREAM: 'remove the statement, or scope it to the specific state where it holds',
  FABRICATED_CREDENTIAL: 'replace with a placeholder: VALID_USERNAME, VALID_PASSWORD, INVALID_PASSWORD',
  UNSUPPORTED_FACT: 'remove it, describe the outcome generically, or move it to openQuestions',
  DUPLICATE_ID: 'give every item a unique ID',
  UNKNOWN_AREA: 'use one of the declared area names',
  UNKNOWN_TEST_CASE: 'reference only test case IDs that exist in test-cases',
  MISSING_PRIORITIZATION: 'add exactly one entry for every test case, MANUAL ones included',
  DUPLICATE_PRIORITIZATION: 'keep exactly one entry per test case',
  INCONSISTENT_PRIORITY: 'MANUAL pairs with NONE; AUTOMATION pairs with HIGH, MEDIUM, or LOW',
  SUMMARY_MISMATCH: 'copy the counts exactly as given',
  INCONSISTENT_STATUS: 'make status agree with the issues you listed',
  UNKNOWN_PATH: 'name only paths you actually opened or listed in the repository',
  BAD_PATH: 'use a path relative to the repository root, with no ".." and no leading "/"',
  DUPLICATE_PATH: 'describe each path once',
  UNKNOWN_SCRIPT: 'name only scripts present in the repository package.json',
  UNKNOWN_DEPENDENCY: 'name only packages present in the repository package.json',
  EMPTY_ANALYSIS: 'Record what you actually found.',
  NOT_A_LITERAL: 'write the literal default value, or omit the field',
  UNEXPLORED_DIRECTORY: 'Open these directories and describe them in layout.',
  UNINSPECTED_DIRECTORY: 'Name a real file inside each of these.',
  UNKNOWN_COVERAGE_ID: 'covers must name acceptance point or business rule IDs that exist',
  MISSING_COVERAGE: 'say which requirement each test case demonstrates',
  UNCOVERED_ACCEPTANCE_POINT: 'Every testable requirement needs a test case. Add one for each ID below.',
  UNEXPLORED_LOCATION: 'Account for every location below: VISITED, or UNREACHABLE/SKIPPED with a reason.',
  UNKNOWN_LOCATION: 'report only locations the browser actually offered',
  UNACCOUNTED_OBSERVATION: 'Every observation you recorded must reach a behavior, or be excluded with a reason.',
  UNANALYZED_BEHAVIOR:
    'Every discovered behavior must be cited as evidence by a requirement, or listed in excludedBehaviors with a reason.',
  UNKNOWN_BEHAVIOR_REFERENCE: 'An excluded behavior ID must exist in discovery and must not also be cited as evidence.',
  CONTRADICTORY_VALIDATION_TYPE: 'A requirement marked not testable cannot also claim an automatable validation route.',
  COVERAGE_NOT_EVIDENCED:
    'A case may only claim to cover a requirement whose evidence it actually cites. Split the scenario, or cite the evidence.',
  CONTRADICTORY_STRATEGY: 'An automation strategy may not contradict the execution mode.',
  UNSUPPORTED_STRATEGY: 'A strategy may only name a capability this run actually observed.',
  UNKNOWN_OBSERVATION: 'cite only observation ids the ledger actually holds',
};

// ---------------------------------------------------------------------------
// repo-analysis (Phase 2, stage 1)
// ---------------------------------------------------------------------------

/** Repo-relative, no escapes, no absolute paths — the same contract the repo tools enforce. */
function pathProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return 'must be a non-empty repo-relative path';
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(value)) return 'must be relative to the repository root, not absolute';
  if (value.split(/[\\/]/).includes('..')) return 'must not contain ".."';
  return undefined;
}

/** Strip a leading "./" and any trailing slash so "./tests/" and "tests" compare equal. */
function normalisePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Every path, script and dependency the analysis names must exist in the target
 * repository. This is the Phase 1 evidence rule carried into Phase 2: the point
 * of repo-analysis is to tell the Automation Generator how THIS repository
 * works, and a plausible-but-invented path is worse than no analysis at all.
 *
 * Prose fields (`purpose`, `rule`, `risks`, `unknowns`) are deliberately not
 * fact-checked — they are judgements about code the agent did read, and the
 * fixed-vocabulary rules used in Phase 1 would reject reasonable wording.
 */
export function validateRepoAnalysis(analysis: RepoAnalysis, facts: RepoFacts): SemanticError[] {
  const errors: SemanticError[] = [];

  if (!facts.rootExists) {
    return [
      {
        code: 'MISSING_UPSTREAM',
        path: '$',
        details:
          'The target repository does not exist at the configured root. This is a host configuration ' +
          'problem you cannot fix: report it and stop.',
      },
    ];
  }

  /** One path claim: well-formed, and actually present in the repository. */
  const checkPath = (raw: unknown, where: string, expectDirectory = false) => {
    const problem = pathProblem(raw);
    if (problem !== undefined) {
      errors.push({ code: 'BAD_PATH', path: where, value: typeof raw === 'string' ? raw : String(raw), details: problem });
      return;
    }
    const value = normalisePath(raw as string);
    if (value.length === 0 || value === '.') return;
    if (!facts.exists(value)) {
      errors.push({ code: 'UNKNOWN_PATH', path: where, value, details: 'no such file or directory in the repository' });
      return;
    }
    if (expectDirectory && !facts.isDirectory(value)) {
      errors.push({ code: 'BAD_PATH', path: where, value, details: 'is a file, but this field names a directory' });
    }
  };

  const layout = Array.isArray(analysis.layout) ? analysis.layout : [];
  const seen = new Map<string, number>();
  layout.forEach((entry, i) => {
    checkPath(entry?.path, `layout[${i}].path`);
    const key = typeof entry?.path === 'string' ? normalisePath(entry.path).toLowerCase() : undefined;
    if (key !== undefined) {
      const first = seen.get(key);
      if (first !== undefined) {
        errors.push({
          code: 'DUPLICATE_PATH',
          path: `layout[${i}].path`,
          value: entry.path,
          details: `already described by layout[${first}]`,
        });
      } else {
        seen.set(key, i);
      }
    }
    (entry?.examples ?? []).forEach((example, j) => checkPath(example, `layout[${i}].examples[${j}]`));
  });

  (analysis.keyFiles ?? []).forEach((file, i) => checkPath(file?.path, `keyFiles[${i}].path`));
  (analysis.conventions ?? []).forEach((c, i) => checkPath(c?.evidencePath, `conventions[${i}].evidencePath`));

  // Observed in the first live run: the agent copied `process.env.BASE_URL ??
  // 'http://localhost:4444'` straight out of the config. True, but not a value
  // the Automation Generator can use. Fields that name a value must hold one.
  const baseURL = analysis.playwright?.baseURL;
  if (typeof baseURL === 'string' && /process\.env|\?\?|\$\{|`|import\.meta/.test(baseURL)) {
    errors.push({
      code: 'NOT_A_LITERAL',
      path: 'playwright.baseURL',
      value: baseURL,
      details: 'this is the expression from the config, not a value',
    });
  }

  if (analysis.playwright?.configPath !== undefined) checkPath(analysis.playwright.configPath, 'playwright.configPath');
  if (analysis.playwright?.testDir !== undefined) checkPath(analysis.playwright.testDir, 'playwright.testDir', true);
  if (analysis.typescript?.configPath !== undefined) checkPath(analysis.typescript.configPath, 'typescript.configPath');

  // package.json is the authority on script and dependency names. When the repo
  // has none, skip rather than reject: not every repository is a Node package.
  if (facts.scripts !== undefined) {
    (analysis.scripts ?? []).forEach((script, i) => {
      if (typeof script?.name === 'string' && !facts.scripts!.has(script.name)) {
        errors.push({
          code: 'UNKNOWN_SCRIPT',
          path: `scripts[${i}].name`,
          value: script.name,
          details: 'not a script in the repository package.json',
        });
      }
    });
  }
  if (facts.dependencies !== undefined) {
    (analysis.dependencies ?? []).forEach((dep, i) => {
      if (typeof dep?.name === 'string' && !facts.dependencies!.has(dep.name)) {
        errors.push({
          code: 'UNKNOWN_DEPENDENCY',
          path: `dependencies[${i}].name`,
          value: dep.name,
          details: 'not in dependencies or devDependencies of the repository package.json',
        });
      }
    });
  }

  // ---- completeness -------------------------------------------------------
  //
  // The rules above prove that what the analysis says is true. These two prove
  // it looked. Both are deterministic: a fixed list of directory names, and
  // "did you name a file inside it". Neither infers what a directory *is*.

  /** Anything the analysis said about this path, anywhere a path can appear. */
  const mentions = (dir: string): boolean => {
    const needle = dir.toLowerCase();
    const inPaths = (value: unknown) => {
      if (typeof value !== 'string') return false;
      const p = normalisePath(value).toLowerCase();
      return p === needle || p.startsWith(needle + '/') || needle.startsWith(p + '/');
    };
    if (layout.some((e) => inPaths(e?.path))) return true;
    if ((analysis.keyFiles ?? []).some((f) => inPaths(f?.path))) return true;
    // The escape hatch: say in `unknowns` why a directory was not described.
    return (analysis.unknowns ?? []).some((u) => typeof u === 'string' && u.toLowerCase().includes(needle));
  };

  for (const dir of facts.automationDirectories) {
    if (!mentions(dir)) {
      errors.push({
        code: 'UNEXPLORED_DIRECTORY',
        path: '$.layout',
        value: dir,
        details: `"${dir}/" holds automation but the analysis never describes it. List it, read a file in it, and add a layout entry — or say in unknowns why you did not.`,
      });
    }
  }

  // A directory whose kind promises content the next agent will copy from has
  // to name a real file inside it. Listing a directory is not reading one.
  const MUST_SHOW_A_FILE = new Set(['testDir', 'pageObjects', 'fixtures', 'apiClients', 'testData', 'auth']);
  layout.forEach((entry, i) => {
    if (typeof entry?.path !== 'string' || !MUST_SHOW_A_FILE.has(entry?.kind)) return;
    const dir = normalisePath(entry.path);
    if (!facts.exists(dir) || !facts.isDirectory(dir) || !facts.hasFiles(dir)) return;

    const insideDir = (value: unknown) =>
      typeof value === 'string' &&
      normalisePath(value).toLowerCase().startsWith(dir.toLowerCase() + '/') &&
      facts.exists(normalisePath(value)) &&
      !facts.isDirectory(normalisePath(value));

    const shown =
      (entry.examples ?? []).some(insideDir) ||
      (analysis.conventions ?? []).some((c) => insideDir(c?.evidencePath)) ||
      (analysis.keyFiles ?? []).some((f) => insideDir(f?.path)) ||
      (analysis.unknowns ?? []).some((u) => typeof u === 'string' && u.toLowerCase().includes(dir.toLowerCase()));

    if (!shown) {
      errors.push({
        code: 'UNINSPECTED_DIRECTORY',
        path: `layout[${i}].examples`,
        value: dir,
        details: `you call "${dir}/" ${entry.kind} but name no file inside it. Read one and cite it here, in a convention's evidencePath, or in keyFiles.`,
      });
    }
  });

  // A analysis that names nothing is not an analysis. Unknowns alone are fine
  // only if the agent genuinely found an empty repository — which it did not,
  // because the root exists and it was asked to look.
  if (layout.length === 0 && (analysis.keyFiles ?? []).length === 0) {
    errors.push({
      code: 'EMPTY_ANALYSIS',
      path: '$',
      details:
        'layout and keyFiles are both empty, so this says nothing about the repository. List the ' +
        'directories and files you actually read with list_repo_directory and read_repo_file.',
    });
  }

  return errors;
}

/** Rules whose per-item details carry information the group hint does not. */
const SPECIFIC = new Set<SemanticErrorCode>([
  'EMPTY_ANALYSIS',
  'UNEXPLORED_DIRECTORY',
  'UNINSPECTED_DIRECTORY',
  'NOT_A_LITERAL',
  'BAD_PATH',
  'DUPLICATE_PATH',
  'SUMMARY_MISMATCH',
  'INCONSISTENT_STATUS',
  'MISSING_UPSTREAM',
  'UPSTREAM_INVALID',
  'NOT_EVIDENCE',
  'EVIDENCE_MISMATCH',
  'CONTRADICTS_UPSTREAM',
  'UNKNOWN_AREA',
]);

const MAX_REPORTED = 24;

function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * Grouped by rule with one fix instruction per group, so an 8192-token model
 * can see every distinct problem in one pass instead of discovering them over
 * several retries. Repeats of the same (rule, value) collapse to one line.
 */
export function formatSemanticErrors(artifact: string, errors: SemanticError[]): string {
  const seen = new Set<string>();
  const unique = errors.filter((e) => {
    const key = `${e.code}|${(e.value ?? e.path).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const blocks: string[] = [];
  let shown = 0;
  for (const code of ORDER) {
    const group = unique.filter((e) => e.code === code);
    if (group.length === 0) continue;

    let hint = HOW_TO_FIX[code];
    if (code === 'UNKNOWN_EVIDENCE_ID') {
      const valid = group[0].details?.match(/Valid[^:]*: (.+?)\.?$/)?.[1];
      if (valid) hint += `: ${valid}`;
    }

    const lines: string[] = [];
    for (const e of group) {
      if (shown >= MAX_REPORTED) break;
      const value = e.value === undefined ? '' : ` = ${JSON.stringify(clip(e.value))}`;
      const detail = SPECIFIC.has(code) && e.details ? `\n      ${e.details}` : '';
      lines.push(`  - ${e.path}${value}${detail}`);
      shown += 1;
    }
    if (lines.length > 0) blocks.push(`${code} — ${hint}\n${lines.join('\n')}`);
  }

  const more = unique.length > shown ? `\n\n...and ${unique.length - shown} more of the kinds above.` : '';
  return (
    `"${artifact}" is schema-valid but not supported by upstream evidence, so nothing was written ` +
    `(${unique.length} problem${unique.length === 1 ? '' : 's'}):\n\n${blocks.join('\n\n')}${more}\n\n` +
    'Fix every item and call write_qa_artifact again with the complete corrected object.'
  );
}
