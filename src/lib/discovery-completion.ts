// The Discovery Completion Gate.
//
// Artifact validation asks "is this artifact well-formed and supported by the
// evidence?". This asks a different question: "is there concrete, host-recorded
// evidence that exploration is unfinished?" A discovered-behavior artifact can
// be perfectly valid while the run that produced it clicked Sign In, never
// looked at the result, and stopped.
//
// Evaluated when Product Discovery proposes to finalize — its
// `write_qa_artifact("discovered-behavior")` call — after schema and semantic
// validation pass and before anything is written. A rejection writes nothing
// and returns the reasons; the agent keeps its conversation, its observations
// and its browser, and continues.
//
// Deterministic by construction: a pure function of the surface the host
// recorded from the browser's own results and of the artifact proposed. It
// never calls a model, never reads the model's reasoning, and never counts
// towards a quota. There is no "at least N behaviours": an application with
// one behaviour, fully observed, finalizes on the first attempt.

import { isUnsafe, type ActionRecord, type DiscoverySurface, type NavigationTarget } from './discovery-surface.ts';
import { locationIdentity } from './redaction.ts';
import { normaliseControlName } from './discovery-state.ts';

/** The tool-log message tracing recognises as one gate verdict. */
export const COMPLETION_LOG = 'discovery_completion';

/** Stable reason codes. Tests, telemetry and any future UI key on these, never on messages. */
export const COMPLETION_REASON_CODES = [
  'UNVERIFIED_ACTION_OUTCOME',
  'UNVERIFIED_EXPLORED_LOCATION',
  'UNRESOLVED_AUTH_STATE',
  'UNEXPLORED_REACHABLE_AREA',
  'UNEXPLORED_RELEVANT_NAVIGATION',
  'BLOCKED_WITHOUT_EVIDENCE',
] as const;

export type CompletionReasonCode = (typeof COMPLETION_REASON_CODES)[number];

export interface CompletionReason {
  code: CompletionReasonCode;
  /** For the agent and for a person. Never parsed. */
  message: string;
  actionId?: string;
  location?: string;
  stateId?: string;
  /** For UNEXPLORED_RELEVANT_NAVIGATION: the target, and the page that exposed it. */
  navigationId?: string;
  sourceLocation?: string;
}

export interface CompletionMetrics {
  stateChangingActions: number;
  unverifiedOutcomeCount: number;
  /** Snapshots after unverified actions that went to a file instead of to the agent. */
  fileOnlySnapshotCount: number;
  productStateCount: number;
  unexploredAreaCount: number;
  observedLocationCount: number;
  unverifiedExploredLocationCount: number;
  authFormSeen: boolean;
  authenticatedStateSeen: boolean;
  authUnresolved: boolean;
  visibleNavigationCount: number;
  newlyVisibleNavigationCount: number;
  crossOriginNavigationCount: number;
  followedRelevantNavigationCount: number;
  unexploredRelevantNavigationCount: number;
  /** The artifact resolves something as BLOCKED with a reason. */
  blockedProposed: boolean;
  /** …and an attempt with an observed outcome backs it. */
  blockedSupported: boolean;
  blockedWithoutEvidence: boolean;
  /** Sign-in / sign-up attempts that actually executed. */
  authAttemptCount: number;
  /** Actions whose first look afterwards produced a host delta. */
  surfaceDeltaCount: number;
}

/**
 * How far one attempt got along the chain a BLOCKED conclusion needs:
 *
 *   input entered → action executed → result inspected → outcome visible
 *
 * "Executed" is structural: only a browser call that succeeded is ever
 * recorded as an action, so a call that failed on its arguments performed
 * nothing and cannot appear here at all. Success of the *flow* is never
 * required — an application that answers a real attempt with an error has
 * genuinely blocked it.
 */
export interface AttemptEvidence {
  actionId: string;
  label: string;
  inputBefore: boolean;
  inspected: boolean;
  outcomeObserved: boolean;
  supported: boolean;
}

