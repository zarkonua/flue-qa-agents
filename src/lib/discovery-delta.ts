// What changed between two looks at the product, computed by the host.
//
// A weak model handed a full accessibility snapshot after an action has to
// work out for itself what is new, and it often does not: measured, a sign-up
// exposed a continuation link and the model never noticed it. The host already
// holds both sides of the comparison — the previous snapshot's controls,
// messages and page, and the new one's — so it states the difference once,
// compactly, next to the unchanged browser output.
//
// Deterministic and bounded. Only structural signals are used: interactive
// controls by role and normalised name (the same representation the product
// states use), ARIA `status`/`alert` regions for messages, the location
// identity for the page, and the navigation targets the surface already
// attributes to actions. No prose is interpreted and no model is asked.

import { redactText } from './redaction.ts';
import { normaliseControlName } from './discovery-state.ts';

/** What one look at a page established, kept to compare the next look against. */
export interface SurfaceView {
  location: string;
  /** `role:name` as `interactiveControls` produces them. */
  controls: string[];
  /** Text of ARIA status / alert regions, redacted and shortened. */
  messages: string[];
}

export interface SurfaceDelta {
  /** The action this delta is the first look after, e.g. `click on button "Sign Up"`. */
  afterAction?: { id: string; label: string };
  pageChanged?: { from: string; to: string };
  newControls: string[];
  removedControls: string[];
  newMessages: string[];
  newNavigation: { name: string; target: string; scope: 'PRODUCT' | 'AUXILIARY' | 'EXTERNAL' }[];
}

/** Counts only — what telemetry may carry. Never text, never URLs. */
export interface DeltaCounts {
  surfaceDeltaGenerated: true;
  newInteractiveCount: number;
  newNavigationCount: number;
  newStatusCount: number;
  removedRelevantElementCount: number;
  pageChanged: boolean;
}

/** Bounds that keep a hint small enough for an 8k-token model. */
const MAX_LISTED = 4;
const MAX_MESSAGE_CHARS = 120;
const MAX_NAME_CHARS = 60;

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'dialog', 'searchbox', 'switch']);

/**
 * Distinct interactive controls in one snapshot, as `role:name` with the same
 * name normalisation product states use (content stripped, so a list of rows
 * is one name). Deliberately *not* the state's collapsed form: that folds three
 * or more siblings into one `role:*` entry to keep state ids stable, and a diff
 * over it reported a still-present button as removed.
 */
