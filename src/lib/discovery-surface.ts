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

export type LocationStatus = 'PENDING' | 'VISITED' | 'UNREACHABLE' | 'SKIPPED';

export interface SurfaceLocation {
  /** Absolute, normalised URL. */
  url: string;
  /** How it was found: the entry page, or a later snapshot. */
  discoveredFrom: string;
  /** Host-assigned when the surface is built; SKIPPED for unsafe links. */
  status: LocationStatus;
  /** Why a location was skipped before the agent saw it. */
  reason?: string;
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
}

export const SURFACE_FILE = 'discovery-surface.json';
export const surfacePath = () => join(QA_ARTIFACT_ROOT, SURFACE_FILE);

/**
 * One canonical form per location, so `/notes`, `/notes/`, `/notes#top` and
 * `/notes?` are one entry rather than four. The query string is kept: it
 * frequently selects a genuinely different view.
 */
export function normaliseUrl(raw: string, base: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  // `new URL('/x?')` keeps a bare '?' in toString(); clearing search drops it.
  if (url.search === '' || url.search === '?') url.search = '';
  return url.toString();
}

/**
 * Would following this link end the session or change data?
 *
 * Separators are squashed on both sides, so "Log out", "log-out" and "logout"
 * are one thing. This errs towards caution: a false positive costs a SKIPPED
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
 * SKIPPED so the agent records them without following them.
 */
export function buildSurface(target: string, snapshot: string, now = new Date()): DiscoverySurface {
  const entry = normaliseUrl(target, target);
  if (entry === undefined) throw new Error(`TARGET_URL is not a usable URL: ${target}`);
  const origin = new URL(entry).origin;

  const locations: SurfaceLocation[] = [
    { url: entry, discoveredFrom: 'TARGET_URL', status: 'PENDING' },
  ];
  const seen = new Set([entry]);
  const externalOrigins = new Set<string>();
  let overflow = 0;

  for (const link of extractLinks(snapshot)) {
    const url = normaliseUrl(link.url, entry);
    if (url === undefined) continue;
    if (new URL(url).origin !== origin) {
      externalOrigins.add(new URL(url).origin);
      continue;
    }
    if (seen.has(url)) continue;
    if (locations.length >= MAX_LOCATIONS) {
      overflow += 1;
      seen.add(url);
      continue;
    }
    seen.add(url);
    const unsafe = isUnsafe(url, link.name);
    locations.push({
      url,
      discoveredFrom: entry,
      status: unsafe ? 'SKIPPED' : 'PENDING',
      reason: unsafe,
    });
  }

  return {
    target: entry,
    origin,
    createdAt: now.toISOString(),
    locations,
    overflow,
    externalOrigins: [...externalOrigins].sort(),
  };
}

/**
 * Add a location found during exploration, if it is in scope and there is room.
 * Returns the entry when it was added — the surface grows as the agent learns.
 */
export function expandSurface(surface: DiscoverySurface, rawUrl: string, from: string, linkName = ''): SurfaceLocation | undefined {
  const url = normaliseUrl(rawUrl, surface.target);
  if (url === undefined) return undefined;
  if (new URL(url).origin !== surface.origin) {
    if (!surface.externalOrigins.includes(new URL(url).origin)) {
      surface.externalOrigins.push(new URL(url).origin);
      surface.externalOrigins.sort();
    }
    return undefined;
  }
  if (surface.locations.some((l) => l.url === url)) return undefined;
  if (surface.locations.length >= MAX_LOCATIONS) {
    surface.overflow += 1;
    return undefined;
  }
  const unsafe = isUnsafe(url, linkName);
  const entry: SurfaceLocation = { url, discoveredFrom: from, status: unsafe ? 'SKIPPED' : 'PENDING', reason: unsafe };
  surface.locations.push(entry);
  return entry;
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
    l.status === 'SKIPPED' ? `- ${l.url}  (pre-skipped: ${l.reason})` : `- ${l.url}`,
  );
  const extras: string[] = [];
  if (surface.overflow > 0) extras.push(`${surface.overflow} further same-origin link(s) were found but are beyond this run's cap of ${MAX_LOCATIONS}.`);
  if (surface.externalOrigins.length > 0) extras.push(`External origins seen and deliberately not explored: ${surface.externalOrigins.join(', ')}.`);
  return `${lines.join('\n')}${extras.length ? `\n\n${extras.join(' ')}` : ''}`;
}
