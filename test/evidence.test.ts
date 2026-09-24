// Deterministic browser evidence.
//
// Everything here is pure: the parsers are fed the exact text @playwright/mcp
// 0.0.82 produced against a live server, captured while building this feature.
// If the server's format changes, these fixtures stop matching and the parser
// tests fail — which is the point. A silent format change would otherwise turn
// into "no console errors found", which reads as a clean bill of health.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FINDINGS,
  MAX_FINDINGS_PER_LOCATION,
  accumulate,
  buildEvidence,
  classifyConsole,
  classifyNetwork,
  coverageNote,
  dropRedundantResourceEchoes,
  evidenceSummary,
  fingerprint,
  isStaticResource,
  parseConsoleMessages,
  markReplaySuspects,
  parseNetworkRequests,
  singleUseParam,
  totalsFor,
  type RawFinding,
} from '../src/lib/browser-evidence.ts';

const LOC = 'http://localhost:4444/';

// Captured verbatim from @playwright/mcp 0.0.82.
const CONSOLE_TEXT = `### Result
Total messages: 2 (Errors: 1, Warnings: 0)

[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) @ http://localhost:4444/missing.png:0
[VERBOSE] [DOM] Input elements should have autocomplete attributes (suggested: "current-password"): (More info: https://goo.gl/9p2vKq) %o @ http://localhost:4444/:0`;

const NETWORK_TEXT = `### Result
1. [GET] http://localhost:4444/ => [200] OK
2. [GET] http://localhost:4444/assets/styles.css => [200] OK
3. [GET] http://localhost:4444/missing.png => [404] Not Found
4. [POST] http://localhost:4444/api/notes => [500] Internal Server Error`;

// ---------------------------------------------------------------------------
// Console error collection
// ---------------------------------------------------------------------------

describe('console error collection', () => {
  it('parses the level, message and source out of the server text', () => {
    const messages = parseConsoleMessages(CONSOLE_TEXT);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].level, 'ERROR');
    assert.match(messages[0].message, /^Failed to load resource/);
    assert.equal(messages[0].source, 'http://localhost:4444/missing.png:0');
  });

  it('keeps a message containing " @ " intact, taking the source from the last one', () => {
    const [m] = parseConsoleMessages('[ERROR] Invalid address a @ b for user @ http://x/y.js:12');
    assert.equal(m.message, 'Invalid address a @ b for user');
    assert.equal(m.source, 'http://x/y.js:12');
  });

  it('treats a trailing "@ something with spaces" as message text, not a source', () => {
    const [m] = parseConsoleMessages('[ERROR] failed @ two words');
    assert.equal(m.source, undefined);
    assert.equal(m.message, 'failed @ two words');
  });

  it('reports only errors and warnings — verbose and info are page noise', () => {
    const findings = classifyConsole(parseConsoleMessages(CONSOLE_TEXT), LOC);
    assert.equal(findings.length, 1, 'the VERBOSE autocomplete hint is not a finding');
    assert.equal(findings[0].type, 'CONSOLE_ERROR');
  });

  it('classifies a warning as a warning', () => {
    const findings = classifyConsole(parseConsoleMessages('[WARNING] deprecated API @ http://x/a.js:1'), LOC);
    assert.deepEqual(findings.map((f) => f.type), ['CONSOLE_WARNING']);
  });

  it('yields nothing rather than nonsense when the format is unrecognised', () => {
    assert.deepEqual(parseConsoleMessages('### Result\nno messages\n'), []);
  });
});

// ---------------------------------------------------------------------------
// Failed request collection
// ---------------------------------------------------------------------------

