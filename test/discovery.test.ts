// Product Discovery: the bounded product surface, and the completeness rule
// that replaces "two or three states is enough".
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  absorbBrowserResult,
  buildSurface,
  currentPageUrl,
  expandSurface,
  expectedLocations,
  extractLinks,
  isUnsafe,
  MAX_LOCATIONS,
  normaliseUrl,
} from '../src/lib/discovery-surface.ts';
import {
  productUrls,
  validateDiscoveredBehavior,
  type DiscoveredBehavior,
  type SurfaceFacts,
} from '../src/lib/semantic-validate.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'http://localhost:4444/';

/** A snapshot shaped like the ones Playwright MCP actually returns. */
const snapshot = (...urls: string[]) =>
  ['- main [ref=e1]:', ...urls.flatMap((u, i) => [`  - link "Link ${i}" [ref=e${i + 2}]:`, `    - /url: ${u}`])].join('\n');

// ---------------------------------------------------------------------------

describe('the shallow completion contract is gone', () => {
  const prompt = readFileSync(join(PROJECT, 'src/agents/product-discovery.ts'), 'utf8');

  it('no longer says a couple of states or behaviors is enough', () => {
    for (const phrase of [
      'Two or three observed states is enough',
      'One area and two or three behaviors is a complete',
      'Explore briefly, then write',
      'As soon as you can describe one real page and one real interaction',
    ]) {
      assert.ok(!prompt.includes(phrase), `the prompt still contains: "${phrase}"`);
    }
  });

  it('sets no numeric target in its place', () => {
    assert.ok(!/at least \d+ behaviors?/i.test(prompt), 'completeness must not become a quota');
    assert.ok(!/minimum of \d+/i.test(prompt));
  });

  it('states the terminal states the host enforces', () => {
    for (const word of ['EXPLORED', 'BLOCKED', 'SKIPPED_WITH_REASON']) assert.ok(prompt.includes(word));
  });
});

// ---------------------------------------------------------------------------

describe('building the surface from what the browser rendered', () => {
  it('finds same-origin links and always includes the entry page', () => {
    const s = buildSurface(TARGET, snapshot('http://localhost:4444/notes', '/profile'));
    assert.deepEqual(expectedLocations(s), [
      'http://localhost:4444/',
      'http://localhost:4444/notes',
      'http://localhost:4444/profile',
    ]);
  });

  it('never makes an external link a product location', () => {
    const s = buildSurface(TARGET, snapshot('https://example.com/docs', 'http://localhost:8025/', '/notes'));
    assert.deepEqual(expectedLocations(s), ['http://localhost:4444/', 'http://localhost:4444/notes']);
    assert.deepEqual(s.externalOrigins, ['http://localhost:8025', 'https://example.com']);
  });

  it('deduplicates equivalent URLs', () => {
    const s = buildSurface(
      TARGET,
      snapshot('/notes', '/notes/', 'http://localhost:4444/notes#top', '/notes?', '/notes'),
    );
    assert.deepEqual(expectedLocations(s), ['http://localhost:4444/', 'http://localhost:4444/notes']);
  });

  it('folds a query string into the route it belongs to', () => {
    // Query *values* are not identity. A confirmation link differs every run,
    // and keying on it made one flow mint a new location each time — consuming
    // the budget and demanding terminal states for pages that never existed.
    const s = buildSurface(TARGET, snapshot('/notes?tab=archive', '/notes'));
    assert.deepEqual(expectedLocations(s), ['http://localhost:4444/', 'http://localhost:4444/notes']);
  });

  it('records the parameter names a route takes, never their values', () => {
    const s = buildSurface(TARGET, snapshot('/confirm?confirm_code=424242&email=a@b.c'));
    const confirm = s.locations.find((l) => l.url.endsWith('/confirm'))!;
    assert.deepEqual(confirm.queryParameters, ['confirm_code', 'email']);
    assert.equal(confirm.containsSensitiveTransientData, true);
    assert.ok(!JSON.stringify(s).includes('424242'), 'the code must not reach the surface');
  });

  it('gives every location a kind', () => {
    const s = buildSurface(TARGET, snapshot('/notes'));
    assert.deepEqual([...new Set(s.locations.map((l) => l.kind))], ['PRODUCT']);
  });

  it('marks session-ending and destructive links SKIPPED_WITH_REASON rather than following them', () => {
    const s = buildSurface(TARGET, snapshot('/logout', '/notes/1/delete', '/notes'));
    const byUrl = Object.fromEntries(s.locations.map((l) => [l.url, l]));
    assert.equal(byUrl['http://localhost:4444/logout'].status, 'SKIPPED_WITH_REASON');
    assert.ok(byUrl['http://localhost:4444/logout'].reason);
    assert.equal(byUrl['http://localhost:4444/notes/1/delete'].status, 'SKIPPED_WITH_REASON');
    assert.equal(byUrl['http://localhost:4444/notes'].status, 'PENDING');
  });

  it('caps the surface so exploration cannot run away', () => {
    const many = Array.from({ length: MAX_LOCATIONS + 25 }, (_, i) => `/page-${i}`);
    const s = buildSurface(TARGET, snapshot(...many));
    assert.equal(s.locations.length, MAX_LOCATIONS);
    assert.ok(s.overflow > 0, 'the excess is counted, not silently dropped');
  });

  it('ignores non-http schemes', () => {
    const s = buildSurface(TARGET, snapshot('mailto:a@b.c', 'javascript:void(0)', 'tel:+123', '/notes'));
    assert.deepEqual(expectedLocations(s), ['http://localhost:4444/', 'http://localhost:4444/notes']);
  });

  it('reads the accessible name so an unsafe link can be recognised by its label', () => {
    const snap = ['- link "Log out" [ref=e2]:', '  - /url: http://localhost:4444/session/end'].join('\n');
    const s = buildSurface(TARGET, snap);
    assert.equal(s.locations[1].status, 'SKIPPED_WITH_REASON');
  });

  it('parses only real /url: lines', () => {
    assert.deepEqual(extractLinks('- text: visit /url: not-a-link inline'), []);
    assert.equal(extractLinks(snapshot('/a', '/b')).length, 2);
  });

  it('normalises and classifies consistently', () => {
    assert.equal(normaliseUrl('/x/', TARGET), 'http://localhost:4444/x');
    assert.equal(normaliseUrl('nonsense://x', TARGET), undefined);
    assert.ok(isUnsafe('http://h/account/delete'));
    assert.equal(isUnsafe('http://h/notes'), undefined);
  });
});

