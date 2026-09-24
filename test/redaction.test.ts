// Secrets and location identity: what may be persisted, and what may not.
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSensitiveParamName, locationIdentity, redactDeep, redactOpaqueSegment, redactText, REDACTED } from '../src/lib/redaction.ts';
import { normaliseControlName } from '../src/lib/discovery-state.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = '424242';
const CONFIRM = `http://localhost:4444/app?confirm_email=a@b.c&confirm_code=${CODE}`;

describe('location identity ignores query values', () => {
  it('folds different codes onto one location', () => {
    const a = locationIdentity('http://h/confirm?code=123')!;
    const b = locationIdentity('http://h/confirm?code=456')!;
    assert.equal(a.url, 'http://h/confirm');
    assert.equal(a.url, b.url);
  });

  it('keeps parameter names and flags the sensitive ones', () => {
    const id = locationIdentity(CONFIRM)!;
    assert.deepEqual(id.queryParameters, ['confirm_code', 'confirm_email']);
    assert.equal(id.containsSensitiveTransientData, true);
    assert.ok(!JSON.stringify(id).includes(CODE));
  });

  it('does not flag an ordinary parameter', () => {
    const id = locationIdentity('http://h/notes?tab=archive&page=2')!;
    assert.deepEqual(id.queryParameters, ['page', 'tab']);
    assert.equal(id.containsSensitiveTransientData, false);
  });

  it('normalises trailing slash and hash, and rejects non-http', () => {
    assert.equal(locationIdentity('http://h/notes/#top')!.url, 'http://h/notes');
    assert.equal(locationIdentity('javascript:alert(1)'), undefined);
  });

  it('recognises sensitive names generically, not by one hard-coded key', () => {
    for (const name of ['token', 'confirm_code', 'verificationCode', 'session', 'apiKey', 'auth', 'signature', 'otp'])
      assert.ok(isSensitiveParamName(name), name);
    for (const name of ['tab', 'page', 'sort', 'email', 'q']) assert.ok(!isSensitiveParamName(name), name);
  });
});

describe('redaction removes transient values from any string', () => {
  it('redacts a code inside a URL', () => {
    assert.equal(redactText(CONFIRM), `http://localhost:4444/app?confirm_email=a@b.c&confirm_code=${REDACTED}`);
  });

  it('redacts a code quoted in prose', () => {
    const prose = `Opened the link ?confirm_code=${CODE} and the account was confirmed.`;
    assert.ok(!redactText(prose).includes(CODE));
  });

  it('leaves ordinary parameters alone', () => {
    assert.equal(redactText('/notes?tab=archive'), '/notes?tab=archive');
  });

  it('walks a whole artifact', () => {
    const artifact = {
      areas: [{ routes: [CONFIRM] }],
      behaviors: [{ statement: `Following ?token=${CODE} signs the user in` }],
      nested: { deep: [{ x: CONFIRM }] },
    };
    assert.ok(!JSON.stringify(redactDeep(artifact)).includes(CODE));
  });

  it('preserves everything that is not a secret', () => {
    const artifact = { a: 'plain', b: 12, c: true, d: null, e: ['/notes?tab=archive'] };
    assert.deepEqual(redactDeep(artifact), artifact);
  });
});

describe('no artifact can carry a one-time code to disk', () => {
  it('redacts on the way through write_qa_artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-redact-'));
    const artifact = {
      product: 'Demo',
      locations: [{ url: 'http://localhost:4444/', status: 'EXPLORED', area: 'Main' }],
      areas: [{ name: 'Main', routes: [CONFIRM], notes: [] }],
      behaviors: [{
        id: 'BEH-1', area: 'Main',
        statement: `Opening ?confirm_code=${CODE} confirms the account`,
        status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false,
      }],
      openQuestions: [], conflicts: [],
    };
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e',
       `const q = await import("./src/lib/qa-artifacts.ts");
        q.writeQaArtifact("discovered-behavior", ${JSON.stringify(artifact)});
        console.log(q.qaArtifactPath("discovered-behavior"));`],
      { cwd: PROJECT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env') } },
    );
    assert.equal(r.status, 0, r.stderr);
    const written = readFileSync(r.stdout.trim().split('\n').pop()!, 'utf8');
    assert.ok(!written.includes(CODE), 'the confirmation code reached disk');
    assert.ok(written.includes(REDACTED), 'the redaction marker should be visible in its place');
  });
});

describe('a secret is not always a query value', () => {
  it('redacts an opaque path segment such as a mailbox message id', () => {
    // Found in a live run: persisting this id hands over a readable inbox.
    const id = locationIdentity('http://localhost:8025/api/v1/messages/aaaabbbbccccddddeeeeffff11112222=@mailbox.example/download')!;
    assert.equal(id.url, 'http://localhost:8025/api/v1/messages/-redacted-/download');
    assert.ok(!id.url.includes('aaaabbbb'));
  });

  it('leaves ordinary route words alone', () => {
    for (const path of ['/account/notes', '/app', '/api/v1/messages', '/very-long-but-wordy-route'])
      assert.equal(locationIdentity(`http://h${path}`)!.url, `http://h${path}`);
  });

  it('needs both letters and digits before it calls a segment opaque', () => {
    assert.equal(redactOpaqueSegment('averylongpurelyalphabeticsegment'), 'averylongpurelyalphabeticsegment');
    assert.equal(redactOpaqueSegment('012345678901234567890123'), '012345678901234567890123');
    assert.equal(redactOpaqueSegment('aaaabbbbccccddddeeee1111'), '-redacted-');
  });

  it('redacts a confirmation link quoted as a control name', () => {
    // A link's accessible name is sometimes the whole href.
    assert.ok(!normaliseControlName('http://h/app?confirm_code=ab12cd34ef').includes('ab12cd34ef'));
  });
});