describe('failed request collection', () => {
  it('parses method, url and status', () => {
    const requests = parseNetworkRequests(NETWORK_TEXT);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[3], {
      method: 'POST',
      url: 'http://localhost:4444/api/notes',
      status: 500,
      statusText: 'Internal Server Error',
    });
  });

  it('reports only requests that failed, never the successful ones', () => {
    const findings = classifyNetwork(parseNetworkRequests(NETWORK_TEXT), LOC);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map((f) => f.status).sort(), [404, 500]);
  });

  it('separates a broken resource from a failed action', () => {
    const findings = classifyNetwork(parseNetworkRequests(NETWORK_TEXT), LOC);
    const byType = Object.fromEntries(findings.map((f) => [f.type, f]));
    assert.equal(byType.BROKEN_RESOURCE.source, 'http://localhost:4444/missing.png');
    assert.equal(byType.REQUEST_FAILED.source, 'http://localhost:4444/api/notes');
  });

  it('keeps a request that never completed — no status is evidence, not absence', () => {
    const findings = classifyNetwork(parseNetworkRequests('1. [GET] http://x/api/slow => [pending] '), LOC);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].status, undefined);
    assert.match(findings[0].detail, /did not complete/);
  });

  it('judges a static resource by its path, ignoring the query string', () => {
    assert.equal(isStaticResource('http://x/a/app.js?v=3'), true);
    assert.equal(isStaticResource('http://x/logo.SVG'), true);
    assert.equal(isStaticResource('http://x/api/notes'), false);
    assert.equal(isStaticResource('http://x/notes.js.map'), true);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
    type: 'CONSOLE_ERROR',
    location: LOC,
    detail: 'boom',
    ...over,
  });

  it('counts a repeat instead of adding a second row', () => {
    const { findings } = accumulate([finding(), finding(), finding()]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].occurrences, 3);
  });

  it('ignores case and whitespace when deciding two facts are the same', () => {
    assert.equal(fingerprint(finding({ detail: 'Boom  Bang' })), fingerprint(finding({ detail: 'boom bang' })));
  });

  it('does not merge different statuses of the same URL', () => {
    const a = finding({ type: 'REQUEST_FAILED', detail: 'GET http://x/a returned 404', source: 'http://x/a' });
    const b = finding({ type: 'REQUEST_FAILED', detail: 'GET http://x/a returned 500', source: 'http://x/a' });
    assert.notEqual(fingerprint(a), fingerprint(b), '404 and 500 are different problems');
    assert.equal(accumulate([a, b]).findings.length, 2);
  });

  it('keeps the same error seen at two locations apart', () => {
    const { findings } = accumulate([finding({ location: 'http://x/one' }), finding({ location: 'http://x/two' })]);
    assert.equal(findings.length, 2);
  });

  it('drops the console echo of a failed request already recorded from the network log', () => {
    const raw: RawFinding[] = [
      {
        type: 'CONSOLE_ERROR',
        location: LOC,
        detail: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
        source: 'http://localhost:4444/missing.png:0',
      },
      {
        type: 'BROKEN_RESOURCE',
        location: LOC,
        detail: 'GET http://localhost:4444/missing.png returned 404 Not Found',
        source: 'http://localhost:4444/missing.png',
        status: 404,
      },
    ];
    const kept = dropRedundantResourceEchoes(raw);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].type, 'BROKEN_RESOURCE', 'the entry carrying method and status survives');
  });

  it("keeps an application's own console error about a URL that also failed", () => {
    const raw: RawFinding[] = [
      { type: 'CONSOLE_ERROR', location: LOC, detail: 'Could not save the note', source: 'http://localhost:4444/api/notes:0' },
      { type: 'REQUEST_FAILED', location: LOC, detail: 'POST http://localhost:4444/api/notes returned 500', source: 'http://localhost:4444/api/notes', status: 500 },
    ];
    assert.equal(dropRedundantResourceEchoes(raw).length, 2, 'only the browser-generated wording is redundant');
  });

  it('assigns sequential ids in encounter order, stably', () => {
    const raw = [finding({ detail: 'first' }), finding({ detail: 'second' })];
    assert.deepEqual(accumulate(raw).findings.map((f) => f.id), ['EV-001', 'EV-002']);
    assert.deepEqual(accumulate(raw).findings.map((f) => f.id), ['EV-001', 'EV-002']);
  });
});

