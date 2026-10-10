// Live API validation: the host calls the documented API and compares what
// really comes back with what the documentation declares.
//
//   npm test
//
// Against a real HTTP server on the loopback interface (test/fixtures/
// fake-api-server.mjs) — real sockets, real status codes — whose faults are
// switched on one at a time. What is proved here:
//
//   - nothing state-changing is sent unless a person approved that operation,
//     nothing destructive touches data this run did not create, and nothing at
//     all goes to a host the run was not allowed to call;
//   - an operation is VALIDATED only when it was executed AND checked; a
//     mismatch is a CONTRACT_VIOLATION only when the response contradicts the
//     documentation, and a POTENTIAL_ISSUE otherwise;
//   - credentials never reach the artifact;
//   - an unreachable, rate-limited or slow API degrades to documentation-only
//     instead of failing the run.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'qa-api-validation-'));
process.env.QA_ARTIFACT_ROOT = ROOT;
process.env.QA_ENV_FILE = '/nonexistent';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { FAKE_API_TOKEN, FAKE_API_USER, fakeApiSpec, startFakeApi } = await import('./fixtures/fake-api-server.mjs');
const { extractApiDiscovery } = await import('../src/lib/api-discovery.ts');
const live = await import('../src/lib/api-validation.ts');
const { validateWithSchema } = await import('../src/lib/schema-validation.ts');
const { apiEvidenceOf, stampApiEvidence } = await import('../src/lib/semantic-validate.ts');
const { validateDefectAnalysis } = await import('../src/lib/defects.ts');
const { coverageBriefing } = await import('../src/lib/coverage-mode.ts');
const qa = await import('../src/lib/qa-artifacts.ts');
const ui = await import('../ui/src/lib/api-validation.ts');

import type { ApiValidation, ApiValidationOptions } from '../src/lib/api-validation.ts';
import type { CoverageContext, RequirementsAnalysis, TestCase } from '../src/lib/semantic-validate.ts';

const SCHEMA = join(PROJECT, 'schemas', 'api-validation.schema.json');
const spec = fakeApiSpec();
const discovery = extractApiDiscovery(spec, { url: 'http://127.0.0.1/docs', format: 'SWAGGER_UI' });
const ID = Object.fromEntries(discovery.endpoints.map((e) => [`${e.method} ${e.path}`, e.id])) as Record<string, string>;

let api: Awaited<ReturnType<typeof startFakeApi>>;
before(async () => { api = await startFakeApi(); });
after(async () => {
  await api.close();
  rmSync(ROOT, { recursive: true, force: true });
});

/** Run live validation against the fixture API. Fast: no pause between requests. */
async function run(options: Partial<ApiValidationOptions> = {}, faults: Record<string, unknown> = {}): Promise<ApiValidation> {
  api.state.faults = faults;
  api.requests.length = 0;
  const result = await live.validateApi(spec, discovery, { enabled: true, docsUrl: api.docsUrl, delayMs: 0, nonce: 'test1', ...options });
  api.state.faults = {};
  return result;
}
const endpoint = (v: ApiValidation, key: string) => v.endpoints.find((e) => e.id === ID[key])!;
const probesOf = (v: ApiValidation, key: string) => v.probes.filter((p) => p.endpointId === ID[key]);
const findingsOf = (v: ApiValidation, key: string) => v.findings.filter((f) => f.endpointId === ID[key]);
const sent = () => api.apiRequests().map((r: { method: string; path: string }) => `${r.method} ${r.path}`);

// ---------------------------------------------------------------------------

describe('which operations are safe to call unasked', () => {
  it('classifies by method, and a GET by what it is named', () => {
    const safety = (method: string, path: string, operationId?: string) => live.operationSafety({ method, path, operationId });
    assert.equal(safety('GET', '/items'), 'SAFE');
    assert.equal(safety('HEAD', '/items/{id}'), 'SAFE');
    assert.equal(safety('GET', '/items', 'api_items_get_collection'), 'SAFE');
    assert.equal(safety('POST', '/items'), 'STATE_CHANGING');
    assert.equal(safety('PUT', '/items/{id}'), 'STATE_CHANGING');
    assert.equal(safety('PATCH', '/items/{id}'), 'STATE_CHANGING');
    assert.equal(safety('DELETE', '/items/{id}'), 'DESTRUCTIVE');
    // HTTP says GET is safe; an API that names one like an action is not believed.
    assert.equal(safety('GET', '/session/logout'), 'UNSAFE_GET');
    assert.equal(safety('GET', '/users/{id}/activate'), 'UNSAFE_GET');
    assert.equal(safety('GET', '/account', 'resetPassword'), 'UNSAFE_GET');
    assert.equal(safety('GET', '/reports/{delete}'), 'SAFE', 'a parameter name is not an action');
  });

  it('accepts an approval only as "METHOD /path" naming a documented operation', () => {
    assert.deepEqual(live.parseApprovals('POST /items, DELETE /items/{id}\nPUT /items/{id}'), ['POST /items', 'DELETE /items/{id}', 'PUT /items/{id}']);
    assert.deepEqual(live.parseApprovals('*, post /items, POST items, POST /items; rm -rf /, DELETE http://x/y'), []);
    assert.deepEqual(live.parseApprovals(['POST /items', 7, 'nope']), ['POST /items']);
    const known = live.knownApprovals(['POST /items', 'POST /items', 'DELETE /everything', 'PATCH /items/{id}'], discovery.endpoints);
    assert.deepEqual(known, ['POST /items'], 'only what the documentation declares, once');
  });
});

describe('where requests may go', () => {
  it('resolves the base URL: an override, then the document, then where the document is', () => {
    const docs = 'https://docs.example.test/api/doc';
    assert.deepEqual(live.resolveBaseUrl({ openapi: '3.0.0', paths: {} }, docs), { url: 'https://docs.example.test', source: 'DOCS_ORIGIN' });
    assert.deepEqual(live.resolveBaseUrl({ openapi: '3.0.0', paths: {}, servers: [{ url: 'https://api.example.test/v1/' }] }, docs), { url: 'https://api.example.test/v1', source: 'SPEC_SERVER' });
    assert.deepEqual(live.resolveBaseUrl({ openapi: '3.0.0', paths: {}, servers: [{ url: '/v2' }] }, docs), { url: 'https://docs.example.test/v2', source: 'SPEC_SERVER' }, 'a relative server is relative to the document');
    assert.deepEqual(
      live.resolveBaseUrl({ openapi: '3.0.0', paths: {}, servers: [{ url: 'https://{env}.example.test/{base}', variables: { env: { default: 'staging' }, base: { default: 'v3' } } }] }, docs),
      { url: 'https://staging.example.test/v3', source: 'SPEC_SERVER' },
    );
    assert.deepEqual(live.resolveBaseUrl({ openapi: '3.0.0', paths: {}, servers: [{ url: 'https://{env}.example.test' }] }, docs), { url: 'https://docs.example.test', source: 'DOCS_ORIGIN' }, 'a variable without a default cannot be resolved');
    assert.deepEqual(live.resolveBaseUrl({ swagger: '2.0', paths: {}, host: 'legacy.example.test', basePath: '/api', schemes: ['https'] }, docs), { url: 'https://legacy.example.test/api', source: 'SPEC_SERVER' });
    assert.deepEqual(live.resolveBaseUrl({ swagger: '2.0', paths: {}, basePath: '/api' }, docs), { url: 'https://docs.example.test/api', source: 'SPEC_SERVER' });
    assert.deepEqual(live.resolveBaseUrl({ openapi: '3.0.0', paths: {}, servers: [{ url: 'https://api.example.test' }] }, docs, ' http://localhost:8080/base/?x=1 '), { url: 'http://localhost:8080/base', source: 'OVERRIDE' });
    assert.ok('error' in live.resolveBaseUrl({ openapi: '3.0.0', paths: {} }, docs, 'file:///etc/passwd'));
    assert.ok('error' in live.resolveBaseUrl({ openapi: '3.0.0', paths: {} }, docs, 'https://user:pw@api.example.test'));
  });

  it('never calls link-local, metadata or unspecified addresses', () => {
    for (const bad of ['169.254.169.254', '169.254.1.1', '0.0.0.0', 'fe80::1', '[fe80::1]', '::ffff:169.254.169.254', '224.0.0.1', 'ff02::1']) assert.equal(live.isForbiddenAddress(bad), true, bad);
    for (const ok of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '93.184.216.34', '::1']) assert.equal(live.isForbiddenAddress(ok), false, ok);
  });

  it('treats the loopback names as one host, and keeps the port', () => {
    assert.equal(live.hostKey('http://localhost:4444/x'), live.hostKey('http://127.0.0.1:4444'));
    assert.notEqual(live.hostKey('http://localhost:4444'), live.hostKey('http://localhost:4445'));
    assert.equal(live.hostKey('api.example.test'), 'api.example.test:80');
    assert.equal(live.hostKey('https://API.Example.test'), 'api.example.test:443');
  });

  it('refuses a base URL on a host the run was not given — and sends nothing', async () => {
    const elsewhere = await run({ baseUrlOverride: 'http://127.0.0.1:9' });
    assert.equal(elsewhere.status, 'UNAVAILABLE');
    assert.match(elsewhere.reason ?? '', /is on a host this run may not call.*QA_API_ALLOWED_HOSTS/);
    assert.deepEqual(sent(), []);
    assert.ok(elsewhere.endpoints.every((e) => e.evidence === 'DOCUMENTED'), 'everything stays documentation-only');
    assert.deepEqual(validateWithSchema(SCHEMA, elsewhere), []);

    const metadata = await run({ baseUrlOverride: 'http://169.254.169.254', allowedHosts: ['169.254.169.254'] });
    assert.equal(metadata.status, 'UNAVAILABLE');
    assert.match(metadata.reason ?? '', /link-local or metadata address, which is never called/);

    // A name that resolves to a metadata address is refused even though the name itself was allowed.
    const rebinding = await live.validateApi(spec, discovery, { enabled: true, docsUrl: 'http://internal.example.test/docs', lookupImpl: async () => ['169.254.169.254'], delayMs: 0 });
    assert.equal(rebinding.status, 'UNAVAILABLE');
    assert.match(rebinding.reason ?? '', /resolves to a link-local or metadata address/);
  });

  it('calls a host the operator listed explicitly, including one on the loopback interface', async () => {
    const result = await live.validateApi(spec, discovery, { enabled: true, docsUrl: 'http://docs.example.test/docs', baseUrlOverride: api.origin, allowedHosts: [new URL(api.origin).host], delayMs: 0 });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.baseUrlSource, 'OVERRIDE');
    assert.ok(result.summary.requests > 0);
  });

  it('plans without sending anything: what would be called, what needs approval, and whether the host is allowed', () => {
    const plan = live.planApiValidation(spec, discovery, { docsUrl: api.docsUrl });
    assert.equal(plan.allowed, true);
    assert.equal(plan.baseUrl, api.origin);
    assert.deepEqual(plan.operations.filter((o) => o.needsApproval).map((o) => `${o.method} ${o.path}:${o.safety}`), [
      'POST /auth/login:STATE_CHANGING', 'POST /items:STATE_CHANGING', 'PUT /items/{id}:STATE_CHANGING', 'DELETE /items/{id}:DESTRUCTIVE', 'GET /session/logout:UNSAFE_GET',
    ]);
    const blocked = live.planApiValidation(spec, discovery, { docsUrl: api.docsUrl, baseUrlOverride: 'https://api.production.example.com' });
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? '', /api\.production\.example\.com is not a host this workspace may call/);
    assert.equal(live.planApiValidation(spec, discovery, { docsUrl: api.docsUrl, environment: 'production' }).protectedEnvironment, true);
  });
});

