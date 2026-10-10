// API discovery: what a product's API documentation declares, read by the host.
//
//   npm test
//
// The rule this guards is "never invent an endpoint". It can only be a check if
// the host itself reads the documentation — deterministically, from whichever
// form it is published in — and if a document that is missing, private, broken
// or empty produces an honest "unavailable" rather than a guess or a crash.
//
// No network: every fetch here is a function the test supplies.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  apiDiscoverySummary,
  apiEvidenceTexts,
  briefStage,
  describeEndpoint,
  discoverApi,
  extractApiDiscovery,
  hasApi,
  inspectSwaggerUi,
  isDocumentedPath,
  LIMITS,
  parseSpecText,
  pathMatchesTemplate,
  type FetchLike,
} from '../src/lib/api-discovery.ts';
import { validateWithSchema } from '../src/lib/schema-validation.ts';

const SCHEMA = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'schemas', 'api-discovery.schema.json');
const NOW = () => new Date('2026-10-09T10:00:00.000Z');

/** An OpenAPI 3 document for a small notes product. Domain-neutral on purpose. */
const openapi3 = () => ({
  openapi: '3.0.3',
  info: { title: 'Notes API', version: '1.2.0' },
  servers: [{ url: 'https://example.test/v1' }],
  security: [{ bearer: [] }],
  paths: {
    '/auth/signin': {
      post: {
        operationId: 'signIn', summary: 'Creates a user token.', tags: ['Auth'], security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } } } } },
        responses: { 200: { description: 'Token created', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string', readOnly: true } } } } } }, 401: { description: 'Invalid credentials' } },
      },
    },
    '/notes': {
      get: {
        operationId: 'listNotes', summary: 'Lists notes.', tags: ['Note'],
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }, { $ref: '#/components/parameters/Search' }],
        responses: { 200: { description: 'Notes', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Note' } } } } }, 401: { description: 'Unauthenticated' } },
      },
      post: {
        operationId: 'createNote', summary: 'Creates a note.', tags: ['Note'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteInput' } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } }, 422: { description: 'Validation failed' } },
      },
    },
    '/notes/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { operationId: 'getNote', responses: { 200: { description: 'A note', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } }, 404: { description: 'Not found' } } },
      delete: { operationId: 'deleteNote', deprecated: true, responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
  },
  components: {
    parameters: { Search: { name: 'q', in: 'query', description: 'Text to search for', schema: { type: 'string' } } },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Note: { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string', readOnly: true }, title: { type: 'string', maxLength: 255 }, content: { type: 'string', nullable: true }, owner: { $ref: '#/components/schemas/Note' } } },
      NoteInput: { allOf: [{ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 255 } } }, { type: 'object', properties: { content: { type: 'string' } } }] },
    },
  },
});

const swagger2 = () => ({
  swagger: '2.0',
  info: { title: 'Legacy API', version: '0.9' },
  host: 'legacy.example.test', basePath: '/api', schemes: ['https'], consumes: ['application/json'],
  securityDefinitions: { key: { type: 'apiKey', name: 'X-Api-Key', in: 'header' }, oauth: { type: 'oauth2', flow: 'password', tokenUrl: 'https://legacy.example.test/token' } },
  security: [{ key: [] }],
  paths: {
    '/items': {
      post: {
        operationId: 'addItem',
        parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Item' } }],
        responses: { 201: { description: 'Created', schema: { $ref: '#/definitions/Item' } }, 400: { description: 'Bad request' } },
      },
    },
    '/upload': {
      post: { consumes: ['multipart/form-data'], parameters: [{ in: 'formData', name: 'file', type: 'file', required: true }], responses: { 200: { description: 'ok' } } },
    },
  },
  definitions: { Item: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, qty: { type: 'integer', minimum: 0 } } } },
});

