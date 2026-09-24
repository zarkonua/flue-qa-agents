// Deterministic browser evidence: facts the host reads out of the browser,
// rather than things the model is asked to notice.
//
// Why the host collects this instead of the agent. Product Discovery reports
// what it *saw in a snapshot*; an accessibility tree says nothing about a
// console error, a 404 on a background image, or a request that never
// completed. Asking the model to notice those would make evidence a matter of
// attention, and — worse — a model asked "were there console errors?" can
// answer "no" without having looked. Silence is indistinguishable from
// absence. So the host looks, and the model never supplies these facts.
//
// How it is collected is constrained by two things measured in this repo:
//
//   1. @playwright/mcp isolates sessions. A second MCP client connection gets
//      its own browser context: it sees none of the agent's console or network
//      history. The host therefore cannot sweep up evidence after the agent
//      exits — it would read an empty context and report "no errors" as a fact.
//   2. Flue routes MCP tools through an internal adapter and refuses direct
//      invocation from host code, so the host cannot borrow the agent's
//      connection either.
//
// What remains, and what `scripts/lib/evidence.mjs` does: the host opens its
// OWN session and replays the locations discovery recorded as EXPLORED,
// collecting console and network facts per page load.
//
// The honest limitation, stated here because it belongs with the data: this
// captures PAGE-LOAD evidence per location. A console error thrown only when a
// form is submitted with bad input is not captured, because the host does not
// replay the agent's interactions. Findings are evidence of a real problem;
// their absence is not proof that a location is clean. `coverageNote()` puts
// that in the artifact so no downstream reader has to infer it.
//
// This module is pure: parsing, classification, deduplication and bounds. The
// MCP conversation lives in the script, so all of the logic below is testable
// without a browser.

/** A run's total findings cap — a guard against a pathological page, not a target. */
export const MAX_FINDINGS = 80;

/** Per-location cap, so one very noisy page cannot crowd out every other one. */
export const MAX_FINDINGS_PER_LOCATION = 20;

export type EvidenceType =
  | 'CONSOLE_ERROR'
  | 'CONSOLE_WARNING'
  | 'REQUEST_FAILED'
  | 'BROKEN_RESOURCE'
  | 'NAVIGATION_FAILED';

export interface EvidenceFinding {
  /** Host-assigned, sequential: EV-001, EV-002, … */
  id: string;
  type: EvidenceType;
  /** The location being inspected when this was collected. */
  location: string;
  detail: string;
  /** Where it came from: `url:line` for console, the request URL for network. */
  source?: string;
  /** HTTP status, for network findings. */
  status?: number;
  /** How many times this identical fact was seen. Deduplicated, not dropped. */
  occurrences: number;
  /**
   * True when this was collected at a URL carrying a one-time credential, so
   * the failure may be caused by replaying a spent token rather than by a
   * defect. Downstream must not treat it as confirmed broken behaviour.
   */
  replaySuspect?: boolean;
}

export interface EvidenceLocation {
  /** The URL the host asked for. */
  requestedUrl: string;
  /** Where the browser actually ended up — navigation state, not an assumption. */
  finalUrl?: string;
  /** The status of the main document request, when one was observed. */
  status?: number;
  /** True when the browser ended somewhere other than the requested URL. */
  redirected: boolean;
  /** False when the host could not collect here; `error` says why. */
  collected: boolean;
  error?: string;
  /** Set when the URL carries a one-time credential — see `singleUseParam`. */
  replayCaveat?: string;
}

