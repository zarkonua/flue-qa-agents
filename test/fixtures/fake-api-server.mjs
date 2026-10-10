// A small real HTTP API with its own OpenAPI document, for the live-validation
// tests and the browser tests. Domain-neutral: "items" with a title.
//
// It serves its documentation at /docs (a Swagger UI page embedding the
// document) and /openapi.json, and implements what the document declares —
// except for the faults a test switches on, each one a way a real API drifts
// from its documentation:
//
//   schemaDrift        GET /items returns a title as a number
//   wrongContentType   GET /items answers text/plain
//   undocumentedStatus GET /health answers 203
//   authNotEnforced    GET /items answers 200 without credentials
//   acceptsInvalid     POST /items accepts an empty body
//   serverError        GET /health answers 500
//   rateLimited        every request answers 429
//   slow               every request waits this many ms

import { createServer } from 'node:http';

export const FAKE_API_TOKEN = 'fake-api-token-0123456789';
export const FAKE_API_USER = { email: 'qa@example.test', password: 'Correct-horse-1' };

export function fakeApiSpec() {
  const item = { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string', readOnly: true }, title: { type: 'string', minLength: 1, maxLength: 40 }, note: { type: 'string', nullable: true } } };
  const error = { type: 'object', required: ['message'], properties: { code: { type: 'integer' }, message: { type: 'string' } } };
  const json = (schema) => ({ 'application/json': { schema } });
  return {
    openapi: '3.0.3',
    info: { title: 'Items API', version: '1.0.0' },
    security: [{ bearer: [] }],
    paths: {
      '/health': { get: { operationId: 'health', summary: 'Liveness.', security: [], responses: { 200: { description: 'Up', content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ok'] } } }) } } } },
      '/auth/login': {
        post: {
          operationId: 'login', summary: 'Creates a token.', security: [],
          requestBody: { required: true, content: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } }) },
          responses: { 200: { description: 'Token', content: json({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }) }, 401: { description: 'Bad credentials', content: json(error) } },
        },
      },
      '/items': {
        get: { operationId: 'listItems', summary: 'Lists items.', responses: { 200: { description: 'Items', content: json({ type: 'array', items: { $ref: '#/components/schemas/Item' } }) }, 401: { description: 'Unauthenticated', content: json(error) } } },
        post: {
          operationId: 'createItem', summary: 'Creates an item.',
          requestBody: { required: true, content: json({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 40 }, note: { type: 'string' } } }) },
          responses: { 201: { description: 'Created', content: json({ $ref: '#/components/schemas/Item' }) }, 401: { description: 'Unauthenticated', content: json(error) }, 422: { description: 'Invalid', content: json(error) } },
        },
      },
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'getItem', summary: 'Reads an item.', responses: { 200: { description: 'Item', content: json({ $ref: '#/components/schemas/Item' }) }, 401: { description: 'Unauthenticated', content: json(error) }, 404: { description: 'Not found', content: json(error) } } },
        put: {
          operationId: 'replaceItem', summary: 'Replaces an item.',
          requestBody: { required: true, content: json({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 40 } } }) },
          responses: { 200: { description: 'Item', content: json({ $ref: '#/components/schemas/Item' }) }, 401: { description: 'Unauthenticated', content: json(error) }, 404: { description: 'Not found', content: json(error) }, 422: { description: 'Invalid', content: json(error) } },
        },
        delete: { operationId: 'deleteItem', summary: 'Removes an item.', responses: { 204: { description: 'Removed' }, 401: { description: 'Unauthenticated', content: json(error) }, 404: { description: 'Not found', content: json(error) } } },
      },
      '/session/logout': { get: { operationId: 'logout', summary: 'Ends the session.', responses: { 204: { description: 'Signed out' } } } },
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Item: item } },
  };
}

/** Start the API on a free port. `faults` may be changed while it runs. */
export async function startFakeApi(faults = {}, { port = 0 } = {}) {
  const requests = [];
  const items = new Map([['seed-1', { id: 'seed-1', title: 'Seeded item', note: null }]]);
  let next = 1;
  const state = { faults, requests, items };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path, authorization: req.headers.authorization ?? null, body: raw });
      const f = state.faults;
      if (f.slow) await new Promise((r) => setTimeout(r, f.slow));
      const send = (status, body, headers = {}) => {
        const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
        res.end(text);
      };
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }

      if (path === '/openapi.json') return send(200, fakeApiSpec());
      if (path === '/docs') return send(200, `<!DOCTYPE html><html><body><div id="swagger-ui"></div><script type="application/json" id="swagger-data">${JSON.stringify({ spec: fakeApiSpec() })}</script></body></html>`, { 'content-type': 'text/html' });
      if (path === '/elsewhere') return send(302, undefined, { location: 'http://169.254.169.254/latest/meta-data/' });
      if (f.rateLimited) return send(429, { message: 'Too many requests' }, { 'retry-after': '30' });

      if (path === '/health') {
        if (f.serverError) return send(500, { message: 'boom' });
        return send(f.undocumentedStatus ? 203 : 200, { status: 'ok' });
      }
      if (path === '/auth/login' && req.method === 'POST') {
        return body?.email === FAKE_API_USER.email && body?.password === FAKE_API_USER.password
          ? send(200, { token: FAKE_API_TOKEN }, { 'set-cookie': 'session=abc123; HttpOnly' })
          : send(401, { code: 401, message: 'Bad credentials' });
      }
      const authed = req.headers.authorization === `Bearer ${FAKE_API_TOKEN}`;
      if (path === '/session/logout') return send(204);
      if (!authed && !(f.authNotEnforced && path === '/items' && req.method === 'GET')) return send(401, { code: 401, message: 'Token not found' });

      if (path === '/items' && req.method === 'GET') {
        const list = [...items.values()];
        if (f.wrongContentType) return send(200, JSON.stringify(list), { 'content-type': 'text/plain' });
        return send(200, f.schemaDrift ? list.map((i) => ({ ...i, title: 42 })) : list);
      }
      if (path === '/items' && req.method === 'POST') {
        if (!f.acceptsInvalid && (typeof body?.title !== 'string' || body.title === '')) return send(422, { code: 422, message: 'title is required' });
        const id = `item-${next++}`;
        items.set(id, { id, title: body?.title ?? '', note: body?.note ?? null });
        return send(201, items.get(id));
      }
      const m = /^\/items\/([^/]+)$/.exec(path);
      if (m) {
        const item = items.get(decodeURIComponent(m[1]));
        if (!item) return send(404, { code: 404, message: 'Not found' });
        if (req.method === 'GET') return send(200, item);
        if (req.method === 'PUT') {
          if (typeof body?.title !== 'string' || body.title === '') return send(422, { code: 422, message: 'title is required' });
          item.title = body.title;
          return send(200, item);
        }
        if (req.method === 'DELETE') {
          items.delete(item.id);
          return send(204);
        }
      }
      return send(404, { code: 404, message: 'No such route' });
    });
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    docsUrl: `${origin}/docs`,
    specUrl: `${origin}/openapi.json`,
    state,
    requests,
    /** Requests that reached the API itself, not its documentation. */
    apiRequests: () => requests.filter((r) => r.path !== '/docs' && r.path !== '/openapi.json'),
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

// Run directly: a fixture API for the browser tests — `node test/fixtures/fake-api-server.mjs <port>`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = await startFakeApi({}, { port: Number(process.argv[2] ?? 4559) });
  console.log(`fake API on ${api.origin} (documentation: ${api.docsUrl})`);
}
