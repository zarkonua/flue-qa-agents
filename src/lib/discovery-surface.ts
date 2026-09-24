// The product surface Product Discovery is expected to account for.
//
// The same pattern the Repo Analyzer and the Test Designer already follow:
//
//     known relevant surface  ->  inspect it, or say why not
//
// Host code establishes the surface deterministically from what the browser
// actually rendered — the `/url:` entries Playwright's accessibility snapshot
// emits for links — and the validator later requires every entry to have
// reached a terminal state. The model never invents a location, and never
// decides that it has seen enough.
//
// Bounded on purpose: same origin only, a cap on locations, and obviously
// destructive or session-ending links excluded rather than clicked.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QA_ARTIFACT_ROOT } from './qa-artifacts.ts';
import { auxiliaryOrigins } from '../config/auxiliary-origins.ts';
import { locationIdentity } from './redaction.ts';
import {
  MAX_STATES,
  MAX_STATES_PER_LOCATION,
  stateSignature,
  type DiscoveryState,
} from './discovery-state.ts';

/** How many product locations one discovery run is asked to account for. */
export const MAX_LOCATIONS = 12;

/**
 * Link text or paths that end a session or change data. Discovery is
 * observational: it records that these exist rather than following them.
 * Matched case-insensitively against both the URL path and the link's name.
 */
const UNSAFE = [
  'logout', 'log-out', 'sign-out', 'signout',
  'delete', 'remove', 'destroy', 'revoke',
  'purchase', 'checkout', 'pay', 'buy', 'subscribe',
  'unsubscribe', 'cancel-account', 'close-account',
];

export type LocationStatus = 'PENDING' | 'EXPLORED' | 'BLOCKED' | 'SKIPPED_WITH_REASON';

/** Product origin, or a host-configured support system such as a test mailbox. */
export type LocationKind = 'PRODUCT' | 'AUXILIARY';

export interface SurfaceLocation {
  /** Absolute, normalised URL. */
  url: string;
  /** How it was found: the entry page, or a later snapshot. */
  discoveredFrom: string;
  /** Host-assigned when the surface is built; SKIPPED_WITH_REASON for unsafe links. */
  status: LocationStatus;
  /** Why a location was skipped before the agent saw it. */
  reason?: string;
  /** The product itself, or configured support infrastructure. */
  kind: LocationKind;
  /** Parameter names seen on this route. Values never take part in identity. */
  queryParameters?: string[];
  /** True when a parameter name marked its value secret or one-time. */
  containsSensitiveTransientData?: boolean;
}

export interface DiscoverySurface {
  target: string;
  origin: string;
  createdAt: string;
  /** Locations the run is expected to account for, entry page first. */
  locations: SurfaceLocation[];
  /** Same-origin links found but dropped because the cap was reached. */
  overflow: number;
  /** Distinct external origins seen. Recorded, never explored. */
  externalOrigins: string[];
  /** Configured support origins this run may visit. */
  auxiliaryOrigins?: string[];
  /** Distinct product states observed, keyed by signature. */
  states?: DiscoveryState[];
  /** States dropped because a cap was reached. */
  stateOverflow?: number;
}

export const SURFACE_FILE = 'discovery-surface.json';
export const surfacePath = () => join(QA_ARTIFACT_ROOT, SURFACE_FILE);

/**
 * One canonical identity per location.
 *
 * `/notes`, `/notes/`, `/notes#top` and `/notes?code=1` are one entry. Query
 * *values* are deliberately not part of identity: a confirmation link differs
 * on every run, and keying on it made one flow mint a new location each time —
 * consuming the budget and demanding terminal states for pages that never
 * existed. Parameter names survive on the location record; see `redaction.ts`.
 */
export function normaliseUrl(raw: string, base: string): string | undefined {
  return locationIdentity(raw, base)?.url;
}

/**
 * Would following this link end the session or change data?
 *
 * Separators are squashed on both sides, so "Log out", "log-out" and "logout"
 * are one thing. This errs towards caution: a false positive costs a SKIPPED_WITH_REASON
 * location with a stated reason, which is still reported — a false negative
 * could log the run out or delete something.
 */
export function isUnsafe(url: string, linkName = ''): string | undefined {
  const squash = (v: string) => v.toLowerCase().replace(/[-_\s]+/g, '');
  const haystack = squash(`${url} ${linkName}`);
  const hit = UNSAFE.find((word) => haystack.includes(squash(word)));
  return hit ? `link looks session-ending or destructive ("${hit}")` : undefined;
}

/**
 * Pull link targets out of a Playwright MCP accessibility snapshot.
 *
 * The snapshot is YAML-ish text where a link contributes a `/url:` line, and
 * the preceding `link "Name"` line carries its accessible name. Parsed rather
 * than guessed: a URL the browser did not render is not a product location.
 */