describe('by default: read-only requests, and nothing that could change state', () => {
  let result: ApiValidation;
  before(async () => { result = await run(); });

  it('sends only GETs — no POST, PUT, DELETE, and not the GET named like an action', () => {
    assert.deepEqual(sent(), ['GET /health', 'GET /items', 'GET /items/qa-probe-nonexistent-0']);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.policy.requestsSent, 3);
    assert.deepEqual(result.policy.approvedOperations, []);
  });

  it('says why each other operation was not called', () => {
    for (const key of ['POST /auth/login', 'POST /items', 'PUT /items/{id}', 'DELETE /items/{id}', 'GET /session/logout']) {
      const e = endpoint(result, key);
      assert.equal(e.execution, 'SKIPPED', key);
      assert.equal(e.skipReason, 'APPROVAL_REQUIRED', key);
      assert.equal(e.evidence, 'DOCUMENTED', key);
      assert.match(e.skipDetail ?? '', /runs only when a person approves this operation/);
    }
    assert.match(endpoint(result, 'DELETE /items/{id}').skipDetail ?? '', /is destructive/);
    assert.match(endpoint(result, 'GET /session/logout').skipDetail ?? '', /named like an action/);
  });

  it('VALIDATES what it executed and checked: status, content type and schema', () => {
    const health = endpoint(result, 'GET /health');
    assert.equal(health.evidence, 'VALIDATED');
    assert.deepEqual(health.validated, ['ANONYMOUS']);
    const [probe] = probesOf(result, 'GET /health');
    assert.equal(probe.response?.status, 200);
    assert.equal(probe.evidence, 'VALIDATED');
    assert.deepEqual(probe.checks.map((c) => `${c.name}:${c.outcome}`), ['STATUS:PASS', 'EXPECTATION:PASS', 'CONTENT_TYPE:PASS', 'SCHEMA:PASS']);
  });

  it('checks a secured operation the one way it safely can without credentials: it must refuse', () => {
    const list = endpoint(result, 'GET /items');
    assert.equal(list.evidence, 'VALIDATED');
    assert.deepEqual(list.validated, ['UNAUTHENTICATED'], 'what was validated is the refusal — not the listing');
    const [probe] = probesOf(result, 'GET /items');
    assert.equal(probe.kind, 'UNAUTHENTICATED');
    assert.equal(probe.response?.status, 401);
    assert.equal(result.authentication.status, 'NOT_CONFIGURED');
    assert.deepEqual(findingsOf(result, 'GET /items'), []);
  });

  it('summarises honestly and matches its schema', () => {
    assert.deepEqual(result.summary, { endpoints: 8, documented: 5, observed: 0, validated: 3, skipped: 5, requests: 3, contractViolations: 0, potentialIssues: 0 });
    assert.deepEqual(validateWithSchema(SCHEMA, result), []);
    assert.equal(live.hasLiveEvidence(result), true);
  });
});

describe('with credentials configured on the host', () => {
  it('uses a token: the success path is validated, and the token is nowhere in the artifact', async () => {
    const result = await run({ auth: { token: FAKE_API_TOKEN } });
    assert.deepEqual(result.authentication, { status: 'READY', method: 'TOKEN' });
    const list = endpoint(result, 'GET /items');
    assert.deepEqual(list.validated, ['UNAUTHENTICATED', 'AUTHENTICATED']);
    const authed = probesOf(result, 'GET /items').find((p) => p.kind === 'AUTHENTICATED')!;
    assert.equal(authed.response?.status, 200);
    assert.equal(authed.request.headers.authorization, '<redacted>');
    assert.match(authed.response?.bodySample ?? '', /Seeded item/);
    // A missing resource, asked for with credentials, is the documented 404.
    assert.deepEqual(probesOf(result, 'GET /items/{id}').map((p) => `${p.kind}:${p.response?.status}:${p.evidence}`), ['UNAUTHENTICATED:401:VALIDATED', 'NOT_FOUND:404:VALIDATED']);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(FAKE_API_TOKEN));
    assert.ok(api.apiRequests().some((r: { authorization: string | null }) => r.authorization === `Bearer ${FAKE_API_TOKEN}`), 'the API did receive it');
  });

  it('signs in through the documented login operation, and stores neither the password nor the token', async () => {
    const result = await run({ auth: { username: FAKE_API_USER.email, password: FAKE_API_USER.password, loginPath: '/auth/login' } });
    assert.deepEqual(result.authentication, { status: 'READY', method: 'LOGIN' });
    assert.ok(endpoint(result, 'GET /items').validated.includes('AUTHENTICATED'));
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, new RegExp(`${FAKE_API_TOKEN}|${FAKE_API_USER.password}`));
    // Signing in is the operator's configured step, not an approved probe of that operation.
    assert.equal(endpoint(result, 'POST /auth/login').execution, 'SKIPPED');
  });

  it('reports credentials that do not work, and still validates what needs none', async () => {
    const wrong = await run({ auth: { username: FAKE_API_USER.email, password: 'wrong', loginPath: '/auth/login' } });
    assert.equal(wrong.authentication.status, 'FAILED');
    assert.match(wrong.authentication.detail ?? '', /signing in responded 401/);
    assert.equal(endpoint(wrong, 'GET /health').evidence, 'VALIDATED');
    assert.deepEqual(endpoint(wrong, 'GET /items').validated, ['UNAUTHENTICATED']);

    const undocumented = await run({ auth: { username: 'u', password: 'p', loginPath: '/not/documented' } });
    assert.match(undocumented.authentication.detail ?? '', /is not a documented POST operation/);
    assert.ok(!sent().includes('POST /not/documented'), 'an undocumented path is never called');

    const noScheme = await run({ auth: { username: 'u', password: 'p' } });
    assert.match(noScheme.authentication.detail ?? '', /declares no basic authentication/);
  });
});