// ---------------------------------------------------------------------------
// Bounded storage
// ---------------------------------------------------------------------------

describe('bounded storage', () => {
  it('stops at the per-location cap and records the overflow', () => {
    const raw: RawFinding[] = Array.from({ length: MAX_FINDINGS_PER_LOCATION + 5 }, (_, i) => ({
      type: 'CONSOLE_ERROR',
      location: LOC,
      detail: `error ${i}`,
    }));
    const { findings, overflow } = accumulate(raw);
    assert.equal(findings.length, MAX_FINDINGS_PER_LOCATION);
    assert.equal(overflow, 5, 'what did not fit is counted, not silently dropped');
  });

  it('stops at the run-wide cap across many locations', () => {
    const raw: RawFinding[] = [];
    for (let loc = 0; loc < 20; loc += 1) {
      for (let i = 0; i < 10; i += 1) {
        raw.push({ type: 'CONSOLE_ERROR', location: `http://x/${loc}`, detail: `error ${i}` });
      }
    }
    const { findings, overflow } = accumulate(raw);
    assert.equal(findings.length, MAX_FINDINGS);
    assert.equal(findings.length + overflow, 200);
  });

  it('a duplicate past the cap still counts as an occurrence, not an overflow', () => {
    const many: RawFinding[] = Array.from({ length: MAX_FINDINGS_PER_LOCATION }, (_, i) => ({
      type: 'CONSOLE_ERROR',
      location: LOC,
      detail: `error ${i}`,
    }));
    const { findings, overflow } = accumulate([...many, { type: 'CONSOLE_ERROR', location: LOC, detail: 'error 0' }]);
    assert.equal(overflow, 0);
    assert.equal(findings.find((f) => f.detail === 'error 0')?.occurrences, 2);
  });
});

// ---------------------------------------------------------------------------
// No fabricated evidence
// ---------------------------------------------------------------------------

describe('evidence cannot be fabricated', () => {
  it('is absent from the write picklist, so no agent can author it', async () => {
    const { writeQaArtifactToolFor } = await import('../src/tools/qa-artifacts.ts');
    // The unrestricted tool is the widest write capability that exists.
    const widest = writeQaArtifactToolFor([
      'discovered-behavior',
      'requirements-analysis',
      'test-cases',
      'automation-prioritization',
      'test-cases-review',
      'repo-analysis',
      'ui-exploration',
      'automation-plan',
    ]);
    assert.doesNotMatch(
      widest.description,
      /discovery-evidence/,
      'no agent is offered discovery-evidence as a writable name',
    );
  });

  it('is readable, so a model may interpret what the host collected', async () => {
    const { readQaArtifactTool } = await import('../src/tools/qa-artifacts.ts');
    const v = await import('valibot');
    const ok = v.safeParse(readQaArtifactTool.input!, { name: 'discovery-evidence' });
    assert.equal(ok.success, true, 'read_qa_artifact accepts discovery-evidence');
  });

  it('rejects a write of discovery-evidence at the schema, before run() executes', async () => {
    const { writeQaArtifactTool } = await import('../src/tools/qa-artifacts.ts');
    const v = await import('valibot');
    const attempt = v.safeParse(writeQaArtifactTool.input!, {
      name: 'discovery-evidence',
      data: { findings: [] },
    });
    assert.equal(attempt.success, false, 'the widest write tool still refuses the name');
  });

  it('derives every total from the findings rather than accepting a reported one', () => {
    const { findings } = accumulate([
      { type: 'CONSOLE_ERROR', location: LOC, detail: 'a' },
      { type: 'CONSOLE_ERROR', location: LOC, detail: 'a' },
      { type: 'BROKEN_RESOURCE', location: LOC, detail: 'b', source: 'http://x/i.png', status: 404 },
    ]);
    const totals = totalsFor(findings);
    assert.equal(totals.consoleErrors, 2, 'occurrences count, not rows');
    assert.equal(totals.brokenResources, 1);
    assert.equal(totals.consoleWarnings, 0);
  });

  it('states what the evidence does not cover, so absence is not read as proof', () => {
    const note = coverageNote(4);
    assert.match(note, /page-load/i);
    assert.match(note, /not include/i);
    assert.match(note, /absence of/i);
    assert.match(note, /unauthenticated/i, 'a logged-out collection must say so');
  });
});

