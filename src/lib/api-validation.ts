// Live API validation: what the product's API actually does, checked by the
// host against what its documentation declares.
//
// `api-discovery.ts` reads the documentation. This module goes one step
// further: it sends real HTTP requests to the application under test and
// compares each response — status, content type, headers, body schema — with
// the documented contract, writing the `api-validation` artifact.
//
// No model takes part and no agent can write the artifact. Three things follow
// from that, and the rest of the pipeline relies on them:
//
//   - evidence has a class the host assigned: an operation is DOCUMENTED (only
//     declared), OBSERVED (a real response was captured) or VALIDATED (a real
//     response was captured AND it matched the contract). Nothing is VALIDATED
//     that was not executed and checked;
//   - a mismatch is a finding with a classification the host assigned:
//     CONTRACT_VIOLATION when the response contradicts something the document
//     states, POTENTIAL_ISSUE when it needs a person to look;
//   - every request was allowed by policy, below.
//
// Safe execution — the policy, in one place:
//
//   hosts         requests go only to the resolved base URL, whose host must be
//                 the API documentation's, the target's, or one listed in
//                 QA_API_ALLOWED_HOSTS. Link-local and cloud-metadata addresses
//                 are refused always. Redirects are recorded, never followed.
//   methods       GET / HEAD / OPTIONS on an operation that does not look
//                 state-changing run by default. Everything else — POST, PUT,
//                 PATCH, DELETE, and a GET named like an action — runs only if
//                 a person approved that exact operation for this run.
//   data          PUT, PATCH and DELETE only ever touch a resource this run
//                 itself created through an approved POST.
//   environment   in a production environment nothing state-changing runs,
//                 approved or not.
//   credentials   come from host configuration only, are sent only to the
//                 base URL's origin, and never reach the artifact.
//   volume        a request budget, a pause between requests, a timeout each;
//                 a 429 or repeated connection failures stop the probing.
//
// Whatever cannot run is skipped with a reason, and the run carries on with
// the documentation alone. Nothing here throws for a network or policy problem.

import Ajv2020 from 'ajv/dist/2020.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  deref, describeEndpoint, hasApi, isObject, rawOperations,
  type ApiDiscovery, type ApiEndpoint, type Json, type RawOperation,
} from './api-discovery.ts';
import { isSensitiveParamName, REDACTED, redactText } from './redaction.ts';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type EvidenceClass = 'DOCUMENTED' | 'OBSERVED' | 'VALIDATED';
export type OperationSafety = 'SAFE' | 'UNSAFE_GET' | 'STATE_CHANGING' | 'DESTRUCTIVE';
export type ValidationStatus = 'COMPLETED' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_REQUESTED';
export type FindingClassification = 'CONTRACT_VIOLATION' | 'POTENTIAL_ISSUE';
export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export const SKIP_REASONS = [
  'APPROVAL_REQUIRED', 'ENVIRONMENT_PROTECTED', 'MISSING_PARAMETERS', 'MISSING_TEST_DATA', 'UNSUPPORTED_BODY',
  'UNSUPPORTED_METHOD', 'REQUEST_BUDGET', 'RATE_LIMITED', 'UNREACHABLE', 'NOT_ATTEMPTED',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What a probe sets out to show; decides what counts as the expected kind of response. */
export type ProbeKind = 'ANONYMOUS' | 'UNAUTHENTICATED' | 'AUTHENTICATED' | 'NOT_FOUND' | 'INVALID_BODY' | 'VALID_BODY';
export type CheckName = 'STATUS' | 'EXPECTATION' | 'CONTENT_TYPE' | 'SCHEMA' | 'HEADERS';
export type CheckOutcome = 'PASS' | 'FAIL' | 'NOT_CHECKED';

export interface ProbeCheck { name: CheckName; outcome: CheckOutcome; detail?: string }
export interface ApiProbe {
  id: string;
  endpointId: string;
  kind: ProbeKind;
  /** Redacted: no credential, no secret query value. */
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; contentType?: string; headers: Record<string, string>; bodySample?: string; bodyTruncated?: boolean; durationMs: number };
  /** Set instead of `response` when no response arrived. */
  error?: { code: 'TIMEOUT' | 'CONNECTION' | 'BLOCKED' | 'TOO_LARGE'; message: string };
  checks: ProbeCheck[];
  /** OBSERVED: a response was captured. VALIDATED: and every check that could run passed. Absent when there was no response. */
  evidence?: 'OBSERVED' | 'VALIDATED';
}
export interface ApiValidationEndpoint {
  id: string;
  method: string;
  path: string;
  safety: OperationSafety;
  evidence: EvidenceClass;
  execution: 'EXECUTED' | 'SKIPPED';
  skipReason?: SkipReason;
  skipDetail?: string;
  /**
   * Which kinds of probe were validated / only observed. Says what "VALIDATED" covers for this
   * operation — and an operation with any contract violation is OBSERVED, whatever else matched.
   */
  validated: ProbeKind[];
  observed: ProbeKind[];
  probes: string[];
  findings: string[];
}
export interface ApiFinding {
  id: string;
  endpointId: string;
  probeId: string;
  classification: FindingClassification;
  type: string;
  severity: FindingSeverity;
  title: string;
  expected: string;
  actual: string;
}
export interface ApiValidation {
  status: ValidationStatus;
  reason?: string;
  baseUrl?: string;
  baseUrlSource?: 'OVERRIDE' | 'SPEC_SERVER' | 'DOCS_ORIGIN';
  environment?: string;
  startedAt?: string;
  finishedAt?: string;
  authentication: { status: 'NOT_CONFIGURED' | 'READY' | 'FAILED'; method?: 'TOKEN' | 'BASIC' | 'LOGIN'; detail?: string };
  policy: { allowedHosts: string[]; approvedOperations: string[]; maxRequests: number; requestsSent: number };
  summary: {
    endpoints: number; documented: number; observed: number; validated: number; skipped: number;
    requests: number; contractViolations: number; potentialIssues: number;
  };
  endpoints: ApiValidationEndpoint[];
  probes: ApiProbe[];
  findings: ApiFinding[];
}

export const LIVE_LIMITS = {
  maxRequests: 60,
  hardMaxRequests: 500,
  timeoutMs: 10_000,
  delayMs: 100,
  bodyBytes: 1024 * 1024,
  bodySample: 1500,
  /** Connection failures in a row after which the API is considered unreachable. */
  failuresToAbort: 3,
} as const;

const EMPTY_SUMMARY = { endpoints: 0, documented: 0, observed: 0, validated: 0, skipped: 0, requests: 0, contractViolations: 0, potentialIssues: 0 };

const shell = (status: ValidationStatus, reason: string, rest: Partial<ApiValidation> = {}): ApiValidation => ({
  status,
  reason,
  authentication: { status: 'NOT_CONFIGURED' },
  policy: { allowedHosts: [], approvedOperations: [], maxRequests: 0, requestsSent: 0 },
  summary: { ...EMPTY_SUMMARY },
  endpoints: [],
  probes: [],
  findings: [],
  ...rest,
});

export const validationNotRequested = (reason: string): ApiValidation => shell('NOT_REQUESTED', reason);

// ---------------------------------------------------------------------------
// Operation safety and approvals
// ---------------------------------------------------------------------------

export const operationKey = (e: { method: string; path: string }): string => `${e.method.toUpperCase()} ${e.path}`;

/** `POST /notes`, `DELETE /notes/{id}` — how an approval names an operation. */
export const OPERATION_KEY = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9_\-./{}:~%@+]{0,300}$/;

/** Words that make a read look like an action. Matched against path segments and the operation id, never prose. */
const ACTION_WORD = /^(logout|signout|delete|remove|destroy|purge|reset|revoke|confirm|activate|deactivate|approve|reject|cancel|send|resend|trigger|execute|run|start|stop|restart|import|unsubscribe|subscribe|generate|create|update|clear|flush|kill|shutdown|invalidate|rotate|sync|refresh)$/;

const words = (text: string): string[] =>
  text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * How dangerous it is to call an operation unasked.
 *
 * DELETE is destructive; POST, PUT and PATCH change state. A GET, HEAD or
 * OPTIONS is safe unless its path or operation id names an action (`/logout`,
 * `/users/{id}/activate`, `resetPassword`) — HTTP says GET is safe, and APIs
 * break that promise often enough that the name is checked.
 */
export function operationSafety(e: { method: string; path: string; operationId?: string }): OperationSafety {
  const method = e.method.toUpperCase();
  if (method === 'DELETE') return 'DESTRUCTIVE';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') return 'STATE_CHANGING';
  const named = [
    ...e.path.split('/').filter((s) => s !== '' && !/^\{.*\}$/.test(s)).flatMap(words),
    // The operation id too: `resetPassword` on a GET is an action whatever its path says.
    ...words(e.operationId ?? ''),
  ];
  return named.some((w) => ACTION_WORD.test(w)) ? 'UNSAFE_GET' : 'SAFE';
}

/** Approvals as given, kept only if they are well-formed and name a documented operation. */
export function knownApprovals(approved: readonly string[], endpoints: readonly { method: string; path: string }[]): string[] {
  const documented = new Set(endpoints.map(operationKey));
  return [...new Set(approved.map((a) => a.trim()).filter((a) => OPERATION_KEY.test(a) && documented.has(a)))];
}

/** `"POST /a, DELETE /a/{id}"` or one per line -> the list. Anything malformed is dropped. */
export function parseApprovals(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter((a) => OPERATION_KEY.test(a));
  if (typeof raw !== 'string') return [];
  return raw.split(/[,\n]/).map((a) => a.trim()).filter((a) => OPERATION_KEY.test(a));
}

export const isProtectedEnvironment = (environment: string | undefined): boolean =>
  /^(prod|production|live)$/i.test((environment ?? '').trim());