/** Evidence for each executed attempt that `relevant` selects, best first. Generic over flows. */
export function attemptEvidence(surface: DiscoverySurface, relevant: (a: ActionRecord) => boolean): AttemptEvidence[] {
  const inputs = surface.inputs ?? [];
  return (surface.actions ?? [])
    .filter(relevant)
    .map((a) => {
      const inputBefore = inputs.some((i) => i.stateId === a.stateId && i.at <= a.at);
      const inspected = a.verifiedAt !== undefined;
      const o = a.outcome;
      const outcomeObserved =
        o !== undefined && (o.newStatusCount > 0 || o.newInteractiveCount > 0 || o.removedRelevantElementCount > 0 || o.newNavigationCount > 0 || o.pageChanged);
      return { actionId: a.id, label: a.label, inputBefore, inspected, outcomeObserved, supported: inputBefore && inspected && outcomeObserved };
    })
    .sort((x, y) => Number(y.supported) - Number(x.supported) || steps(y) - steps(x) || y.actionId.localeCompare(x.actionId));
}

function steps(e: AttemptEvidence): number {
  return Number(e.inputBefore) + Number(e.inspected) + Number(e.outcomeObserved);
}

export interface DiscoveryCompletionResult {
  canFinalize: boolean;
  reasons: CompletionReason[];
  metrics: CompletionMetrics;
  /** This attempt has used its finalization budget; stop rather than loop. */
  exhausted: boolean;
}

/**
 * Rejected finalizations allowed per agent attempt before the gate tells the
 * agent to stop. A guard against a loop, not an exploration target: each
 * rejection names what is missing, and one snapshot or one BLOCKED entry
 * usually clears it. Past this, the stage's own bounded attempts take over.
 */
export const MAX_FINALIZATION_REJECTIONS = 5;

export interface CompletionInput {
  surface: DiscoverySurface;
  /** The artifact Product Discovery proposes to write. */
  artifact: { locations?: { url?: unknown; status?: unknown; reason?: unknown }[] };
  /** Rejections already returned in this agent attempt. */
  rejectionsSoFar?: number;
}

/** Is completion tracking on for this surface? Only surfaces the orchestrator built for a run. */
export function completionTracked(surface: DiscoverySurface | undefined): surface is DiscoverySurface {
  return surface !== undefined && Array.isArray(surface.actions) && Array.isArray(surface.observedLocations);
}

// Text fields are left out: typing is not a recorded action, and a field
// almost always comes with the button that submits it, which is.
const ACTIVATING = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'combobox']);
const SIGN_OUT = /\b(sign|log)[\s-]?(out|off)\b/i;

/** `role:name ×MANY` → { role, name }. */
function parseControl(control: string): { role: string; name: string } {
  const i = control.indexOf(':');
  const role = i === -1 ? control : control.slice(0, i);
  const name = (i === -1 ? '' : control.slice(i + 1)).replace(/\s*×\w+$/, '');
  return { role, name };
}

/** Controls a user could drive to move the product somewhere, excluding the ones discovery must not touch. */
function drivableControls(controls: string[]): string[] {
  return controls.filter((c) => {
    const { role, name } = parseControl(c);
    if (!ACTIVATING.has(role)) return false;
    if (SIGN_OUT.test(name)) return false;
    return isUnsafe('', name) === undefined;
  });
}