describe('contract mismatches: confirmed violations and potential issues', () => {
  const auth = { token: FAKE_API_TOKEN };

  it('a body that does not match its documented schema is a CONTRACT_VIOLATION, and the operation is only OBSERVED', async () => {
    const result = await run({ auth }, { schemaDrift: true });
    const list = endpoint(result, 'GET /items');
    assert.deepEqual(list.observed, ['AUTHENTICATED']);
    assert.deepEqual(list.validated, ['UNAUTHENTICATED'], 'it still refuses correctly without credentials');
    assert.equal(list.evidence, 'OBSERVED', 'but one response contradicting the documentation means the operation is not validated');
    const [finding] = findingsOf(result, 'GET /items');
    assert.equal(finding.classification, 'CONTRACT_VIOLATION');
    assert.equal(finding.type, 'SCHEMA_MISMATCH');
    assert.match(finding.actual, /\/0\/title must be string/);
    const probe = result.probes.find((p) => p.id === finding.probeId)!;
    assert.equal(probe.evidence, 'OBSERVED', 'executed, but not validated');
    assert.equal(probe.checks.find((c) => c.name === 'SCHEMA')!.outcome, 'FAIL');
  });

  it('a content type the documentation does not declare is a CONTRACT_VIOLATION', async () => {
    const result = await run({ auth }, { wrongContentType: true });
    const types = findingsOf(result, 'GET /items').map((f) => `${f.classification}:${f.type}`);
    assert.ok(types.includes('CONTRACT_VIOLATION:CONTENT_TYPE_MISMATCH'), types.join());
  });

  it('a success status the documentation does not declare is a CONTRACT_VIOLATION', async () => {
    const result = await run({}, { undocumentedStatus: true });
    const [finding] = findingsOf(result, 'GET /health');
    assert.deepEqual([finding.classification, finding.type, finding.severity], ['CONTRACT_VIOLATION', 'UNDOCUMENTED_STATUS', 'MEDIUM']);
    assert.match(finding.expected, /declares these statuses for GET \/health: 200/);
    assert.equal(endpoint(result, 'GET /health').evidence, 'OBSERVED');
  });

  it('a secured operation that answers without credentials is a CONTRACT_VIOLATION', async () => {
    const result = await run({}, { authNotEnforced: true });
    const [finding] = findingsOf(result, 'GET /items');
    assert.deepEqual([finding.classification, finding.type, finding.severity], ['CONTRACT_VIOLATION', 'AUTH_NOT_ENFORCED', 'HIGH']);
    assert.match(finding.title, /responded 200 without credentials although authentication is documented as required/);
  });

  it('a 5xx is a POTENTIAL_ISSUE — worth a person\'s look, not proof against the contract', async () => {
    const result = await run({}, { serverError: true });
    const [finding] = findingsOf(result, 'GET /health');
    assert.deepEqual([finding.classification, finding.type, finding.severity], ['POTENTIAL_ISSUE', 'SERVER_ERROR', 'HIGH']);
    assert.equal(result.summary.contractViolations, 0);
    assert.equal(result.summary.potentialIssues, 1, 'one finding for it, not a second for being undocumented');
  });

  it('a refusal the documentation merely does not list is a POTENTIAL_ISSUE, never a violation', () => {
    const op = { method: 'GET', path: '/things', security: ['bearer'], op: { responses: { 200: { description: 'ok' } } } };
    const evaluated = live.evaluateResponse({ openapi: '3.0.0', paths: {} }, op, 'UNAUTHENTICATED', { status: 401, contentType: 'application/json', headers: {}, text: '{"message":"no"}' });
    assert.deepEqual(evaluated.findings.map((f) => `${f.classification}:${f.type}:${f.severity}`), ['POTENTIAL_ISSUE:UNDOCUMENTED_STATUS:LOW']);
    assert.equal(live.evidenceOf(evaluated.checks), 'OBSERVED', 'an undocumented status is never VALIDATED');
  });

  it('checks documented required headers, status ranges and a default response', () => {
    const doc = { openapi: '3.0.0', paths: {} };
    const op = (responses: Record<string, unknown>) => ({ method: 'GET', path: '/x', security: [], op: { responses } });
    const ranged = live.evaluateResponse(doc, op({ '2XX': { description: 'ok' } }), 'ANONYMOUS', { status: 202, headers: {}, text: '' });
    assert.match(ranged.checks[0].detail ?? '', /202 is documented \(as 2XX\)/);
    const fallback = live.evaluateResponse(doc, op({ default: { description: 'anything' } }), 'ANONYMOUS', { status: 418, headers: {}, text: '' });
    assert.equal(fallback.checks[0].outcome, 'PASS');
    const headers = live.evaluateResponse(doc, op({ 200: { description: 'ok', headers: { 'X-Request-Id': { required: true, schema: { type: 'string' } } } } }), 'ANONYMOUS', { status: 200, headers: {}, text: '' });
    assert.deepEqual(headers.findings.map((f) => f.type), ['MISSING_HEADER']);
    assert.equal(live.evidenceOf(headers.checks), 'OBSERVED');
  });
});

describe('approved operations', () => {
  const auth = { token: FAKE_API_TOKEN };
  const all = ['POST /items', 'PUT /items/{id}', 'DELETE /items/{id}'];

  it('runs an approved creation: the empty body is rejected, the generated one creates, and the result is read back', async () => {
    const result = await run({ auth, approvedOperations: ['POST /items'] });
    assert.deepEqual(result.policy.approvedOperations, ['POST /items']);
    assert.deepEqual(probesOf(result, 'POST /items').map((p) => `${p.kind}:${p.response?.status}:${p.evidence}`), ['INVALID_BODY:422:VALIDATED', 'VALID_BODY:201:VALIDATED']);
    const created = api.apiRequests().find((r: { method: string; body: string }) => r.method === 'POST' && r.body.includes('title'))!;
    assert.match(created.body, /"title":"qa-probe-test1"/, 'generated from the documented schema, unique to the run');
    // The created resource is then read — the first real id this run has.
    assert.ok(endpoint(result, 'GET /items/{id}').validated.includes('AUTHENTICATED'));
    assert.ok(sent().includes('GET /items/item-1'));
    // Approving the creation approved nothing else.
    assert.equal(endpoint(result, 'DELETE /items/{id}').skipReason, 'APPROVAL_REQUIRED');
    assert.ok(!sent().some((s: string) => s.startsWith('DELETE') || s.startsWith('PUT')));
  });

  it('changes and deletes only what this run created — never the data that was already there', async () => {
    const result = await run({ auth, approvedOperations: all });
    const writes = sent().filter((s: string) => /^(PUT|DELETE)/.test(s));
    assert.ok(writes.length >= 2);
    assert.ok(writes.every((s: string) => /\/items\/item-\d+$/.test(s)), writes.join());
    assert.ok(!writes.some((s: string) => s.includes('seed-1')), 'the seeded item is never touched');
    assert.equal(api.state.items.has('seed-1'), true);
    assert.equal(endpoint(result, 'DELETE /items/{id}').evidence, 'VALIDATED');
    assert.equal(endpoint(result, 'PUT /items/{id}').evidence, 'VALIDATED');
    assert.equal(sent().at(-1)?.startsWith('DELETE'), true, 'the deletion is last: it cleans up what the run created');
  });

  it('a change or deletion approved without the creation has nothing it may touch', async () => {
    const result = await run({ auth, approvedOperations: ['PUT /items/{id}', 'DELETE /items/{id}'], pathParams: { id: 'seed-1' } });
    for (const key of ['PUT /items/{id}', 'DELETE /items/{id}']) {
      assert.equal(endpoint(result, key).skipReason, 'MISSING_TEST_DATA', key);
      assert.match(endpoint(result, key).skipDetail ?? '', /only ever touches a resource this run created/);
    }
    assert.ok(!sent().some((s: string) => /^(PUT|DELETE)/.test(s)), 'a configured id is used for reading, never for changing');
    assert.ok(sent().includes('GET /items/seed-1'));
    assert.equal(api.state.items.has('seed-1'), true);
  });

  it('never sends anything state-changing in a production environment, approved or not', async () => {
    const result = await run({ auth, approvedOperations: all, environment: 'production' });
    assert.ok(!sent().some((s: string) => /^(POST|PUT|DELETE)/.test(s)));
    assert.equal(endpoint(result, 'POST /items').skipReason, 'ENVIRONMENT_PROTECTED');
    assert.match(endpoint(result, 'POST /items').skipDetail ?? '', /nothing state-changing is sent in the "production" environment/);
    assert.equal(endpoint(result, 'GET /health').evidence, 'VALIDATED', 'reading is still allowed');
  });

  it('stops after an API that accepts an invalid body — a violation, and nothing more is sent to it', async () => {
    const result = await run({ auth, approvedOperations: ['POST /items'] }, { acceptsInvalid: true });
    const kinds = probesOf(result, 'POST /items').map((p) => p.kind);
    assert.deepEqual(kinds, ['INVALID_BODY']);
    // Two violations from the one response: it accepted the body, and what it returned breaks its own schema.
    assert.deepEqual(findingsOf(result, 'POST /items').map((f) => `${f.classification}:${f.type}`), ['CONTRACT_VIOLATION:VALIDATION_NOT_ENFORCED', 'CONTRACT_VIOLATION:SCHEMA_MISMATCH']);
    assert.equal(sent().filter((s: string) => s === 'POST /items').length, 1);
  });

  it('without credentials, an approved secured write is only checked for refusing', async () => {
    const before = api.state.items.size;
    const result = await run({ approvedOperations: ['POST /items'] });
    assert.deepEqual(probesOf(result, 'POST /items').map((p) => `${p.kind}:${p.response?.status}`), ['UNAUTHENTICATED:401']);
    assert.match(endpoint(result, 'POST /items').skipDetail ?? '', /no credentials are configured/);
    assert.equal(api.state.items.size, before, 'nothing was created');
  });

  it('runs an approved action-named GET, and only then', async () => {
    assert.ok(!(await run({ auth })).probes.some((p) => p.endpointId === ID['GET /session/logout']));
    const result = await run({ auth, approvedOperations: ['GET /session/logout'] });
    assert.equal(endpoint(result, 'GET /session/logout').execution, 'EXECUTED');
  });
});

