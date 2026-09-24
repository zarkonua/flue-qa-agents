// Discovery states: the same route can show two different products.
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_STATES,
  MAX_STATES_PER_LOCATION,
  interactiveControls,
  normaliseControlName,
  stateSignature,
} from '../src/lib/discovery-state.ts';
import { auxiliaryOrigins, auxiliaryOriginsNote } from '../src/config/auxiliary-origins.ts';
import { buildSurface, classifyOrigin, registerState } from '../src/lib/discovery-surface.ts';
import { validateDiscoveredBehavior } from '../src/lib/semantic-validate.ts';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOME = 'http://localhost:4444/';
const NOTES = 'http://localhost:4444/account/notes';

const page = (...lines: string[]) => ['- main [ref=e1]:', ...lines.map((l) => `  ${l}`)].join('\n');
const LOGIN = page('- textbox "Email"', '- textbox "Password"', '- button "Sign in"');
const AUTHED = page('- button "Logout"', '- button "Create note"', '- textbox "Note title"');
const WORDS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota'];
const noteList = (n: number) => page('- button "Create note"', ...WORDS.slice(0, n).map((w) => `- link "${w}"`));

describe('state signatures separate products, not page contents', () => {
  it('sees the authenticated shell as a different state at the same route', () => {
    // The transition the URL cannot show, and the reason discovery used to
    // finish at the login screen having seen nothing.
    assert.notEqual(stateSignature(HOME, LOGIN).id, stateSignature(HOME, AUTHED).id);
  });

  it('describes a state by its affordances', () => {
    assert.deepEqual(stateSignature(HOME, LOGIN).controls, [
      'button:sign in', 'textbox:email', 'textbox:password',
    ]);
  });

  it('does not mint a state because a list gained a row', () => {
    const three = stateSignature(NOTES, noteList(3)).id;
    for (const n of [4, 5, 9]) assert.equal(stateSignature(NOTES, noteList(n)).id, three, `${n} rows`);
  });

  it('does not mint a state because identical controls repeated', () => {
    const del = (n: number) => page(...Array.from({ length: n }, () => '- button "Delete"'));
    assert.equal(stateSignature(NOTES, del(2)).id, stateSignature(NOTES, del(7)).id);
  });

  it('still separates an empty collection from a populated one', () => {
    assert.notEqual(stateSignature(NOTES, noteList(0)).id, stateSignature(NOTES, noteList(3)).id);
  });

  it('is stable across runs and machines', () => {
    assert.equal(stateSignature(HOME, LOGIN).id, stateSignature(HOME, LOGIN).id);
    assert.match(stateSignature(HOME, LOGIN).id, /^[0-9a-f]{12}$/);
  });

  it('ignores content roles, timestamps, counters and generated ids', () => {
    const noisy = page(
      '- button "Sign in"',
      '- paragraph "Updated 2026-09-24 at 17:58"',
      '- text "3 notes"',
      '- heading "Welcome back, agent.discovery@example.com"',
    );
    const quiet = page('- button "Sign in"', '- paragraph "Updated 2025-01-01 at 00:00"', '- text "91 notes"');
    assert.equal(stateSignature(HOME, noisy).id, stateSignature(HOME, quiet).id);
  });

  it('strips content out of a control name', () => {
    assert.equal(normaliseControlName('Delete note "Gamma"'), 'delete note');
    assert.equal(normaliseControlName('Page 2 of 7'), 'page # of #');
  });

  it('reads no controls from a page that offers none', () => {
    assert.deepEqual(interactiveControls('- main:\n  - paragraph "nothing to do here"'), []);
  });
});

describe('the state ledger stays finite', () => {
  const surface = () => buildSurface(HOME, '- main [ref=e1]');

  it('registers a new state once', () => {
    const s = surface();
    assert.ok(registerState(s, HOME, LOGIN));
    assert.equal(registerState(s, HOME, LOGIN), undefined, 'already known');
    assert.equal(s.states!.length, 1);
    assert.equal(s.states![0].status, 'PENDING');
  });

  it('ignores a page with nothing to interact with', () => {
    const s = surface();
    assert.equal(registerState(s, HOME, '- main:\n  - paragraph "empty"'), undefined);
    assert.deepEqual(s.states, []);
  });

  it('caps states per location and reports the overflow', () => {
    const s = surface();
    for (let i = 0; i < MAX_STATES_PER_LOCATION + 3; i += 1) {
      registerState(s, HOME, page(`- button "Action ${WORDS[i]}"`));
    }
    assert.equal(s.states!.length, MAX_STATES_PER_LOCATION);
    assert.ok(s.stateOverflow! > 0, 'skipped work must be reported, not silent');
  });

  it('caps states overall', () => {
    const s = surface();
    for (let i = 0; i < MAX_STATES + 5; i += 1) {
      registerState(s, `http://localhost:4444/p${i}`, page(`- button "Do ${i === 0 ? 'x' : WORDS[i % WORDS.length] + i}"`));
    }
    assert.ok(s.states!.length <= MAX_STATES);
  });
});