function identity(url: string, surface: DiscoverySurface): string | undefined {
  return locationIdentity(url, surface.target)?.url;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function short(url: string | undefined, surface: DiscoverySurface): string {
  if (!url) return 'the page';
  return url.startsWith(surface.origin) ? url.slice(surface.origin.length) || '/' : url;
}

/**
 * Evaluate whether Product Discovery may finalize. Pure.
 *
 * Rules, each over recorded evidence only:
 *
 *   UNVERIFIED_ACTION_OUTCOME     a state-changing action with no snapshot since
 *   UNVERIFIED_EXPLORED_LOCATION  a location reported EXPLORED that the browser
 *                                 never showed in a snapshot
 *   UNRESOLVED_AUTH_STATE         a sign-in form was seen, no signed-in state
 *                                 was, and nothing is recorded BLOCKED
 *   UNEXPLORED_REACHABLE_AREA     a product state the run reached, offering
 *                                 controls no exercised state offered, in which
 *                                 nothing was ever done
 *   UNEXPLORED_RELEVANT_NAVIGATION a link a state-changing action newly exposed,
 *                                 while the sign-in flow is open, never followed
 *   BLOCKED_WITHOUT_EVIDENCE      the open sign-in flow is recorded BLOCKED, but no
 *                                 executed attempt had input, an inspected result
 *                                 and a visible outcome
 */
export function evaluateDiscoveryCompletion(input: CompletionInput): DiscoveryCompletionResult {
  const { surface, artifact } = input;
  const reasons: CompletionReason[] = [];
  const actions: ActionRecord[] = surface.actions ?? [];
  const reported = (artifact.locations ?? []).filter((l): l is { url: string; status: string; reason?: unknown } =>
    typeof l?.url === 'string' && typeof l?.status === 'string',
  );
  const reportedAs = (url: string) => reported.find((l) => identity(l.url, surface) === url);
  const blockedWithReason = reported.some((l) => l.status === 'BLOCKED' && typeof l.reason === 'string' && l.reason.trim() !== '');

  // ---- 1. every state-changing action has an observed outcome --------------
  const unverified = actions.filter((a) => a.verifiedAt === undefined);
  for (const a of unverified) {
    reasons.push({
      code: 'UNVERIFIED_ACTION_OUTCOME',
      message:
        `The ${a.label}${a.location ? ` on ${short(a.location, surface)}` : ''} (${a.id}) has no observed outcome: ` +
        (a.fileOnlySnapshotsAfter
          ? `the ${a.fileOnlySnapshotsAfter} browser_snapshot call(s) after it passed a filename, which saves the page to a file ` +
            'you cannot read. Call browser_snapshot with NO arguments to see the page, and record what changed.'
          : 'nothing after it shows what it did. Take a browser_snapshot and record what changed.'),
      actionId: a.id,
      ...(a.location ? { location: a.location } : {}),
    });
  }

  // ---- 2. EXPLORED means the browser showed it ------------------------------
  const observed = new Set(surface.observedLocations ?? []);
  let unverifiedExplored = 0;
  for (const l of reported) {
    if (l.status !== 'EXPLORED') continue;
    const url = identity(l.url, surface);
    if (url === undefined || originOf(url) !== surface.origin) continue;
    if (observed.has(url)) continue;
    unverifiedExplored += 1;
    reasons.push({
      code: 'UNVERIFIED_EXPLORED_LOCATION',
      message:
        `${short(url, surface)} is reported EXPLORED, but no browser_snapshot of it was taken in this run. ` +
        'Navigate there and snapshot it, or report it BLOCKED / SKIPPED_WITH_REASON with the reason.',
      location: url,
    });
  }

  // ---- 3. authentication is resolved, one way or the other -----------------
  const productStates = (surface.states ?? []).filter((s) => originOf(s.location) === surface.origin);
  const authStates = productStates.filter((s) => s.auth?.authForm);
  const authenticated = productStates.some(
    (s) =>
      s.auth?.signOut === true ||
      // Same route, later, with neither a password field nor a sign-in
      // control: the shell was replaced, which is what signing in looks like.
      authStates.some(
        (a) => a.location === s.location && s.firstSeenAt > a.firstSeenAt && !s.auth?.password && !s.auth?.signIn && s.controls.length > 0,
      ),
  );
  // The flow itself is open whenever a sign-in form was seen and no signed-in
  // state was. Recording BLOCKED answers that — unless the application itself
  // showed a way forward (rule 5), which it then has to be.
  const flowOpen = authStates.length > 0 && !authenticated;

  // ---- 5. a continuation the application exposed is followed ---------------
  //
  // A link absent before a state-changing action and present right after it is
  // how an application hands the user the next step of a flow. While that flow
  // is open, such a link is relevant — on any origin; being cross-origin does
  // not make it irrelevant. Links present from the start (footer, social) are
  // never "exposed", so they never block anything.
  const navigation: NavigationTarget[] = surface.navigation ?? [];
  const exposed = navigation.filter((t) => t.exposedBy !== undefined && isUnsafe(t.url, t.name) === undefined);
  const navReasons: CompletionReason[] = [];
  if (flowOpen) {
    for (const t of exposed) {
      if (t.followedAt !== undefined) continue;
      // An origin this run may not visit cannot be followed; an explicit
      // BLOCKED naming it is then the honest answer, and it is accepted.
      if (t.scope === 'EXTERNAL' && blockedWithReason) continue;
      const by = actions.find((a) => a.id === t.exposedBy);
      const where = t.scope === 'PRODUCT' ? short(t.url, surface) : t.url;
      const link = `link${t.name ? ` "${t.name}"` : ''} (${t.id}) to ${where}`;
      const after = by ? `After the ${by.label} (${by.id}), the page newly showed a ${link}` : `The page newly showed a ${link}`;
      navReasons.push({
        code: 'UNEXPLORED_RELEVANT_NAVIGATION',
        message:
          `${after}, and the sign-in flow is still unresolved. ` +
          (t.scope === 'EXTERNAL'
            ? `${t.origin} is not an origin this run may visit, so do not follow it: record the location where the flow ` +
              `stopped as BLOCKED, naming ${t.origin} in the reason.`
            : `Follow it — it is likely the way this flow continues${t.scope === 'AUXILIARY' ? ` (${t.origin} is allowed test infrastructure, not the product)` : ''} — ` +
              'snapshot what it shows, use it to continue the flow, then return to the product. Do not retry the same ' +
              'sign-in or record BLOCKED while this is unexplored.'),
        navigationId: t.id,
        location: t.url,
        ...(t.sourceLocation ? { sourceLocation: t.sourceLocation } : {}),
        ...(by ? { actionId: by.id } : {}),
      });
    }
  }

  // ---- 6. BLOCKED needs an attempt with an observed outcome ----------------
  //
  // "I could not make progress" is not "the application blocked me". Before a
  // BLOCKED entry may close an open sign-in flow, some real attempt at it must
  // show the whole chain: input entered, the action executed, its result
  // inspected, and something visibly changed. A failed tool call executed
  // nothing and so never counts.
  const authEvidence = attemptEvidence(surface, (a) => a.auth);
  const blockedSupported = blockedWithReason && authEvidence.some((e) => e.supported);
  const blockedWithoutEvidence = flowOpen && blockedWithReason && !blockedSupported && navReasons.length === 0;
  if (blockedWithoutEvidence) {
    const best = authEvidence[0];
    const missing = !best
      ? 'no sign-in or sign-up was ever performed — a browser call that returned an error performed nothing'
      : !best.inputBefore
        ? `the ${best.label} (${best.actionId}) was performed with nothing entered in that form`
        : !best.inspected
          ? `the result of the ${best.label} (${best.actionId}) was never looked at`
          : `the snapshot after the ${best.label} (${best.actionId}) showed no change — no message, no control appeared or disappeared`;
    reasons.push({
      code: 'BLOCKED_WITHOUT_EVIDENCE',
      message:
        `The sign-in flow is recorded BLOCKED, but no attempt at it has an observed blocking outcome: ${missing}. ` +
        'Perform the action with its inputs and inspect the resulting state before calling the flow BLOCKED. ' +
        'Tool or input errors are not the application blocking you.',
      location: authStates[0].location,
      ...(best ? { actionId: best.actionId } : {}),
    });
  }

  // Rule 3 and rule 5 can describe one situation. When a continuation is
  // named, it is the more specific instruction, and the generic one is dropped;
  // rule 6 likewise replaces rule 3 when the only answer given was unsupported.
  const authUnresolved = flowOpen && !blockedWithReason && navReasons.length === 0;
  if (authUnresolved) {
    const lastAttempt = [...actions].reverse().find((a) => a.auth);
    reasons.push({
      code: 'UNRESOLVED_AUTH_STATE',
      message:
        `The product shows a sign-in form (${short(authStates[0].location, surface)}) and no signed-in state has been observed` +
        (lastAttempt ? `; the last attempt was the ${lastAttempt.label} (${lastAttempt.id})` : '; no sign-in or sign-up was attempted') +
        '. Complete the sign-in or sign-up and snapshot the result, or record the location where you were stopped as ' +
        'BLOCKED with the reason (POST_AUTH_DISCOVERY_BLOCKED: what stopped you).',
      location: authStates[0].location,
      ...(lastAttempt ? { actionId: lastAttempt.id } : {}),
    });
  }

  // ---- 4. reached product states were actually used ------------------------
  //
  // Links to other origins are rule 5's to judge — by relevance, not by mere
  // appearance — and a link rule 5 already names is not reported twice. A
  // footer link or a "Share" button appearing must not demand an action.
  const judgedByNavigation = new Set(
    navigation
      .filter((t) => t.scope !== 'PRODUCT' || navReasons.some((r) => r.navigationId === t.id))
      .map((t) => `link:${normaliseControlName(t.name)}`),
  );
  const exercised = new Set(actions.map((a) => a.stateId).filter((id): id is string => id !== undefined));
  const known = new Set(productStates.filter((s) => exercised.has(s.id)).flatMap((s) => drivableControls(s.controls)));
  let unexplored = 0;
  for (const s of productStates) {
    if (exercised.has(s.id)) continue;
    const fresh = drivableControls(s.controls).filter((c) => !known.has(c) && !judgedByNavigation.has(c.replace(/\s*×\w+$/, '')));
    if (fresh.length === 0) continue;
    const answer = reportedAs(s.location);
    if (answer && (answer.status === 'BLOCKED' || answer.status === 'SKIPPED_WITH_REASON')) continue;
    unexplored += 1;
    reasons.push({
      code: 'UNEXPLORED_REACHABLE_AREA',
      message:
        `A product state reached at ${short(s.location, surface)} offers ${fresh.slice(0, 4).map((c) => `${parseControl(c).role} "${parseControl(c).name || '(unnamed)'}"`).join(', ')}` +
        `${fresh.length > 4 ? ` and ${fresh.length - 4} more` : ''}, and nothing was done there. ` +
        'Use it and record what happens, or report that location BLOCKED / SKIPPED_WITH_REASON with the reason.',
      location: s.location,
      stateId: s.id,
    });
  }

  reasons.push(...navReasons);

  const rejectionsSoFar = input.rejectionsSoFar ?? 0;
  const canFinalize = reasons.length === 0;
  return {
    canFinalize,
    reasons,
    exhausted: !canFinalize && rejectionsSoFar + 1 >= MAX_FINALIZATION_REJECTIONS,
    metrics: {
      stateChangingActions: actions.length,
      unverifiedOutcomeCount: unverified.length,
      fileOnlySnapshotCount: Math.max(0, ...unverified.map((a) => a.fileOnlySnapshotsAfter ?? 0)),
      productStateCount: productStates.length,
      unexploredAreaCount: unexplored,
      observedLocationCount: observed.size,
      unverifiedExploredLocationCount: unverifiedExplored,
      authFormSeen: authStates.length > 0,
      authenticatedStateSeen: authenticated,
      // The flow is unresolved whether rule 3, 5 or 6 is the one reporting it.
      authUnresolved: authUnresolved || navReasons.length > 0 || blockedWithoutEvidence,
      visibleNavigationCount: navigation.length,
      newlyVisibleNavigationCount: exposed.length,
      crossOriginNavigationCount: navigation.filter((t) => t.scope !== 'PRODUCT').length,
      followedRelevantNavigationCount: exposed.filter((t) => t.followedAt !== undefined).length,
      unexploredRelevantNavigationCount: navReasons.length,
      blockedProposed: blockedWithReason,
      blockedSupported,
      blockedWithoutEvidence,
      authAttemptCount: authEvidence.length,
      surfaceDeltaCount: actions.filter((a) => a.outcome !== undefined).length,
    },
  };
}

/** How many reasons are listed in feedback. The rest are counted, not dropped silently. */
const MAX_LISTED = 6;

/**
 * The feedback Product Discovery receives on a rejection. Generated from the
 * result alone — no model is asked why the gate failed.
 */
export function formatCompletionFeedback(result: DiscoveryCompletionResult): string {
  const listed = result.reasons.slice(0, MAX_LISTED).map((r, i) => `${i + 1}. [${r.code}] ${r.message}`);
  const more = result.reasons.length > MAX_LISTED ? `\n...and ${result.reasons.length - MAX_LISTED} more.` : '';
  if (result.exhausted) {
    return (
      `Discovery cannot finalize, and this attempt has used all ${MAX_FINALIZATION_REJECTIONS} finalization attempts. ` +
      `Still unresolved:\n\n${listed.join('\n')}${more}\n\n` +
      'Nothing was written. Stop calling tools now and reply BLOCKED, listing these items.'
    );
  }
  return (
    `Discovery cannot finalize yet — nothing was written:\n\n${listed.join('\n')}${more}\n\n` +
    'Continue discovery and resolve these items, then call write_qa_artifact again with the complete object. ' +
    'An item you genuinely cannot resolve is reported BLOCKED with the reason, never as EXPLORED.'
  );
}

/** Thrown by the discovered-behavior write when the gate rejects finalization. */
export class DiscoveryIncompleteError extends Error {
  readonly result: DiscoveryCompletionResult;

  constructor(result: DiscoveryCompletionResult) {
    super(formatCompletionFeedback(result));
    this.name = 'DiscoveryIncompleteError';
    this.result = result;
  }
}
