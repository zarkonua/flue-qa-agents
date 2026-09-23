// Product Discovery: the bounded product surface, and the completeness rule
// that replaces "two or three states is enough".
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSurface,
  expandSurface,
  expectedLocations,
  extractLinks,
  isUnsafe,
  MAX_LOCATIONS,
  normaliseUrl,
} from '../src/lib/discovery-surface.ts';
import { validateDiscoveredBehavior, type DiscoveredBehavior, type SurfaceFacts } from '../src/lib/semantic-validate.ts';

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
    for (const word of ['VISITED', 'UNREACHABLE', 'SKIPPED']) assert.ok(prompt.includes(word));
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

  it('keeps a query string, which usually selects a different view', () => {
    const s = buildSurface(TARGET, snapshot('/notes?tab=archive', '/notes'));
    assert.equal(expectedLocations(s).length, 3);
  });

  it('marks session-ending and destructive links SKIPPED rather than following them', () => {
    const s = buildSurface(TARGET, snapshot('/logout', '/notes/1/delete', '/notes'));
    const byUrl = Object.fromEntries(s.locations.map((l) => [l.url, l]));
    assert.equal(byUrl['http://localhost:4444/logout'].status, 'SKIPPED');
    assert.ok(byUrl['http://localhost:4444/logout'].reason);
    assert.equal(byUrl['http://localhost:4444/notes/1/delete'].status, 'SKIPPED');
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
    assert.equal(s.locations[1].status, 'SKIPPED');
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

  const all = (): DiscoveredBehavior['locations'] => surface.expected.map((url) => ({ url, status: 'VISITED' as const }));
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

  it('accepts UNREACHABLE and SKIPPED when a reason is given', () => {
    const locations = all();
    locations[1] = { url: locations[1].url, status: 'UNREACHABLE', reason: 'redirected to a login wall' };
    locations[2] = { url: locations[2].url, status: 'SKIPPED', reason: 'link ends the session' };
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('rejects UNREACHABLE or SKIPPED with no reason', () => {
    const locations = all();
    locations[1] = { url: locations[1].url, status: 'UNREACHABLE' };
    assert.ok(codes(validateDiscoveredBehavior(base(locations), surface)).includes('MISSING_EVIDENCE'));
  });

  it('treats a trailing slash as the same location', () => {
    const locations = all();
    locations[1] = { url: 'http://localhost:4444/notes/', status: 'VISITED' };
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('accepts a same-origin location found during exploration', () => {
    // Most applications reveal their surface only after signing in; the entry
    // page's links are a starting point, not the whole product.
    const locations = [...all(), { url: 'http://localhost:4444/account/notes', status: 'VISITED' as const }];
    assert.deepEqual(validateDiscoveredBehavior(base(locations), surface), []);
  });

  it('rejects a location outside the application', () => {
    const locations = [...all(), { url: 'https://some-other-site.test/page', status: 'VISITED' as const }];
    const errors = validateDiscoveredBehavior(base(locations), surface);
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_LOCATION' && e.value === 'https://some-other-site.test/page'));
  });

  it('rejects a malformed location', () => {
    const locations = [...all(), { url: 'not a url', status: 'VISITED' as const }];
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
    };
    assert.deepEqual(validateRequirementsAnalysis(discovery, requirements), []);
  });

  it('Product Discovery gains no new capability', () => {
    const source = readFileSync(join(PROJECT, 'src/agents/product-discovery.ts'), 'utf8');
    for (const forbidden of ['repo.ts', 'test-code', 'readRepoFileTool', 'child_process', 'node:fs']) {
      assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
    }
    // The surface is host state; the agent reads it only as prompt text.
    assert.ok(!source.includes('discovery-surface'), 'the agent must not read the surface file itself');
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
    locations: [{ url: 'http://localhost:4444/', status: 'VISITED' }],
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
