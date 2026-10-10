// API discovery: what a product's API documentation declares, read by the host.
//
// A run may be given the URL of an OpenAPI / Swagger document — JSON, YAML, or a
// Swagger UI page that embeds or points at one. Host code fetches it, parses it
// and writes the `api-discovery` artifact: endpoints, methods, parameters,
// request and response shapes, authentication, status codes.
//
// No model takes part. The artifact is readable by the agents and writable by
// none of them, exactly like the browser evidence: a model may interpret the
// documentation and may not author, amend or extend it. Every operation gets a
// host-assigned id (API-1, API-2 …) that downstream artifacts cite as evidence,
// so "never invent an endpoint" is a check against this file, not an instruction.
//
// Documentation is optional and may be wrong, private or down. Nothing here
// throws for that: the result is an artifact whose status says UNAVAILABLE and
// why, and the run decides what that means for its mode.

import { parse as parseYaml } from 'yaml';
import { coverageBriefing, displayApiDocsUrl, normalizeApiDocsUrl, type CoverageMode } from './coverage-mode.ts';

export type ApiDiscoveryStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_REQUESTED';
export type ApiSpecFormat = 'OPENAPI_JSON' | 'OPENAPI_YAML' | 'SWAGGER_UI';

export interface ApiField { name: string; type: string; required: boolean; constraints?: string }
export interface ApiParameter { name: string; in: string; required: boolean; type?: string; description?: string }
export interface ApiResponse { status: string; description?: string; schema?: string; fields?: ApiField[] }
export interface ApiEndpoint {
  /** Host-assigned, in document order. What downstream artifacts cite. */
  id: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters: ApiParameter[];
  requestBody?: { required: boolean; contentTypes: string[]; schema?: string; fields: ApiField[] };
  responses: ApiResponse[];
  /** Ids of the authentication schemes this operation requires; empty when it is open. */
  security: string[];
}
export interface ApiAuthScheme {
  id: string;
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
  flows?: string[];
  description?: string;
}
export interface ApiSchema { name: string; type?: string; description?: string; fields: ApiField[] }

export interface ApiDiscovery {
  status: ApiDiscoveryStatus;
  /** Why there is nothing here, when there is nothing here. */
  reason?: string;
  source?: { url: string; specUrl?: string; format: ApiSpecFormat; specVersion?: string; fetchedAt?: string };
  title?: string;
  version?: string;
  servers?: string[];
  authentication: ApiAuthScheme[];
  endpoints: ApiEndpoint[];
  schemas: ApiSchema[];
  /** How many entries the caps below left out, when any. */
  truncated?: { endpoints?: number; schemas?: number };
}

/** Caps: the artifact is read whole by a model, so it stays readable by one. */
export const LIMITS = {
  endpoints: 200,
  schemas: 80,
  fields: 30,
  parameters: 30,
  responses: 12,
  text: 200,
  bytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  /** Candidate spec locations tried behind a Swagger UI page. */
  candidates: 8,
} as const;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const clip = (v: unknown, max: number = LIMITS.text): string | undefined => {
  const s = str(v)?.replace(/\s+/g, ' ');
  return s === undefined ? undefined : s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};
/** Drop undefined members, so the artifact never carries a key with no value. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const notRequested = (reason?: string): ApiDiscovery =>
  compact({ status: 'NOT_REQUESTED' as const, reason, authentication: [], endpoints: [], schemas: [] });

export const unavailable = (url: string | undefined, reason: string): ApiDiscovery =>
  compact({
    status: 'UNAVAILABLE' as const,
    reason: clip(reason, 300) ?? 'unknown problem',
    source: url ? { url: displayApiDocsUrl(url) ?? url, format: 'OPENAPI_JSON' as const } : undefined,
    authentication: [],
    endpoints: [],
    schemas: [],
  });

// ---------------------------------------------------------------------------
// Reading a specification
// ---------------------------------------------------------------------------

/** Is this a parsed OpenAPI 3.x or Swagger 2.0 document? */
export function isSpec(value: unknown): value is Json {
  return isObject(value) && (typeof value.openapi === 'string' || typeof value.swagger === 'string') && isObject(value.paths);
}

