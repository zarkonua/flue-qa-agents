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
import { locationIdentity, redactText } from './redaction.ts';
import {
  MAX_STATES,
  MAX_STATES_PER_LOCATION,
  stateSignature,
  type DiscoveryState,
} from './discovery-state.ts';
import { authSignals, classifyBrowserAction, isAuthAction, isErrorResult, ranCode, type ActionKind } from './discovery-actions.ts';
import { controlNames, deltaCounts, diffViews, extractMessages, type DeltaCounts, type SurfaceDelta, type SurfaceView } from './discovery-delta.ts';

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
  /** State-changing browser actions, in order, and whether their outcome was observed. */
  actions?: ActionRecord[];
  /** The product state the most recent snapshot showed. */
  currentStateId?: string;
  /** Locations the host itself saw a snapshot of — what EXPLORED can be checked against. */
  observedLocations?: string[];
  /** Every finalization attempt the completion gate judged. See discovery-completion.ts. */
  completion?: CompletionLog;
  /** Every link target the browser rendered, and whether a state-changing action exposed it. */
  navigation?: NavigationTarget[];
  /** What the most recent inline snapshot showed — the "before" of the next delta. */
  lastView?: SurfaceView;
  /** Successful input into a form field, by product state. Evidence that an attempt was real. */
  inputs?: { stateId?: string; at: string }[];
}

/** Where a rendered link leads, relative to what this run may visit. */
export type NavigationScope = 'PRODUCT' | 'AUXILIARY' | 'EXTERNAL';

/**
 * A link target the browser rendered.
 *
 * `exposedBy` is what makes it interesting: a target absent before an action
 * and present right after it is how an application hands a user the next step
 * of a flow — a confirmation link after signing up, say — on any origin.
 * Links present from the start (a footer, a social link) never have it.
 *
 * `url` is the location identity: query values dropped and opaque path
 * segments redacted, so a one-time token in a link is never stored.
 */
export interface NavigationTarget {
  /** Host-assigned, sequential: NAV-001, … */
  id: string;
  url: string;
  origin: string;
  scope: NavigationScope;
  /** Accessible name, redacted and shortened. */
  name: string;
  firstSeenAt: string;
  /** The page and product state that first rendered it. */
  sourceLocation?: string;
  sourceStateId?: string;
  /** The state-changing action whose outcome first showed it. */
  exposedBy?: string;
  /** When the session first reached it. */
  followedAt?: string;
}

/** Link targets kept per run. A guard, not a target. */
export const MAX_NAVIGATION = 80;

/**
 * One state-changing browser action, host-recorded from the browser's own
 * report of it. `verifiedAt` is set by the next snapshot: until then, nothing
 * in the agent's context shows what the action did.
 */
export interface ActionRecord {
  /** Host-assigned, sequential: ACT-001, … */
  id: string;
  tool: string;
  kind: ActionKind;
  /** `click on button "Sign In"`, for feedback a person or a model can act on. */
  label: string;
  role?: string;
  name?: string;
  /** Where a navigation went. */
  url?: string;
  /** The page the action ran on, when the result named it. */
  location?: string;
  /** The product state the last snapshot before the action showed. */
  stateId?: string;
  /** A sign-in / sign-up attempt, judged from the control's accessible name. */
  auth: boolean;
  at: string;
  verifiedAt?: string;
  /**
   * Snapshots taken after this action that saved the page to a file instead of
   * returning it — `browser_snapshot` called with a filename. The agent saw
   * nothing, so they do not verify; counted so the rejection can say why.
   */
  fileOnlySnapshotsAfter?: number;
  /** What the first inline snapshot after this action showed changing. Counts only. */
  outcome?: DeltaCounts;
}

export interface CompletionAttempt {
  at: string;
  canFinalize: boolean;
  reasonCodes: string[];
  /** The gate's counts at that attempt: unverified outcomes, unexplored areas, … */
  metrics?: Record<string, number | boolean>;
}

export interface CompletionLog {
  attempts: CompletionAttempt[];
}

/** Actions kept per run. A guard against a runaway loop, not a target. */
export const MAX_ACTIONS = 400;

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
    // Playwright quotes some values as YAML strings (`/url: "#"`). Unquoted,
    // `"#"` resolved as a relative path and minted a phantom `/%22` location
    // the agent could never satisfy. A bare fragment is the same page.
    const url = match[1].replace(/^(['"])(.*)\1$/, '$2');
    if (url === '' || url.startsWith('#')) continue;
    // The owning element is the nearest preceding line that names one.
    let name = '';
    for (let j = i - 1; j >= 0 && j > i - 6; j -= 1) {
      const named = /^\s*-\s*\w+\s+"([^"]*)"/.exec(lines[j]);
      if (named) {
        name = named[1];
        break;
      }
    }
    out.push({ url, name });
  }
  return out;
}

/**
 * Build the surface from the entry page's snapshot.
 *
 * Same origin only, deduplicated, capped, with unsafe links pre-marked
 * SKIPPED_WITH_REASON so the agent records them without following them.
 */