export function extractLinks(snapshot: string): { url: string; name: string }[] {
  const out: { url: string; name: string }[] = [];
  const lines = snapshot.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-?\s*\/url:\s*(\S+)\s*$/.exec(lines[i]);
    if (!match) continue;
    // The owning element is the nearest preceding line that names one.
    let name = '';
    for (let j = i - 1; j >= 0 && j > i - 6; j -= 1) {
      const named = /^\s*-\s*\w+\s+"([^"]*)"/.exec(lines[j]);
      if (named) {
        name = named[1];
        break;
      }
    }
    out.push({ url: match[1], name });
  }
  return out;
}

/**
 * Build the surface from the entry page's snapshot.
 *
 * Same origin only, deduplicated, capped, with unsafe links pre-marked
 * SKIPPED_WITH_REASON so the agent records them without following them.
 */
export function buildSurface(target: string, snapshot: string, now = new Date()): DiscoverySurface {
  const entryId = locationIdentity(target, target);
  if (entryId === undefined) throw new Error(`TARGET_URL is not a usable URL: ${target}`);
  const entry = entryId.url;
  const origin = new URL(entry).origin;
  const aux = auxiliaryOrigins();

  const locations: SurfaceLocation[] = [
    {
      url: entry,
      discoveredFrom: 'TARGET_URL',
      status: 'PENDING',
      kind: 'PRODUCT',
      ...identityFields(entryId),
    },
  ];
  const seen = new Set([entry]);
  const externalOrigins = new Set<string>();
  let overflow = 0;

  for (const link of extractLinks(snapshot)) {
    const id = locationIdentity(link.url, entry);
    if (id === undefined) continue;
    const linkOrigin = new URL(id.url).origin;
    const kind = classifyOrigin(linkOrigin, origin, aux);
    if (kind === undefined) {
      externalOrigins.add(linkOrigin);
      continue;
    }
    if (seen.has(id.url)) continue;
    if (locations.length >= MAX_LOCATIONS) {
      overflow += 1;
      seen.add(id.url);
      continue;
    }
    seen.add(id.url);
    const unsafe = isUnsafe(id.url, link.name);
    locations.push({
      url: id.url,
      discoveredFrom: entry,
      status: unsafe ? 'SKIPPED_WITH_REASON' : 'PENDING',
      reason: unsafe,
      kind,
      ...identityFields(id),
    });
  }

  return {
    target: entry,
    origin,
    createdAt: now.toISOString(),
    locations,
    overflow,
    externalOrigins: [...externalOrigins].sort(),
    auxiliaryOrigins: aux,
    states: [],
    stateOverflow: 0,
  };
}

/** Only carry the identity extras that say something. */
function identityFields(id: { queryParameters: string[]; containsSensitiveTransientData: boolean }) {
  return {
    ...(id.queryParameters.length > 0 ? { queryParameters: id.queryParameters } : {}),
    ...(id.containsSensitiveTransientData ? { containsSensitiveTransientData: true } : {}),
  };
}

/**
 * Which surface an origin belongs to, or `undefined` when it belongs to
 * neither and must stay blocked. Auxiliary origins come only from host
 * configuration — the model never nominates one.
 */
export function classifyOrigin(origin: string, productOrigin: string, aux: readonly string[]): LocationKind | undefined {
  if (origin === productOrigin) return 'PRODUCT';
  if (aux.includes(origin)) return 'AUXILIARY';
  return undefined;
}

/**
 * Add a location found during exploration, if it is in scope and there is room.
 * Returns the entry when it was added — the surface grows as the agent learns.
 */
export function expandSurface(surface: DiscoverySurface, rawUrl: string, from: string, linkName = ''): SurfaceLocation | undefined {
  const id = locationIdentity(rawUrl, surface.target);
  if (id === undefined) return undefined;
  const origin = new URL(id.url).origin;
  const kind = classifyOrigin(origin, surface.origin, surface.auxiliaryOrigins ?? []);
  if (kind === undefined) {
    // Neither the product nor configured support infrastructure: recorded so
    // the run can say where it was offered a door it did not open.
    if (!surface.externalOrigins.includes(origin)) {
      surface.externalOrigins.push(origin);
      surface.externalOrigins.sort();
    }
    return undefined;
  }
  if (surface.locations.some((l) => l.url === id.url)) return undefined;
  if (surface.locations.length >= MAX_LOCATIONS) {
    surface.overflow += 1;
    return undefined;
  }
  const unsafe = isUnsafe(id.url, linkName);
  const entry: SurfaceLocation = {
    url: id.url,
    discoveredFrom: from,
    status: unsafe ? 'SKIPPED_WITH_REASON' : 'PENDING',
    reason: unsafe,
    kind,
    ...identityFields(id),
  };
  surface.locations.push(entry);
  return entry;
}