/** Parse JSON or YAML text into a specification, or say why it is not one. */
export function parseSpecText(text: string): { spec: Json; format: 'OPENAPI_JSON' | 'OPENAPI_YAML' } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: 'the document is empty' };
  if (trimmed.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return isSpec(value) ? { spec: value, format: 'OPENAPI_JSON' } : { error: 'the JSON is not an OpenAPI or Swagger document (no "openapi"/"swagger" version with "paths")' };
    } catch (error) {
      return { error: `the JSON could not be parsed (${(error as Error).message.split('\n')[0]})` };
    }
  }
  try {
    const value: unknown = parseYaml(trimmed, { maxAliasCount: 100 });
    return isSpec(value) ? { spec: value, format: 'OPENAPI_YAML' } : { error: 'the document is not an OpenAPI or Swagger document (no "openapi"/"swagger" version with "paths")' };
  } catch (error) {
    return { error: `the YAML could not be parsed (${(error as Error).message.split('\n')[0]})` };
  }
}

const looksLikeHtml = (text: string) => /^\s*(<!doctype html|<html|<head|<body)/i.test(text) || /<script[\s>]/i.test(text.slice(0, 20_000));

/**
 * What a Swagger UI page says about where its specification is.
 *
 *   - `spec`: the page embeds the document itself (`<script type="application/json">`
 *     holding the spec or `{ "spec": … }`, as API Platform / NelmioApiDoc render it);
 *   - `urls`: the page names it (`url: "…"`, `urls: [{ url: "…" }]`, a
 *     `swagger-initializer.js`, or `configUrl`), resolved against the page;
 *   - plus the conventional locations beside the page, as a last resort.
 */
export function inspectSwaggerUi(html: string, pageUrl: string): { spec?: Json; urls: string[]; scripts: string[] } {
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value: unknown = JSON.parse(m[1]);
      if (isSpec(value)) return { spec: value, urls: [], scripts: [] };
      if (isObject(value) && isSpec(value.spec)) return { spec: value.spec, urls: [], scripts: [] };
    } catch { /* not JSON, or not the spec: keep looking */ }
  }

  const resolve = (raw: string): string | undefined => {
    try {
      return normalizeApiDocsUrl(new URL(raw, pageUrl).toString());
    } catch {
      return undefined;
    }
  };
  const urls: string[] = [];
  const add = (raw: string | undefined) => {
    const url = raw === undefined ? undefined : resolve(raw);
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const m of html.matchAll(/\b(?:url|configUrl)\s*[:=]\s*["'`]([^"'`\s]{1,400})["'`]/g)) add(m[1]);
  for (const m of html.matchAll(/["']url["']\s*:\s*["']([^"'\s]{1,400})["']/g)) add(m[1]);

  // A separate initializer script is where a stock Swagger UI keeps its `url:`.
  const scripts: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']{1,400})["']/gi)) {
    if (/initializer|swagger-config|swagger-ui-init/i.test(m[1])) {
      const url = resolve(m[1]);
      if (url && !scripts.includes(url)) scripts.push(url);
    }
  }

  const page = new URL(pageUrl);
  const base = page.pathname.replace(/\/(index\.html?)?$/, '');
  for (const candidate of [
    `${base}.json`, `${base}-json`, `${base}/swagger.json`, `${base}/openapi.json`, `${base}.yaml`,
    '/openapi.json', '/swagger.json', '/v3/api-docs', '/v2/api-docs', '/api-docs', '/swagger/v1/swagger.json', '/openapi.yaml',
  ]) add(candidate);
  return { urls, scripts };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Follow a local `$ref` (`#/components/schemas/Note`); anything else resolves to nothing. */
export function deref(spec: Json, node: unknown, seen: Set<string> = new Set()): { node: Json | undefined; name?: string } {
  if (!isObject(node)) return { node: undefined };
  const ref = node.$ref;
  if (typeof ref !== 'string') return { node };
  if (!ref.startsWith('#/') || seen.has(ref)) return { node: undefined, name: ref.split('/').pop() };
  seen.add(ref);
  let target: unknown = spec;
  for (const part of ref.slice(2).split('/')) {
    target = isObject(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  const resolved = deref(spec, target, seen);
  return { node: resolved.node, name: resolved.name ?? ref.split('/').pop() };
}

/** A schema's type in a few words: `string`, `integer`, `Note[]`, `string|null`, `Note`. */
function typeOf(spec: Json, node: unknown, depth = 0): string {
  if (!isObject(node)) return 'unknown';
  if (typeof node.$ref === 'string') return node.$ref.split('/').pop() ?? 'object';
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const parts = list(node[key]);
    if (parts.length > 0 && depth < 3) return [...new Set(parts.map((p) => typeOf(spec, p, depth + 1)))].join(key === 'allOf' ? '&' : '|');
  }
  const type = Array.isArray(node.type) ? node.type.filter((t) => typeof t === 'string').join('|') : str(node.type);
  if (type === 'array') return `${depth < 3 ? typeOf(spec, node.items, depth + 1) : 'unknown'}[]`;
  const format = str(node.format);
  const base = type ?? (isObject(node.properties) ? 'object' : 'unknown');
  return `${base}${format ? `(${format})` : ''}${node.nullable === true ? '|null' : ''}`;
}

/** The limits a schema states, as one short string: `enum: a|b; maxLength: 80`. */
function constraintsOf(node: Json): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(node.enum)) parts.push(`enum: ${node.enum.slice(0, 12).map(String).join('|')}`);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'default'] as const) {
    const value = node[key];
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') parts.push(`${key}: ${String(value)}`);
  }
  if (node.readOnly === true) parts.push('readOnly');
  if (node.writeOnly === true) parts.push('writeOnly');
  return parts.length > 0 ? clip(parts.join('; '), 160) : undefined;
}