export interface DiscoveryEvidence {
  runId: string;
  collectedAt: string;
  target: string;
  origin: string;
  locations: EvidenceLocation[];
  findings: EvidenceFinding[];
  totals: {
    consoleErrors: number;
    consoleWarnings: number;
    failedRequests: number;
    brokenResources: number;
    navigationFailures: number;
  };
  /** Findings refused because a cap was reached. Recorded, never silently dropped. */
  overflow: number;
  /** What this evidence does and does not cover. */
  coverageNote: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
//
// Both formats below are @playwright/mcp 0.0.82's rendered text, confirmed
// against a live server rather than assumed. If a future version changes them,
// these parsers yield nothing rather than nonsense. The tests pin the exact
// captured text, so a format change fails there — which matters, because at
// runtime it would otherwise look identical to a page with no problems.

export interface ConsoleMessage {
  level: string;
  message: string;
  source?: string;
}

/**
 * Parse `browser_console_messages` output.
 *
 * Lines look like:
 *
 *     [ERROR] Failed to load resource: … (Not Found) @ http://localhost:4444/x:0
 *
 * The message itself can contain " @ ", so the source is taken from the LAST
 * such separator, not the first.
 */
export function parseConsoleMessages(text: string): ConsoleMessage[] {
  const out: ConsoleMessage[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^\[([A-Z]+)\]\s+([\s\S]*)$/.exec(line);
    if (!match) continue;
    const level = match[1];
    let message = match[2].trim();
    let source: string | undefined;
    const at = message.lastIndexOf(' @ ');
    if (at !== -1) {
      const candidate = message.slice(at + 3).trim();
      // A source is a single token; anything with a space is still message text.
      if (candidate.length > 0 && !/\s/.test(candidate)) {
        source = candidate;
        message = message.slice(0, at).trim();
      }
    }
    if (message.length === 0) continue;
    out.push({ level, message, ...(source ? { source } : {}) });
  }
  return out;
}

export interface NetworkRequest {
  method: string;
  url: string;
  /** Absent when the request never produced a status (aborted, blocked, pending). */
  status?: number;
  statusText?: string;
}

/**
 * Parse `browser_network_requests` output.
 *
 * Lines look like:
 *
 *     1. [GET] http://localhost:4444/assets/app.js => [200] OK
 *
 * A request with no numeric status is kept with `status` undefined: a request
 * that never completed is evidence, and dropping it would hide it.
 */
export function parseNetworkRequests(text: string): NetworkRequest[] {
  const out: NetworkRequest[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^\d+\.\s*\[([A-Z]+)\]\s+(\S+)\s*=>\s*\[([^\]]*)\]\s*(.*)$/.exec(line);
    if (!match) continue;
    const statusRaw = match[3].trim();
    const status = /^\d+$/.test(statusRaw) ? Number(statusRaw) : undefined;
    const statusText = match[4].trim();
    out.push({
      method: match[1],
      url: match[2],
      ...(status !== undefined ? { status } : {}),
      ...(statusText ? { statusText } : {}),
    });
  }
  return out;
}

/**
 * Query parameters that carry a one-time credential.
 *
 * Replaying a URL that holds a spent token produces a real failure that is an
 * artifact of the replay, not a defect. The first live run of this collector
 * did exactly that: Product Discovery consumed a confirmation code, the host
 * replayed `/app?confirm_email=…&confirm_code=…`, and the resulting
 * `POST /api/auth/confirm -> 400` looked like a product bug. It is not one.
 *
 * Findings from such a location are still collected — the request really did
 * fail — but they are marked, so nothing downstream mistakes a consumed token
 * for broken behaviour.
 */
const SINGLE_USE_PARAMS = [
  'confirm_code', 'confirmation_code', 'code', 'token', 'otp',
  'nonce', 'ticket', 'signature', 'sig', 'invite', 'reset',
];

/** The single-use parameter a URL carries, when it carries one. */
export function singleUseParam(url: string): string | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return undefined;
  }
  for (const [key] of params) {
    const k = key.toLowerCase();
    if (SINGLE_USE_PARAMS.some((p) => k === p || k.endsWith(`_${p}`))) return key;
  }
  return undefined;
}

/** File extensions that make a request a page *resource* rather than an action. */
const STATIC_EXTENSIONS = [
  '.css', '.js', '.mjs', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.wav',
];