// ---------------------------------------------------------------------------
// Tied to the current run and page state
// ---------------------------------------------------------------------------

describe('evidence is tied to the run and the page state', () => {
  const build = (over = {}) =>
    buildEvidence({
      runId: 'RUN-1',
      target: LOC,
      origin: 'http://localhost:4444',
      locations: [{ requestedUrl: LOC, finalUrl: LOC, status: 200, redirected: false, collected: true }],
      accumulated: accumulate([{ type: 'CONSOLE_ERROR', location: LOC, detail: 'boom' }]),
      now: new Date('2026-09-24T00:00:00.000Z'),
      ...over,
    });

  it('carries the run id, so evidence from an earlier run is recognisable', () => {
    assert.equal(build().runId, 'RUN-1');
    assert.equal(build().collectedAt, '2026-09-24T00:00:00.000Z');
  });

  it('records where the browser actually ended up, not where it was sent', () => {
    const evidence = build({
      locations: [{ requestedUrl: 'http://localhost:4444/account', finalUrl: 'http://localhost:4444/', status: 200, redirected: true, collected: true }],
    });
    assert.equal(evidence.locations[0].redirected, true);
    assert.equal(evidence.locations[0].finalUrl, 'http://localhost:4444/');
  });

  it('marks a location the host could not reach, with the reason', () => {
    const evidence = build({
      locations: [{ requestedUrl: 'http://localhost:4444/gone', redirected: false, collected: false, error: 'net::ERR_ABORTED' }],
    });
    assert.equal(evidence.locations[0].collected, false);
    assert.match(evidence.locations[0].error!, /ERR_ABORTED/);
  });

  it('validates against its schema', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.deepEqual(schemaErrorsFor('discovery-evidence', build()), []);
  });

  it('rejects a findings entry with an unknown type', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const bad = build();
    (bad.findings[0] as { type: string }).type = 'VIBES';
    assert.ok(schemaErrorsFor('discovery-evidence', bad).length > 0);
  });

  it('summarises for the run log without inventing a ratio', () => {
    const line = evidenceSummary(build());
    assert.match(line, /1 location\(s\)/);
    assert.match(line, /1 console error\(s\)/);
    assert.doesNotMatch(line, /%/);
  });
});

// ---------------------------------------------------------------------------
// Replaying a spent one-time token
// ---------------------------------------------------------------------------
//
// The first live run of this collector produced exactly the URL below. The
// agent had already consumed the confirmation code, so the host's replay got
// `POST /api/auth/confirm -> 400`. The request really did fail; the cause was
// the replay. Unmarked, that becomes a fabricated defect downstream.