describe('nothing sensitive reaches the artifact', () => {
  it('redacts credentials in requests, tokens and cookies in responses, and secret-named fields', async () => {
    const result = await run({ auth: { token: FAKE_API_TOKEN }, approvedOperations: ['POST /auth/login'] });
    const login = probesOf(result, 'POST /auth/login');
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, new RegExp(FAKE_API_TOKEN));
    assert.doesNotMatch(text, /abc123/, 'a session cookie value is never kept');
    for (const p of login) assert.ok(!p.request.body || !/Qa-probe-test1-1!/.test(p.request.body), 'a generated password is redacted in the stored request');
    assert.deepEqual(live.redactBody({ token: 'aaa', nested: { password: 'p', apiKey: 'k', title: 'kept' }, code: 401, otp: 123456, list: [{ secret: 's' }] }),
      { token: '<redacted>', nested: { password: '<redacted>', apiKey: '<redacted>', title: 'kept' }, code: 401, otp: '<redacted>', list: [{ secret: '<redacted>' }] });
    assert.equal(live.redactBody('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'), '<redacted>', 'a JWT is a credential wherever it sits');
  });
});

describe('reliability: a problem with the API never fails the run', () => {
  it('an API that does not answer: UNAVAILABLE, every operation documentation-only', async () => {
    const dead = await live.validateApi(spec, discovery, { enabled: true, docsUrl: 'http://127.0.0.1:9/docs', delayMs: 0, timeoutMs: 2000 });
    assert.equal(dead.status, 'UNAVAILABLE');
    assert.match(dead.reason ?? '', /could not be reached/);
    assert.ok(dead.endpoints.every((e) => e.evidence === 'DOCUMENTED' && e.execution === 'SKIPPED'));
    assert.equal(dead.endpoints.find((e) => e.safety === 'SAFE')!.skipReason, 'UNREACHABLE');
    assert.equal(live.hasLiveEvidence(dead), false);
    assert.deepEqual(validateWithSchema(SCHEMA, dead), []);
  });

  it('a rate limit stops the probing at once: PARTIAL, with what was learnt kept', async () => {
    const result = await run({}, { rateLimited: true });
    assert.equal(result.status, 'PARTIAL');
    assert.match(result.reason ?? '', /answered 429 \(rate limited, retry after 30\)/);
    assert.equal(result.policy.requestsSent, 1, 'no further request after the 429');
    assert.equal(endpoint(result, 'GET /items').skipReason, 'RATE_LIMITED');
  });

  it('a request budget bounds the run', async () => {
    const result = await run({ maxRequests: 2 });
    assert.equal(result.policy.requestsSent, 2);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(endpoint(result, 'GET /items/{id}').skipReason, 'REQUEST_BUDGET');
  });

  it('a slow response is a timeout: recorded, flagged for a look, and never VALIDATED', async () => {
    const result = await run({ timeoutMs: 60, maxRequests: 1 }, { slow: 400 });
    const [probe] = result.probes;
    assert.equal(probe.error?.code, 'TIMEOUT');
    assert.equal(probe.evidence, undefined);
    assert.equal(endpoint(result, 'GET /health').evidence, 'DOCUMENTED');
    assert.deepEqual(result.findings.map((f) => `${f.classification}:${f.type}`), ['POTENTIAL_ISSUE:TIMEOUT']);
  });

  it('a redirect is the response — it is never followed', async () => {
    const redirecting = { openapi: '3.0.0', info: {}, paths: { '/elsewhere': { get: { responses: { 200: { description: 'ok' } } } } } };
    const d = extractApiDiscovery(redirecting, { url: api.docsUrl, format: 'OPENAPI_JSON' });
    api.requests.length = 0;
    const result = await live.validateApi(redirecting, d, { enabled: true, docsUrl: api.docsUrl, delayMs: 0 });
    assert.equal(result.probes[0].response?.status, 302);
    assert.deepEqual(sent(), ['GET /elsewhere'], 'the Location was not requested');
    assert.equal(result.probes[0].evidence, 'OBSERVED');
  });

  it('is off, or has nothing to validate against, without calling anything', async () => {
    api.requests.length = 0;
    assert.equal((await live.validateApi(spec, discovery, { enabled: false, docsUrl: api.docsUrl })).status, 'NOT_REQUESTED');
    assert.equal((await live.validateApi(undefined, undefined, { enabled: true, docsUrl: api.docsUrl })).status, 'UNAVAILABLE');
    assert.deepEqual(sent(), []);
  });
});

describe('schemas and sample values', () => {
  it('turns an OpenAPI schema into JSON Schema: refs inlined, nullable, 3.0 exclusive bounds, cycles survived', () => {
    const doc = { openapi: '3.0.0', paths: {}, components: { schemas: {
      Node: { type: 'object', required: ['id', 'secret'], properties: { id: { type: 'string', format: 'uuid' }, secret: { type: 'string', writeOnly: true }, next: { $ref: '#/components/schemas/Node' }, score: { type: 'number', minimum: 0, exclusiveMinimum: true }, label: { type: 'string', nullable: true } } },
    } } };
    const schema = live.toJsonSchema(doc, { $ref: '#/components/schemas/Node' }) as { required: string[]; properties: Record<string, Record<string, unknown>> };
    assert.deepEqual(schema.required, ['id'], 'a write-only property is not required of a response');
    assert.deepEqual(schema.properties.label.type, ['string', 'null']);
    assert.equal(schema.properties.score.exclusiveMinimum, 0);
    assert.equal('minimum' in schema.properties.score, false);
    assert.deepEqual(schema.properties.next, {}, 'where the schema refers back to itself, anything is accepted — never a crash');
    assert.deepEqual(live.schemaProblems(doc, { $ref: '#/components/schemas/Node' }, { id: 'x', label: null, score: 1 }), { problems: [], checked: true });
    assert.equal(live.schemaProblems(doc, { $ref: '#/components/schemas/Node' }, { label: 3 }).problems.length, 2);
  });

  it('generates the plainest request body the documentation allows — required fields only, nothing the server owns', () => {
    const doc = { openapi: '3.0.0', paths: {} };
    const schema = { type: 'object', required: ['title', 'email', 'count', 'kind', 'id', 'tags'], properties: {
      id: { type: 'string', readOnly: true }, title: { type: 'string', minLength: 20, maxLength: 24 }, email: { type: 'string', format: 'email' },
      count: { type: 'integer', minimum: 5 }, kind: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' }, minItems: 2 }, optional: { type: 'string' },
    } };
    const body = live.sampleValue(doc, schema, 'n1') as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['count', 'email', 'kind', 'tags', 'title']);
    assert.equal((body.title as string).length, 20);
    assert.equal(body.email, 'qa-probe-n1@example.test');
    assert.equal(body.count, 5);
    assert.equal(body.kind, 'a');
    assert.equal((body.tags as unknown[]).length, 2);
    assert.deepEqual(live.schemaProblems(doc, schema, body).problems.filter((p) => !/id/.test(p)), []);
    assert.equal(live.sampleValue(doc, { type: 'string', example: 'from the document' }, 'n'), 'from the document');
  });
});