/** True when a URL points at a static resource, judged by its path extension. */
export function isStaticResource(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase().split('?')[0];
  }
  return STATIC_EXTENSIONS.some((ext) => path.endsWith(ext));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Console levels that are findings. Everything else is page noise. */
const REPORTABLE_LEVELS: Record<string, EvidenceType> = {
  ERROR: 'CONSOLE_ERROR',
  WARNING: 'CONSOLE_WARNING',
  WARN: 'CONSOLE_WARNING',
};

/** A finding before the host assigns an id and folds in duplicates. */
export type RawFinding = Omit<EvidenceFinding, 'id' | 'occurrences'>;

export function classifyConsole(messages: ConsoleMessage[], location: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const m of messages) {
    const type = REPORTABLE_LEVELS[m.level.toUpperCase()];
    if (type === undefined) continue;
    out.push({ type, location, detail: m.message, ...(m.source ? { source: m.source } : {}) });
  }
  return out;
}

export function classifyNetwork(requests: NetworkRequest[], location: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const r of requests) {
    if (r.status !== undefined && r.status < 400) continue;
    const type: EvidenceType = isStaticResource(r.url) ? 'BROKEN_RESOURCE' : 'REQUEST_FAILED';
    const detail =
      r.status === undefined
        ? `${r.method} ${r.url} did not complete`
        : `${r.method} ${r.url} returned ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
    out.push({ type, location, detail, source: r.url, ...(r.status !== undefined ? { status: r.status } : {}) });
  }
  return out;
}

/**
 * Drop the console echo of a failed request we already recorded from the
 * network log.
 *
 * A 404 on an image produces BOTH a network entry and a browser-generated
 * "Failed to load resource: …" console error naming the same URL. They are one
 * problem. The network entry is kept because it carries the method and status;
 * the console echo is removed. Only that specific browser-generated wording is
 * matched — an application's own console error about the same URL is a
 * different fact and survives.
 */
export function dropRedundantResourceEchoes(findings: RawFinding[]): RawFinding[] {
  const failedUrls = new Set(
    findings
      .filter((f) => f.type === 'BROKEN_RESOURCE' || f.type === 'REQUEST_FAILED')
      .map((f) => f.source)
      .filter((u): u is string => u !== undefined),
  );
  return findings.filter((f) => {
    if (f.type !== 'CONSOLE_ERROR') return true;
    if (!/^failed to load resource\b/i.test(f.detail)) return true;
    // The console source carries a `:line` suffix the network URL does not.
    const bare = f.source?.replace(/:\d+$/, '');
    return !(bare !== undefined && failedUrls.has(bare));
  });
}

// ---------------------------------------------------------------------------
// Deduplication and bounds
// ---------------------------------------------------------------------------

/**
 * The identity of a finding. Two findings are the same fact when they are the
 * same type, at the same location, about the same thing.
 *
 * Whitespace and case are normalised; nothing else is. Aggressive
 * normalisation (stripping digits, say) would merge "returned 404" with
 * "returned 500", which are different problems.
 */
export function fingerprint(f: RawFinding): string {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
  return [f.type, norm(f.location), norm(f.detail), norm(f.source ?? '')].join('|');
}

export interface Accumulated {
  findings: EvidenceFinding[];
  overflow: number;
}

/**
 * Fold raw findings into the deduplicated, bounded, id-assigned set.
 *
 * A repeat increments `occurrences` rather than adding a row — seeing the same
 * error on every page load is one problem observed many times. Ids are
 * assigned by the host in encounter order and are stable for a given input.
 */
export function markReplaySuspects(findings: RawFinding[], location: string): RawFinding[] {
  const param = singleUseParam(location);
  if (param === undefined) return findings;
  return findings.map((f) => ({ ...f, replaySuspect: true }));
}

export function accumulate(raw: RawFinding[], existing: Accumulated = { findings: [], overflow: 0 }): Accumulated {
  const byPrint = new Map<string, EvidenceFinding>();
  for (const f of existing.findings) byPrint.set(fingerprint(f), f);
  const perLocation = new Map<string, number>();
  for (const f of existing.findings) perLocation.set(f.location, (perLocation.get(f.location) ?? 0) + 1);

  let overflow = existing.overflow;
  const findings = [...existing.findings];

  for (const f of raw) {
    const print = fingerprint(f);
    const seen = byPrint.get(print);
    if (seen) {
      seen.occurrences += 1;
      continue;
    }
    const atLocation = perLocation.get(f.location) ?? 0;
    if (findings.length >= MAX_FINDINGS || atLocation >= MAX_FINDINGS_PER_LOCATION) {
      overflow += 1;
      continue;
    }
    const finding: EvidenceFinding = {
      id: `EV-${String(findings.length + 1).padStart(3, '0')}`,
      ...f,
      occurrences: 1,
    };
    findings.push(finding);
    byPrint.set(print, finding);
    perLocation.set(f.location, atLocation + 1);
  }

  return { findings, overflow };
}

/** Host-derived totals. Never supplied by a model, never stored as a ratio. */
export function totalsFor(findings: EvidenceFinding[]): DiscoveryEvidence['totals'] {
  const count = (type: EvidenceType) =>
    findings.filter((f) => f.type === type).reduce((sum, f) => sum + f.occurrences, 0);
  return {
    consoleErrors: count('CONSOLE_ERROR'),
    consoleWarnings: count('CONSOLE_WARNING'),
    failedRequests: count('REQUEST_FAILED'),
    brokenResources: count('BROKEN_RESOURCE'),
    navigationFailures: count('NAVIGATION_FAILED'),
  };
}

/**
 * The scope statement that travels with the artifact.
 *
 * Both caveats here are measured, not hypothetical. The second was found while
 * building this: the sample application answers 200 for `/account/notes` even
 * with no session and gates the page in client-side script, so a fresh host
 * session collects the logged-out view under the protected URL's name. Saying
 * so in the artifact is the difference between evidence and a misleading label.
 */
export function coverageNote(locationCount: number): string {
  return (
    `Page-load evidence for ${locationCount} location(s), collected by the host in its own browser ` +
    'session by navigating to each location discovery reported as visited. Two limits follow from ' +
    'that method. (1) It does NOT include evidence produced only by interaction — a console error ' +
    'raised when a form is submitted with invalid input will not appear here. (2) The host session ' +
    'is fresh and UNAUTHENTICATED, so for any location behind a sign-in this describes what an ' +
    'anonymous visitor receives, which may be a redirect or a logged-out view served under the ' +
    'same URL. A finding is evidence of a real problem; the absence of findings for a location is ' +
    'not proof that the location is free of problems.'
  );
}

/** Assemble the artifact. Every number here is derived, not reported. */
export function buildEvidence(input: {
  runId: string;
  target: string;
  origin: string;
  locations: EvidenceLocation[];
  accumulated: Accumulated;
  now?: Date;
}): DiscoveryEvidence {
  return {
    runId: input.runId,
    collectedAt: (input.now ?? new Date()).toISOString(),
    target: input.target,
    origin: input.origin,
    locations: input.locations,
    findings: input.accumulated.findings,
    totals: totalsFor(input.accumulated.findings),
    overflow: input.accumulated.overflow,
    coverageNote: coverageNote(input.locations.length),
  };
}

/** A one-line host summary for the run log. */
export function evidenceSummary(evidence: DiscoveryEvidence): string {
  const t = evidence.totals;
  const parts = [
    `${t.consoleErrors} console error(s)`,
    `${t.consoleWarnings} warning(s)`,
    `${t.failedRequests} failed request(s)`,
    `${t.brokenResources} broken resource(s)`,
  ];
  if (t.navigationFailures > 0) parts.push(`${t.navigationFailures} unreachable`);
  const tail = evidence.overflow > 0 ? `, ${evidence.overflow} beyond the cap` : '';
  return `${evidence.locations.length} location(s) -> ${parts.join(', ')}${tail}`;
}