/** The properties of an object schema (through `$ref` and `allOf`), one level deep. */
function fieldsOf(spec: Json, node: unknown, depth = 0): ApiField[] {
  const { node: schema } = deref(spec, node);
  if (!schema || depth > 3) return [];
  const out = new Map<string, ApiField>();
  for (const part of list(schema.allOf)) for (const f of fieldsOf(spec, part, depth + 1)) out.set(f.name, f);
  // An array of objects is described by its items.
  if (schema.type === 'array' && !isObject(schema.properties)) return fieldsOf(spec, schema.items, depth + 1);
  const required = new Set(list(schema.required).filter((r): r is string => typeof r === 'string'));
  if (isObject(schema.properties)) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      const resolved = deref(spec, prop).node ?? {};
      out.set(name, compact({ name, type: typeOf(spec, prop), required: required.has(name), constraints: constraintsOf(resolved) }));
    }
  }
  return [...out.values()].slice(0, LIMITS.fields);
}

/** The name a body or response schema goes by, when it has one. */
function schemaName(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  if (typeof node.$ref === 'string') return node.$ref.split('/').pop();
  if (node.type === 'array' && isObject(node.items) && typeof node.items.$ref === 'string') return `${node.items.$ref.split('/').pop()}[]`;
  return undefined;
}

/** OpenAPI 3 `content` -> its media types and the first JSON-ish schema among them. */
function contentOf(content: unknown): { contentTypes: string[]; schema: unknown } {
  if (!isObject(content)) return { contentTypes: [], schema: undefined };
  const types = Object.keys(content);
  const preferred = types.find((t) => /json/i.test(t)) ?? types[0];
  return { contentTypes: types.slice(0, 6), schema: preferred && isObject(content[preferred]) ? (content[preferred] as Json).schema : undefined };
}