export function controlNames(snapshot: string): string[] {
  const out = new Set<string>();
  for (const line of snapshot.split('\n')) {
    const m = /^\s*-\s*([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
    if (!m || !INTERACTIVE.has(m[1])) continue;
    out.add(`${m[1]}:${normaliseControlName(m[2] ?? '')}`);
  }
  return [...out];
}

/**
 * Text of ARIA status and alert regions in one snapshot.
 *
 * `- status [ref=e6]: User already exists.` carries it inline; a region with
 * children carries it on `- text:` / `- paragraph:` lines beneath. Only these
 * two roles are read: they are how an application announces an outcome, and
 * they are structural — arbitrary page prose is not.
 */
export function extractMessages(snapshot: string): string[] {
  const lines = snapshot.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const region = /^(\s*)-\s*(status|alert)\b[^:\n]*(?::\s*(.*))?$/.exec(lines[i]);
    if (!region) continue;
    const depth = region[1].length;
    const parts: string[] = [];
    if (region[3] && region[3].trim() !== '') parts.push(region[3].trim());
    for (let j = i + 1; j < lines.length; j += 1) {
      const child = /^(\s*)-\s*(?:text|paragraph|generic|strong|emphasis)\b[^:\n]*:\s*(.+)$/.exec(lines[j]);
      const indent = /^(\s*)/.exec(lines[j])![1].length;
      if (indent <= depth) break;
      if (child) parts.push(child[2].trim());
      if (parts.length >= 3) break;
    }
    const text = clip(redactText(parts.join(' ').replace(/^"(.*)"$/, '$1')), MAX_MESSAGE_CHARS);
    if (text !== '') out.push(text);
  }
  return [...new Set(out)];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function interactive(controls: string[]): string[] {
  return controls.map((c) => c.replace(/\s*×\w+$/, '')).filter((c) => INTERACTIVE.has(c.slice(0, c.indexOf(':'))));
}

/**
 * The difference between two views. `sameAction` false (a navigation) skips
 * the control diff: on a new page everything is new, and listing it is noise.
 */
export function diffViews(
  before: SurfaceView | undefined,
  after: SurfaceView,
  options: { compareControls: boolean } = { compareControls: true },
): Omit<SurfaceDelta, 'afterAction' | 'newNavigation'> {
  const pageChanged = before && before.location !== after.location ? { from: before.location, to: after.location } : undefined;
  const prev = new Set(interactive(before?.controls ?? []));
  const next = new Set(interactive(after.controls));
  const compare = options.compareControls && before !== undefined;
  return {
    ...(pageChanged ? { pageChanged } : {}),
    newControls: compare ? [...next].filter((c) => !prev.has(c)) : [],
    removedControls: compare && !pageChanged ? [...prev].filter((c) => !next.has(c)) : [],
    newMessages: after.messages.filter((m) => !(before?.messages ?? []).includes(m)),
  };
}

export function isEmptyDelta(d: SurfaceDelta): boolean {
  return !d.pageChanged && d.newControls.length === 0 && d.removedControls.length === 0 && d.newMessages.length === 0 && d.newNavigation.length === 0;
}

export function deltaCounts(d: SurfaceDelta): DeltaCounts {
  return {
    surfaceDeltaGenerated: true,
    newInteractiveCount: d.newControls.length,
    newNavigationCount: d.newNavigation.length,
    newStatusCount: d.newMessages.length,
    removedRelevantElementCount: d.removedControls.length,
    pageChanged: d.pageChanged !== undefined,
  };
}

function label(control: string): string {
  const i = control.indexOf(':');
  const role = control.slice(0, i);
  const name = control.slice(i + 1);
  return name === '' ? `${role} (unnamed)` : name === '*' ? `${role}s (a repeated list)` : `${role} "${clip(name, MAX_NAME_CHARS)}"`;
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  return shown.join(', ') + (items.length > MAX_LISTED ? `, and ${items.length - MAX_LISTED} more` : '');
}

const SCOPE_NOTE = {
  PRODUCT: 'in the product',
  AUXILIARY: 'on a configured helper origin',
  EXTERNAL: 'on another origin this run may not visit',
} as const;

/** Heading that marks the block as the host's, not the browser's. */
export const HINT_HEADING = '### Host-observed changes';

/**
 * The hint the model reads beside the snapshot. Navigation first — it is what
 * most often continues a flow — then messages, then controls, then the page.
 * Every line is bounded; no URL carries more than its token-free identity.
 */
export function formatDelta(d: SurfaceDelta): string {
  const lines: string[] = [];
  for (const n of d.newNavigation.slice(0, MAX_LISTED)) {
    lines.push(`- New link${n.name ? ` "${clip(n.name, MAX_NAME_CHARS)}"` : ''} → ${n.target} (${SCOPE_NOTE[n.scope]})`);
  }
  if (d.newNavigation.length > MAX_LISTED) lines.push(`- …and ${d.newNavigation.length - MAX_LISTED} more new links`);
  for (const m of d.newMessages.slice(0, 3)) lines.push(`- New message: "${m}"`);
  const navNames = new Set(d.newNavigation.map((n) => `link:${n.name.toLowerCase()}`));
  const controls = d.newControls.filter((c) => !navNames.has(c));
  if (controls.length > 0) lines.push(`- New controls: ${listed(controls.map(label))}`);
  if (d.removedControls.length > 0) lines.push(`- No longer shown: ${listed(d.removedControls.map(label))}`);
  if (d.pageChanged) lines.push(`- Page changed: ${d.pageChanged.from} → ${d.pageChanged.to}`);
  if (lines.length === 0) lines.push('- No visible change: the same controls and messages as before this action.');
  const since = d.afterAction ? ` since your ${d.afterAction.label} (${d.afterAction.id})` : ' since your previous action';
  return `${HINT_HEADING}${since}\n(computed by the Flue host from successive snapshots — not part of the browser's output)\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Telemetry hand-off
// ---------------------------------------------------------------------------
//
// The host interceptor computes a delta while the tool call is still open;
// tracing reads its counts when the call's `tool` event arrives. Keyed by tool
// call id, taken once, bounded.

const pending = new Map<string, DeltaCounts>();

export function publishDeltaCounts(toolCallId: string | undefined, counts: DeltaCounts): void {
  if (!toolCallId) return;
  pending.set(toolCallId, counts);
  if (pending.size > 200) pending.delete(pending.keys().next().value as string);
}

export function takeDeltaCounts(toolCallId: string | undefined): DeltaCounts | undefined {
  if (!toolCallId) return undefined;
  const counts = pending.get(toolCallId);
  pending.delete(toolCallId);
  return counts;
}