describe('live results as evidence downstream', () => {
  let result: ApiValidation;
  before(async () => { result = await run({ auth: { token: FAKE_API_TOKEN } }, { schemaDrift: true }); });
  const requirements = (): RequirementsAnalysis => ({
    feature: 'Items',
    acceptancePoints: [
      { id: 'AP-1', statement: 'Listing items responds with status 200 and the items.', evidenceIds: [ID['GET /items']] },
      { id: 'AP-2', statement: 'Creating an item responds with status 201.', evidenceIds: [ID['POST /items']] },
    ],
    businessRules: [], openQuestions: [], risks: [],
  });
  const tc = (over: Partial<TestCase>): TestCase => ({
    id: 'TC-1', title: 'Listing items responds with status 200', evidenceIds: ['AP-1'], covers: ['AP-1'], priority: 'P1', types: ['positive'], preconditions: [], testData: {},
    steps: [{ action: 'Send GET /items', expected: 'The response status is 200' }], expectedResult: 'Status 200 with the items', automationCandidate: true, automationReason: 'Deterministic', tags: [], testLevel: 'API', ...over,
  });
  const context = (): CoverageContext => ({ mode: 'AUTOMATIC', api: discovery, validation: result });

  it('gives each API-level case the evidence class of what it rests on — host-set, whatever a model wrote', () => {
    // The listing was called but broke its schema; the health check matched; the creation was never called.
    assert.equal(live.evidenceClassOf(result, ID['GET /items']), 'OBSERVED');
    assert.equal(live.evidenceClassOf(result, ID['GET /health']), 'VALIDATED');
    assert.equal(live.evidenceClassOf(result, ID['POST /items']), 'DOCUMENTED');
    assert.equal(live.evidenceClassOf(undefined, ID['GET /items']), 'DOCUMENTED', 'no live results: documentation only');
    assert.equal(apiEvidenceOf(tc({}), requirements(), context()), 'OBSERVED');
    assert.equal(apiEvidenceOf(tc({ evidenceIds: [ID['GET /health']], covers: [] }), requirements(), context()), 'VALIDATED');
    assert.equal(apiEvidenceOf(tc({ evidenceIds: ['AP-1', 'AP-2'] }), requirements(), context()), 'OBSERVED', 'the strongest of what it rests on');
    assert.equal(apiEvidenceOf(tc({ evidenceIds: ['AP-2'], covers: ['AP-2'] }), requirements(), context()), 'DOCUMENTED');
    assert.equal(apiEvidenceOf(tc({ testLevel: 'UI' }), requirements(), context()), undefined);
    const stamped = stampApiEvidence({ feature: 'Items', openQuestions: [], testCases: [
      tc({ apiEvidence: 'DOCUMENTED' }), tc({ id: 'TC-2', evidenceIds: ['AP-2'], covers: ['AP-2'], apiEvidence: 'VALIDATED' }), tc({ id: 'TC-3', testLevel: 'UI', apiEvidence: 'VALIDATED' }),
    ] }, requirements(), context());
    assert.deepEqual(stamped.testCases.map((c) => c.apiEvidence), ['OBSERVED', 'DOCUMENTED', undefined], 'a claim of VALIDATED for something never called is overwritten');
    // Without live results every API case is documentation-only, and says so.
    assert.equal(stampApiEvidence({ feature: 'Items', openQuestions: [], testCases: [tc({})] }, requirements(), { mode: 'AUTOMATIC', api: discovery }).testCases[0].apiEvidence, 'DOCUMENTED');
  });

  it('enters defect analysis as behaviors: documentation CONFIRMED, each real response OBSERVED, a violation flagged', () => {
    const { area, behaviors } = live.apiEvidenceBehaviors(discovery, result);
    assert.equal(area?.name, 'API');
    const documented = behaviors.find((b) => b.id === ID['GET /items'])!;
    assert.equal(documented.status, 'CONFIRMED');
    assert.match(documented.statement, /^Documented: GET \/items\./);
    const violation = result.findings.find((f) => f.type === 'SCHEMA_MISMATCH')!;
    const observed = behaviors.find((b) => b.id === violation.probeId)!;
    assert.equal(observed.status, 'OBSERVED');
    assert.equal(observed.suspectedIssue, true);
    assert.match(observed.statement, /^Observed: GET \/items with the configured credentials responded with status 200/);
    assert.equal(behaviors.filter((b) => b.suspectedIssue).length, 1, 'only a contract violation is a suspected issue');
    assert.deepEqual(live.apiEvidenceBehaviors(undefined, result).behaviors, []);
    assert.ok(live.apiEvidenceBehaviors(discovery, undefined).behaviors.every((b) => b.status === 'CONFIRMED'), 'nothing is OBSERVED that was not called');
  });

  it('a defect may rest on a real response — and must account for every violation the host found', () => {
    const violation = result.findings.find((f) => f.type === 'SCHEMA_MISMATCH')!;
    const refusal = result.probes.find((p) => p.endpointId === ID['GET /items'] && p.kind === 'UNAUTHENTICATED')!;
    const evidence = live.apiEvidenceBehaviors(discovery, result);
    const ctx = {
      discovery: { product: 'Items', locations: [], areas: [evidence.area!], behaviors: evidence.behaviors, openQuestions: [], conflicts: [] },
      requirements: requirements(), coverage: context(),
    };
    const finding = (over: Record<string, unknown>) => ({
      id: 'DEF-001', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: [violation.probeId], sourceAcceptancePointIds: ['AP-1'], reason: 'The body does not match the documented schema.',
      title: 'Listing items returns a body that does not match its documented schema', severity: 'MAJOR', steps: ['Send GET /items with the configured credentials'],
      expected: 'Listing items responds with status 200 and the items as documented.', actual: 'GET /items responded with status 200 and a body that does not match its documented schema.', ...over,
    });
    assert.deepEqual(validateDefectAnalysis({ findings: [finding({})] } as never, ctx as never), []);
    // Nothing the host flagged may be left out.
    assert.deepEqual(validateDefectAnalysis({ findings: [] }, ctx as never).map((e) => `${e.code}:${e.value}`), [`UNANALYZED_SUSPECTED_ISSUE:${violation.probeId}`]);
    // A response the host did not find violating anything cannot be promoted to a confirmed defect by a model.
    const promoted = validateDefectAnalysis({ findings: [finding({}), finding({ id: 'DEF-002', sourceBehaviorIds: [refusal.id], title: 'Listing items is refused without credentials', actual: 'GET /items without credentials responded with status 401.', expected: 'Listing items responds with status 200 and the items.' })] } as never, ctx as never);
    assert.ok(promoted.some((e) => e.code === 'UNSUPPORTED_EXPECTED' && /did not find a contract violation/.test(e.details ?? '')), JSON.stringify(promoted.map((e) => e.code)));
  });

  it('briefs each stage with what was really called — or that nothing was', () => {
    const executed = { available: true, endpoints: 8, live: { executed: true, validated: 3, observed: 1, documented: 4, contractViolations: 1, potentialIssues: 0 } };
    assert.match(coverageBriefing('analysis', 'AUTOMATIC', executed), /3 operation\(s\) VALIDATED, 1 OBSERVED, 4 DOCUMENTED only; 1 contract violation\(s\)/);
    assert.match(coverageBriefing('defects', 'API_ONLY', executed), /Every probe with a CONTRACT_VIOLATION must appear in a finding/);
    const absent = { available: true, endpoints: 8, live: { executed: false, validated: 0, observed: 0, documented: 8, contractViolations: 0, potentialIssues: 0, reason: 'the API at http://x could not be reached' } };
    assert.match(coverageBriefing('design', 'API_ONLY', absent), /The API was not called \(the API at http:\/\/x could not be reached\), so every operation is DOCUMENTED only/);
    assert.match(coverageBriefing('defects', 'AUTOMATIC', absent), /No API response was observed, so no defect can rest on API behavior/);
    assert.doesNotMatch(coverageBriefing('design', 'UI_ONLY', executed), /VALIDATED|api-validation/, 'UI only never mentions the API');
    assert.match(coverageBriefing('design', 'API_ONLY', executed), /positive, negative, boundary, authentication, authorization and schema-validation/);
  });

  it('is read from disk beside the documentation — and ignored without it, or in UI only', () => {
    qa.writeQaArtifact('api-discovery', discovery);
    qa.writeQaArtifact('api-validation', result);
    qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC', apiValidation: { enabled: true, environment: 'test', approvedOperations: [] } });
    assert.equal(qa.readCoverageContext().validation?.summary.contractViolations, 1);
    qa.writeQaArtifact('run-config', { coverageMode: 'UI_ONLY' });
    assert.equal(qa.readCoverageContext().validation, undefined);
    qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC' });
    assert.throws(() => qa.writeQaArtifact('api-validation', { ...result, probes: [{ id: 'made-up' }] }), /api-validation\.schema\.json/);
    // No agent can write it; every agent that reads artifacts can read it.
    const tools = readFileSync(join(PROJECT, 'src', 'tools', 'qa-artifacts.ts'), 'utf8');
    assert.doesNotMatch(/const ARTIFACT_NAMES = \[([\s\S]*?)\] as const/.exec(tools)![1], /api-validation/);
    assert.match(/const READABLE_ARTIFACT_NAMES = \[([\s\S]*?)\] as const/.exec(tools)![1], /'api-validation'/);
  });
});