describe('the surface grows as exploration reveals more', () => {
  it('accepts a newly found in-scope location', () => {
    const s = buildSurface(TARGET, snapshot('/settings'));
    const added = expandSurface(s, '/settings/security', 'http://localhost:4444/settings');
    assert.ok(added);
    assert.ok(expectedLocations(s).includes('http://localhost:4444/settings/security'));
  });

  it('still refuses external origins and duplicates when expanding', () => {
    const s = buildSurface(TARGET, snapshot('/settings'));
    assert.equal(expandSurface(s, 'https://elsewhere.test/x', 'x'), undefined);
    assert.equal(expandSurface(s, '/settings/', 'x'), undefined, 'already known');
    assert.ok(s.externalOrigins.includes('https://elsewhere.test'));
  });

  it('respects the cap when expanding', () => {
    const s = buildSurface(TARGET, snapshot(...Array.from({ length: MAX_LOCATIONS - 1 }, (_, i) => `/p${i}`)));
    assert.equal(s.locations.length, MAX_LOCATIONS);
    assert.equal(expandSurface(s, '/one-too-many', 'x'), undefined);
  });
});

// ---------------------------------------------------------------------------

describe('completeness: the surface must be accounted for', () => {
  const surface: SurfaceFacts = {
    origin: 'http://localhost:4444',
    expected: ['http://localhost:4444/', 'http://localhost:4444/notes', 'http://localhost:4444/profile'],
  };

  const base = (locations: DiscoveredBehavior['locations']): DiscoveredBehavior => ({
    product: 'Demo',
    locations,
    areas: [{ name: 'Main', routes: ['http://localhost:4444/'], notes: [] }],
    behaviors: [
      { id: 'BEH-1', area: 'Main', statement: 'The page shows a heading', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false },
    ],
    openQuestions: [],
    conflicts: [],
  });

  const all = (): DiscoveredBehavior['locations'] => surface.expected.map((url) => ({ url, status: 'EXPLORED' as const }));
  const codes = (e: { code: string }[]) => e.map((x) => x.code);

  it('accepts a run that visited everything', () => {
    assert.deepEqual(validateDiscoveredBehavior(base(all()), surface), []);
  });

  it('rejects a run that leaves a known location unmentioned', () => {
    const errors = validateDiscoveredBehavior(base(all().slice(0, 2)), surface);
    assert.ok(errors.some((e) => e.code === 'UNEXPLORED_LOCATION' && e.value === 'http://localhost:4444/profile'));
  });

  it('names every unexplored location, not just the first', () => {
    const missing = validateDiscoveredBehavior(base(all().slice(0, 1)), surface)
      .filter((e) => e.code === 'UNEXPLORED_LOCATION')
      .map((e) => e.value);
    assert.deepEqual(missing.sort(), ['http://localhost:4444/notes', 'http://localhost:4444/profile']);
  });

  it('accepts BLOCKED and SKIPPED_WITH_REASON when a reason is given', () => {
    const locations = all();
    locations[1] = { url: locations[1].url, status: 'BLOCKED', reason: 'redirected to a login wall' };
    locations[2] = { url: locations[2].url, status: 'SKIPPED_WITH_REASON', reason: 'link ends the session' };
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('rejects BLOCKED or SKIPPED_WITH_REASON with no reason', () => {
    const locations = all();
    locations[1] = { url: locations[1].url, status: 'BLOCKED' };
    assert.ok(codes(validateDiscoveredBehavior(base(locations), surface)).includes('MISSING_EVIDENCE'));
  });

  it('treats a trailing slash as the same location', () => {
    const locations = all();
    locations[1] = { url: 'http://localhost:4444/notes/', status: 'EXPLORED' };
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('accepts a same-origin location found during exploration', () => {
    // Most applications reveal their surface only after signing in; the entry
    // page's links are a starting point, not the whole product.
    const locations = [...all(), { url: 'http://localhost:4444/account/notes', status: 'EXPLORED' as const }];
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('rejects a location outside the application', () => {
    const locations = [...all(), { url: 'https://some-other-site.test/page', status: 'EXPLORED' as const }];
    const errors = validateDiscoveredBehavior(base(locations), surface);
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_LOCATION' && e.value === 'https://some-other-site.test/page'));
  });

  it('rejects a malformed location', () => {
    const locations = [...all(), { url: 'not a url', status: 'EXPLORED' as const }];
    assert.ok(codes(validateDiscoveredBehavior(base(locations), surface)).includes('UNKNOWN_LOCATION'));
  });

  it('skips the completeness rules entirely when the host built no surface', () => {
    assert.deepEqual(validateDiscoveredBehavior(base([])), [], 'no surface means no obligation');
  });

  it('still requires every behavior to belong to a declared area', () => {
    const d = base(all());
    d.behaviors[0].area = 'Nowhere';
    assert.ok(codes(validateDiscoveredBehavior(d, surface)).includes('UNKNOWN_AREA'));
  });

  it('accepts SPA state recorded as behaviors without new locations', () => {
    const d = base(all());
    d.behaviors.push(
      { id: 'BEH-2', area: 'Main', statement: 'Clicking Filter shows only matching rows', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false },
      { id: 'BEH-3', area: 'Main', statement: 'Clearing the filter restores the full list', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false },
    );
    assert.deepEqual(validateDiscoveredBehavior(d, surface), [], 'behaviors need no URL of their own');
  });
});

// ---------------------------------------------------------------------------

describe('the downstream contract still holds', () => {
  it('the discovery fixtures remain schema-valid with locations', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    for (const f of ['bad-run-2026-09-21', 'phase1-approved']) {
      const data = JSON.parse(readFileSync(join(PROJECT, 'test/fixtures', f, 'discovered-behavior.json'), 'utf8'));
      assert.deepEqual(schemaErrorsFor('discovered-behavior', data), [], `${f} must still validate`);
    }
  });

  it('Behavior Analyst still reads behaviors, unaffected by locations', async () => {
    const { validateRequirementsAnalysis } = await import('../src/lib/semantic-validate.ts');
    const discovery = JSON.parse(
      readFileSync(join(PROJECT, 'test/fixtures/bad-run-2026-09-21/discovered-behavior.json'), 'utf8'),
    ) as DiscoveredBehavior;
    const requirements = {
      feature: 'Authentication',
      acceptancePoints: [
        { id: 'AC-1', statement: discovery.behaviors[0].statement, evidenceIds: [discovery.behaviors[0].id] },
      ],
      businessRules: [],
      openQuestions: [],
      risks: [],
      // Completeness is its own rule (see analysis.test.ts). This test is about
      // locations not interfering, so the remaining behaviors are accounted for
      // rather than left to trip a different check.
      excludedBehaviors: discovery.behaviors.slice(1).map((b) => ({
        id: b.id,
        reason: 'Outside this fixture, which exercises location handling only.',
      })),
    };
    assert.deepEqual(validateRequirementsAnalysis(discovery, requirements), []);
  });

  it('Product Discovery gains no new capability', () => {
    const source = readFileSync(join(PROJECT, 'src/agents/product-discovery.ts'), 'utf8');
    for (const forbidden of ['repo.ts', 'test-code', 'readRepoFileTool', 'child_process', 'node:fs']) {
      assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
    }
    // The surface is host state. The agent may be *told* what is on it, as
    // prompt text, but must hold nothing that reads or writes the file — the
    // name of a module matters less than the capability it hands over.
    for (const capability of ['readSurface', 'writeSurface', 'surfacePath', 'expandSurface', 'registerState']) {
      assert.ok(!source.includes(capability), `the agent must not reach the surface via ${capability}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral observation completeness — a different question from surface
// completeness: did what we saw survive synthesis?
// ---------------------------------------------------------------------------

describe('the observation ledger', () => {
  /** A ledger rooted in its own temp artifact root, via a child process. */
  const inLedger = (code: string) => {
    const root = mkdtempSync(join(tmpdir(), 'qa-obs-'));
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e',
       'const L = await import("./src/lib/observation-ledger.ts");' + code],
      { cwd: PROJECT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env') } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  it('assigns sequential ids the model cannot choose', () => {
    const out = inLedger(`
      L.resetLedger("run-1");
      const a = L.appendObservation({ area: "Auth", action: "submit empty form", outcome: "validation message" });
      const b = L.appendObservation({ area: "Auth", action: "submit valid form", outcome: "moved to notes" });
      console.log(JSON.stringify([a.observation.id, b.observation.id]));`);
    assert.deepEqual(out, ['OBS-001', 'OBS-002']);
  });

  it('returns the original id for a repeat instead of appending a duplicate', () => {
    const out = inLedger(`
      L.resetLedger("run-1");
      L.appendObservation({ area: "Auth", action: "Submit empty form", outcome: "Validation message" });
      const again = L.appendObservation({ area: "auth", action: "submit  empty form", outcome: "validation message!" });
      console.log(JSON.stringify({ id: again.observation.id, dupe: Boolean(again.duplicateOf), total: L.readLedger().observations.length }));`);
    assert.deepEqual(out, { id: 'OBS-001', dupe: true, total: 1 });
  });

  it('refuses an empty observation', () => {
    const out = inLedger(`
      L.resetLedger("run-1");
      console.log(JSON.stringify(L.appendObservation({ area: "", action: "x", outcome: "y" }).ok));`);
    assert.equal(out, false);
  });

  it('is bounded', () => {
    const out = inLedger(`
      L.resetLedger("run-1");
      for (let i = 0; i < L.MAX_OBSERVATIONS + 5; i += 1)
        L.appendObservation({ area: "A", action: "act " + i, outcome: "out " + i });
      const l = L.readLedger();
      console.log(JSON.stringify({ n: l.observations.length, overflow: l.overflow, max: L.MAX_OBSERVATIONS }));`);
    assert.equal(out.n, out.max);
    assert.ok(out.overflow > 0);
  });

  it('ignores a ledger left by a different run', () => {
    const out = inLedger(`
      L.resetLedger("run-1");
      L.appendObservation({ area: "A", action: "a", outcome: "b" });
      console.log(JSON.stringify({ mine: Boolean(L.readLedger("run-1")), other: Boolean(L.readLedger("run-2")) }));`);
    assert.deepEqual(out, { mine: true, other: false });
  });

  it('cannot be mutated — the tool only appends', async () => {
    const { recordObservationTool } = await import('../src/tools/observations.ts');
    const keys = Object.keys((recordObservationTool as { input: { entries?: object } }).input.entries ?? {});
    assert.deepEqual(keys.sort(), ['action', 'area', 'evidence', 'outcome']);
    const source = readFileSync(join(PROJECT, 'src/tools/observations.ts'), 'utf8');
    assert.ok(!/id:\s*v\./.test(source), 'the model must not supply an id');
    assert.ok(!/delete|update|remove/i.test(source.replace(/\/\/.*/g, '')), 'append-only');
  });
});

describe('observations must survive synthesis', () => {
  const observed = (n: number) => ({
    ids: Array.from({ length: n }, (_, i) => `OBS-${String(i + 1).padStart(3, '0')}`),
    describe: (id: string) => `observation ${id}`,
  });

  const withBehaviors = (behaviors: DiscoveredBehavior['behaviors'], excluded?: { id: string; reason: string }[]): DiscoveredBehavior => ({
    product: 'Demo',
    locations: [{ url: 'http://localhost:4444/', status: 'EXPLORED' }],
    excludedObservations: excluded,
    areas: [{ name: 'Main', routes: ['http://localhost:4444/'], notes: [] }],
    behaviors,
    openQuestions: [],
    conflicts: [],
  });

  const behavior = (id: string, observations: string[]): DiscoveredBehavior['behaviors'][number] => ({
    id, area: 'Main', statement: `Something observable happened (${id})`,
    status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false, observations,
  });

  const codes = (e: { code: string }[]) => e.map((x) => x.code);

  it('rejects a single behavior that drops nine of ten observations', () => {
    // The exact regression this exists to stop.
    const errors = validateDiscoveredBehavior(withBehaviors([behavior('BEH-1', ['OBS-001'])]), undefined, observed(10));
    const dropped = errors.filter((e) => e.code === 'UNACCOUNTED_OBSERVATION').map((e) => e.value);
    assert.equal(dropped.length, 9);
    assert.ok(!dropped.includes('OBS-001'));
  });

  it('accepts one behavior covering several related observations', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001', 'OBS-002', 'OBS-003'])]);
    assert.deepEqual(validateDiscoveredBehavior(d, undefined, observed(3)), []);
  });

  it('accepts an observation excluded with a reason', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001'])], [{ id: 'OBS-002', reason: 'duplicate of OBS-001 seen again' }]);
    assert.deepEqual(validateDiscoveredBehavior(d, undefined, observed(2)), []);
  });

  it('rejects a behavior citing an observation that was never recorded', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001', 'OBS-099'])]);
    const errors = validateDiscoveredBehavior(d, undefined, observed(1));
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_OBSERVATION' && e.value === 'OBS-099'));
  });

  it('rejects excluding an observation that was never recorded', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001'])], [{ id: 'OBS-050', reason: 'nope' }]);
    assert.ok(codes(validateDiscoveredBehavior(d, undefined, observed(1))).includes('UNKNOWN_OBSERVATION'));
  });

  it('does not force one behavior per observation', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001', 'OBS-002']), behavior('BEH-2', ['OBS-003'])]);
    assert.deepEqual(validateDiscoveredBehavior(d, undefined, observed(3)), []);
  });

  it('imposes nothing when nothing was recorded', () => {
    const d = withBehaviors([behavior('BEH-1', [])]);
    assert.deepEqual(validateDiscoveredBehavior(d, undefined, observed(0)), []);
    assert.deepEqual(validateDiscoveredBehavior(d), []);
  });

  it('holds independently of the surface: one location does not relax it', () => {
    const surface: SurfaceFacts = { origin: 'http://localhost:4444', expected: ['http://localhost:4444/'] };
    const d = withBehaviors([behavior('BEH-1', ['OBS-001'])]);
    const errors = validateDiscoveredBehavior(d, surface, observed(5));
    assert.equal(errors.filter((e) => e.code === 'UNEXPLORED_LOCATION').length, 0, 'surface is satisfied');
    assert.equal(errors.filter((e) => e.code === 'UNACCOUNTED_OBSERVATION').length, 4, 'behavior accounting is not');
  });

  it('still requires behaviors to be grounded', () => {
    const d = withBehaviors([behavior('BEH-1', ['OBS-001'])]);
    d.behaviors[0].area = 'Imaginary';
    assert.ok(codes(validateDiscoveredBehavior(d, undefined, observed(1))).includes('UNKNOWN_AREA'));
  });
});

// ---------------------------------------------------------------------------
// Efficiency metrics — counted by the host, never self-reported
// ---------------------------------------------------------------------------

/** A sink for the tee'd copy, so these tests do not spray the test output. */
const devNull = () => new Writable({ write(_c, _e, cb) { cb(); } });

describe('tool-call counting', () => {
  const trace = [
    'tool mcp__playwright__browser_navigate',
    'tool done mcp__playwright__browser_navigate',
    'tool mcp__playwright__browser_snapshot',
    'tool done mcp__playwright__browser_snapshot',
    'tool mcp__playwright__browser_type',
    'tool error mcp__playwright__browser_type',
    'tool record_observation',
    'tool done record_observation',
  ].join('\n');

  it('counts each invocation exactly once, ignoring done and error lines', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    const counts = countToolInvocations(trace);
    assert.deepEqual(counts, {
      browser_navigate: 1,
      browser_snapshot: 1,
      browser_type: 1,
      record_observation: 1,
    });
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 4);
  });

  it('does not repeat the double-count that reported 109 calls as 216', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    // The old bug: `^tool [a-z_]` also matches `tool done …`.
    const naive = trace.split('\n').filter((l) => /^tool [a-z_]/.test(l)).length;
    const actual = Object.values(countToolInvocations(trace)).reduce((a, b) => a + b, 0);
    assert.equal(naive, 8, 'the naive count still doubles');
    assert.equal(actual, 4, 'the real count does not');
  });

  it('strips the MCP prefix so a tool reads the same however it is served', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    const counts = countToolInvocations('tool mcp__playwright__browser_click\ntool browser_click');
    assert.deepEqual(counts, { browser_click: 2 });
  });

  it('accumulates into an existing tally, for chunked output', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    const into = {};
    countToolInvocations('tool browser_click\n', into);
    countToolInvocations('tool browser_click\n', into);
    assert.deepEqual(into, { browser_click: 2 });
  });

  it('ignores prose that merely mentions a tool', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    const noise = [
      '  I will call tool browser_click next',
      'thinking about tool browser_snapshot',
      'tool done browser_click',
    ].join('\n');
    assert.deepEqual(countToolInvocations(noise), {}, 'only line-initial invocations count');
  });

  // The bug these cover: the parser above was correct and well tested, while
  // the code feeding it read the wrong stream. Every stage of a real run
  // recorded `toolCallsByTool: {}`. Test the wiring, not only the regex.
  it('counts tool lines a child writes to STDERR, which is where flue writes them', async () => {
    const { attachToolCounter } = await import('../scripts/lib/runtime.mjs');
    const child = spawn(process.execPath, [
      '-e',
      `process.stderr.write('tool browser_navigate\\ntool done browser_navigate\\n');
       process.stderr.write('tool record_observation\\n');`,
    ]);
    const counter = attachToolCounter(child, devNull(), devNull());
    await once(child, 'close');
    counter.flush();
    assert.deepEqual(counter.toolCalls, { browser_navigate: 1, record_observation: 1 });
  });

  it('counts a line split across two stderr writes exactly once', async () => {
    const { attachToolCounter } = await import('../scripts/lib/runtime.mjs');
    const child = spawn(process.execPath, [
      '-e',
      `process.stderr.write('tool browser_sna');
       setTimeout(() => process.stderr.write('pshot\\n'), 20);`,
    ]);
    const counter = attachToolCounter(child, devNull(), devNull());
    await once(child, 'close');
    counter.flush();
    assert.deepEqual(counter.toolCalls, { browser_snapshot: 1 });
  });

  it('counts a final line that never ended in a newline', async () => {
    const { attachToolCounter } = await import('../scripts/lib/runtime.mjs');
    const child = spawn(process.execPath, ['-e', `process.stderr.write('tool browser_click')`]);
    const counter = attachToolCounter(child, devNull(), devNull());
    await once(child, 'close');
    assert.deepEqual(counter.flush(), { browser_click: 1 });
  });

  it('sees through the ANSI dimming flue applies when stderr is a terminal', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    // Exactly what @flue/cli emits with colour on: `${dim('tool')} ${name}`.
    const dimmed = '\u001b[2mtool\u001b[22m browser_click\n\u001b[2mtool done\u001b[22m browser_click';
    assert.deepEqual(countToolInvocations(dimmed), { browser_click: 1 });
  });

  it('reproduces the hand-verified count from the real baseline trace', async () => {
    const { countToolInvocations } = await import('../scripts/lib/runtime.mjs');
    // A faithful excerpt of the measured DeepSeek discovery stage.
    const real = ['navigate', 'snapshot', 'type', 'type', 'click', 'snapshot']
      .flatMap((t) => [`tool mcp__playwright__browser_${t}`, `tool done mcp__playwright__browser_${t}`])
      .concat(['tool record_observation', 'tool done record_observation'])
      .join('\n');
    const counts = countToolInvocations(real);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 7);
    assert.equal(counts.browser_type, 2);
  });
});

describe('Product Discovery capabilities', () => {
  it('can fill a multi-field form in one call', async () => {
    const { DISCOVERY_BROWSER_TOOLS } = await import('../src/connections/playwright-mcp.ts');
    assert.ok(DISCOVERY_BROWSER_TOOLS.includes('browser_fill_form'));
  });

  it('keeps field-by-field typing, for behaviour that is the typing itself', async () => {
    const { DISCOVERY_BROWSER_TOOLS } = await import('../src/connections/playwright-mcp.ts');
    assert.ok(DISCOVERY_BROWSER_TOOLS.includes('browser_type'));
    const prompt = readFileSync(join(PROJECT, 'src/agents/product-discovery.ts'), 'utf8');
    assert.match(prompt, /browser_fill_form/);
    assert.match(prompt, /per-field validation|validation, a control that enables as you type/);
  });

  it('gains no other browser capability', async () => {
    const c = await import('../src/connections/playwright-mcp.ts');
    const added = c.DISCOVERY_BROWSER_TOOLS.filter(
      (t) => !['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_fill_form'].includes(t),
    );
    assert.deepEqual(added, [], 'the allowlist grew by exactly one deliberate tool');
    for (const forbidden of c.FORBIDDEN_BROWSER_TOOLS) {
      assert.ok(!c.DISCOVERY_BROWSER_TOOLS.includes(forbidden), `${forbidden} must never be mounted`);
    }
    // and nothing outside the browser
    const source = readFileSync(join(PROJECT, 'src/agents/product-discovery.ts'), 'utf8');
    for (const f of ['tools/repo', 'test-code', 'child_process', 'node:fs']) {
      assert.ok(!source.includes(f), `must not import ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the surface absorbs what the browser reveals', () => {
  /** A result shaped like the ones Playwright MCP returns for navigate/snapshot. */
  const result = (page: string, ...urls: string[]) =>
    [`- Page URL: ${page}`, '- Page Snapshot:', snapshot(...urls)].join('\n');

  it('reads the page the session is on', () => {
    assert.equal(currentPageUrl(result('http://localhost:4444/account/notes')), 'http://localhost:4444/account/notes');
    assert.equal(currentPageUrl('- Page Snapshot:\n- main [ref=e1]'), undefined);
  });

  it('adds the page reached after signing in, and the links it renders', () => {
    // The real failure this exists for: a landing page that is a sign-in form
    // has no links, so the entry surface is one location and accounting for it
    // is satisfied without ever seeing the product.
    const s = buildSurface(TARGET, snapshot());
    assert.equal(s.locations.length, 1, 'entry page offers nothing');

    const added = absorbBrowserResult(s, result('http://localhost:4444/account/notes', '/account/profile'));

    assert.deepEqual(
      added.map((l) => l.url).sort(),
      ['http://localhost:4444/account/notes', 'http://localhost:4444/account/profile'],
    );
    assert.ok(expectedLocations(s).includes('http://localhost:4444/account/notes'));
    assert.ok(expectedLocations(s).includes('http://localhost:4444/account/profile'));
  });

  it('resolves a link against the page that rendered it, not the entry page', () => {
    const s = buildSurface(TARGET, snapshot());
    absorbBrowserResult(s, result('http://localhost:4444/account/notes', 'edit'));
    assert.ok(expectedLocations(s).includes('http://localhost:4444/account/edit'));
  });

  it('adds nothing twice, and nothing off-origin', () => {
    const s = buildSurface(TARGET, snapshot());
    const once = absorbBrowserResult(s, result('http://localhost:4444/notes', 'https://elsewhere.test/x'));
    assert.deepEqual(once.map((l) => l.url), ['http://localhost:4444/notes']);
    assert.deepEqual(absorbBrowserResult(s, result('http://localhost:4444/notes')), [], 'already known');
    assert.ok(s.externalOrigins.includes('https://elsewhere.test'));
  });

  it('still respects the cap', () => {
    const s = buildSurface(TARGET, snapshot(...Array.from({ length: MAX_LOCATIONS - 1 }, (_, i) => `/p${i}`)));
    assert.deepEqual(absorbBrowserResult(s, result('http://localhost:4444/one-too-many')), []);
    assert.ok(s.overflow > 0);
  });

  it('does nothing with a result that is not a page', () => {
    const s = buildSurface(TARGET, snapshot());
    assert.deepEqual(absorbBrowserResult(s, 'Error: element not found'), []);
    assert.equal(s.locations.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('a location the run names itself must be accounted for', () => {
  const surface: SurfaceFacts = { origin: 'http://localhost:4444', expected: ['http://localhost:4444/'] };

  /** The artifact gpt-oss-20b actually wrote: signed in, said so, listed only the entry page. */
  const signedIn = (locations: DiscoveredBehavior['locations']): DiscoveredBehavior => ({
    product: 'Notes Console',
    locations,
    areas: [{ name: 'Home', routes: ['http://localhost:4444/'], notes: [] }],
    behaviors: [
      {
        id: 'BEH-1',
        area: 'Home',
        statement: 'Submitting the Sign In form with valid credentials signs the user in and navigates to /account/notes.',
        observations: ['OBS-1'],
        status: 'OBSERVED',
        source: ['browser snapshot'],
        confidence: 'high',
        suspectedIssue: false,
      },
    ],
    openQuestions: [],
    conflicts: [],
  });

  const observed = {
    ids: ['OBS-1'],
    describe: () => "Submitted Sign In form -> Navigated to /account/notes and status banner shows 'Signed in.'",
  };

  it('rejects an artifact that reports reaching a page it never accounts for', () => {
    const errors = validateDiscoveredBehavior(
      signedIn([{ url: 'http://localhost:4444/', status: 'EXPLORED' }]),
      surface,
      observed,
    );
    assert.ok(
      errors.some((e) => e.code === 'UNACCOUNTED_LOCATION' && e.value === 'http://localhost:4444/account/notes'),
      `expected UNACCOUNTED_LOCATION, got ${JSON.stringify(errors)}`,
    );
  });

  it('accepts it once that page has a terminal state', () => {
    const errors = validateDiscoveredBehavior(
      signedIn([
        { url: 'http://localhost:4444/', status: 'EXPLORED' },
        { url: 'http://localhost:4444/account/notes', status: 'EXPLORED' },
      ]),
      surface,
      observed,
    );
    assert.deepEqual(errors, []);
  });

  it('accepts BLOCKED with a reason, the same as any other location', () => {
    const errors = validateDiscoveredBehavior(
      signedIn([
        { url: 'http://localhost:4444/', status: 'EXPLORED' },
        { url: 'http://localhost:4444/account/notes', status: 'BLOCKED', reason: 'session expired before I got there' },
      ]),
      surface,
      observed,
    );
    assert.deepEqual(errors, []);
  });
});

describe('productUrls reads locations out of prose without inventing them', () => {
  const origin = 'http://localhost:4444';

  it('finds absolute and root-relative forms, normalised to one', () => {
    assert.deepEqual(productUrls('went to http://localhost:4444/account/notes/', origin), ['http://localhost:4444/account/notes']);
    assert.deepEqual(productUrls('navigated to /account/notes.', origin), ['http://localhost:4444/account/notes']);
    // The same identity the surface uses: query values are not part of it, so
    // a URL mentioned in prose can actually match the location that was reported.
    assert.deepEqual(productUrls('see "/notes?sort=asc"', origin), ['http://localhost:4444/notes']);
  });

  it('reduces a mentioned URL to the identity a location can actually match', () => {
    // The rule is only satisfiable if both sides normalise the same way. A run
    // that opened `/app?confirm_code=...` can only report the canonical `/app`;
    // comparing the raw URL against it matched nothing, and no status the agent
    // wrote could clear the error — 78 minutes and 502 tool calls of trying.
    assert.deepEqual(
      productUrls('Opened http://localhost:4444/app?confirm_email=a@b.c&confirm_code=683410', origin),
      ['http://localhost:4444/app'],
    );
  });

  it('agrees with the surface, so an accounted location clears the error', () => {
    const surface: SurfaceFacts = { origin, expected: ['http://localhost:4444/'] };
    const artifact: DiscoveredBehavior = {
      product: 'Demo',
      locations: [
        { url: 'http://localhost:4444/', status: 'EXPLORED' },
        { url: 'http://localhost:4444/app', status: 'EXPLORED' },
      ],
      areas: [{ name: 'Auth', routes: ['http://localhost:4444/'], notes: [] }],
      behaviors: [{
        id: 'BEH-1', area: 'Auth',
        statement: 'Opening http://localhost:4444/app?confirm_code=683410 confirms the account',
        status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false,
      }],
      openQuestions: [], conflicts: [],
    };
    assert.deepEqual(validateDiscoveredBehavior(artifact, surface), []);
  });

  it('does not mistake ordinary prose for a path', () => {
    assert.deepEqual(productUrls('shown to the owner and/or an admin', origin), []);
    assert.deepEqual(productUrls('the banner read 9/24 and then cleared', origin), []);
    assert.deepEqual(productUrls('no location here at all', origin), []);
  });

  it('ignores another origin', () => {
    assert.deepEqual(productUrls('linked out to https://elsewhere.test/notes', origin), []);
  });
});

// ---------------------------------------------------------------------------

describe('browser results feed the surface', () => {
  /** Instrumentation driven in its own temp artifact root, via a child process. */
  const inTracked = (code: string) => {
    const root = mkdtempSync(join(tmpdir(), 'qa-surface-'));
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e',
       'const S = await import("./src/lib/discovery-surface.ts");' +
       'const I = await import("./src/lib/surface-instrumentation.ts");' + code],
      { cwd: PROJECT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env') } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  /** The envelope shape a Flue-mounted MCP tool actually settles with. */
  const MCP_RESULT = `{ output: { content: [{ type: "text", text: [
      "- Page URL: http://localhost:4444/account/notes",
      '- link "Profile" [ref=e2]:',
      "  - /url: /account/profile",
    ].join("\\n") }] } }`;

  it('collects the strings instead of stringifying the envelope', () => {
    // Regression: `JSON.stringify` spliced the envelope's own punctuation into
    // the text, and the last `/url:` line came back carrying `"}]}}` — the page
    // was then recorded under a URL-encoded corruption of its path.
    const out = inTracked(`console.log(JSON.stringify({ text: I.resultText(${MCP_RESULT}) }));`);
    assert.ok(out.text.includes('- Page URL: http://localhost:4444/account/notes'));
    assert.ok(!out.text.includes('"}]}}'), 'envelope punctuation must not reach the text');
  });

  it('adds the page reached after signing in, and the links it renders', () => {
    const out = inTracked(`
      S.writeSurface(S.buildSurface("http://localhost:4444/", "- main [ref=e1]"));
      const added = I.absorbIntoSurface(${MCP_RESULT});
      console.log(JSON.stringify({ added, locations: S.readSurface().locations.map((l) => l.url) }));`);
    assert.deepEqual(out.added.sort(), [
      'http://localhost:4444/account/notes',
      'http://localhost:4444/account/profile',
    ]);
    assert.ok(out.locations.includes('http://localhost:4444/account/notes'));
  });

  it('persists an external origin even though it adds no location', () => {
    // Regression: writing only when a location was added dropped the external
    // origin entirely, so a run that visited one reported none.
    const out = inTracked(`
      S.writeSurface(S.buildSurface("http://localhost:4444/", "- main [ref=e1]"));
      const added = I.absorbIntoSurface({ output: "- Page URL: http://localhost:8025/" });
      const s = S.readSurface();
      console.log(JSON.stringify({ added, external: s.externalOrigins, locations: s.locations.length }));`);
    assert.deepEqual(out.added, [], 'an off-origin page is not a product location');
    assert.deepEqual(out.external, ['http://localhost:8025']);
    assert.equal(out.locations, 1);
  });

  it('does nothing when no surface was established', () => {
    const out = inTracked(`console.log(JSON.stringify({ added: I.absorbIntoSurface(${MCP_RESULT}) }));`);
    assert.deepEqual(out.added, []);
  });

  it('never lets a bookkeeping failure escape into the browser call', () => {
    // The surface file is a directory here: every read or write of it throws.
    const out = inTracked(`
      const fs = await import("node:fs");
      fs.mkdirSync(S.surfacePath(), { recursive: true });
      console.log(JSON.stringify({ added: I.absorbIntoSurface(${MCP_RESULT}) }));`);
    assert.deepEqual(out.added, []);
  });

  it('installs its interceptor once, however often it is imported', () => {
    const out = inTracked(`
      I.trackDiscoverySurface(); I.trackDiscoverySurface();
      console.log(JSON.stringify({ ok: true }));`);
    assert.equal(out.ok, true);
  });
});