// ---------------------------------------------------------------------------
// Where requests may go
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `host[:port]`, lower-cased, with every loopback name folded into one. */
export function hostKey(url: URL | string): string | undefined {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`) : url;
  } catch {
    return undefined;
  }
  const name = LOOPBACK.has(u.hostname.toLowerCase()) ? 'localhost' : u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${name}:${port}`;
}

/** Addresses no run may reach, whatever is configured: link-local (cloud metadata lives there), unspecified, multicast. */
export function isForbiddenAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\./.test(a) || a === '0.0.0.0' || /^2(2[4-9]|3\d)\./.test(a)) return true;
  if (a === '::' || /^fe[89ab][0-9a-f]:/.test(a) || /^ff[0-9a-f]{2}:/.test(a)) return true;
  // IPv4-mapped IPv6: judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? isForbiddenAddress(mapped[1]) : false;
}

const FORBIDDEN_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

function cleanBaseUrl(raw: unknown, relativeTo?: string): URL | undefined {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 500) return undefined;
  let url: URL;
  try {
    url = relativeTo ? new URL(raw.trim(), relativeTo) : new URL(raw.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return undefined;
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

/** A base URL a person may configure: http(s), no credentials, no query. Undefined when it is not one. */
export function normalizeBaseUrl(raw: unknown): string | undefined {
  return cleanBaseUrl(raw)?.toString().replace(/\/$/, '');
}

/**
 * Where the API is: the override if one was given, else what the document
 * says (`servers[0]`, or Swagger 2's host and basePath — a relative one is
 * resolved against where the document was fetched), else the documentation's
 * own origin.
 */
export function resolveBaseUrl(spec: Json, docsUrl: string, override?: string): { url: string; source: NonNullable<ApiValidation['baseUrlSource']> } | { error: string } {
  const out = (url: URL, source: NonNullable<ApiValidation['baseUrlSource']>) => ({ url: url.toString().replace(/\/$/, ''), source });
  if (override !== undefined && override.trim() !== '') {
    const url = cleanBaseUrl(override);
    return url ? out(url, 'OVERRIDE') : { error: 'the API base URL override is not a valid http(s) URL' };
  }
  if (typeof spec.swagger === 'string') {
    const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
    if (typeof spec.host === 'string' && spec.host.trim() !== '') {
      const scheme = (Array.isArray(spec.schemes) ? spec.schemes : []).find((s) => s === 'https' || s === 'http') ?? new URL(docsUrl).protocol.replace(':', '');
      const url = cleanBaseUrl(`${scheme}://${spec.host}${basePath}`);
      if (url) return out(url, 'SPEC_SERVER');
    }
    const url = cleanBaseUrl(basePath || '/', docsUrl);
    if (url) return out(url, basePath ? 'SPEC_SERVER' : 'DOCS_ORIGIN');
  }
  const server = (Array.isArray(spec.servers) ? spec.servers : []).find(isObject);
  if (server && typeof server.url === 'string' && server.url.trim() !== '') {
    // `{variable}` placeholders take their documented default; one without a default cannot be resolved.
    const variables = isObject(server.variables) ? server.variables : {};
    let unresolved = false;
    const filled = server.url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const v = variables[name];
      if (isObject(v) && (typeof v.default === 'string' || typeof v.default === 'number')) return String(v.default);
      unresolved = true;
      return '';
    });
    const url = unresolved ? undefined : cleanBaseUrl(filled, docsUrl);
    if (url) return out(url, 'SPEC_SERVER');
  }
  const origin = cleanBaseUrl('/', docsUrl);
  return origin ? out(origin, 'DOCS_ORIGIN') : { error: 'the API base URL could not be resolved from the documentation' };
}

// ---------------------------------------------------------------------------
// Schemas: OpenAPI -> JSON Schema, sample values
// ---------------------------------------------------------------------------

/** OpenAPI keywords that are not JSON Schema, or that a response check must not enforce. */
const DROP = new Set(['example', 'examples', 'xml', 'externalDocs', 'discriminator', 'deprecated', 'readOnly', 'writeOnly', 'nullable', '$ref', 'format', 'title', 'description', 'default']);

/**
 * A documented schema as plain JSON Schema: `$ref`s inlined, `nullable`
 * turned into a type union, OpenAPI-only keywords dropped. A reference cycle
 * or excessive depth becomes "anything" rather than an error — an unchecked
 * corner is honest; a crash on a real document is not.
 */
export function toJsonSchema(spec: Json, node: unknown, seen: readonly string[] = [], depth = 0): Json {
  if (!isObject(node) || depth > 24) return {};
  if (typeof node.$ref === 'string') {
    if (seen.includes(node.$ref)) return {};
    return toJsonSchema(spec, deref(spec, node).node, [...seen, node.$ref], depth + 1);
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP.has(key) || key.startsWith('x-')) continue;
    if (key === 'properties' || key === 'patternProperties') {
      out[key] = Object.fromEntries(Object.entries(isObject(value) ? value : {}).map(([k, v]) => [k, toJsonSchema(spec, v, seen, depth + 1)]));
    } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      out[key] = typeof value === 'boolean' ? value : toJsonSchema(spec, value, seen, depth + 1);
    } else if (key === 'allOf' || key === 'oneOf' || key === 'anyOf') {
      out[key] = (Array.isArray(value) ? value : []).map((v) => toJsonSchema(spec, v, seen, depth + 1));
    } else if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
      // OpenAPI 3.0 says `true` beside minimum/maximum; JSON Schema says the number itself.
      const bound = key === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      if (value === true && typeof node[bound] === 'number') out[key] = node[bound];
      else if (typeof value === 'number') out[key] = value;
    } else if (key === 'required') {
      // A write-only property never comes back, so a response may not be required to carry it.
      const props = isObject(node.properties) ? node.properties : {};
      const kept = (Array.isArray(value) ? value : []).filter((name) => typeof name === 'string' && !(isObject(deref(spec, props[name]).node) && (deref(spec, props[name]).node as Json).writeOnly === true));
      if (kept.length > 0) out.required = kept;
    } else if (key === 'type') {
      out.type = value;
    } else {
      out[key] = value;
    }
  }
  for (const bound of ['minimum', 'maximum'] as const) {
    if (node[bound === 'minimum' ? 'exclusiveMinimum' : 'exclusiveMaximum'] === true) delete out[bound];
  }
  if (node.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  // `enum` with nullable: null is one of the allowed values.
  if (node.nullable === true && Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

const ajv = new (Ajv2020 as unknown as new (o: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null } })(
  { strict: false, allErrors: true, validateFormats: false },
);

/** Problems of `body` against a documented schema, a few readable lines. Empty when it conforms, or when the schema cannot be compiled. */
export function schemaProblems(spec: Json, schema: unknown, body: unknown): { problems: string[]; checked: boolean } {
  let validate;
  try {
    validate = ajv.compile(toJsonSchema(spec, schema));
  } catch {
    return { problems: [], checked: false };
  }
  if (validate(body)) return { problems: [], checked: true };
  const problems = [...new Set((validate.errors ?? []).map((e) => `${e.instancePath || '(body)'} ${e.message ?? 'does not match'}`))].slice(0, 5);
  return { problems, checked: true };
}

/**
 * A value that satisfies a documented schema, for a request the run sends.
 * Prefers what the document itself offers — example, default, enum — and
 * otherwise the plainest value of the type. `nonce` keeps strings unique to
 * this run, so a creation never collides with real data.
 */
export function sampleValue(spec: Json, node: unknown, nonce: string, name = '', depth = 0): unknown {
  const schema = deref(spec, node).node;
  if (!schema || depth > 8) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) return sampleValue(spec, schema[key][0], nonce, name, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const merged: Json = {};
    for (const part of schema.allOf) {
      const v = sampleValue(spec, part, nonce, name, depth + 1);
      if (isObject(v)) Object.assign(merged, v);
    }
    if (isObject(schema.properties)) Object.assign(merged, sampleValue(spec, { ...schema, allOf: undefined }, nonce, name, depth + 1) as Json);
    return merged;
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type ?? (isObject(schema.properties) ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((r): r is string => typeof r === 'string'));
      const out: Json = {};
      for (const [key, prop] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
        const p = deref(spec, prop).node;
        // Only what the request must carry, and nothing the server owns.
        if (!required.has(key) || p?.readOnly === true) continue;
        out[key] = sampleValue(spec, prop, nonce, key, depth + 1);
      }
      return out;
    }
    case 'array': {
      const item = sampleValue(spec, schema.items, nonce, name, depth + 1);
      return Array.from({ length: Math.max(typeof schema.minItems === 'number' ? schema.minItems : 0, item === undefined ? 0 : 1) }, () => item);
    }
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
      const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
      const value = min ?? (max !== undefined && max < 1 ? max : 1);
      return type === 'integer' ? Math.ceil(value) : value;
    }
    case 'boolean':
      return true;
    case 'string':
    case undefined: {
      const format = typeof schema.format === 'string' ? schema.format : '';
      const looksLike = (re: RegExp) => re.test(format) || re.test(name);
      let value = `qa-probe-${nonce}`;
      if (format === 'uuid') value = `00000000-0000-4000-8000-${nonce.padStart(12, '0').slice(-12)}`;
      else if (format === 'date-time') value = '2030-01-01T00:00:00Z';
      else if (format === 'date') value = '2030-01-01';
      else if (looksLike(/^(uri|url)$/i)) value = 'https://example.test/qa-probe';
      else if (looksLike(/e-?mail/i)) value = `qa-probe-${nonce}@example.test`;
      else if (looksLike(/^password$|passw/i)) value = `Qa-probe-${nonce}-1!`;
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
      const max = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
      if (value.length < min) value = value.padEnd(min, 'x');
      if (max !== undefined && value.length > max) value = value.slice(0, Math.max(max, 0));
      return value;
    }
    default:
      return undefined;
  }
}