describe('API only, end to end through the artifact library — no browser evidence anywhere', () => {
  it('requirements, test cases, defect analysis and a bug report all rest on documentation and real responses', async () => {
    const result = await run({ auth: { token: FAKE_API_TOKEN } }, { schemaDrift: true });
    const violation = result.findings.find((f) => f.type === 'SCHEMA_MISMATCH')!;
    qa.writeQaArtifact('run-config', { coverageMode: 'API_ONLY', apiDocsUrl: api.docsUrl, apiValidation: { enabled: true, environment: 'test', approvedOperations: [] } });
    qa.writeQaArtifact('api-discovery', discovery);
    qa.writeQaArtifact('api-validation', result);
    // What the runner writes in API-only mode: nothing was explored, said plainly.
    qa.writeQaArtifact('discovered-behavior', { product: 'Items API (API only: the interface was not explored)', locations: [], areas: [], behaviors: [], openQuestions: [], conflicts: [] });

    qa.writeQaArtifact('requirements-analysis', {
      feature: 'Items',
      acceptancePoints: [
        { id: 'AP-1', statement: 'Listing items with credentials responds with status 200 and the items.', evidenceIds: [ID['GET /items']], validationType: 'API' },
        { id: 'AP-2', statement: 'Listing items without credentials is refused with status 401, unauthenticated.', evidenceIds: [ID['GET /items']], validationType: 'API' },
        { id: 'AP-3', statement: 'Creating an item with a title responds with status 201, created.', evidenceIds: [ID['POST /items']], validationType: 'API' },
      ],
      businessRules: [], openQuestions: [], risks: [],
    });
    // A requirement that names an operation nobody documented is refused even here.
    assert.throws(() => qa.writeQaArtifact('requirements-analysis', {
      feature: 'Items', acceptancePoints: [{ id: 'AP-1', statement: 'Archiving an item through POST /items/archive responds with status 200.', evidenceIds: [ID['GET /items']] }], businessRules: [], openQuestions: [], risks: [],
    }), /UNSUPPORTED_FACT/);

    const tc = (id: string, covers: string, title: string, action: string, expected: string, types: string[]) => ({
      id, title, evidenceIds: [covers], covers: [covers], priority: 'P1', types, preconditions: [], testData: {}, steps: [{ action, expected }], expectedResult: expected,
      automationCandidate: true, automationReason: 'Deterministic', tags: [], testLevel: 'API',
    });
    qa.writeQaArtifact('test-cases', { feature: 'Items', openQuestions: [], testCases: [
      tc('TC-1', 'AP-1', 'Listing items with credentials responds with status 200', 'Send GET /items with credentials', 'The response status is 200 with the items', ['positive']),
      tc('TC-2', 'AP-2', 'Listing items without credentials is refused with status 401', 'Send GET /items without credentials', 'The request is refused with status 401, unauthenticated', ['negative', 'security-functional']),
      tc('TC-3', 'AP-3', 'Creating an item with a title responds with status 201', 'Send POST /items with a title', 'The response status is 201, created', ['positive']),
    ] });
    const suite = qa.readQaArtifact('test-cases') as { testCases: { id: string; apiEvidence?: string }[] };
    // On disk, each API case says how real its evidence is: the listing was called, the creation never was.
    assert.deepEqual(suite.testCases.map((c) => `${c.id}:${c.apiEvidence}`), ['TC-1:OBSERVED', 'TC-2:OBSERVED', 'TC-3:DOCUMENTED']);
    // A UI-level case is still refused in API only, whatever it cites.
    assert.throws(() => qa.writeQaArtifact('test-cases', { feature: 'Items', openQuestions: [], testCases: [{ ...tc('TC-1', 'AP-1', 'Listing items responds with status 200', 'Open the items page', 'The items are listed with status 200', ['positive']), testLevel: 'UI' }] }), /TEST_LEVEL_OUT_OF_MODE/);

    // Defect analysis: leaving out the violation the host found is refused...
    assert.throws(() => qa.writeQaArtifact('defect-analysis', { findings: [] }), /UNANALYZED_SUSPECTED_ISSUE/);
    // ...and a finding resting on the real response, against the documented expectation, is accepted.
    qa.writeQaArtifact('defect-analysis', { findings: [{
      id: 'DEF-001', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: [violation.probeId], sourceAcceptancePointIds: ['AP-1'], sourceTestCaseIds: ['TC-1'],
      reason: 'The response body does not match the schema the documentation declares; the evidence does not say which side is wrong.',
      title: 'Listing items returns a body that does not match its documented schema', severity: 'MAJOR',
      steps: ['Send GET /items with credentials'], expected: 'Listing items with credentials responds with status 200 and the items as documented.',
      actual: 'GET /items with the configured credentials responded with status 200 and a body that does not match its documented schema.',
    }] });
    const analysis = qa.readQaArtifact('defect-analysis') as { summary: { confirmed: number }; findings: { expectedBasis: string; bugReportId: string }[] };
    assert.equal(analysis.summary.confirmed, 1);
    assert.equal(analysis.findings[0].expectedBasis, 'CONFIRMED_REQUIREMENT', 'the documented contract is what the run was given');
    const bug = qa.readBugReport('BUG-001')!;
    assert.equal(bug.area, 'API');
    assert.equal(bug.environment.browser, 'none (HTTP request)', 'a defect seen in an API response was not seen in a browser');
    assert.deepEqual(bug.evidence, [{ type: 'OBSERVED', sourceId: violation.probeId }, { type: 'REQUIREMENT', sourceId: 'AP-1' }, { type: 'TEST_CASE', sourceId: 'TC-1' }]);
    // The whole set re-validates from disk, as the approval gate does.
    for (const name of ['requirements-analysis', 'test-cases', 'defect-analysis'] as const) assert.deepEqual(qa.semanticErrorsFor(name, qa.readQaArtifact(name)), [], name);

    // A documented expectation nobody verified is never a confirmed defect: a finding whose
    // "actual" is only the documentation itself has observed nothing.
    const { validateDefectAnalysis: judge } = await import('../src/lib/defects.ts');
    const evidence = live.apiEvidenceBehaviors(discovery, result);
    const ctx = { discovery: { product: 'Items', locations: [], areas: [evidence.area!], behaviors: evidence.behaviors, openQuestions: [], conflicts: [] }, requirements: qa.readQaArtifact('requirements-analysis'), coverage: qa.readCoverageContext() };
    const unverified = judge({ findings: [{
      id: 'DEF-001', classification: 'CONFIRMED_DEFECT', sourceBehaviorIds: [ID['POST /items']], sourceAcceptancePointIds: ['AP-3'], reason: 'Assumed from the documentation.',
      title: 'Creating an item fails', severity: 'MAJOR', steps: ['Send POST /items with a title'], expected: 'Creating an item with a title responds with status 201, created.', actual: 'Creating an item is rejected.',
    }] } as never, ctx as never);
    assert.ok(unverified.some((e) => e.code === 'UNOBSERVED_ACTUAL'), 'an operation that was never called shows nothing about what actually happens');

    // The rest of Phase 1 and the human gate work on API-only artifacts: prioritization, then approval.
    qa.writeQaArtifact('automation-prioritization', { cases: ['TC-1', 'TC-2', 'TC-3'].map((testCaseId) => ({ testCaseId, executionMode: 'AUTOMATION', automationPriority: 'HIGH', reason: 'Deterministic request and response', blockingFactors: [], automationStrategy: 'API' })) });
    assert.throws(() => qa.writeQaArtifact('automation-prioritization', { cases: ['TC-1', 'TC-2', 'TC-3'].map((testCaseId) => ({ testCaseId, executionMode: 'AUTOMATION', automationPriority: 'HIGH', reason: 'Deterministic', blockingFactors: [], automationStrategy: 'UI' })) }), /CONTRADICTORY_STRATEGY/);
    const gate = await import('../src/lib/phase1-gate.ts');
    const state = gate.inspectPhase1();
    assert.deepEqual(state.missing, [], 'nothing is missing: the empty discovery artifact is the host\'s own');
    assert.deepEqual([state.schemaErrors, state.hard, state.findings.map((f) => `${f.artifact}:${f.code}`)], [[], [], []]);
    assert.equal(state.defects?.bugs.length, 1);
    const approved = gate.approvePhase1();
    assert.equal(approved.ok, true, 'an API-only suite reaches human approval with no browser evidence anywhere');
    assert.deepEqual(gate.changedSinceApproval(JSON.parse(readFileSync(gate.APPROVAL_PATH, 'utf8'))), []);
    rmSync(gate.APPROVAL_PATH, { force: true });
    qa.writeQaArtifact('run-config', { coverageMode: 'AUTOMATIC' });
  });
});