/**
 * Register the product state a snapshot shows, if it is new.
 *
 * This is what makes a sign-in count as discovery work. The route often does
 * not change across it; the set of controls on offer always does. Bounded by
 * `MAX_STATES` overall and `MAX_STATES_PER_LOCATION` per route, so a page whose
 * shape genuinely churns cannot mint an endless queue.
 */
export function registerState(
  surface: DiscoverySurface,
  locationUrl: string,
  snapshot: string,
  now = new Date(),
): DiscoveryState | undefined {
  const states = (surface.states ??= []);
  const { id, pathname, controls } = stateSignature(locationUrl, snapshot);
  // A page with no interactive controls at all is a dead end, not a state
  // worth demanding an account of.
  if (controls.length === 0) return undefined;
  if (states.some((s) => s.id === id)) return undefined;
  if (states.length >= MAX_STATES || states.filter((s) => s.location === locationUrl).length >= MAX_STATES_PER_LOCATION) {
    surface.stateOverflow = (surface.stateOverflow ?? 0) + 1;
    return undefined;
  }
  const state: DiscoveryState = {
    id,
    location: locationUrl,
    pathname,
    controls,
    status: 'PENDING',
    firstSeenAt: now.toISOString(),
  };
  states.push(state);
  return state;
}

/**
 * The page a browser result says the session is on.
 *
 * `@playwright/mcp` prefixes navigate and snapshot results with a `Page URL:`
 * line. Same parse as `scripts/lib/evidence.mjs` uses on the host side.
 */
export function currentPageUrl(text: string): string | undefined {
  const line = text.split('\n').find((l) => /^\s*-?\s*Page URL:/i.test(l));
  return line?.replace(/^\s*-?\s*Page URL:\s*/i, '').trim() || undefined;
}

/**
 * Fold what one browser result reveals into the surface: the page the session
 * is now on, and the same-origin links that page renders.
 *
 * This is what makes the surface grow past the entry page. Most of a real
 * application is behind a form — signing in, confirming a mail, opening a
 * panel — so the entry page's links are a floor, not the product. Without
 * this, an application whose landing page is a login form presents a surface
 * of exactly one location, and a model that does no more than account for it
 * has satisfied every host-enforced rule while seeing almost nothing.
 *
 * Pure: the caller decides whether to persist. Returns what was added, and the
 * existing `MAX_LOCATIONS` cap still bounds the run.
 */
export function absorbBrowserResult(surface: DiscoverySurface, text: string): SurfaceLocation[] {
  const added: SurfaceLocation[] = [];
  const page = currentPageUrl(text);
  if (page !== undefined) {
    const entry = expandSurface(surface, page, 'reached while exploring');
    if (entry) added.push(entry);
    // The same route can show an entirely different product either side of a
    // sign-in; the state ledger is what notices.
    const identity = locationIdentity(page, surface.target);
    if (identity !== undefined) registerState(surface, identity.url, text);
  }
  // Links resolve against the page that rendered them, not the entry page, so
  // a relative href on a sub-page lands where the browser would take it.
  const base = page ?? surface.target;
  for (const link of extractLinks(text)) {
    const absolute = normaliseUrl(link.url, base) ?? link.url;
    const entry = expandSurface(surface, absolute, page ?? 'entry page', link.name);
    if (entry) added.push(entry);
  }
  return added;
}

/** Locations the agent is expected to account for — the pre-skipped ones included. */
export function expectedLocations(surface: DiscoverySurface): string[] {
  return surface.locations.map((l) => l.url);
}

export function writeSurface(surface: DiscoverySurface): void {
  const path = surfacePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(surface, null, 2), 'utf8');
}

/** The surface for the current run, or undefined when the host never built one. */
export function readSurface(): DiscoverySurface | undefined {
  const path = surfacePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DiscoverySurface;
  } catch {
    return undefined;
  }
}

/** A short, model-readable list of what to account for. */
export function surfaceBriefing(surface: DiscoverySurface): string {
  const lines = surface.locations.map((l) =>
    l.status === 'SKIPPED_WITH_REASON' ? `- ${l.url}  (pre-skipped: ${l.reason})` : `- ${l.url}`,
  );
  const extras: string[] = [];
  if (surface.overflow > 0) extras.push(`${surface.overflow} further same-origin link(s) were found but are beyond this run's cap of ${MAX_LOCATIONS}.`);
  if (surface.externalOrigins.length > 0) extras.push(`External origins seen and deliberately not explored: ${surface.externalOrigins.join(', ')}.`);
  return `${lines.join('\n')}${extras.length ? `\n\n${extras.join(' ')}` : ''}`;
}