/** A fetch that serves a fixed map of url -> body (or an Error to throw, or a number for that status). */
function fakeFetch(pages: Record<string, string | number | Error>, seen: string[] = []): FetchLike {
  return async (url) => {
    seen.push(url);
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (page === undefined || typeof page === 'number') {
      return { ok: false, status: page ?? 404, headers: { get: () => null }, text: async () => '' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => page };
  };
}

const source = { url: 'https://example.test/openapi.json', format: 'OPENAPI_JSON' as const };

describe('extraction from OpenAPI 3', () => {
  const api = extractApiDiscovery(openapi3(), source);

  it('lists every operation once, with a host-assigned id in document order', () => {
    assert.equal(api.status, 'AVAILABLE');
    assert.deepEqual(api.endpoints.map((e) => `${e.id} ${e.method} ${e.path}`), [
      'API-1 POST /auth/signin', 'API-2 GET /notes', 'API-3 POST /notes', 'API-4 GET /notes/{id}', 'API-5 DELETE /notes/{id}',
    ]);
    assert.equal(api.title, 'Notes API');
    assert.equal(api.source?.specVersion, '3.0.3');
    assert.deepEqual(api.servers, ['https://example.test/v1']);
  });

  it('keeps parameters — a $ref, a path-level one, and required-ness', () => {
    const list = api.endpoints[1];
    assert.deepEqual(list.parameters, [
      { name: 'page', in: 'query', required: false, type: 'integer' },
      { name: 'q', in: 'query', required: false, type: 'string', description: 'Text to search for' },
    ]);
    assert.deepEqual(api.endpoints[3].parameters, [{ name: 'id', in: 'path', required: true, type: 'string(uuid)' }]);
  });

  it('keeps request and response shapes, through $ref and allOf, with their constraints', () => {
    const create = api.endpoints[2];
    assert.equal(create.requestBody?.schema, 'NoteInput');
    assert.deepEqual(create.requestBody?.fields, [
      { name: 'title', type: 'string', required: true, constraints: 'minLength: 1; maxLength: 255' },
      { name: 'content', type: 'string', required: false },
    ]);
    assert.deepEqual(create.responses.map((r) => r.status), ['201', '422']);
    assert.equal(create.responses[0].schema, 'Note');
    assert.equal(api.endpoints[1].responses[0].schema, 'Note[]');
    const signIn = api.endpoints[0];
    assert.deepEqual(signIn.requestBody?.fields.map((f) => `${f.name}:${f.type}:${f.required}`), ['email:string(email):true', 'password:string:true']);
  });

  it('keeps authentication: the schemes, and which operations need them', () => {
    assert.deepEqual(api.authentication, [{ id: 'bearer', type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }]);
    assert.deepEqual(api.endpoints[0].security, [], 'an operation that overrides security with [] is open');
    assert.deepEqual(api.endpoints[1].security, ['bearer'], 'the document-level requirement applies otherwise');
  });

  it('keeps named schemas, and survives one that refers to itself', () => {
    const note = api.schemas.find((s) => s.name === 'Note')!;
    assert.deepEqual(note.fields.map((f) => f.name), ['id', 'title', 'content', 'owner']);
    assert.equal(note.fields.find((f) => f.name === 'owner')!.type, 'Note');
    assert.equal(note.fields.find((f) => f.name === 'content')!.type, 'string|null');
  });

  it('marks a deprecated operation, and writes an artifact that matches its schema', () => {
    assert.equal(api.endpoints[4].deprecated, true);
    assert.deepEqual(validateWithSchema(SCHEMA, api), []);
  });
});

describe('extraction from Swagger 2', () => {
  const api = extractApiDiscovery(swagger2(), { ...source, format: 'OPENAPI_YAML' });

  it('reads body and form parameters, definitions and security definitions', () => {
    assert.deepEqual(api.endpoints.map((e) => `${e.method} ${e.path}`), ['POST /items', 'POST /upload']);
    assert.deepEqual(api.endpoints[0].requestBody, {
      required: true, contentTypes: ['application/json'], schema: 'Item',
      fields: [{ name: 'name', type: 'string', required: true }, { name: 'qty', type: 'integer', required: false, constraints: 'minimum: 0' }],
    });
    assert.deepEqual(api.endpoints[0].parameters, [], 'a body parameter is the request body, not a parameter');
    assert.deepEqual(api.endpoints[1].requestBody?.contentTypes, ['multipart/form-data']);
    assert.deepEqual(api.endpoints[1].requestBody?.fields.map((f) => f.name), ['file']);
    assert.deepEqual(api.authentication.map((a) => `${a.id}:${a.type}`), ['key:apiKey', 'oauth:oauth2']);
    assert.deepEqual(api.authentication[1].flows, ['password']);
    assert.deepEqual(api.servers, ['https://legacy.example.test/api']);
    assert.equal(api.source?.specVersion, '2.0');
    assert.deepEqual(validateWithSchema(SCHEMA, api), []);
  });
});

describe('the three ways documentation is published', () => {
  it('reads a JSON document', async () => {
    const api = await discoverApi('https://example.test/openapi.json', { fetchImpl: fakeFetch({ 'https://example.test/openapi.json': JSON.stringify(openapi3()) }), now: NOW });
    assert.equal(api.status, 'AVAILABLE');
    assert.equal(api.source?.format, 'OPENAPI_JSON');
    assert.equal(api.source?.fetchedAt, '2026-10-09T10:00:00.000Z');
    assert.equal(api.endpoints.length, 5);
  });

  it('reads a YAML document', async () => {
    const yaml = [
      'openapi: 3.1.0', 'info:', '  title: YAML API', '  version: "1"', 'paths:', '  /ping:', '    get:', '      summary: Liveness',
      '      responses:', '        "200":', '          description: pong',
    ].join('\n');
    const api = await discoverApi('https://example.test/openapi.yaml', { fetchImpl: fakeFetch({ 'https://example.test/openapi.yaml': yaml }), now: NOW });
    assert.equal(api.source?.format, 'OPENAPI_YAML');
    assert.deepEqual(api.endpoints.map((e) => `${e.method} ${e.path} ${e.responses.map((r) => r.status)}`), ['GET /ping 200']);
  });

  it('reads a Swagger UI page that embeds the document', async () => {
    const html = `<!DOCTYPE html><html><head><title>Docs</title></head><body><div id="swagger-ui"></div>
      <script id="swagger-data" type="application/json">${JSON.stringify({ spec: openapi3() })}</script></body></html>`;
    const seen: string[] = [];
    const api = await discoverApi('https://example.test/api/doc', { fetchImpl: fakeFetch({ 'https://example.test/api/doc': html }, seen), now: NOW });
    assert.equal(api.source?.format, 'SWAGGER_UI');
    assert.equal(api.endpoints.length, 5);
    assert.deepEqual(seen, ['https://example.test/api/doc'], 'nothing else is fetched when the page carries the document');
  });

  it('reads a Swagger UI page that names its document, resolved against the page', async () => {
    const html = '<html><body><div id="swagger-ui"></div><script>window.ui = SwaggerUIBundle({ url: "./openapi.json", dom_id: "#swagger-ui" })</script></body></html>';
    const api = await discoverApi('https://example.test/docs/', {
      fetchImpl: fakeFetch({ 'https://example.test/docs/': html, 'https://example.test/docs/openapi.json': JSON.stringify(openapi3()) }), now: NOW,
    });
    assert.equal(api.status, 'AVAILABLE');
    assert.equal(api.source?.format, 'SWAGGER_UI');
    assert.equal(api.source?.specUrl, 'https://example.test/docs/openapi.json');
  });

  it('follows a stock Swagger UI initializer script to the document', async () => {
    const html = '<html><body><div id="swagger-ui"></div><script src="./swagger-initializer.js"></script></body></html>';
    const js = 'window.onload = function() { window.ui = SwaggerUIBundle({ url: "/spec/v3.yaml" }); };';
    const api = await discoverApi('https://example.test/swagger/index.html', {
      fetchImpl: fakeFetch({
        'https://example.test/swagger/index.html': html,
        'https://example.test/swagger/swagger-initializer.js': js,
        'https://example.test/spec/v3.yaml': 'swagger: "2.0"\ninfo: {title: T, version: "1"}\npaths:\n  /x:\n    get:\n      responses:\n        "200": {description: ok}\n',
      }), now: NOW,
    });
    assert.equal(api.status, 'AVAILABLE');
    assert.equal(api.source?.specUrl, 'https://example.test/spec/v3.yaml');
  });

  it('falls back to the conventional locations beside a page that names nothing', async () => {
    const seen: string[] = [];
    const api = await discoverApi('https://example.test/api/doc', {
      fetchImpl: fakeFetch({ 'https://example.test/api/doc': '<html><body><div id="swagger-ui"></div></body></html>', 'https://example.test/api/doc.json': JSON.stringify(openapi3()) }, seen),
      now: NOW,
    });
    assert.equal(api.status, 'AVAILABLE');
    assert.equal(api.source?.specUrl, 'https://example.test/api/doc.json');
    assert.ok(seen.length <= 1 + LIMITS.candidates, 'the number of guesses is bounded');
  });

  it('inspects a page without fetching: embedded spec, named urls, same-document fallbacks', () => {
    assert.ok(inspectSwaggerUi(`<script type="application/json">${JSON.stringify(openapi3())}</script>`, 'https://example.test/d').spec);
    const named = inspectSwaggerUi('<script>SwaggerUIBundle({ urls: [{"url": "/a.json", "name": "A"}] })</script>', 'https://example.test/d');
    assert.equal(named.urls[0], 'https://example.test/a.json');
    assert.ok(named.urls.includes('https://example.test/d.json'));
    assert.ok(named.urls.every((u) => u.startsWith('https://')), 'only http(s) locations are ever candidates');
  });
});

describe('missing or inaccessible documentation is a state, never a crash', () => {
  const cases: [string, Record<string, string | number | Error>, RegExp][] = [
    ['a 404', {}, /could not be fetched: HTTP 404/],
    ['a 401', { 'https://example.test/doc': 401 }, /HTTP 401/],
    ['a network failure', { 'https://example.test/doc': Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, /ECONNREFUSED/],
    ['JSON that is not a specification', { 'https://example.test/doc': '{"hello": "world"}' }, /not an OpenAPI or Swagger document/],
    ['broken JSON', { 'https://example.test/doc': '{"openapi": ' }, /could not be parsed/],
    ['plain text', { 'https://example.test/doc': 'just some words' }, /not an OpenAPI or Swagger document/],
    ['an HTML page with no document anywhere', { 'https://example.test/doc': '<html><body>Welcome</body></html>' }, /no OpenAPI or Swagger document could be found/],
    ['a specification with no operations', { 'https://example.test/doc': JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }) }, /declares no operations/],
  ];
  for (const [name, pages, reason] of cases) {
    it(`reports ${name}`, async () => {
      const api = await discoverApi('https://example.test/doc', { fetchImpl: fakeFetch(pages), now: NOW });
      assert.equal(api.status, 'UNAVAILABLE');
      assert.match(api.reason ?? '', reason);
      assert.deepEqual(api.endpoints, []);
      assert.equal(hasApi(api), false);
      assert.deepEqual(validateWithSchema(SCHEMA, api), [], 'an unavailable result is still a valid artifact');
    });
  }

  it('reports a server that never answers, after the timeout', async () => {
    const never: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const api = await discoverApi('https://example.test/doc', { fetchImpl: never, timeoutMs: 20 });
    assert.equal(api.status, 'UNAVAILABLE');
    assert.match(api.reason ?? '', /no response within/);
  });

  it('says NOT_REQUESTED when no URL was given, and refuses a URL that is not http(s)', async () => {
    assert.equal((await discoverApi(undefined)).status, 'NOT_REQUESTED');
    assert.equal((await discoverApi('  ')).status, 'NOT_REQUESTED');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.test/doc', 'not a url']) {
      const seen: string[] = [];
      const api = await discoverApi(bad, { fetchImpl: fakeFetch({}, seen) });
      assert.equal(api.status, 'UNAVAILABLE', bad);
      assert.deepEqual(seen, [], `${bad} is never fetched`);
    }
  });

  it('never stores the query string of the URL — that is where a key would be', async () => {
    const api = await discoverApi('https://example.test/openapi.json?api_key=s3cr3t', {
      fetchImpl: fakeFetch({ 'https://example.test/openapi.json?api_key=s3cr3t': JSON.stringify(openapi3()) }), now: NOW,
    });
    assert.equal(api.status, 'AVAILABLE');
    assert.doesNotMatch(JSON.stringify(api), /s3cr3t|api_key/);
  });
});