describe('host configuration', () => {
  it('reads credentials, hosts, environment and limits from the environment — and a person\'s choice from the run', () => {
    const options = live.liveValidationOptions(
      { enabled: true, baseUrl: 'http://localhost:9000', approvedOperations: ['POST /items'] },
      { docsUrl: 'http://localhost:9000/docs', targetUrl: 'http://localhost:9001/' },
      { QA_API_ALLOWED_HOSTS: 'api.example.test, 10.0.0.5:8080', QA_API_ENVIRONMENT: 'staging', QA_API_AUTH_TOKEN: 't', QA_API_PATH_PARAMS: '{"id":"42","bad key":"x","n":7}', QA_API_MAX_REQUESTS: '25', QA_API_TIMEOUT_MS: 'soon' },
    );
    assert.deepEqual(options.allowedHosts, ['api.example.test', '10.0.0.5:8080']);
    assert.equal(options.environment, 'staging');
    assert.deepEqual(options.pathParams, { id: '42', n: '7' });
    assert.equal(options.maxRequests, 25);
    assert.equal(options.timeoutMs, undefined, 'a value that is not a positive integer is ignored');
    assert.deepEqual(options.approvedOperations, ['POST /items']);
    assert.equal(live.credentialsConfigured({ QA_API_AUTH_TOKEN: 't' }), true);
    assert.equal(live.credentialsConfigured({ QA_API_AUTH_USERNAME: 'u' }), false, 'a user name without a password is not credentials');
    assert.equal(live.isProtectedEnvironment('Production'), true);
    assert.equal(live.isProtectedEnvironment('staging'), false);
    for (const [raw, value] of [['on', true], ['false', false], ['1', true], ['maybe', undefined]] as const) assert.equal(live.parseSwitch(raw), value);
  });
});

describe('the workspace words it', () => {
  const endpoints = [
    { evidence: 'VALIDATED' as const, execution: 'EXECUTED', findings: [] },
    { evidence: 'OBSERVED' as const, execution: 'EXECUTED', findings: [{}] },
    { evidence: 'DOCUMENTED' as const, execution: 'SKIPPED', findings: [] },
    { evidence: 'DOCUMENTED' as const, execution: 'SKIPPED', findings: [] },
  ];

  it('counts and filters operations: validated, observed, documented only, not called, with mismatches', () => {
    assert.deepEqual(ui.endpointCounts(endpoints), { ALL: 4, VALIDATED: 1, OBSERVED: 1, DOCUMENTED: 2, SKIPPED: 2, MISMATCH: 1 });
    assert.equal(endpoints.filter((e) => ui.matchesEndpointFilter(e, 'MISMATCH')).length, 1);
  });

  it('labels skip reasons, and says in words why there is nothing live to show', () => {
    assert.equal(ui.skipLabel('APPROVAL_REQUIRED'), 'Needs approval');
    assert.equal(ui.skipLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
    assert.equal(ui.skipLabel(null), '');
    const view = (coverageMode: string, documentation: unknown, validation: unknown) => ui.unavailableMessage({ coverageMode, documentation, validation } as never);
    assert.match(view('UI_ONLY', null, null) ?? '', /designed UI only/);
    assert.match(view('AUTOMATIC', null, null) ?? '', /No API documentation was given/);
    assert.match(view('AUTOMATIC', { status: 'UNAVAILABLE', reason: 'HTTP 404' }, null) ?? '', /could not be read: HTTP 404/);
    assert.match(view('AUTOMATIC', { status: 'AVAILABLE', reason: null }, null) ?? '', /before live API validation existed/);
    assert.match(view('AUTOMATIC', { status: 'AVAILABLE', reason: null }, { status: 'UNAVAILABLE', reason: 'the API could not be reached' }) ?? '', /Live validation was not possible: the API could not be reached/);
    assert.equal(view('AUTOMATIC', { status: 'AVAILABLE', reason: null }, { status: 'COMPLETED', reason: null }), undefined);
    assert.equal(ui.operationKey({ method: 'POST', path: '/items' }), 'POST /items');
  });
});

describe('API discovery completes by its own criteria — none of them about a browser', () => {
  it('is complete with live evidence, complete on documentation alone, and blocked without documentation', async () => {
    const result = await run();
    const complete = live.apiDiscoveryCompletion(discovery, result);
    assert.deepEqual([complete.status, complete.evidence], ['COMPLETE', 'LIVE']);
    assert.deepEqual(complete.criteria.map((c) => `${c.name}:${c.met}:${c.required}`), ['DOCUMENTATION_READ:true:true', 'OPERATIONS_DISCOVERED:true:true', 'OPERATIONS_ACCOUNTED_FOR:true:true', 'LIVE_OBSERVATION:true:false']);
    assert.match(complete.criteria[2].detail, /3 called, 5 skipped with a reason/);
    assert.doesNotMatch(JSON.stringify(complete), /browser|page|location|snapshot|screenshot|DOM/i);

    // The API could not be called: discovery still completes, and says what it rests on.
    const docsOnly = live.apiDiscoveryCompletion(discovery, await live.validateApi(spec, discovery, { enabled: true, docsUrl: 'http://127.0.0.1:9/docs', delayMs: 0, timeoutMs: 1500 }));
    assert.deepEqual([docsOnly.status, docsOnly.evidence], ['COMPLETE', 'DOCUMENTATION_ONLY']);
    assert.equal(docsOnly.criteria.find((c) => c.name === 'LIVE_OBSERVATION')!.met, false);
    assert.deepEqual([live.apiDiscoveryCompletion(discovery, undefined).status, live.apiDiscoveryCompletion(discovery, undefined).evidence], ['COMPLETE', 'DOCUMENTATION_ONLY']);

    const none = live.apiDiscoveryCompletion({ status: 'UNAVAILABLE', reason: 'could not be fetched: HTTP 404', authentication: [], endpoints: [], schemas: [] }, undefined);
    assert.deepEqual([none.status, none.evidence], ['BLOCKED', 'NONE']);
    assert.match(none.reason ?? '', /documentation read: could not be fetched: HTTP 404/);
    assert.equal(live.apiDiscoveryCompletion(undefined, undefined).status, 'BLOCKED');
    // An operation the prober neither called nor explained would block it: nothing may be silently dropped.
    const dropped = structuredClone(result);
    delete dropped.endpoints[1].skipReason;
    dropped.endpoints[1].execution = 'SKIPPED';
    assert.equal(live.apiDiscoveryCompletion(discovery, dropped).status, 'BLOCKED');
  });

  it('is worded for a person: the method, and its limits', () => {
    assert.equal(ui.discoveryLabel(null), 'UI (browser)', 'a run from before the two were independent explored the interface');
    assert.equal(ui.discoveryLabel({ methods: ['API'], api: { status: 'COMPLETE', evidence: 'LIVE' } }), 'API (documentation + live requests)');
    assert.equal(ui.discoveryLabel({ methods: ['UI', 'API'], api: { status: 'COMPLETE', evidence: 'DOCUMENTATION_ONLY' } }), 'UI (browser) + API (documentation only)');
    assert.equal(ui.discoveryLabel({ methods: [] }), 'none');
    const notes = ui.discoveryNotes({ methods: ['API'], ui: { status: 'SKIPPED', reason: 'API only: the interface is not explored' }, api: { status: 'COMPLETE', evidence: 'DOCUMENTATION_ONLY' } });
    assert.match(notes[0], /No browser was started: API only/);
    assert.match(notes[1], /Documentation only: the API was not called/);
    assert.deepEqual(ui.discoveryNotes({ methods: ['UI'], ui: { status: 'PLANNED' }, api: { status: 'BLOCKED', reason: 'documentation read: HTTP 404', evidence: 'NONE' } }), ['API discovery was blocked: documentation read: HTTP 404.']);
    assert.equal(ui.mayOmitTarget('API_ONLY', 'http://x/docs'), true);
    assert.equal(ui.mayOmitTarget('AUTOMATIC', 'http://x/docs'), true);
    assert.equal(ui.mayOmitTarget('AUTOMATIC', '  '), false);
    assert.equal(ui.mayOmitTarget('UI_ONLY', 'http://x/docs'), false);
  });
});

/** The real runner, without blocking this process — the API it calls is served here. Stops at its first agent: no model is reachable. */
function runPhase1(args: string[], env: Record<string, string>): Promise<{ output: string; root: string; read: (name: string) => any }> {
  const root = mkdtempSync(join(tmpdir(), 'qa-independent-api-'));
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(PROJECT, 'scripts', 'qa-manual.mjs'), '--attempts', '1', ...args], {
      cwd: PROJECT,
      env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: '/nonexistent', LANGFUSE_ENABLED: 'false', TARGET_URL: '', QA_MODEL: 'ollama/none', QA_COVERAGE_MODE: '', QA_API_DOCS_URL: '', QA_API_LIVE_VALIDATION: '', QA_API_APPROVED_OPERATIONS: '', QA_API_BASE_URL: '', PLAYWRIGHT_MCP_URL: 'http://127.0.0.1:9/mcp', ...env },
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', () => { clearTimeout(timer); done({ output, root, read: (name) => JSON.parse(readFileSync(join(root, name), 'utf8')) }); });
  });
}

