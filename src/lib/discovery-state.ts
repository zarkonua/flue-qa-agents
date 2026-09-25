// Discovery states: what the product shows, not where the browser is.
//
// The surface used to be keyed on URL alone, which cannot see the transition
// that matters most. A sign-in usually leaves the path where it was and
// replaces the entire application shell:
//
//     pathname: /                      pathname: /
//     textbox:Email                    button:Logout
//     textbox:Password        -->      button:Create note
//     button:Sign in                   textbox:Note title
//
// Same route, different product. Keyed on the URL, the authenticated product
// looks like a page already covered, and discovery is "complete" having never
// seen it.
//
// A state is therefore (normalised pathname + the set of interactive controls
// on offer). Two rules keep that stable enough to terminate:
//
//   - only *structural* roles count, never content. A note's title is data; a
//     `button:Delete` is an affordance. A list gaining a row must not be a new
//     state, or discovery never finishes.
//   - repeated identical controls collapse to a bucket, so five delete buttons
//     and six delete buttons are the same shape.
//
// Bounded like the location surface: caps on total states and on states per
// location, with the overflow reported rather than silently dropped.

import { createHash } from 'node:crypto';
import { redactText } from './redaction.ts';

/** Roles that describe what a page lets you *do*. Content roles are excluded. */
const STRUCTURAL_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'tab',
  'menuitem',
  'dialog',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
]);

/** How many product states one discovery run is asked to account for. */
export const MAX_STATES = 24;
/** How many distinct states one location may contribute before we stop adding. */
export const MAX_STATES_PER_LOCATION = 6;

/**
 * Repetition is a shape, not a count.
 *
 * Five delete buttons and six are the same affordance, so any repeat collapses
 * to MANY rather than to a number. A boundary at 3-vs-4 would mint a new state
 * when a list gained a row, which is exactly what must not happen.
 */
function bucket(count: number): string {
  return count > 1 ? 'MANY' : '1';
}

/** Marker for a group of sibling controls whose names are data, not structure. */
const REPEATED = '*';

/**
 * Accessible names carry data — `Delete note "Gamma"` names a row that will not
 * exist tomorrow. Strip what varies so the affordance survives and the content
 * does not.
 */
export function normaliseControlName(name: string): string {
  // A link's accessible name is sometimes the whole href, confirmation code
  // included. Redact before anything else touches it: a state signature is
  // persisted, and digits alone happening to normalise away is luck, not a
  // guarantee.
  return redactText(name)
    .toLowerCase()
    .replace(/"[^"]*"/g, '')          // quoted content: Delete note "Gamma"
    .replace(/\d+/g, '#')             // counters, ids, page numbers, codes
    .replace(/[\s ]+/g, ' ')
    .trim();
}

export interface ControlTally {
  role: string;
  name: string;
  bucket: string;
}

/**
 * The interactive controls a Playwright MCP accessibility snapshot offers.
 *
 * The snapshot is indented YAML-ish, one element per line as
 * `- role "Name" [ref=e1]`. Two passes:
 *
 * 1. Read every structural role, with its indentation depth.
 * 2. Collapse sibling groups. Controls at the same depth and role whose names
 *    differ are a repeated structure — a list of notes, a table of rows — and
 *    their names are data. They become one `role:*` entry. Without this, a
 *    list gaining a row changes the signature and discovery never terminates.
 *
 * A control with no accessible name still counts: an unlabelled button is an
 * affordance, and its namelessness is itself stable.
 */
export function interactiveControls(snapshot: string): ControlTally[] {
  const groups = new Map<string, { role: string; names: Map<string, number> }>();
  for (const line of snapshot.split('\n')) {
    const match = /^(\s*)-\s*([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (!match) continue;
    const role = match[2];
    if (!STRUCTURAL_ROLES.has(role)) continue;
    const depth = match[1].length;
    const key = `${depth}\u0000${role}`;
    const group = groups.get(key) ?? { role, names: new Map<string, number>() };
    const name = normaliseControlName(match[3] ?? '');
    group.names.set(name, (group.names.get(name) ?? 0) + 1);
    groups.set(key, group);
  }

  const tallies = new Map<string, ControlTally>();
  for (const group of groups.values()) {
    const distinct = [...group.names.keys()];
    const total = [...group.names.values()].reduce((a, b) => a + b, 0);
    // Collapse only a group that is genuinely a repeated structure: three or
    // more siblings that do not share a name. A two-field form (Email,
    // Password) keeps both names, which is what distinguishes one form from
    // another at the same route; a list of rows loses names it should lose.
    // Most real lists never reach this test — `normaliseControlName` already
    // folds "Note 1"/"Note 2" onto one name.
    const repeated = total >= 3 && distinct.length > 1;
    const entries: [string, number][] =
      repeated ? [[REPEATED, total]] : [...group.names.entries()];
    for (const [name, count] of entries) {
      const key = `${group.role}:${name}`;
      const existing = tallies.get(key);
      const merged = (existing ? 2 : 0) + count;
      tallies.set(key, { role: group.role, name, bucket: bucket(merged) });
    }
  }
  return [...tallies.values()].sort((a, b) => `${a.role}:${a.name}`.localeCompare(`${b.role}:${b.name}`));
}

/** The human-readable form of a state's shape — what the signature hashes. */
export function stateShape(pathname: string, controls: ControlTally[]): string {
  const lines = controls.map((c) => `${c.role}:${c.name}${c.bucket === '1' ? '' : ` ×${c.bucket}`}`);
  return `pathname: ${pathname}\ninteractive:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export interface DiscoveryState {
  /** Stable id: 12 hex of the shape's digest. */
  id: string;
  /** Location identity this state belongs to. */
  location: string;
  /** Normalised pathname, for reading the surface without decoding ids. */
  pathname: string;
  /** The controls that define it, for a human reading the artifact. */
  controls: string[];
  status: 'PENDING' | 'EXPLORED' | 'BLOCKED' | 'SKIPPED_WITH_REASON';
  reason?: string;
  firstSeenAt: string;
  /** What the page's own controls say about authentication. See discovery-actions.ts. */
  auth?: { authForm: boolean; signOut: boolean; password: boolean; signIn: boolean };
}

/**
 * The signature of one observed state. Deterministic: the same shape always
 * produces the same id, on any machine and in any run.
 */
export function stateSignature(locationUrl: string, snapshot: string): { id: string; pathname: string; controls: string[] } {
  const pathname = (() => {
    try {
      return new URL(locationUrl).pathname || '/';
    } catch {
      return locationUrl;
    }
  })();
  const controls = interactiveControls(snapshot);
  const shape = stateShape(pathname, controls);
  return {
    id: createHash('sha256').update(shape).digest('hex').slice(0, 12),
    pathname,
    controls: controls.map((c) => `${c.role}:${c.name}${c.bucket === '1' ? '' : ` ×${c.bucket}`}`),
  };
}