export function buildSurface(
  target: string,
  snapshot: string,
  now = new Date(),
  options: { trackCompletion?: boolean } = {},
): DiscoverySurface {
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

  const surface: DiscoverySurface = {
    target: entry,
    origin,
    createdAt: now.toISOString(),
    locations,
    overflow,
    externalOrigins: [...externalOrigins].sort(),
    auxiliaryOrigins: aux,
    states: [],
    stateOverflow: 0,
    // Turns on the completion gate for this run: actions and snapshots are
    // recorded from here on, and finalization is judged against them.
    ...(options.trackCompletion ? { actions: [], observedLocations: [], navigation: [] } : {}),
  };
  // What the entry page offers before anything is done is the baseline: none
  // of it was exposed by an action.
  if (options.trackCompletion) registerNavigation(surface, snapshot, entry, undefined, undefined, now);
  return surface;
}

/**
 * Record every link target a snapshot renders that is not yet known. New
 * targets are attributed to `exposedBy` — the action this snapshot is the
 * first look after — when there is one. Pure; the caller persists.
 */
export function registerNavigation(
  surface: DiscoverySurface,
  snapshot: string,
  page: string,
  stateId: string | undefined,
  exposedBy: string | undefined,
  now = new Date(),
): NavigationTarget[] {
  const targets = (surface.navigation ??= []);
  const added: NavigationTarget[] = [];
  for (const link of extractLinks(snapshot)) {
    const id = locationIdentity(link.url, page);
    if (id === undefined) continue;
    if (targets.some((t) => t.url === id.url)) continue;
    if (targets.length >= MAX_NAVIGATION) break;
    const origin = new URL(id.url).origin;
    const kind = classifyOrigin(origin, surface.origin, surface.auxiliaryOrigins ?? []);
    const target: NavigationTarget = {
      id: `NAV-${String(targets.length + 1).padStart(3, '0')}`,
      url: id.url,
      origin,
      scope: kind ?? 'EXTERNAL',
      name: redactText(link.name).replace(/\s+/g, ' ').trim().slice(0, 80),
      firstSeenAt: now.toISOString(),
      sourceLocation: page,
      ...(stateId ? { sourceStateId: stateId } : {}),
      ...(exposedBy ? { exposedBy } : {}),
    };
    targets.push(target);
    added.push(target);
  }
  return added;
}