describe('the Phase 1 runner: UI and API discovery are independent', () => {
  it('API only with documentation but an API that cannot be called: documentation-only, still no browser', async () => {
    api.requests.length = 0;
    // The API "is" somewhere this run may not call: live validation is unavailable, discovery is not.
    const r = await runPhase1(['--coverage-mode', 'api', '--api-docs', api.specUrl, '--api-base-url', 'http://127.0.0.1:9'], {});
    assert.match(r.output, /API validation\s+: UNAVAILABLE — .*is on a host this run may not call.*continues with the documentation alone/);
    assert.match(r.output, /Discovery\s+: API \(documentation only\) — no browser/);
    assert.match(r.output, /Stages\s+: Behavior Analyst ->/);
    assert.match(r.output, /every operation is DOCUMENTED only/, 'the agents are told nothing was observed');
    assert.doesNotMatch(r.output, /Playwright MCP|Product surface/);
    assert.deepEqual([r.read('run-config.json').discovery.api.status, r.read('run-config.json').discovery.api.evidence], ['COMPLETE', 'DOCUMENTATION_ONLY']);
    assert.equal(r.read('api-validation.json').status, 'UNAVAILABLE');
    assert.deepEqual(sent(), [], 'nothing was sent to the API');
    rmSync(r.root, { recursive: true, force: true });
  });

  it('Automatic with no application URL discovers the API alone; with one that is down, the same — never a browser', async () => {
    const noUi = await runPhase1(['--api-docs', api.docsUrl], {});
    assert.match(noUi.output, /Coverage mode\s+: Automatic/);
    assert.match(noUi.output, /Discovery\s+: API \(documentation \+ live requests\) — no browser: no application URL \(TARGET_URL\) was given/);
    assert.doesNotMatch(noUi.output, /Playwright MCP|TARGET_URL is not set/);
    assert.deepEqual(noUi.read('run-config.json').discovery.ui, { status: 'SKIPPED', reason: 'no application URL (TARGET_URL) was given' });
    assert.deepEqual(noUi.read('discovered-behavior.json').behaviors, []);
    rmSync(noUi.root, { recursive: true, force: true });

    const down = await runPhase1(['--api-docs', api.docsUrl], { TARGET_URL: 'http://127.0.0.1:9/' });
    assert.match(down.output, /no browser: the application at http:\/\/127\.0\.0\.1:9\/ did not answer/);
    assert.match(down.output, /Stages\s+: Behavior Analyst ->/);
    assert.doesNotMatch(down.output, /Playwright MCP|Target unreachable/i);
    assert.deepEqual(down.read('run-config.json').discovery.methods, ['API']);
    rmSync(down.root, { recursive: true, force: true });
  });

  it('with no usable discovery source at all: a clear configuration error, nothing archived, no browser', async () => {
    const invalid = await runPhase1(['--coverage-mode', 'api', '--api-docs', `${api.origin}/health`], {});
    assert.match(invalid.output, /Phase 1 not started: API-only coverage needs API documentation, and the API documentation is unavailable \(.*not an OpenAPI or Swagger document/);
    assert.match(invalid.output, /no browser was started/);
    assert.ok(!existsSync(join(invalid.root, 'discovered-behavior.json')) && !existsSync(join(invalid.root, 'archive')));
    rmSync(invalid.root, { recursive: true, force: true });

    const neither = await runPhase1(['--api-docs', 'http://127.0.0.1:9/openapi.json'], { TARGET_URL: 'http://127.0.0.1:9/' });
    assert.match(neither.output, /Nothing can be discovered: the interface is not available \(the application at .* did not answer.*\) and the API documentation is unavailable/);
    assert.doesNotMatch(neither.output, /Playwright MCP/);
    rmSync(neither.root, { recursive: true, force: true });

    // UI only is untouched by all of this: it needs its application URL, and reads no API documentation.
    api.requests.length = 0;
    const uiOnly = await runPhase1(['--coverage-mode', 'ui', '--api-docs', api.docsUrl], {});
    assert.match(uiOnly.output, /TARGET_URL is not set/);
    assert.equal(api.requests.length, 0, 'UI only never reads the API documentation or calls the API');
    rmSync(uiOnly.root, { recursive: true, force: true });
  });
});

describe('the Phase 1 runner: API only, against a real API, without a browser', () => {
  it('reads the documentation, validates live, records that nothing was explored, and starts at the Behavior Analyst', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-api-only-runner-'));
    api.requests.length = 0;
    // Spawned without blocking: the API it calls is served by this very process.
    const output = await new Promise<string>((done) => {
      const child = spawn(process.execPath, [join(PROJECT, 'scripts', 'qa-manual.mjs'), '--coverage-mode', 'api', '--api-docs', api.docsUrl, '--attempts', '1'], {
        cwd: PROJECT,
        // No reachable model: the run stops at its first agent, after everything the host does on its own.
        // And no application URL either: an API-only run needs none.
        env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: '/nonexistent', LANGFUSE_ENABLED: 'false', TARGET_URL: '', QA_MODEL: 'ollama/none', QA_COVERAGE_MODE: '', QA_API_DOCS_URL: '', QA_API_LIVE_VALIDATION: '', QA_API_APPROVED_OPERATIONS: '', QA_API_BASE_URL: '', PLAYWRIGHT_MCP_URL: 'http://127.0.0.1:9/mcp' },
      });
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      child.stderr.on('data', (c) => { text += c; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('close', () => { clearTimeout(timer); done(text); });
    });
    assert.match(output, /Stages\s+: Behavior Analyst -> Test Designer -> Automation Prioritizer -> Defect Analyzer -> STOP/);
    assert.match(output, /API validation\s+: 3 request\(s\) to http:\/\/127\.0\.0\.1:\d+: 3 validated, 0 observed, 5 documented only/);
    assert.doesNotMatch(output, /Playwright MCP|Product surface|TARGET_URL is not set/, 'no browser is started, and no application URL is asked for');
    assert.match(output, /Discovery\s+: API \(documentation \+ live requests\) — no browser: API only/);
    assert.match(output, /Target\s+: \(not needed for this plan\)/);
    const read = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));
    assert.deepEqual(read('discovered-behavior.json').behaviors, [], 'host-written: nothing was observed in the interface');
    assert.match(read('discovered-behavior.json').product, /API only: the interface was not explored/);
    assert.equal(read('api-validation.json').status, 'COMPLETED');
    assert.deepEqual(read('run-config.json').apiValidation, { enabled: true, environment: 'test', approvedOperations: [] });
    const recorded = read('run-config.json').discovery;
    assert.deepEqual(recorded.methods, ['API']);
    assert.deepEqual(recorded.ui, { status: 'SKIPPED', reason: 'API only: the interface is not explored' });
    assert.deepEqual([recorded.api.status, recorded.api.evidence], ['COMPLETE', 'LIVE']);
    // API discovery is a stage of its own in the run's event log, before any agent.
    const events = readFileSync(join(root, 'runs', readFileSync(join(root, 'run-config.json'), 'utf8').match(/"runId": "([^"]+)"/)![1], 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(events[0].plan.map((s: { key: string }) => s.key), ['api-discovery', 'analysis', 'design', 'prioritization', 'defects']);
    assert.ok(events.some((e) => e.type === 'STAGE_COMPLETED' && e.stage === 'api-discovery'));
    assert.ok(!events.some((e) => e.stage === 'discovery' || e.category === 'BROWSER'), 'no browser stage, no browser event');
    assert.equal(read('phase1-run.json').apiValidation.validated, 3);
    assert.ok(existsSync(join(root, 'runs')), 'the run is archived');
    assert.deepEqual(sent().filter((s: string) => !s.startsWith('GET')), [], 'the run sent nothing but reads');
    rmSync(root, { recursive: true, force: true });
  });
});