/** A value of the right type that should not exist — for checking a documented 404. */
function absentValue(spec: Json, node: unknown): string {
  const schema = deref(spec, node).node ?? {};
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  if (type === 'integer' || type === 'number') return '2147483646';
  return 'qa-probe-nonexistent-0';
}

// ---------------------------------------------------------------------------
// Redaction — nothing sensitive reaches the artifact
// ---------------------------------------------------------------------------

/** Headers worth keeping as evidence. Everything else is dropped; a cookie is only ever noted as present. */
const KEPT_HEADERS = new Set(['content-type', 'content-length', 'cache-control', 'location', 'www-authenticate', 'retry-after', 'allow', 'etag', 'vary']);

function keptHeaders(headers: { forEach(cb: (value: string, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'set-cookie') out[name] = REDACTED;
    else if (KEPT_HEADERS.has(name) || /^x-ratelimit-/.test(name)) out[name] = redactText(value).slice(0, 300);
  });
  return out;
}

/** `"code": 401` is a status, not a secret; a one-time code has more digits than that. */
const isSmallNumber = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000;

/** JSON with the value of every sensitively named key replaced. */
export function redactBody(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactBody(v, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, isSensitiveParamName(k) && v !== null && typeof v !== 'object' && !isSmallNumber(v) ? REDACTED : redactBody(v, depth + 1)]));
  }
  // A JWT or a long opaque string is a credential wherever it sits.
  if (typeof value === 'string') return /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}$/.test(value) ? REDACTED : redactText(value);
  return value;
}

function sampleOf(text: string, parsed: unknown): { bodySample?: string; bodyTruncated?: boolean } {
  if (text === '') return {};
  const shown = parsed === undefined ? redactText(text) : JSON.stringify(redactBody(parsed));
  return shown.length > LIVE_LIMITS.bodySample ? { bodySample: `${shown.slice(0, LIVE_LIMITS.bodySample)}…`, bodyTruncated: true } : { bodySample: shown };
}

/** The request URL as it may be stored: query values with secret names removed, credentials never in it. */
const shownUrl = (url: URL): string => redactText(url.toString());

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Credentials from host configuration. Never from a browser, never written anywhere. */
export interface ApiAuthConfig { token?: string; username?: string; password?: string; loginPath?: string }

interface AuthScheme { type: string; scheme?: string; in?: string; name?: string }
type Applier = (url: URL, headers: Record<string, string>) => void;

function schemesOf(spec: Json): Map<string, AuthScheme> {
  const defs = isObject(spec.components) && isObject(spec.components.securitySchemes)
    ? spec.components.securitySchemes
    : isObject(spec.securityDefinitions) ? spec.securityDefinitions : {};
  const out = new Map<string, AuthScheme>();
  for (const [id, raw] of Object.entries(defs)) {
    const d = deref(spec, raw).node;
    if (d) out.set(id, { type: String(d.type ?? ''), scheme: typeof d.scheme === 'string' ? d.scheme.toLowerCase() : undefined, in: typeof d.in === 'string' ? d.in : undefined, name: typeof d.name === 'string' ? d.name : undefined });
  }
  return out;
}

/** How a credential is attached, from the document's first usable scheme. Bearer when the document does not say. */
function applierFor(schemes: Map<string, AuthScheme>, value: string, basic: boolean): Applier {
  const all = [...schemes.values()];
  if (basic) return (_u, h) => { h.authorization = `Basic ${value}`; };
  const apiKey = all.find((s) => s.type === 'apiKey' && s.name);
  const bearer = all.find((s) => (s.type === 'http' && s.scheme === 'bearer') || s.type === 'oauth2' || s.type === 'openIdConnect');
  if (!bearer && apiKey?.name) {
    const name = apiKey.name;
    if (apiKey.in === 'query') return (u) => { u.searchParams.set(name, value); };
    if (apiKey.in === 'cookie') return (_u, h) => { h.cookie = `${name}=${value}`; };
    return (_u, h) => { h[name.toLowerCase()] = value; };
  }
  return (_u, h) => { h.authorization = `Bearer ${value}`; };
}

const TOKEN_FIELDS = ['token', 'access_token', 'accessToken', 'jwt', 'id_token', 'idToken'];