function authSchemes(spec: Json): ApiAuthScheme[] {
  const defs = isObject(spec.components) && isObject(spec.components.securitySchemes)
    ? spec.components.securitySchemes
    : isObject(spec.securityDefinitions) ? spec.securityDefinitions : {};
  return Object.entries(defs).map(([id, raw]) => {
    const def = deref(spec, raw).node ?? {};
    const flows = isObject(def.flows) ? Object.keys(def.flows) : str(def.flow) ? [str(def.flow)!] : undefined;
    return compact({
      id,
      // Swagger 2 says `basic`; OpenAPI 3 says `http` + scheme `basic`. Both are kept as written.
      type: str(def.type) ?? 'unknown',
      scheme: str(def.scheme),
      bearerFormat: str(def.bearerFormat),
      in: str(def.in),
      name: str(def.name),
      flows,
      description: clip(def.description),
    });
  });
}

/** Scheme ids from a `security` requirement list; `[]` or `[{}]` means open. */
const securityIds = (security: unknown): string[] | undefined =>
  Array.isArray(security) ? [...new Set(security.flatMap((s) => (isObject(s) ? Object.keys(s) : [])))] : undefined;

/** One operation as the document states it, with the id the artifact gives it. */
export interface RawOperation { id: string; method: string; path: string; op: Json; item: Json }

/**
 * The document's operations in the order — and under the cap — the artifact
 * lists them, so `API-n` here is `API-n` there. Live validation works from
 * these: it needs the full schemas the artifact only summarises.
 */
export function rawOperations(spec: Json): RawOperation[] {
  const out: RawOperation[] = [];
  for (const [path, rawItem] of Object.entries(isObject(spec.paths) ? spec.paths : {})) {
    const item = deref(spec, rawItem).node;
    if (!item || !path.startsWith('/')) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op) || out.length >= LIMITS.endpoints) continue;
      out.push({ id: `API-${out.length + 1}`, method: method.toUpperCase(), path, op, item });
    }
  }
  return out;
}