describe('auxiliary origins come only from host configuration', () => {
  it('classifies the product, a configured mailbox, and everything else', () => {
    const aux = ['http://localhost:8025'];
    assert.equal(classifyOrigin('http://localhost:4444', 'http://localhost:4444', aux), 'PRODUCT');
    assert.equal(classifyOrigin('http://localhost:8025', 'http://localhost:4444', aux), 'AUXILIARY');
    assert.equal(classifyOrigin('https://github.com', 'http://localhost:4444', aux), undefined);
  });

  it('blocks a mailbox that was not configured', () => {
    assert.equal(classifyOrigin('http://localhost:8025', 'http://localhost:4444', []), undefined);
  });

  it('reads one or more origins, and refuses a value that is not a URL', () => {
    const run = (value: string | undefined) => {
      const before = process.env.QA_DISCOVERY_AUX_ORIGINS;
      if (value === undefined) delete process.env.QA_DISCOVERY_AUX_ORIGINS;
      else process.env.QA_DISCOVERY_AUX_ORIGINS = value;
      try { return auxiliaryOrigins(); } finally {
        if (before === undefined) delete process.env.QA_DISCOVERY_AUX_ORIGINS;
        else process.env.QA_DISCOVERY_AUX_ORIGINS = before;
      }
    };
    assert.deepEqual(run(undefined), []);
    assert.deepEqual(run('http://localhost:8025'), ['http://localhost:8025']);
    assert.deepEqual(run('http://localhost:8025, http://localhost:1080/'), ['http://localhost:8025', 'http://localhost:1080']);
    assert.throws(() => run('not-a-url'), /not a URL/);
  });
});

describe('auxiliary infrastructure never becomes product functionality', () => {
  const surface = {
    origin: 'http://localhost:4444',
    expected: ['http://localhost:4444/'],
    auxiliaryOrigins: ['http://localhost:8025'],
  };

  const artifact = (over: Record<string, unknown>) => ({
    product: 'Notes Console',
    locations: [{ url: 'http://localhost:4444/', status: 'EXPLORED' as const, area: 'Auth' }],
    areas: [{ name: 'Auth', routes: ['http://localhost:4444/'], notes: [] }],
    behaviors: [{
      id: 'BEH-1', area: 'Auth', statement: 'Submitting the Sign Up form sends a confirmation mail',
      status: 'OBSERVED' as const, source: ['browser snapshot'], confidence: 'high' as const, suspectedIssue: false,
    }],
    openQuestions: [], conflicts: [],
    ...over,
  });

  it('accepts the mailbox as a location the run passed through', () => {
    const errors = validateDiscoveredBehavior(artifact({
      locations: [
        { url: 'http://localhost:4444/', status: 'EXPLORED', area: 'Auth' },
        { url: 'http://localhost:8025/', status: 'EXPLORED' },
      ],
    }) as never, surface);
    assert.deepEqual(errors, []);
  });

  it('rejects an area rooted in the mailbox', () => {
    const errors = validateDiscoveredBehavior(artifact({
      areas: [
        { name: 'Auth', routes: ['http://localhost:4444/'], notes: [] },
        { name: 'MailHog', routes: ['http://localhost:8025/'], notes: [] },
      ],
    }) as never, surface);
    assert.ok(errors.some((e) => e.code === 'AUXILIARY_AS_PRODUCT'), JSON.stringify(errors));
  });

  it('rejects giving the mailbox a product area', () => {
    const errors = validateDiscoveredBehavior(artifact({
      locations: [
        { url: 'http://localhost:4444/', status: 'EXPLORED', area: 'Auth' },
        { url: 'http://localhost:8025/', status: 'EXPLORED', area: 'Mailbox' },
      ],
    }) as never, surface);
    assert.ok(errors.some((e) => e.code === 'AUXILIARY_AS_PRODUCT'), JSON.stringify(errors));
  });

  it('still rejects an origin that was never configured', () => {
    const errors = validateDiscoveredBehavior(artifact({
      locations: [
        { url: 'http://localhost:4444/', status: 'EXPLORED', area: 'Auth' },
        { url: 'https://github.com/x', status: 'EXPLORED' },
      ],
    }) as never, surface);
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_LOCATION'), JSON.stringify(errors));
  });
});

describe('the agent is told which origins it may pass through', () => {
  const note = (value?: string) => {
    const before = process.env.QA_DISCOVERY_AUX_ORIGINS;
    if (value === undefined) delete process.env.QA_DISCOVERY_AUX_ORIGINS;
    else process.env.QA_DISCOVERY_AUX_ORIGINS = value;
    try { return auxiliaryOriginsNote('http://localhost:4444/'); } finally {
      if (before === undefined) delete process.env.QA_DISCOVERY_AUX_ORIGINS;
      else process.env.QA_DISCOVERY_AUX_ORIGINS = before;
    }
  };

  it('names a configured origin and bounds what it may be used for', () => {
    const text = note('http://localhost:8025');
    assert.match(text, /- http:\/\/localhost:8025/);
    assert.match(text, /ONLY when a product flow cannot continue/);
    assert.match(text, /NOT the product under test/);
  });

  it('says so explicitly when none is configured, and names the blocker', () => {
    const text = note(undefined);
    assert.match(text, /None are configured/);
    assert.match(text, /POST_AUTH_DISCOVERY_BLOCKED/);
  });

  it('never invites the model to nominate an origin of its own', () => {
    for (const text of [note('http://localhost:8025'), note(undefined)]) {
      assert.ok(!/you may add|choose (an|any) origin|decide which origin/i.test(text));
    }
  });
});

describe('the discovery prompt treats authentication as a transition', () => {
  const prompt = readFileSync(join(PROJECT_ROOT, 'src/agents/product-discovery.ts'), 'utf8');

  it('says finding a login is the beginning, not the end', () => {
    assert.match(prompt, /Authentication is a transition, not the end/);
    assert.match(prompt, /never the end of\nthe run/);
  });

  it('gives a blocked transition a status and a reason code', () => {
    assert.match(prompt, /"status": "BLOCKED", "reason": "POST_AUTH_DISCOVERY_BLOCKED"/);
  });

  it('sets no quota in its place', () => {
    assert.ok(!/at least \d+ (behaviors?|states?|test cases?)/i.test(prompt));
  });
});