describe('a large document stays readable by a model', () => {
  it('caps operations and schemas, and says how many it left out', () => {
    const spec = openapi3() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (let i = 0; i < LIMITS.endpoints + 20; i += 1) spec.paths[`/bulk/${i}`] = { get: { responses: { 200: { description: 'ok' } } } };
    for (let i = 0; i < LIMITS.schemas + 5; i += 1) spec.components.schemas[`Bulk${i}`] = { type: 'object', properties: { a: { type: 'string' } } };
    const api = extractApiDiscovery(spec, source);
    assert.equal(api.endpoints.length, LIMITS.endpoints);
    assert.equal(api.schemas.length, LIMITS.schemas);
    assert.deepEqual(api.truncated, { endpoints: 25, schemas: 7 });
    assert.equal(new Set(api.endpoints.map((e) => e.id)).size, LIMITS.endpoints, 'ids stay unique');
  });

  it('parses text, and names the problem when it cannot', () => {
    assert.ok('spec' in parseSpecText(JSON.stringify(swagger2())));
    assert.ok('spec' in parseSpecText('openapi: 3.0.0\npaths:\n  /a: {}\n'));
    assert.ok('error' in parseSpecText(''));
    assert.ok('error' in parseSpecText('a: [unclosed'));
  });
});

describe('the artifact as evidence', () => {
  const api = extractApiDiscovery(openapi3(), source);

  it('matches a concrete path against a documented template — and nothing else', () => {
    assert.ok(pathMatchesTemplate('/notes/42', '/notes/{id}'));
    assert.ok(pathMatchesTemplate('/notes/{noteId}', '/notes/{id}'));
    assert.ok(pathMatchesTemplate('/notes/:id', '/notes/{id}'));
    assert.ok(!pathMatchesTemplate('/notes/42/share', '/notes/{id}'));
    assert.ok(!pathMatchesTemplate('/users/42', '/notes/{id}'));
    assert.ok(isDocumentedPath(api, '/notes/42'));
    assert.ok(isDocumentedPath(api, '/v1/notes'), 'under the server base path too');
    assert.ok(!isDocumentedPath(api, '/notes/42/share'), 'an endpoint the document does not declare is not documented');
    assert.ok(!isDocumentedPath(undefined, '/notes'));
  });

  it('describes an operation in words a claim can be compared with', () => {
    const text = describeEndpoint(api.endpoints[2]);
    assert.match(text, /^POST \/notes\. Creates a note\./);
    assert.match(text, /request body NoteInput title content/);
    assert.match(text, /response 201 Created Note/);
    assert.match(text, /response 422 Validation failed/);
    assert.match(text, /requires authentication bearer/);
    assert.match(describeEndpoint(api.endpoints[0]), /no authentication required/);
  });

  it('yields no evidence at all when there is no documentation', () => {
    assert.deepEqual(apiEvidenceTexts(undefined), []);
    assert.deepEqual(apiEvidenceTexts({ status: 'UNAVAILABLE', reason: 'x', authentication: [], endpoints: [], schemas: [] }), []);
    assert.ok(apiEvidenceTexts(api).some((t) => t === '"title"'), 'a field name is quotable');
  });

  it('summarises itself for the run record and briefs each stage', () => {
    assert.deepEqual(apiDiscoverySummary(api), { status: 'AVAILABLE', endpoints: 5, schemas: 2, authentication: 1, format: 'OPENAPI_JSON', specVersion: '3.0.3' });
    assert.deepEqual(apiDiscoverySummary(undefined), { status: 'NOT_REQUESTED', endpoints: 0, schemas: 0, authentication: 0 });
    const brief = briefStage('design', 'Write the test cases.', 'AUTOMATIC', api);
    assert.match(brief, /^Write the test cases\.\n\nCoverage mode for this run: Automatic/);
    assert.match(brief, /5 documented operation\(s\)/);
    const none = briefStage('design', 'Write the test cases.', 'AUTOMATIC', { status: 'UNAVAILABLE', reason: 'could not be fetched: HTTP 404', authentication: [], endpoints: [], schemas: [] });
    assert.match(none, /No API documentation is available to this run \(could not be fetched: HTTP 404\)/);
    assert.match(none, /"testLevel": "UI" on every test case/);
  });
});