/** Mark targets the session has now reached. Cross-origin targets count by origin: a flow may redirect within it. */
function markFollowed(surface: DiscoverySurface, location: string, now: Date): void {
  const origin = new URL(location).origin;
  for (const t of surface.navigation ?? []) {
    if (t.followedAt !== undefined) continue;
    if (t.url === location || (t.scope !== 'PRODUCT' && t.origin === origin)) t.followedAt = now.toISOString();
  }
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
    auth: authSignals(snapshot),
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
export function absorbBrowserResult(surface: DiscoverySurface, text: string, now = new Date()): SurfaceLocation[] {
  const added: SurfaceLocation[] = [];
  const page = currentPageUrl(text);
  if (page !== undefined) {
    const entry = expandSurface(surface, page, 'reached while exploring');
    if (entry) added.push(entry);
    // The same route can show an entirely different product either side of a
    // sign-in; the state ledger is what notices.
    const identity = locationIdentity(page, surface.target);
    if (identity !== undefined) registerState(surface, identity.url, text, now);
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

/** Does this result carry the page's accessibility tree inline? Only `browser_snapshot` does. */
export function hasInlineTree(text: string): boolean {
  return /###\s*Snapshot\s*\n```/i.test(text);
}

/** A snapshot saved to a file and returned only as a link: nothing reached the agent. */
export function isFileOnlySnapshot(text: string): boolean {
  return /###\s*Snapshot\s*\n-\s*\[Snapshot\]\(/i.test(text) && !hasInlineTree(text);
}

/**
 * Fold one browser tool result into the surface: everything
 * `absorbBrowserResult` does, plus the action log.
 *
 *   - a state-changing action (a click on a button, a submit, a navigation)
 *     is appended unverified;
 *   - a snapshot is the only thing that verifies: it puts the resulting page
 *     in front of the agent, so every earlier unverified action now has an
 *     observed outcome.
 *
 * Deterministic and host-side. The model's own account of what happened —
 * "sign-in probably worked" — is never an input.
 */
export interface AbsorbResult {
  added: SurfaceLocation[];
  /** Set on the first inline snapshot after a state-changing action. */
  delta?: SurfaceDelta;
}

/** A page as a hint shows it: a path in the product, the token-free identity elsewhere. */
function displayUrl(surface: DiscoverySurface, url: string): string {
  return url.startsWith(surface.origin) ? url.slice(surface.origin.length) || '/' : url;
}

/** Did this successful browser_type / browser_fill_form call put input into a field? */
function isInputResult(tool: string, text: string): boolean {
  if (tool !== 'browser_type' && tool !== 'browser_fill_form') return false;
  return /\.(fill|type|pressSequentially)\(/.test(ranCode(text));
}

export function absorbToolResult(surface: DiscoverySurface, toolName: string, text: string, now = new Date()): AbsorbResult {
  const added = absorbBrowserResult(surface, text, now);
  const tool = toolName.replace(/^mcp__[a-z0-9_-]+__/i, '');
  const page = currentPageUrl(text);
  const location = page === undefined ? undefined : locationIdentity(page, surface.target)?.url;
  const failed = isErrorResult(text);

  if (location !== undefined && !failed) markFollowed(surface, location, now);

  if (tool === 'browser_snapshot' && !failed && hasInlineTree(text)) {
    const unverified = (surface.actions ?? []).filter((a) => a.verifiedAt === undefined);
    // The action this snapshot is the first look after: what it rendered that
    // was not rendered before is what that action exposed. A navigation
    // exposes a page, not a continuation, so it is not credited.
    const firstLookAfter = [...unverified].reverse().find((a) => a.kind !== 'navigate');
    const lastAction = unverified[unverified.length - 1];
    let delta: SurfaceDelta | undefined;
    if (location !== undefined) {
      const seen = (surface.observedLocations ??= []);
      if (!seen.includes(location)) seen.push(location);
      const { id, controls } = stateSignature(location, text);
      if (controls.length > 0) surface.currentStateId = id;
      const exposed =
        surface.navigation !== undefined
          ? registerNavigation(surface, text, location, controls.length > 0 ? id : undefined, firstLookAfter?.id, now).filter((t) => t.exposedBy)
          : [];
      const view: SurfaceView = { location, controls: controlNames(text), messages: extractMessages(text) };
      // Only after an action: a snapshot for its own sake has nothing to compare.
      if (lastAction !== undefined && surface.lastView !== undefined) {
        const diff = diffViews(surface.lastView, view, { compareControls: lastAction.kind !== 'navigate' });
        delta = {
          afterAction: { id: lastAction.id, label: lastAction.label },
          ...diff,
          ...(diff.pageChanged ? { pageChanged: { from: displayUrl(surface, diff.pageChanged.from), to: displayUrl(surface, diff.pageChanged.to) } } : {}),
          newNavigation: exposed.map((t) => ({ name: t.name, target: displayUrl(surface, t.url), scope: t.scope })),
        };
        // The outcome this action produced, as the host saw it: the evidence a
        // BLOCKED conclusion needs. Counts only.
        lastAction.outcome = deltaCounts(delta);
      }
      surface.lastView = view;
    }
    for (const action of unverified) action.verifiedAt = now.toISOString();
    return { added, ...(delta ? { delta } : {}) };
  }

  if (tool === 'browser_snapshot') {
    if (isFileOnlySnapshot(text)) {
      for (const action of surface.actions ?? []) {
        if (action.verifiedAt === undefined) action.fileOnlySnapshotsAfter = (action.fileOnlySnapshotsAfter ?? 0) + 1;
      }
    }
    return { added };
  }

  // Input that actually reached a field. A failed call typed nothing.
  if (!failed && isInputResult(tool, text)) {
    const inputs = (surface.inputs ??= []);
    inputs.push({ ...(surface.currentStateId ? { stateId: surface.currentStateId } : {}), at: now.toISOString() });
    if (inputs.length > MAX_ACTIONS) inputs.shift();
  }

  const action = classifyBrowserAction(tool, text);
  if (action === undefined) return { added };
  const actions = (surface.actions ??= []);
  const state = (surface.states ?? []).find((s) => s.id === surface.currentStateId);
  actions.push({
    id: `ACT-${String(actions.length + 1).padStart(3, '0')}`,
    tool,
    kind: action.kind,
    label: action.label,
    ...(action.role ? { role: action.role } : {}),
    ...(action.name ? { name: action.name } : {}),
    ...(action.url ? { url: action.url } : {}),
    ...(location ? { location } : {}),
    ...(surface.currentStateId ? { stateId: surface.currentStateId } : {}),
    // A sign-in / sign-up control by name, or a submit pressed inside a form
    // that shows a password field next to one.
    auth: isAuthAction(action) || ((action.kind === 'submit' || action.kind === 'key') && state?.auth?.authForm === true),
    at: now.toISOString(),
  });
  // Oldest *verified* entries go first; an unverified action is never dropped.
  while (actions.length > MAX_ACTIONS) {
    const i = actions.findIndex((a) => a.verifiedAt !== undefined);
    if (i === -1) break;
    actions.splice(i, 1);
  }
  return { added };
}

/** Record one completion-gate verdict. Pure; the caller persists. */
export function recordCompletionAttempt(surface: DiscoverySurface, attempt: CompletionAttempt): void {
  (surface.completion ??= { attempts: [] }).attempts.push(attempt);
}

/**
 * Locations the agent is expected to account for — the pre-skipped ones
 * included. Product locations only: a configured auxiliary origin is
 * infrastructure the agent is told never to describe as product, so demanding
 * it in `locations` as well set the two rules against each other — measured,
 * a run that correctly reached the mailbox gave up on exactly that. The host
 * already knows it went there; the agent may still report it, and when it
 * does, the auxiliary rules apply.
 */
export function expectedLocations(surface: DiscoverySurface): string[] {
  return surface.locations.filter((l) => l.kind !== 'AUXILIARY').map((l) => l.url);
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