function tokenIn(body: unknown, depth = 0): string | undefined {
  if (!isObject(body) || depth > 2) return undefined;
  for (const key of TOKEN_FIELDS) if (typeof body[key] === 'string' && body[key] !== '') return body[key] as string;
  for (const value of Object.values(body)) {
    const nested = tokenIn(value, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The contract for one response
// ---------------------------------------------------------------------------

const mediaType = (header: string | null | undefined): string | undefined => header?.split(';')[0].trim().toLowerCase() || undefined;
const isJson = (type: string | undefined): boolean => type !== undefined && /(^|[/+])json$/.test(type);

/** The documented response for a status: the exact code, its range (`2XX`), or `default`. */
function documentedResponse(spec: Json, op: Json, status: number): { key: string; response: Json } | undefined {
  const responses = isObject(op.responses) ? op.responses : {};
  for (const key of [String(status), `${Math.floor(status / 100)}XX`, `${Math.floor(status / 100)}xx`, 'default']) {
    const response = deref(spec, responses[key]).node;
    if (response) return { key, response };
  }
  return undefined;
}

/** Media type -> schema for a documented response, OpenAPI 3 or Swagger 2. */
function documentedContent(spec: Json, op: Json, response: Json): Map<string, unknown> {
  if (isObject(response.content)) {
    return new Map(Object.entries(response.content).map(([type, v]) => [type.toLowerCase(), isObject(v) ? v.schema : undefined]));
  }
  if (typeof spec.swagger === 'string' && response.schema !== undefined) {
    const produces = (Array.isArray(op.produces) ? op.produces : Array.isArray(spec.produces) ? spec.produces : ['application/json']).filter((p): p is string => typeof p === 'string');
    return new Map(produces.map((type) => [type.toLowerCase(), response.schema]));
  }
  return new Map();
}

const documentedStatuses = (op: Json): string[] => Object.keys(isObject(op.responses) ? op.responses : {});

/** What kind of response each probe is expected to get. */
const EXPECTS: Record<ProbeKind, { label: string; ok: (status: number) => boolean }> = {
  ANONYMOUS: { label: 'a successful response (2xx or 3xx)', ok: (s) => s >= 200 && s < 400 },
  AUTHENTICATED: { label: 'a successful response (2xx or 3xx)', ok: (s) => s >= 200 && s < 400 },
  VALID_BODY: { label: 'a successful response (2xx or 3xx)', ok: (s) => s >= 200 && s < 400 },
  UNAUTHENTICATED: { label: 'the request to be refused (401 or 403)', ok: (s) => s === 401 || s === 403 },
  INVALID_BODY: { label: 'the request to be rejected (4xx)', ok: (s) => s >= 400 && s < 500 },
  NOT_FOUND: { label: 'not found (404), or the value rejected (400 or 422)', ok: (s) => s === 404 || s === 400 || s === 422 },
};

const KIND_PHRASE: Record<ProbeKind, string> = {
  ANONYMOUS: 'without credentials (none are documented as required)',
  UNAUTHENTICATED: 'without credentials',
  AUTHENTICATED: 'with the configured credentials',
  NOT_FOUND: 'for a resource that does not exist',
  INVALID_BODY: 'with an empty request body',
  VALID_BODY: 'with a generated valid request body',
};

interface Evaluated { checks: ProbeCheck[]; findings: Omit<ApiFinding, 'id' | 'endpointId' | 'probeId'>[] }

/** Compare one real response with the documented contract. Pure. */
export function evaluateResponse(
  spec: Json,
  operation: { method: string; path: string; op: Json; security: string[] },
  kind: ProbeKind,
  res: { status: number; contentType?: string; headers: Record<string, string>; text: string },
): Evaluated {
  const checks: ProbeCheck[] = [];
  const findings: Evaluated['findings'] = [];
  const what = `${operation.method} ${operation.path}`;
  const declared = documentedStatuses(operation.op);
  const declaredList = declared.join(', ') || 'no response';
  const documented = documentedResponse(spec, operation.op, res.status);
  const expects = EXPECTS[kind];
  const expectationMet = expects.ok(res.status);

  // ---- STATUS: is this status one the document declares for the operation?
  checks.push(documented
    ? { name: 'STATUS', outcome: 'PASS', detail: `${res.status} is documented${documented.key === String(res.status) ? '' : ` (as ${documented.key})`}` }
    : { name: 'STATUS', outcome: 'FAIL', detail: `${res.status} is not documented; the documentation declares ${declaredList}` });

  // ---- EXPECTATION: did the probe get the kind of response it set out to check?
  checks.push({ name: 'EXPECTATION', outcome: expectationMet ? 'PASS' : 'FAIL', detail: `expected ${expects.label}; got ${res.status}` });

  if (res.status >= 500) {
    findings.push({
      classification: 'POTENTIAL_ISSUE', type: 'SERVER_ERROR', severity: 'HIGH',
      title: `${what} responded ${res.status} ${KIND_PHRASE[kind]}`,
      expected: `${what} ${KIND_PHRASE[kind]} is expected to produce ${expects.label}.`,
      actual: `The server responded ${res.status}.`,
    });
  } else if (!expectationMet) {
    if (kind === 'UNAUTHENTICATED') {
      findings.push({
        classification: 'CONTRACT_VIOLATION', type: 'AUTH_NOT_ENFORCED', severity: 'HIGH',
        title: `${what} responded ${res.status} without credentials although authentication is documented as required`,
        expected: `The documentation requires authentication (${operation.security.join(', ')}) for ${what}, so a request without credentials is refused with 401 or 403.`,
        actual: `A request without credentials responded ${res.status}.`,
      });
    } else if (kind === 'INVALID_BODY') {
      findings.push({
        classification: 'CONTRACT_VIOLATION', type: 'VALIDATION_NOT_ENFORCED', severity: 'HIGH',
        title: `${what} accepted a request body without its documented required fields`,
        expected: `The documentation marks fields of the ${what} request body as required, so an empty body is rejected with a 4xx status.`,
        actual: `An empty request body responded ${res.status}.`,
      });
    } else if (kind === 'NOT_FOUND') {
      findings.push({
        classification: 'POTENTIAL_ISSUE', type: 'UNEXPECTED_RESPONSE', severity: 'LOW',
        title: `${what} responded ${res.status} for a resource that should not exist`,
        expected: `${what} for a non-existent resource responds 404.`,
        actual: `The request responded ${res.status}.`,
      });
    } else {
      const authFailure = res.status === 401 || res.status === 403;
      findings.push({
        classification: 'POTENTIAL_ISSUE', type: authFailure ? 'ACCESS_DENIED' : 'UNEXPECTED_REJECTION', severity: 'MEDIUM',
        title: `${what} responded ${res.status} ${KIND_PHRASE[kind]}`,
        expected: `${what} ${KIND_PHRASE[kind]} is expected to produce ${expects.label}.`,
        actual: `The request responded ${res.status}. ${authFailure ? 'The configured credentials may lack permission, or the documentation omits a requirement.' : 'The generated request may be missing something the documentation does not state.'}`,
      });
    }
  }

  if (!documented && res.status < 500) {
    // A success the document does not declare contradicts it. A refusal it does
    // not declare — the usual case is a 401 nobody wrote down — is a gap in the
    // documentation: worth a look, not proof of a defect.
    const contradicts = expectationMet && res.status < 400;
    findings.push({
      classification: contradicts ? 'CONTRACT_VIOLATION' : 'POTENTIAL_ISSUE', type: 'UNDOCUMENTED_STATUS', severity: contradicts ? 'MEDIUM' : 'LOW',
      title: `${what} responded ${res.status}, which its documentation does not declare`,
      expected: `The documentation declares these statuses for ${what}: ${declaredList}.`,
      actual: `A request ${KIND_PHRASE[kind]} responded ${res.status}.`,
    });
  }

  // ---- CONTENT_TYPE and SCHEMA: only against a documented response, and only where there is a body.
  const hasBody = res.text !== '' && operation.method !== 'HEAD' && res.status !== 204 && res.status !== 304;
  if (documented) {
    const content = documentedContent(spec, operation.op, documented.response);
    if (!hasBody) {
      checks.push({ name: 'CONTENT_TYPE', outcome: 'NOT_CHECKED', detail: 'the response has no body' });
    } else if (content.size === 0) {
      checks.push({ name: 'CONTENT_TYPE', outcome: 'NOT_CHECKED', detail: `no content is documented for ${documented.key}` });
    } else {
      const type = res.contentType;
      const match = type !== undefined && ([...content.keys()].find((k) => k === type) ?? [...content.keys()].find((k) => k === '*/*' || (k.endsWith('/*') && type.startsWith(k.slice(0, -1)))));
      if (match) {
        checks.push({ name: 'CONTENT_TYPE', outcome: 'PASS', detail: `${type} is documented` });
      } else {
        checks.push({ name: 'CONTENT_TYPE', outcome: 'FAIL', detail: `${type ?? 'no content type'}; documented: ${[...content.keys()].join(', ')}` });
        findings.push({
          classification: 'CONTRACT_VIOLATION', type: 'CONTENT_TYPE_MISMATCH', severity: 'MEDIUM',
          title: `${what} responded ${res.status} with content type ${type ?? '(none)'}, not a documented one`,
          expected: `The documented content type(s) for ${what} ${documented.key}: ${[...content.keys()].join(', ')}.`,
          actual: `The response content type was ${type ?? 'absent'}.`,
        });
      }
      // The schema is checked whenever the body is JSON and a schema is documented for it — or, when the
      // content type itself did not match, for the one JSON schema the document offers.
      const schema = match ? content.get(match) : [...content.entries()].find(([k]) => isJson(k))?.[1];
      if (schema === undefined) {
        checks.push({ name: 'SCHEMA', outcome: 'NOT_CHECKED', detail: 'no schema is documented for this response' });
      } else if (!isJson(type) && !(match && isJson(match))) {
        checks.push({ name: 'SCHEMA', outcome: 'NOT_CHECKED', detail: 'the response body is not JSON' });
      } else {
        let parsed: unknown;
        let invalid = false;
        try {
          parsed = JSON.parse(res.text);
        } catch {
          invalid = true;
        }
        if (invalid) {
          checks.push({ name: 'SCHEMA', outcome: 'FAIL', detail: 'the body is not valid JSON' });
          findings.push({
            classification: 'CONTRACT_VIOLATION', type: 'INVALID_JSON', severity: 'MEDIUM',
            title: `${what} responded ${res.status} with a body that is not valid JSON`,
            expected: `A JSON body, as the documentation declares for ${what} ${documented.key}.`,
            actual: 'The body could not be parsed as JSON.',
          });
        } else {
          const { problems, checked } = schemaProblems(spec, schema, parsed);
          if (!checked) {
            checks.push({ name: 'SCHEMA', outcome: 'NOT_CHECKED', detail: 'the documented schema could not be compiled' });
          } else if (problems.length === 0) {
            checks.push({ name: 'SCHEMA', outcome: 'PASS', detail: 'the body matches the documented schema' });
          } else {
            checks.push({ name: 'SCHEMA', outcome: 'FAIL', detail: problems.join('; ') });
            findings.push({
              classification: 'CONTRACT_VIOLATION', type: 'SCHEMA_MISMATCH', severity: 'MEDIUM',
              title: `${what} responded ${res.status} with a body that does not match its documented schema`,
              expected: `The response body of ${what} ${documented.key} matches the documented schema.`,
              actual: `The body differs from the schema: ${problems.join('; ')}.`,
            });
          }
        }
      }
    }

    // ---- HEADERS: only the ones the document marks required.
    const required = Object.entries(isObject(documented.response.headers) ? documented.response.headers : {})
      .filter(([, h]) => isObject(deref(spec, h).node) && (deref(spec, h).node as Json).required === true).map(([name]) => name.toLowerCase());
    if (required.length > 0) {
      const missing = required.filter((name) => !(name in res.headers));
      checks.push(missing.length === 0
        ? { name: 'HEADERS', outcome: 'PASS', detail: `required header(s) present: ${required.join(', ')}` }
        : { name: 'HEADERS', outcome: 'FAIL', detail: `missing required header(s): ${missing.join(', ')}` });
      if (missing.length > 0) {
        findings.push({
          classification: 'CONTRACT_VIOLATION', type: 'MISSING_HEADER', severity: 'LOW',
          title: `${what} responded ${res.status} without its documented required header(s)`,
          expected: `The documentation requires these response headers for ${what} ${documented.key}: ${required.join(', ')}.`,
          actual: `Missing: ${missing.join(', ')}.`,
        });
      }
    }
  }
  return { checks, findings };
}

/** VALIDATED only when the status is documented, the probe got the kind of response it checks, and nothing failed. */
export function evidenceOf(checks: readonly ProbeCheck[]): 'OBSERVED' | 'VALIDATED' {
  const passed = (name: CheckName) => checks.some((c) => c.name === name && c.outcome === 'PASS');
  return passed('STATUS') && passed('EXPECTATION') && !checks.some((c) => c.outcome === 'FAIL') ? 'VALIDATED' : 'OBSERVED';
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface LiveResponse { status: number; headers: { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void }; text(): Promise<string> }
export type LiveFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal: AbortSignal }) => Promise<LiveResponse>;

export interface ApiValidationOptions {
  /** False: the documentation is used alone. */
  enabled: boolean;
  /** Where the documentation was fetched from — an allowed host, and the fallback base URL. */
  docsUrl: string;
  targetUrl?: string;
  baseUrlOverride?: string;
  /** Extra `host[:port]` entries (QA_API_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  environment?: string;
  /** Operations a person approved for this run, as `METHOD /path`. */
  approvedOperations?: string[];
  auth?: ApiAuthConfig;
  /** Values for path parameters, by name (QA_API_PATH_PARAMS). Used for safe requests only. */
  pathParams?: Record<string, string>;
  maxRequests?: number;
  timeoutMs?: number;
  delayMs?: number;
  fetchImpl?: LiveFetch;
  lookupImpl?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  nonce?: string;
}

const defaultLookup = async (hostname: string): Promise<string[]> => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

interface Planned { raw: RawOperation; endpoint: ApiEndpoint; safety: OperationSafety }

/**
 * Probe the API and compare it with its documentation. Never throws: whatever
 * stops it — no documentation, a host that is not allowed, an unreachable
 * server — comes back as a status and a reason, with every operation the run
 * could not exercise left DOCUMENTED.
 */
export async function validateApi(spec: Json | undefined, discovery: ApiDiscovery | undefined, options: ApiValidationOptions): Promise<ApiValidation> {
  if (!options.enabled) return validationNotRequested('live API validation was not requested for this run');
  if (!hasApi(discovery) || !spec) return shell('UNAVAILABLE', 'there is no API documentation to validate against');

  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as LiveFetch);
  const environment = (options.environment ?? 'test').trim() || 'test';
  const protectedEnv = isProtectedEnvironment(environment);
  const maxRequests = Math.max(1, Math.min(options.maxRequests ?? LIVE_LIMITS.maxRequests, LIVE_LIMITS.hardMaxRequests));
  const timeoutMs = options.timeoutMs ?? LIVE_LIMITS.timeoutMs;
  const delayMs = options.delayMs ?? LIVE_LIMITS.delayMs;
  const nonce = options.nonce ?? Math.random().toString(36).slice(2, 10);
  const startedAt = now().toISOString();

  // ---- The plan: every documented operation, with nothing decided yet --------
  const byId = new Map(discovery.endpoints.map((e) => [e.id, e]));
  const planned: Planned[] = rawOperations(spec).filter((r) => byId.has(r.id)).map((raw) => {
    const endpoint = byId.get(raw.id)!;
    return { raw, endpoint, safety: operationSafety({ method: raw.method, path: raw.path, operationId: endpoint.operationId }) };
  });
  const approved = knownApprovals(options.approvedOperations ?? [], planned.map((p) => p.raw));
  const endpoints: ApiValidationEndpoint[] = planned.map((p) => ({
    id: p.raw.id, method: p.raw.method, path: p.raw.path, safety: p.safety, evidence: 'DOCUMENTED', execution: 'SKIPPED',
    skipReason: 'NOT_ATTEMPTED', validated: [], observed: [], probes: [], findings: [],
  }));
  const view = new Map(endpoints.map((e) => [e.id, e]));
  const probes: ApiProbe[] = [];
  const findings: ApiFinding[] = [];
  const policy: ApiValidation['policy'] = { allowedHosts: [], approvedOperations: approved, maxRequests, requestsSent: 0 };
  let authentication: ApiValidation['authentication'] = { status: 'NOT_CONFIGURED' };

  const finish = (status: ValidationStatus, reason: string | undefined, base?: { url: string; source: NonNullable<ApiValidation['baseUrlSource']> }): ApiValidation => {
    const count = (c: FindingClassification) => findings.filter((f) => f.classification === c).length;
    return {
      status,
      ...(reason ? { reason } : {}),
      ...(base ? { baseUrl: base.url, baseUrlSource: base.source } : {}),
      environment,
      startedAt,
      finishedAt: now().toISOString(),
      authentication,
      policy,
      summary: {
        endpoints: endpoints.length,
        documented: endpoints.filter((e) => e.evidence === 'DOCUMENTED').length,
        observed: endpoints.filter((e) => e.evidence === 'OBSERVED').length,
        validated: endpoints.filter((e) => e.evidence === 'VALIDATED').length,
        skipped: endpoints.filter((e) => e.execution === 'SKIPPED').length,
        requests: policy.requestsSent,
        contractViolations: count('CONTRACT_VIOLATION'),
        potentialIssues: count('POTENTIAL_ISSUE'),
      },
      endpoints,
      probes,
      findings,
    };
  };

  // ---- Where requests may go ------------------------------------------------
  const base = resolveBaseUrl(spec, options.docsUrl, options.baseUrlOverride);
  if ('error' in base) return finish('UNAVAILABLE', base.error);
  const baseUrl = new URL(base.url);
  const allowed = new Set([hostKey(options.docsUrl), options.targetUrl ? hostKey(options.targetUrl) : undefined, ...(options.allowedHosts ?? []).map((h) => hostKey(h))].filter((h): h is string => h !== undefined));
  policy.allowedHosts = [...allowed];
  const baseKey = hostKey(baseUrl);
  if (!baseKey || !allowed.has(baseKey)) {
    return finish('UNAVAILABLE',
      `the API base URL ${base.url} is on a host this run may not call (allowed: ${[...allowed].join(', ') || 'none'}). ` +
      'Add it to QA_API_ALLOWED_HOSTS, or set the API base URL to the environment under test.', base);
  }
  if (FORBIDDEN_HOSTNAMES.has(baseUrl.hostname.toLowerCase()) || isForbiddenAddress(baseUrl.hostname)) {
    return finish('UNAVAILABLE', `the API base URL ${base.url} is a link-local or metadata address, which is never called`, base);
  }
  if (!LOOPBACK.has(baseUrl.hostname.toLowerCase()) && !/^[\d.]+$|:/.test(baseUrl.hostname)) {
    try {
      const addresses = await (options.lookupImpl ?? defaultLookup)(baseUrl.hostname);
      if (addresses.some(isForbiddenAddress)) return finish('UNAVAILABLE', `the API host ${baseUrl.hostname} resolves to a link-local or metadata address, which is never called`, base);
    } catch (error) {
      return finish('UNAVAILABLE', `the API host ${baseUrl.hostname} could not be resolved (${(error as { code?: string }).code ?? 'DNS error'})`, base);
    }
  }

  // ---- Sending one request ---------------------------------------------------
  let failuresInARow = 0;
  let stopped: { reason: SkipReason; detail: string } | undefined;
  const budgetLeft = () => policy.requestsSent < maxRequests;

  /** The full URL of a path under the base — and a refusal if it would leave the base's origin. */
  const urlFor = (path: string, query: Record<string, string> = {}): URL | undefined => {
    const url = new URL(baseUrl.toString());
    url.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}${path}`;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.origin === baseUrl.origin ? url : undefined;
  };

  type Sent = { res: LiveResponse; text: string; durationMs: number; error?: undefined } | { error: NonNullable<ApiProbe['error']>; res?: undefined };
  const send = async (url: URL, method: string, headers: Record<string, string>, body?: string): Promise<Sent> => {
    if (policy.requestsSent > 0 && delayMs > 0) await sleep(delayMs);
    policy.requestsSent += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      // Redirects are never followed: a redirect is itself the response, and following one could leave the allowed host.
      const res = await fetchImpl(url.toString(), { method, headers, body, redirect: 'manual', signal: controller.signal });
      const length = Number(res.headers.get('content-length'));
      if (Number.isFinite(length) && length > LIVE_LIMITS.bodyBytes) return { error: { code: 'TOO_LARGE' as const, message: 'the response is larger than 1 MB and was not read' } };
      const text = method === 'HEAD' ? '' : await res.text();
      failuresInARow = 0;
      return { res, text: text.length > LIVE_LIMITS.bodyBytes ? text.slice(0, LIVE_LIMITS.bodyBytes) : text, durationMs: Date.now() - started };
    } catch (error) {
      const e = error as Error & { cause?: { code?: string } };
      if (e.name === 'AbortError') return { error: { code: 'TIMEOUT' as const, message: `no response within ${Math.round(timeoutMs / 1000)}s` } };
      failuresInARow += 1;
      return { error: { code: 'CONNECTION' as const, message: e.cause?.code ?? e.message.split('\n')[0].slice(0, 120) } };
    } finally {
      clearTimeout(timer);
    }
  };

  // ---- Credentials ------------------------------------------------------------
  const schemes = schemesOf(spec);
  let applyAuth: Applier | undefined;
  const auth = options.auth ?? {};
  if (auth.token) {
    applyAuth = applierFor(schemes, auth.token, false);
    authentication = { status: 'READY', method: 'TOKEN' };
  } else if (auth.username && auth.password) {
    const hasBasic = [...schemes.values()].some((s) => (s.type === 'http' && s.scheme === 'basic') || s.type === 'basic');
    if (auth.loginPath) {
      // Signing in is a POST the operator configured by name: it must be an operation the document declares.
      const login = planned.find((p) => p.raw.method === 'POST' && p.raw.path === auth.loginPath);
      if (!login) {
        authentication = { status: 'FAILED', method: 'LOGIN', detail: `QA_API_AUTH_LOGIN_PATH (${auth.loginPath}) is not a documented POST operation` };
      } else {
        const fields = login.endpoint.requestBody?.fields.map((f) => f.name) ?? [];
        const userField = fields.find((f) => /e-?mail|user|login|identifier/i.test(f)) ?? 'username';
        const passField = fields.find((f) => /pass/i.test(f)) ?? 'password';
        const url = urlFor(login.raw.path);
        const sent = url ? await send(url, 'POST', { accept: 'application/json', 'content-type': 'application/json' }, JSON.stringify({ [userField]: auth.username, [passField]: auth.password })) : ({ error: { code: 'BLOCKED', message: 'outside the base URL' } } as Sent);
        if (sent.error) {
          authentication = { status: 'FAILED', method: 'LOGIN', detail: `signing in failed: ${sent.error.message}` };
        } else {
          let token: string | undefined;
          try { token = tokenIn(JSON.parse(sent.text)); } catch { token = undefined; }
          if (sent.res.status >= 200 && sent.res.status < 300 && token) {
            applyAuth = applierFor(schemes, token, false);
            authentication = { status: 'READY', method: 'LOGIN' };
          } else {
            authentication = { status: 'FAILED', method: 'LOGIN', detail: sent.res.status >= 200 && sent.res.status < 300 ? 'signing in succeeded but the response carries no token field' : `signing in responded ${sent.res.status}` };
          }
        }
      }
    } else if (hasBasic) {
      applyAuth = applierFor(schemes, Buffer.from(`${auth.username}:${auth.password}`).toString('base64'), true);
      authentication = { status: 'READY', method: 'BASIC' };
    } else {
      authentication = { status: 'FAILED', detail: 'a user name and password are configured, but the documentation declares no basic authentication: set QA_API_AUTH_LOGIN_PATH to the sign-in operation, or QA_API_AUTH_TOKEN' };
    }
  }

  // ---- One probe ---------------------------------------------------------------
  /** Ids of resources this run created, by the collection path that created them. The only things PUT/PATCH/DELETE may touch. */
  const created = new Map<string, string>();

  const requestBodySchema = (p: Planned): { schema?: unknown; supported: boolean; required: boolean } => {
    if (typeof spec.swagger === 'string') {
      const params = [...(Array.isArray(p.raw.item.parameters) ? p.raw.item.parameters : []), ...(Array.isArray(p.raw.op.parameters) ? p.raw.op.parameters : [])].map((x) => deref(spec, x).node).filter(isObject);
      const body = params.find((x) => x.in === 'body');
      if (params.some((x) => x.in === 'formData')) return { supported: false, required: true };
      return body ? { schema: body.schema, supported: true, required: body.required === true } : { supported: true, required: false };
    }
    const body = deref(spec, p.raw.op.requestBody).node;
    if (!body) return { supported: true, required: false };
    const content = isObject(body.content) ? body.content : {};
    const json = Object.keys(content).find((t) => isJson(t.toLowerCase()));
    return json ? { schema: (content[json] as Json).schema, supported: true, required: body.required === true } : { supported: false, required: true };
  };

  const parametersOf = (p: Planned): Json[] => {
    const merged = new Map<string, Json>();
    for (const raw of [...(Array.isArray(p.raw.item.parameters) ? p.raw.item.parameters : []), ...(Array.isArray(p.raw.op.parameters) ? p.raw.op.parameters : [])]) {
      const node = deref(spec, raw).node;
      if (node && typeof node.name === 'string' && typeof node.in === 'string') merged.set(`${node.in}:${node.name}`, node);
    }
    return [...merged.values()];
  };

  /** A documented value for a parameter — its example, default or first enum member — or nothing. */
  const documentedValue = (param: Json): string | undefined => {
    const schema = deref(spec, param.schema).node ?? param;
    for (const v of [param.example, schema.example, schema.default, Array.isArray(schema.enum) ? schema.enum[0] : undefined]) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return undefined;
  };

  const collectionOf = (path: string): string => path.replace(/\/\{[^}]+\}$/, '');

  const runProbe = async (p: Planned, kind: ProbeKind, pathValues: Record<string, string>, body?: unknown): Promise<ApiProbe | undefined> => {
    const e = view.get(p.raw.id)!;
    const skip = (reason: SkipReason, detail: string) => {
      if (e.execution !== 'EXECUTED') Object.assign(e, { skipReason: reason, skipDetail: detail });
      return undefined;
    };
    if (stopped) return skip(stopped.reason, stopped.detail);
    if (!budgetLeft()) return skip('REQUEST_BUDGET', `the request budget for this run (${maxRequests}) was used up`);

    const params = parametersOf(p);
    let path = p.raw.path;
    for (const param of params.filter((x) => x.in === 'path')) {
      const value = pathValues[String(param.name)];
      if (value === undefined) return skip('MISSING_PARAMETERS', `no value is available for the path parameter "${String(param.name)}"`);
      path = path.replace(`{${String(param.name)}}`, encodeURIComponent(value));
    }
    if (/\{[^}]+\}/.test(path)) return skip('MISSING_PARAMETERS', 'the path has a parameter the documentation does not describe');
    const query: Record<string, string> = {};
    const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5', 'user-agent': 'flue-qa-agents/api-validation' };
    for (const param of params.filter((x) => x.required === true && (x.in === 'query' || x.in === 'header'))) {
      const value = documentedValue(param);
      if (value === undefined) return skip('MISSING_PARAMETERS', `the required ${String(param.in)} parameter "${String(param.name)}" has no documented example or default`);
      if (param.in === 'query') query[String(param.name)] = value;
      else headers[String(param.name).toLowerCase()] = value;
    }
    const url = urlFor(path, query);
    if (!url) return skip('MISSING_PARAMETERS', 'the request would leave the API base URL');
    // Every probe but the deliberately unauthenticated one carries credentials when the operation needs them.
    const withAuth = kind !== 'UNAUTHENTICATED' && p.endpoint.security.length > 0 && applyAuth !== undefined;
    if (withAuth) applyAuth!(url, headers);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = 'application/json';

    const sent = await send(url, p.raw.method, headers, payload);
    const id = `PRB-${probes.length + 1}`;
    // What is stored: the URL without secret values, and headers with the credential replaced.
    const shownHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'user-agent').map(([k, v]) => [k, k === 'authorization' || k === 'cookie' || isSensitiveParamName(k) ? REDACTED : v]));
    for (const name of [...url.searchParams.keys()]) if (withAuth && isSensitiveParamName(name)) url.searchParams.set(name, REDACTED);
    const request = { method: p.raw.method, url: shownUrl(url), headers: shownHeaders, ...(payload !== undefined ? { body: JSON.stringify(redactBody(body)).slice(0, LIVE_LIMITS.bodySample) } : {}) };
    const probe: ApiProbe = { id, endpointId: p.raw.id, kind, request, checks: [] };
    probes.push(probe);
    e.probes.push(id);

    if (sent.error) {
      probe.error = sent.error;
      if (sent.error.code === 'TIMEOUT') {
        findings.push({ id: `APF-${findings.length + 1}`, endpointId: e.id, probeId: id, classification: 'POTENTIAL_ISSUE', type: 'TIMEOUT', severity: 'LOW', title: `${operationKey(p.raw)} did not respond in time`, expected: `A response within ${Math.round(timeoutMs / 1000)}s.`, actual: sent.error.message });
        e.findings.push(findings.at(-1)!.id);
      }
      if (failuresInARow >= LIVE_LIMITS.failuresToAbort) stopped = { reason: 'UNREACHABLE', detail: `the API stopped answering (${sent.error.message}); the remaining operations were not called` };
      if (e.execution !== 'EXECUTED') Object.assign(e, { skipReason: sent.error.code === 'TIMEOUT' ? 'NOT_ATTEMPTED' : 'UNREACHABLE', skipDetail: sent.error.message });
      return probe;
    }

    const contentType = mediaType(sent.res.headers.get('content-type'));
    const kept = keptHeaders(sent.res.headers);
    let parsed: unknown;
    try { parsed = isJson(contentType) || /^\s*[[{]/.test(sent.text) ? JSON.parse(sent.text) : undefined; } catch { parsed = undefined; }
    probe.response = { status: sent.res.status, ...(contentType ? { contentType } : {}), headers: kept, ...sampleOf(sent.text, parsed), durationMs: sent.durationMs };

    const evaluated = evaluateResponse(spec, { method: p.raw.method, path: p.raw.path, op: p.raw.op, security: p.endpoint.security }, kind, { status: sent.res.status, contentType, headers: kept, text: sent.text });
    probe.checks = evaluated.checks;
    probe.evidence = evidenceOf(evaluated.checks);
    for (const f of evaluated.findings) {
      findings.push({ id: `APF-${findings.length + 1}`, endpointId: e.id, probeId: id, ...f });
      e.findings.push(findings.at(-1)!.id);
    }
    if (e.execution !== 'EXECUTED') {
      // Called after all: whatever was noted about not calling it no longer applies.
      e.execution = 'EXECUTED';
      delete e.skipReason;
      delete e.skipDetail;
    }
    (probe.evidence === 'VALIDATED' ? e.validated : e.observed).push(kind);
    // VALIDATED needs a response that matched AND no response that contradicted the documentation:
    // an operation that refuses correctly but returns a body breaking its schema is not validated.
    const violated = e.findings.some((fid) => findings.find((f) => f.id === fid)?.classification === 'CONTRACT_VIOLATION');
    e.evidence = e.validated.length > 0 && !violated ? 'VALIDATED' : 'OBSERVED';

    if (sent.res.status === 429) {
      const retry = sent.res.headers.get('retry-after');
      stopped = { reason: 'RATE_LIMITED', detail: `the API answered 429 (rate limited${retry ? `, retry after ${retry}` : ''}); the remaining operations were not called` };
    }
    // A resource this run created: the only thing later PUT, PATCH and DELETE requests may touch.
    if (p.raw.method === 'POST' && kind === 'VALID_BODY' && sent.res.status >= 200 && sent.res.status < 300) {
      const fromBody = isObject(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? String(parsed.id) : undefined;
      const fromLocation = sent.res.headers.get('location')?.split(/[?#]/)[0].split('/').filter(Boolean).pop();
      const idValue = fromBody ?? fromLocation;
      if (idValue) created.set(p.raw.path, idValue);
    }
    return probe;
  };

  /** Values for an operation's path parameters, or undefined when there are none to be had. */
  const pathValuesFor = (p: Planned, source: 'CREATED' | 'ABSENT' | 'CONFIGURED'): Record<string, string> | undefined => {
    const pathParams = parametersOf(p).filter((x) => x.in === 'path');
    if (pathParams.length === 0) return {};
    const out: Record<string, string> = {};
    for (const [i, param] of pathParams.entries()) {
      const name = String(param.name);
      const last = i === pathParams.length - 1;
      if (source === 'CONFIGURED') {
        const v = options.pathParams?.[name] ?? documentedValue(param);
        if (v === undefined) return undefined;
        out[name] = v;
      } else if (source === 'CREATED') {
        // Only the last parameter can be the created resource; anything before it must be configured.
        const v = last ? created.get(collectionOf(p.raw.path)) : options.pathParams?.[name];
        if (v === undefined) return undefined;
        out[name] = v;
      } else {
        out[name] = last ? absentValue(spec, param.schema ?? param) : options.pathParams?.[name] ?? absentValue(spec, param.schema ?? param);
      }
    }
    return out;
  };

  const secured = (p: Planned) => p.endpoint.security.length > 0;
  const mayRun = (p: Planned): boolean => {
    const e = view.get(p.raw.id)!;
    if (p.raw.method === 'TRACE') {
      Object.assign(e, { skipReason: 'UNSUPPORTED_METHOD', skipDetail: 'TRACE is never sent' });
      return false;
    }
    if (p.safety === 'SAFE') return true;
    const label = p.safety === 'DESTRUCTIVE' ? 'destructive' : p.safety === 'UNSAFE_GET' ? 'named like an action, so it may change state' : 'state-changing';
    if (protectedEnv) {
      Object.assign(e, { skipReason: 'ENVIRONMENT_PROTECTED', skipDetail: `${operationKey(p.raw)} is ${label}; nothing state-changing is sent in the "${environment}" environment` });
      return false;
    }
    if (!approved.includes(operationKey(p.raw))) {
      Object.assign(e, { skipReason: 'APPROVAL_REQUIRED', skipDetail: `${operationKey(p.raw)} is ${label}; it runs only when a person approves this operation for the run` });
      return false;
    }
    return true;
  };

  /** The probes of one operation that needs no request body: refused without credentials, then served with them. */
  const probeRead = async (p: Planned, values: Record<string, string>, absent: boolean) => {
    if (secured(p)) {
      await runProbe(p, 'UNAUTHENTICATED', values);
      if (applyAuth) await runProbe(p, absent ? 'NOT_FOUND' : 'AUTHENTICATED', values);
    } else {
      await runProbe(p, absent ? 'NOT_FOUND' : 'ANONYMOUS', values);
    }
  };

  // ---- 1. Reads: safe by default, action-named ones only when approved ----------
  for (const p of planned.filter((x) => x.safety === 'SAFE' || x.safety === 'UNSAFE_GET')) {
    if (!mayRun(p)) continue;
    const configured = pathValuesFor(p, 'CONFIGURED');
    if (configured) {
      await probeRead(p, configured, false);
    } else if (p.safety === 'SAFE') {
      // No real id to read. What can still be checked safely: that it is refused without
      // credentials, and — where a 404 is documented — that a resource that does not exist is not found.
      const absent = pathValuesFor(p, 'ABSENT')!;
      const documents404 = documentedStatuses(p.raw.op).includes('404');
      if (secured(p)) {
        await runProbe(p, 'UNAUTHENTICATED', absent);
        if (applyAuth && documents404) await runProbe(p, 'NOT_FOUND', absent);
      } else if (documents404) {
        await runProbe(p, 'NOT_FOUND', absent);
      } else {
        Object.assign(view.get(p.raw.id)!, { skipReason: 'MISSING_PARAMETERS', skipDetail: 'no value is available for its path parameter(s); set QA_API_PATH_PARAMS, or approve the operation that creates the resource' });
      }
    } else {
      Object.assign(view.get(p.raw.id)!, { skipReason: 'MISSING_PARAMETERS', skipDetail: 'no value is available for its path parameter(s)' });
    }
  }

  // ---- 2. Creations and other approved POSTs --------------------------------------
  const writes = planned.filter((x) => x.safety === 'STATE_CHANGING' || x.safety === 'DESTRUCTIVE');
  const needsCredentials = (p: Planned) => secured(p) && !applyAuth;
  const runWrite = async (p: Planned, values: Record<string, string>) => {
    const body = requestBodySchema(p);
    if (!body.supported) {
      Object.assign(view.get(p.raw.id)!, { skipReason: 'UNSUPPORTED_BODY', skipDetail: 'its request body is not JSON; only JSON bodies are generated' });
      return;
    }
    if (needsCredentials(p)) {
      // Without credentials the only honest probe is the refusal itself — and only that is sent.
      await runProbe(p, 'UNAUTHENTICATED', values, body.schema === undefined ? undefined : {});
      const e = view.get(p.raw.id)!;
      if (e.execution !== 'EXECUTED') return;
      e.skipDetail = 'only the refusal without credentials was checked: no credentials are configured (QA_API_AUTH_TOKEN, or QA_API_AUTH_USERNAME / QA_API_AUTH_PASSWORD)';
      return;
    }
    const kind: ProbeKind = secured(p) ? 'AUTHENTICATED' : 'ANONYMOUS';
    if (body.schema === undefined) {
      await runProbe(p, kind, values);
      return;
    }
    const schema = deref(spec, body.schema).node ?? {};
    const requires = Array.isArray(schema.required) && schema.required.length > 0;
    if (requires) {
      const invalid = await runProbe(p, 'INVALID_BODY', values, {});
      // It accepted a body without its required fields — recorded as a violation. Nothing more is sent to it.
      if (invalid?.response && invalid.response.status >= 200 && invalid.response.status < 300) return;
    }
    await runProbe(p, 'VALID_BODY', values, sampleValue(spec, body.schema, nonce));
  };

  for (const p of writes.filter((x) => x.raw.method === 'POST')) {
    if (!mayRun(p)) continue;
    const values = pathValuesFor(p, 'CREATED') ?? pathValuesFor(p, 'CONFIGURED');
    if (!values) {
      Object.assign(view.get(p.raw.id)!, { skipReason: 'MISSING_PARAMETERS', skipDetail: 'no value is available for its path parameter(s)' });
      continue;
    }
    await runWrite(p, values);
  }

  // ---- 3. Reads of what this run created -------------------------------------------
  for (const p of planned.filter((x) => x.safety === 'SAFE' && created.has(collectionOf(x.raw.path)) && x.raw.path !== collectionOf(x.raw.path))) {
    const values = pathValuesFor(p, 'CREATED');
    if (values && view.get(p.raw.id)!.validated.every((k) => k !== 'AUTHENTICATED' && k !== 'ANONYMOUS')) await runProbe(p, secured(p) ? 'AUTHENTICATED' : 'ANONYMOUS', values);
  }

  // ---- 4. Changes, then deletions — only of what this run created --------------------
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const p of writes.filter((x) => x.raw.method === method)) {
      if (!mayRun(p)) continue;
      const values = pathValuesFor(p, 'CREATED');
      if (!values) {
        Object.assign(view.get(p.raw.id)!, { skipReason: 'MISSING_TEST_DATA', skipDetail: `${method} only ever touches a resource this run created, and none was: approve the POST that creates it` });
        continue;
      }
      await runWrite(p, values);
      if (method === 'DELETE' && view.get(p.raw.id)!.execution === 'EXECUTED') created.delete(collectionOf(p.raw.path));
    }
  }

  const executed = endpoints.filter((e) => e.execution === 'EXECUTED').length;
  if (executed === 0 && stopped?.reason === 'UNREACHABLE') return finish('UNAVAILABLE', `the API at ${base.url} could not be reached (${probes.find((x) => x.error)?.error?.message ?? 'no response'})`, base);
  if (stopped) return finish('PARTIAL', stopped.detail, base);
  if (!budgetLeft() && endpoints.some((e) => e.skipReason === 'REQUEST_BUDGET')) return finish('PARTIAL', `the request budget (${maxRequests}) was used up before every operation was called`, base);
  return finish('COMPLETED', undefined, base);
}

// ---------------------------------------------------------------------------
// The plan, without sending anything
// ---------------------------------------------------------------------------

export interface ApiValidationPlan {
  baseUrl?: string;
  baseUrlSource?: NonNullable<ApiValidation['baseUrlSource']>;
  /** False when the base URL is on a host the run may not call; `reason` says why. */
  allowed: boolean;
  reason?: string;
  allowedHosts: string[];
  environment: string;
  /** True when nothing state-changing can be approved here. */
  protectedEnvironment: boolean;
  operations: { id: string; method: string; path: string; summary?: string; safety: OperationSafety; secured: boolean; needsApproval: boolean }[];
}

/**
 * What live validation would do for this documentation, decided the same way
 * `validateApi` decides it — but nothing is sent. This is what a person reads
 * before approving a state-changing operation.
 */
export function planApiValidation(spec: Json, discovery: ApiDiscovery, options: Pick<ApiValidationOptions, 'docsUrl' | 'targetUrl' | 'baseUrlOverride' | 'allowedHosts' | 'environment'>): ApiValidationPlan {
  const environment = (options.environment ?? 'test').trim() || 'test';
  const allowed = new Set([hostKey(options.docsUrl), options.targetUrl ? hostKey(options.targetUrl) : undefined, ...(options.allowedHosts ?? []).map((h) => hostKey(h))].filter((h): h is string => h !== undefined));
  const byId = new Map(discovery.endpoints.map((e) => [e.id, e]));
  const operations = rawOperations(spec).filter((r) => byId.has(r.id)).map((raw) => {
    const e = byId.get(raw.id)!;
    const safety = operationSafety({ method: raw.method, path: raw.path, operationId: e.operationId });
    return { id: raw.id, method: raw.method, path: raw.path, ...(e.summary ? { summary: e.summary } : {}), safety, secured: e.security.length > 0, needsApproval: safety !== 'SAFE' };
  });
  const plan: ApiValidationPlan = { allowed: false, allowedHosts: [...allowed], environment, protectedEnvironment: isProtectedEnvironment(environment), operations };
  const base = resolveBaseUrl(spec, options.docsUrl, options.baseUrlOverride);
  if ('error' in base) return { ...plan, reason: base.error };
  const url = new URL(base.url);
  const key = hostKey(url);
  if (FORBIDDEN_HOSTNAMES.has(url.hostname.toLowerCase()) || isForbiddenAddress(url.hostname)) {
    return { ...plan, baseUrl: base.url, baseUrlSource: base.source, reason: 'that is a link-local or metadata address, which is never called' };
  }
  if (!key || !allowed.has(key)) {
    return { ...plan, baseUrl: base.url, baseUrlSource: base.source, reason: `${url.host} is not a host this workspace may call (allowed: ${[...allowed].join(', ') || 'none'}); add it to QA_API_ALLOWED_HOSTS, or set the API base URL` };
  }
  return { ...plan, baseUrl: base.url, baseUrlSource: base.source, allowed: true };
}

// ---------------------------------------------------------------------------
// The artifact as evidence
// ---------------------------------------------------------------------------

export const PROBE_ID = /^PRB-\d+$/;

export const hasLiveEvidence = (validation: ApiValidation | undefined): validation is ApiValidation =>
  validation !== undefined && (validation.status === 'COMPLETED' || validation.status === 'PARTIAL') && validation.probes.some((p) => p.response !== undefined);

/** One probe as a sentence: what was sent, what came back, and what the host made of it. */
export function describeProbe(probe: ApiProbe, endpoint: { method: string; path: string }, findings: readonly ApiFinding[] = []): string {
  if (!probe.response) return `${endpoint.method} ${endpoint.path} ${KIND_PHRASE[probe.kind]} got no response (${probe.error?.message ?? 'unknown'}).`;
  const mine = findings.filter((f) => f.probeId === probe.id);
  return (
    `Observed: ${endpoint.method} ${endpoint.path} ${KIND_PHRASE[probe.kind]} responded with status ${probe.response.status}` +
    `${probe.response.contentType ? ` and content type ${probe.response.contentType}` : ''}. ` +
    (probe.evidence === 'VALIDATED' ? 'The response matched the documented contract.' : mine.length > 0 ? mine.map((f) => `${f.title}.`).join(' ') : 'The response could not be fully checked against the documentation.')
  );
}

/** The evidence class of one operation; DOCUMENTED when there is no live result for it. */
export function evidenceClassOf(validation: ApiValidation | undefined, endpointId: string): EvidenceClass {
  return validation?.endpoints.find((e) => e.id === endpointId)?.evidence ?? 'DOCUMENTED';
}

/** The strongest class among several operations — what a test case citing them rests on. */
export function strongestEvidence(classes: readonly EvidenceClass[]): EvidenceClass | undefined {
  if (classes.length === 0) return undefined;
  return classes.includes('VALIDATED') ? 'VALIDATED' : classes.includes('OBSERVED') ? 'OBSERVED' : 'DOCUMENTED';
}

/** Every sentence the live results support — added to what the documentation states. */
export function validationEvidenceTexts(validation: ApiValidation | undefined): string[] {
  if (!hasLiveEvidence(validation)) return [];
  const endpoints = new Map(validation.endpoints.map((e) => [e.id, e]));
  return validation.probes.filter((p) => p.response).map((p) => describeProbe(p, endpoints.get(p.endpointId)!, validation.findings));
}

export interface ApiBehavior { id: string; area: string; statement: string; status: 'CONFIRMED' | 'OBSERVED'; confidence: 'high'; suspectedIssue: boolean; source: string[] }

/**
 * The API evidence in the shape the defect rules already understand: each
 * documented operation as a CONFIRMED behavior (the run was given it), each
 * executed probe as an OBSERVED one (the host saw it), in an area of its own.
 * A probe with a contract violation is a suspected issue, so defect analysis
 * must account for it exactly as it accounts for one discovery flagged.
 */
export function apiEvidenceBehaviors(api: ApiDiscovery | undefined, validation: ApiValidation | undefined): {
  area?: { name: string; routes: string[]; notes: string[] };
  behaviors: ApiBehavior[];
} {
  if (!hasApi(api)) return { behaviors: [] };
  const area = 'API';
  const behaviors: ApiBehavior[] = api.endpoints.map((e) => ({
    id: e.id, area, statement: `Documented: ${describeEndpoint(e)}`, status: 'CONFIRMED', confidence: 'high', suspectedIssue: false, source: ['API documentation'],
  }));
  const live = hasLiveEvidence(validation) ? validation : undefined;
  if (live) {
    const endpoints = new Map(live.endpoints.map((e) => [e.id, e]));
    for (const p of live.probes.filter((x) => x.response)) {
      behaviors.push({
        id: p.id, area, statement: describeProbe(p, endpoints.get(p.endpointId)!, live.findings), status: 'OBSERVED', confidence: 'high',
        suspectedIssue: live.findings.some((f) => f.probeId === p.id && f.classification === 'CONTRACT_VIOLATION'), source: ['live API request'],
      });
    }
  }
  return { area: { name: area, routes: live?.baseUrl ? [live.baseUrl] : [], notes: [] }, behaviors };
}

/** The few numbers a briefing, a run record and the workspace header carry. */
export function apiValidationSummary(validation: ApiValidation | undefined): ApiValidation['summary'] & { status: ValidationStatus; reason?: string; baseUrl?: string; authentication: ApiValidation['authentication']['status'] } {
  if (validation === undefined) return { status: 'NOT_REQUESTED', ...EMPTY_SUMMARY, authentication: 'NOT_CONFIGURED' };
  return {
    status: validation.status,
    ...(validation.reason ? { reason: validation.reason } : {}),
    ...(validation.baseUrl ? { baseUrl: validation.baseUrl } : {}),
    ...validation.summary,
    authentication: validation.authentication.status,
  };
}

// ---------------------------------------------------------------------------
// API discovery as a workflow of its own
// ---------------------------------------------------------------------------

export interface DiscoveryCriterion { name: 'DOCUMENTATION_READ' | 'OPERATIONS_DISCOVERED' | 'OPERATIONS_ACCOUNTED_FOR' | 'LIVE_OBSERVATION'; met: boolean; required: boolean; detail: string }
export interface ApiDiscoveryCompletion {
  /** COMPLETE: every required criterion is met. BLOCKED: one is not, and `reason` says which. */
  status: 'COMPLETE' | 'BLOCKED';
  reason?: string;
  /** DOCUMENTATION_ONLY when nothing was observed live — a limitation, not a failure. */
  evidence: 'LIVE' | 'DOCUMENTATION_ONLY' | 'NONE';
  criteria: DiscoveryCriterion[];
}

/**
 * Whether API discovery is finished — judged by its own criteria, none of which
 * mentions a browser, a page or a UI location:
 *
 *   DOCUMENTATION_READ        the documentation was fetched and is an OpenAPI/Swagger document
 *   OPERATIONS_DISCOVERED     it declares at least one operation
 *   OPERATIONS_ACCOUNTED_FOR  when the API was called, every operation was either called or
 *                             skipped with a recorded reason — none silently dropped
 *   LIVE_OBSERVATION          at least one real response was captured. Not required: without
 *                             it discovery is complete on the documentation alone, and says so
 *
 * UI discovery has its own gate (src/lib/discovery-completion.ts). Neither reads the other.
 */
export function apiDiscoveryCompletion(discovery: ApiDiscovery | undefined, validation: ApiValidation | undefined): ApiDiscoveryCompletion {
  const read = discovery !== undefined && discovery.status === 'AVAILABLE';
  const operations = read ? discovery.endpoints.length : 0;
  const live = hasLiveEvidence(validation);
  const notCalledBecause = validation?.reason ?? 'the API was not called';
  const called = validation !== undefined && (validation.status === 'COMPLETED' || validation.status === 'PARTIAL');
  const unaccounted = called ? validation.endpoints.filter((e) => e.execution === 'SKIPPED' && !e.skipReason).map((e) => e.id) : [];
  const accounted = !called || (validation.endpoints.length === operations && unaccounted.length === 0);
  const criteria: DiscoveryCriterion[] = [
    { name: 'DOCUMENTATION_READ', required: true, met: read, detail: read ? `read as ${discovery.source?.format ?? 'a specification'}` : discovery?.reason ?? 'no API documentation was given' },
    { name: 'OPERATIONS_DISCOVERED', required: true, met: operations > 0, detail: `${operations} documented operation(s)` },
    { name: 'OPERATIONS_ACCOUNTED_FOR', required: true, met: accounted, detail: called ? `${validation.summary.endpoints - validation.summary.skipped} called, ${validation.summary.skipped} skipped with a reason${unaccounted.length ? `; unaccounted: ${unaccounted.join(', ')}` : ''}` : 'the API was not called, so there is nothing to account for' },
    { name: 'LIVE_OBSERVATION', required: false, met: live, detail: live ? `${validation.summary.requests} request(s), ${validation.summary.validated} operation(s) validated` : notCalledBecause },
  ];
  const failed = criteria.find((c) => c.required && !c.met);
  return {
    status: failed ? 'BLOCKED' : 'COMPLETE',
    ...(failed ? { reason: `${failed.name.toLowerCase().replace(/_/g, ' ')}: ${failed.detail}` } : {}),
    evidence: !read || operations === 0 ? 'NONE' : live ? 'LIVE' : 'DOCUMENTATION_ONLY',
    criteria,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** What a person chose for one run. Everything else about live validation is host configuration. */
export interface LiveValidationChoice { enabled: boolean; baseUrl?: string; approvedOperations: string[] }

/** `true`/`false`/`1`/`0`/`on`/`off`; anything else is undefined. */
export function parseSwitch(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return ['true', '1', 'on', 'yes'].includes(v) ? true : ['false', '0', 'off', 'no'].includes(v) ? false : undefined;
}

/** `{"id": "42"}` -> the map, keeping only plain names and short scalar values. */
function parsePathParams(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([k, v]) => /^[A-Za-z0-9_.-]{1,60}$/.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 200)
      .map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

const positive = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * The options for a run: the person's choice, plus what only the host may
 * configure — credentials, extra allowed hosts, the environment, limits:
 *
 *   QA_API_ALLOWED_HOSTS       extra host[:port] the API may be on (comma-separated)
 *   QA_API_ENVIRONMENT         a name; `production` forbids every state-changing request
 *   QA_API_AUTH_TOKEN          a bearer token or API key, used as given
 *   QA_API_AUTH_USERNAME / QA_API_AUTH_PASSWORD
 *   QA_API_AUTH_LOGIN_PATH     the documented POST that turns those into a token
 *   QA_API_PATH_PARAMS         JSON: values for path parameters of safe requests
 *   QA_API_MAX_REQUESTS / QA_API_TIMEOUT_MS
 */
export function liveValidationOptions(
  choice: LiveValidationChoice,
  context: { docsUrl: string; targetUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): ApiValidationOptions {
  const value = (name: string) => env[name]?.trim() || undefined;
  return {
    enabled: choice.enabled,
    docsUrl: context.docsUrl,
    targetUrl: context.targetUrl,
    baseUrlOverride: choice.baseUrl,
    allowedHosts: (value('QA_API_ALLOWED_HOSTS') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    environment: value('QA_API_ENVIRONMENT') ?? 'test',
    approvedOperations: choice.approvedOperations,
    auth: { token: value('QA_API_AUTH_TOKEN'), username: value('QA_API_AUTH_USERNAME'), password: value('QA_API_AUTH_PASSWORD'), loginPath: value('QA_API_AUTH_LOGIN_PATH') },
    pathParams: parsePathParams(value('QA_API_PATH_PARAMS')),
    maxRequests: positive(value('QA_API_MAX_REQUESTS')),
    timeoutMs: positive(value('QA_API_TIMEOUT_MS')),
  };
}

/** Whether credentials are configured — a yes or no for the workspace, never the values. */
export function credentialsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.QA_API_AUTH_TOKEN?.trim() || (env.QA_API_AUTH_USERNAME?.trim() && env.QA_API_AUTH_PASSWORD?.trim()));
}