describe('replaying a single-use URL', () => {
  const CONFIRM_URL = 'http://localhost:4444/app?confirm_email=tester@example.com&confirm_code=615755';

  it('recognises the one-time parameter from the real run', () => {
    assert.equal(singleUseParam(CONFIRM_URL), 'confirm_code');
  });

  it('recognises other common one-time credentials', () => {
    assert.equal(singleUseParam('http://x/r?reset_token=abc'), 'reset_token');
    assert.equal(singleUseParam('http://x/i?invite=abc'), 'invite');
    assert.equal(singleUseParam('http://x/v?otp=1234'), 'otp');
  });

  it('does not flag an ordinary query that merely filters', () => {
    assert.equal(singleUseParam('http://x/notes?query=alpha&sort=title'), undefined);
    assert.equal(singleUseParam('http://x/account/profile'), undefined);
  });

  it('marks every finding collected at such a location', () => {
    const raw = classifyNetwork(
      parseNetworkRequests('1. [POST] http://localhost:4444/api/auth/confirm => [400] Bad Request'),
      CONFIRM_URL,
    );
    const marked = markReplaySuspects(raw, CONFIRM_URL);
    assert.equal(marked[0].replaySuspect, true);
  });

  it('leaves findings at an ordinary location unmarked', () => {
    const raw = classifyNetwork(parseNetworkRequests('1. [GET] http://x/a.png => [404] Not Found'), LOC);
    assert.equal(markReplaySuspects(raw, LOC)[0].replaySuspect, undefined);
  });

  it('still reports the failure — a marked finding is kept, not discarded', () => {
    const raw = markReplaySuspects(
      classifyNetwork(parseNetworkRequests('1. [POST] http://x/api/auth/confirm => [400] Bad Request'), CONFIRM_URL),
      CONFIRM_URL,
    );
    const { findings } = accumulate(raw);
    assert.equal(findings.length, 1, 'the evidence is real and stays');
    assert.equal(findings[0].replaySuspect, true, 'but it carries the caveat');
  });

  it('accepts the caveat fields in the schema', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const evidence = buildEvidence({
      runId: 'R',
      target: LOC,
      origin: 'http://localhost:4444',
      locations: [{
        requestedUrl: CONFIRM_URL,
        finalUrl: 'http://localhost:4444/app',
        status: 200,
        redirected: true,
        collected: true,
        replayCaveat: 'URL carries a single-use parameter ("confirm_code").',
      }],
      accumulated: accumulate(markReplaySuspects(
        classifyNetwork(parseNetworkRequests('1. [POST] http://x/api/auth/confirm => [400] Bad Request'), CONFIRM_URL),
        CONFIRM_URL,
      )),
    });
    assert.deepEqual(schemaErrorsFor('discovery-evidence', evidence), []);
  });
});

// ---------------------------------------------------------------------------
// Security boundaries unchanged
// ---------------------------------------------------------------------------

describe('security boundaries are unchanged', () => {
  it('still refuses to mount the code-execution browser tools anywhere', async () => {
    const mod = await import('../src/connections/playwright-mcp.ts');
    const every = [
      ...mod.DISCOVERY_BROWSER_TOOLS,
      ...mod.UI_EXPLORER_BROWSER_TOOLS,
      ...mod.FAILURE_ANALYSIS_BROWSER_TOOLS,
    ];
    for (const forbidden of mod.FORBIDDEN_BROWSER_TOOLS) {
      assert.ok(!every.includes(forbidden), `${forbidden} must never be mounted`);
    }
  });

  it('did not widen Product Discovery to collect evidence itself', async () => {
    const mod = await import('../src/connections/playwright-mcp.ts');
    assert.ok(
      !mod.DISCOVERY_BROWSER_TOOLS.includes('browser_console_messages'),
      'evidence is the host\'s job, not an extra tool on the agent',
    );
    assert.ok(!mod.DISCOVERY_BROWSER_TOOLS.includes('browser_network_requests'));
  });

  it('never passes the filename argument that would write to the filesystem', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../scripts/lib/evidence.mjs', import.meta.url), 'utf8');
    const calls = source.match(/call\('browser_[a-z_]+',\s*\{[^}]*\}/g) ?? [];
    assert.ok(calls.length >= 3, 'the collector makes its browser calls through call()');
    for (const c of calls) {
      assert.doesNotMatch(c, /filename/, 'filename would turn a read into a filesystem write');
    }
  });

  it('calls only read-only browser tools', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../scripts/lib/evidence.mjs', import.meta.url), 'utf8');
    const named = [...source.matchAll(/call\('(browser_[a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(named)].sort(),
      ['browser_console_messages', 'browser_navigate', 'browser_network_requests'],
    );
  });
});
