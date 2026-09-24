// Deterministic host-side normalisation of locations and secrets.
//
// Two problems, one code path:
//
// 1. **Identity.** `/confirm?code=123` and `/confirm?code=456` are the same
//    product location reached twice, not two locations. Keying identity on the
//    raw URL let a single flow consume the whole location budget, and made the
//    completeness rule demand terminal states for pages that do not exist.
//
// 2. **Secrets.** A real run wrote
//    a confirmation link, code and all, into `discovery-surface.json`,
//    `discovered-behavior.json` and `test-cases.json`. A one-time confirmation
//    code is exactly the class of value the credentials policy says must never
//    reach a prompt, an artifact or a log — it was used transiently to complete
//    a browser flow and should have died there.
//
// Both are solved by never letting a query *value* take part in identity, and
// by redacting sensitive values out of every string an artifact carries before
// it is validated or written. Parameter *names* are kept: they are product
// facts ("this route takes a confirm_code"), the values are not.
//
// Generic by construction: the sensitive test is a pattern over parameter
// names, not a list of one application's parameters.

/**
 * Parameter names whose values are secret or one-time. Substring match on a
 * case-folded name, so `confirm_code`, `verificationCode`, `access_token`,
 * `sessionId` and `X-Api-Key` are all caught by the same few stems.
 */
const SENSITIVE_PARAM = /(token|code|secret|password|passwd|session|auth|key|signature|sig|nonce|otp|credential)/i;

/** Replacement written in place of a secret value. Never a real value. */
export const REDACTED = '<redacted>';

/** URL-safe form, so a redacted path segment does not percent-encode. */
export const REDACTED_SEGMENT = '-redacted-';

export function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM.test(name);
}

/**
 * Is this path segment an opaque identifier rather than a route word?
 *
 * Long, and dense in the alphabet identifiers use. Deliberately conservative:
 * a false positive costs a `<redacted>` in a path that was already meaningless
 * to a reader, a false negative persists a credential.
 */
export function redactOpaqueSegment(segment: string): string {
  if (segment.length < 20) return segment;
  const opaque = /^[A-Za-z0-9+/=_.\-@]+$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
  return opaque ? REDACTED_SEGMENT : segment;
}

export interface LocationIdentity {
  /** Origin and pathname only — query values never take part in identity. */
  url: string;
  /** Parameter names that were present, sorted and deduplicated. */
  queryParameters: string[];
  /** Whether any parameter name looked secret or one-time. */
  containsSensitiveTransientData: boolean;
}

/**
 * The canonical identity of a location.
 *
 * Trailing slash, hash and every query *value* are dropped; `/notes`,
 * `/notes/`, `/notes#top` and `/notes?code=1` are one location. Returns
 * `undefined` for anything that is not an http(s) URL.
 */
export function locationIdentity(raw: string, base?: string): LocationIdentity | undefined {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const names = [...new Set([...url.searchParams.keys()])].sort();
  // A secret is not always a query value. A mailbox message id sits in the
  // path — `/api/v1/messages/<opaque-id>=@host/download` — and persisting it
  // hands over a readable inbox. Any segment long enough and dense enough to
  // be an opaque identifier is replaced; ordinary route words never are.
  const pathRedacted = url.pathname.split('/').map(redactOpaqueSegment).join('/');
  if (pathRedacted !== url.pathname) url.pathname = pathRedacted;
  url.hash = '';
  url.search = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);

  return {
    url: url.toString(),
    queryParameters: names,
    containsSensitiveTransientData: names.some(isSensitiveParamName),
  };
}

/**
 * Redact sensitive query values anywhere in a string — in a URL field, or in a
 * sentence of prose that happens to quote one.
 *
 * Deliberately narrow: it removes `name=value` pairs whose *name* marks the
 * value as secret. A bare code quoted on its own ("the code was 123456") has no
 * such marker and is not caught; see `docs/VALIDATION.md` for that limit.
 */
export function redactText(text: string): string {
  return text.replace(
    /([?&;])([A-Za-z0-9_.\-[\]]+)=([^&\s"'<>)\]}]*)/g,
    (match, sep: string, name: string, value: string) =>
      value !== '' && isSensitiveParamName(name) ? `${sep}${name}=${REDACTED}` : match,
  );
}

/**
 * Redact every string in a value, in place of the original structure.
 *
 * Applied to a whole artifact before it is validated and written, so no field —
 * a URL, a route, a behavior statement, an observation quote — can carry a
 * one-time value onto disk.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item);
    return out as unknown as T;
  }
  return value;
}