/** Everything the host keeps from a parsed specification. Pure. */
export function extractApiDiscovery(spec: Json, source: NonNullable<ApiDiscovery['source']>): ApiDiscovery {
  const globalSecurity = securityIds(spec.security) ?? [];
  const isV2 = typeof spec.swagger === 'string';
  const endpoints: ApiEndpoint[] = [];
  let total = 0;

  for (const [path, rawItem] of Object.entries(isObject(spec.paths) ? spec.paths : {})) {
    const item = deref(spec, rawItem).node;
    if (!item || !path.startsWith('/')) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      total += 1;
      if (endpoints.length >= LIMITS.endpoints) continue;

      // Path-level parameters apply to every operation; the operation's own win on a name clash.
      const params = new Map<string, Json>();
      for (const raw of [...list(item.parameters), ...list(op.parameters)]) {
        const p = deref(spec, raw).node;
        if (p && str(p.name) && str(p.in)) params.set(`${p.in}:${p.name}`, p);
      }
      const all = [...params.values()];
      const parameters: ApiParameter[] = all.filter((p) => p.in !== 'body' && p.in !== 'formData').slice(0, LIMITS.parameters).map((p) => compact({
        name: str(p.name)!,
        in: str(p.in)!,
        required: p.required === true || p.in === 'path',
        type: typeOf(spec, isObject(p.schema) ? p.schema : p),
        description: clip(p.description, 120),
      }));

      let requestBody: ApiEndpoint['requestBody'];
      if (isV2) {
        const body = all.find((p) => p.in === 'body');
        const form = all.filter((p) => p.in === 'formData');
        if (body) {
          requestBody = compact({
            required: body.required === true,
            contentTypes: list(op.consumes ?? spec.consumes).filter((c): c is string => typeof c === 'string').slice(0, 6),
            schema: schemaName(body.schema),
            fields: fieldsOf(spec, body.schema),
          });
        } else if (form.length > 0) {
          requestBody = {
            required: form.some((p) => p.required === true),
            contentTypes: list(op.consumes ?? spec.consumes).filter((c): c is string => typeof c === 'string').slice(0, 6),
            fields: form.slice(0, LIMITS.fields).map((p) => compact({ name: str(p.name)!, type: typeOf(spec, p), required: p.required === true, constraints: constraintsOf(p) })),
          };
        }
      } else {
        const body = deref(spec, op.requestBody).node;
        if (body) {
          const { contentTypes, schema } = contentOf(body.content);
          requestBody = compact({ required: body.required === true, contentTypes, schema: schemaName(schema), fields: fieldsOf(spec, schema) });
        }
      }

      const responses: ApiResponse[] = Object.entries(isObject(op.responses) ? op.responses : {}).slice(0, LIMITS.responses).map(([status, raw]) => {
        const r = deref(spec, raw).node ?? {};
        const schema = isV2 ? r.schema : contentOf(r.content).schema;
        const fields = fieldsOf(spec, schema);
        return compact({ status: String(status), description: clip(r.description, 160), schema: schemaName(schema), fields: fields.length > 0 ? fields : undefined });
      });

      const tags = list(op.tags).filter((t): t is string => typeof t === 'string').slice(0, 6);
      endpoints.push(compact({
        id: `API-${endpoints.length + 1}`,
        method: method.toUpperCase(),
        path,
        operationId: clip(op.operationId, 120),
        summary: clip(op.summary ?? op.description),
        tags: tags.length > 0 ? tags : undefined,
        deprecated: op.deprecated === true ? true : undefined,
        parameters,
        requestBody,
        responses,
        security: securityIds(op.security) ?? globalSecurity,
      }));
    }
  }

  const definitions = isObject(spec.components) && isObject(spec.components.schemas)
    ? spec.components.schemas
    : isObject(spec.definitions) ? spec.definitions : {};
  const names = Object.keys(definitions);
  const schemas: ApiSchema[] = names.slice(0, LIMITS.schemas).map((name) => {
    const node = deref(spec, definitions[name]).node ?? {};
    return compact({ name, type: str(node.type) ?? (isObject(node.properties) ? 'object' : undefined), description: clip(node.description), fields: fieldsOf(spec, node) });
  });

  const servers = isV2
    ? (str(spec.host) ? [`${list(spec.schemes).find((s) => typeof s === 'string') ?? 'https'}://${spec.host}${str(spec.basePath) ?? ''}`] : str(spec.basePath) ? [str(spec.basePath)!] : [])
    : list(spec.servers).map((s) => (isObject(s) ? str(s.url) : undefined)).filter((s): s is string => s !== undefined).slice(0, 6);
  const info = isObject(spec.info) ? spec.info : {};
  const truncated = compact({
    endpoints: total > endpoints.length ? total - endpoints.length : undefined,
    schemas: names.length > schemas.length ? names.length - schemas.length : undefined,
  });

  if (endpoints.length === 0) {
    return { ...unavailable(source.url, 'the document declares no operations'), source };
  }
  return compact({
    status: 'AVAILABLE' as const,
    source: compact({ ...source, specVersion: str(spec.openapi) ?? str(spec.swagger) }),
    title: clip(info.title, 120),
    version: clip(info.version, 40),
    servers: servers.length > 0 ? servers : undefined,
    authentication: authSchemes(spec),
    endpoints,
    schemas,
    truncated: Object.keys(truncated).length > 0 ? truncated : undefined,
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'follow' }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

async function fetchText(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<{ text: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > LIMITS.bytes) return { error: 'the document is larger than 5 MB' };
    const text = await res.text();
    if (text.length > LIMITS.bytes) return { error: 'the document is larger than 5 MB' };
    return { text };
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } };
    if (e.name === 'AbortError') return { error: `no response within ${Math.round(timeoutMs / 1000)}s` };
    return { error: e.cause?.code ?? e.cause?.message?.split('\n')[0] ?? e.message.split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the API documentation at `rawUrl` and return the artifact. Never throws:
 * a URL that cannot be fetched, is not a specification, or declares nothing
 * comes back as `UNAVAILABLE` with the reason.
 */
export async function discoverApi(
  rawUrl: string | undefined,
  options: { fetchImpl?: FetchLike; now?: () => Date; timeoutMs?: number } = {},
): Promise<ApiDiscovery> {
  return (await discoverApiDocument(rawUrl, options)).discovery;
}

/**
 * The same, keeping the parsed document beside the artifact. Live validation
 * needs it — full request and response schemas, servers, security — and it is
 * never persisted: only what `extractApiDiscovery` keeps reaches disk.
 */
export async function discoverApiDocument(
  rawUrl: string | undefined,
  options: { fetchImpl?: FetchLike; now?: () => Date; timeoutMs?: number } = {},
): Promise<{ discovery: ApiDiscovery; spec?: Json }> {
  const found = await locateSpec(rawUrl, options);
  return 'discovery' in found ? found : { discovery: extractApiDiscovery(found.spec, found.source), spec: found.spec };
}

async function locateSpec(
  rawUrl: string | undefined,
  options: { fetchImpl?: FetchLike; now?: () => Date; timeoutMs?: number },
): Promise<{ discovery: ApiDiscovery } | { spec: Json; source: NonNullable<ApiDiscovery['source']> }> {
  if (rawUrl === undefined || rawUrl.trim() === '') return { discovery: notRequested('no API documentation URL was given') };
  const url = normalizeApiDocsUrl(rawUrl);
  if (url === undefined) return { discovery: unavailable(undefined, 'the API documentation URL is not a valid http(s) URL') };
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const shown = displayApiDocsUrl(url) ?? url;

  const first = await fetchText(url, fetchImpl, timeoutMs);
  if ('error' in first) return { discovery: unavailable(url, `could not be fetched: ${first.error}`) };

  if (!looksLikeHtml(first.text)) {
    const parsed = parseSpecText(first.text);
    if ('error' in parsed) return { discovery: unavailable(url, parsed.error) };
    return { spec: parsed.spec, source: { url: shown, format: parsed.format, fetchedAt } };
  }

  // A Swagger UI page: the specification is embedded in it, or it says where it is.
  const page = inspectSwaggerUi(first.text, url);
  if (page.spec) return { spec: page.spec, source: { url: shown, format: 'SWAGGER_UI', fetchedAt } };

  const candidates = [...page.urls];
  for (const script of page.scripts.slice(0, 2)) {
    const js = await fetchText(script, fetchImpl, timeoutMs);
    if ('text' in js) for (const found of inspectSwaggerUi(js.text, script).urls.slice(0, 3)) if (!candidates.includes(found)) candidates.unshift(found);
  }
  for (const candidate of candidates.filter((c) => c !== url).slice(0, LIMITS.candidates)) {
    const res = await fetchText(candidate, fetchImpl, timeoutMs);
    if ('error' in res || looksLikeHtml(res.text)) continue;
    const parsed = parseSpecText(res.text);
    if ('error' in parsed) continue;
    return { spec: parsed.spec, source: { url: shown, specUrl: displayApiDocsUrl(candidate) ?? candidate, format: 'SWAGGER_UI', fetchedAt } };
  }
  return { discovery: unavailable(url, 'the page is HTML and no OpenAPI or Swagger document could be found in it or beside it') };
}

// ---------------------------------------------------------------------------
// The artifact as evidence
// ---------------------------------------------------------------------------

export const API_ID = /^API-\d+$/;

/** Is there documented API to rest a requirement or a test on? */
export const hasApi = (api: ApiDiscovery | undefined): api is ApiDiscovery =>
  api !== undefined && api.status === 'AVAILABLE' && api.endpoints.length > 0;

/** One operation as a sentence — what a validator compares a claim against, and what an error message quotes. */
export function describeEndpoint(e: ApiEndpoint): string {
  const parts = [`${e.method} ${e.path}`];
  if (e.summary) parts.push(e.summary);
  if (e.operationId) parts.push(e.operationId);
  if (e.tags?.length) parts.push(e.tags.join(' '));
  if (e.parameters.length) parts.push(`parameters ${e.parameters.map((p) => p.name).join(' ')}`);
  if (e.requestBody) parts.push(`request body ${e.requestBody.schema ?? ''} ${e.requestBody.fields.map((f) => f.name).join(' ')}`);
  for (const r of e.responses) parts.push(`response ${r.status} ${r.description ?? ''} ${r.schema ?? ''} ${(r.fields ?? []).map((f) => f.name).join(' ')}`);
  parts.push(e.security.length ? `requires authentication ${e.security.join(' ')}` : 'no authentication required');
  return parts.join('. ').replace(/\s+/g, ' ').trim();
}

/** Every string the documentation states — what makes a quoted name or a path "supported". */
export function apiEvidenceTexts(api: ApiDiscovery | undefined): string[] {
  if (!hasApi(api)) return [];
  const texts: string[] = [];
  if (api.title) texts.push(api.title);
  for (const e of api.endpoints) {
    texts.push(describeEndpoint(e), e.path);
    // Each name on its own, quoted, so a case may name a field or a parameter exactly.
    for (const name of [...e.parameters.map((p) => p.name), ...(e.requestBody?.fields ?? []).map((f) => f.name), ...e.responses.flatMap((r) => (r.fields ?? []).map((f) => f.name))]) {
      texts.push(`"${name}"`);
    }
  }
  for (const a of api.authentication) texts.push([a.id, a.type, a.scheme, a.bearerFormat, a.name, a.in].filter(Boolean).join(' '));
  for (const s of api.schemas) texts.push(`${s.name} ${s.fields.map((f) => f.name).join(' ')}`);
  return texts;
}

/** `/api/notes/{id}` matches `/api/notes/42` and `/api/notes/{noteId}`; a templated segment matches any one segment. */
export function pathMatchesTemplate(path: string, template: string): boolean {
  const a = path.replace(/\/+$/, '').split('/');
  const b = template.replace(/\/+$/, '').split('/');
  if (a.length !== b.length) return false;
  return b.every((segment, i) => /^\{[^}]+\}$/.test(segment) || /^[:{]/.test(a[i]) || segment === a[i]);
}

/** Does the documentation declare this path (under any server base path)? */
export function isDocumentedPath(api: ApiDiscovery | undefined, path: string): boolean {
  if (!hasApi(api)) return false;
  const bases = ['', ...(api.servers ?? []).map((s) => {
    try { return new URL(s).pathname.replace(/\/+$/, ''); } catch { return s.startsWith('/') ? s.replace(/\/+$/, '') : ''; }
  })];
  return api.endpoints.some((e) => bases.some((base) => pathMatchesTemplate(path, `${base}${e.path}`)));
}

/** The few facts a stage briefing and a run record carry. */
export function apiDiscoverySummary(api: ApiDiscovery | undefined): { status: ApiDiscoveryStatus; endpoints: number; schemas: number; authentication: number; reason?: string; format?: ApiSpecFormat; specVersion?: string } {
  if (api === undefined) return { status: 'NOT_REQUESTED', endpoints: 0, schemas: 0, authentication: 0 };
  return compact({
    status: api.status,
    endpoints: api.endpoints.length,
    schemas: api.schemas.length,
    authentication: api.authentication.length,
    reason: api.reason,
    format: api.status === 'AVAILABLE' ? api.source?.format : undefined,
    specVersion: api.source?.specVersion,
  });
}

/** A stage's opening message with the run's coverage briefing appended — what every Phase 1 stage is started with. */
export function briefStage(
  stageKey: string,
  message: string,
  mode: CoverageMode,
  api: ApiDiscovery | undefined,
  /** The live validation summary, when live validation was asked for. Structural, so this module needs no import of it. */
  live?: { status: string; reason?: string; validated: number; observed: number; documented: number; contractViolations: number; potentialIssues: number },
): string {
  // Why there is nothing is only worth saying when the documentation was asked for and could not be read.
  const reason = api?.status === 'UNAVAILABLE' ? api.reason : undefined;
  const liveFacts = live && live.status !== 'NOT_REQUESTED'
    ? { live: { executed: live.validated + live.observed > 0, validated: live.validated, observed: live.observed, documented: live.documented, contractViolations: live.contractViolations, potentialIssues: live.potentialIssues, reason: live.reason } }
    : {};
  const facts = hasApi(api) ? { available: true, endpoints: api.endpoints.length, ...liveFacts } : { available: false, endpoints: 0, reason };
  return `${message}\n\n${coverageBriefing(stageKey, mode, facts)}`;
}
