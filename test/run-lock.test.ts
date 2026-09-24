// One QA run at a time. Two concurrent runs corrupt each other rather than
// queue — measured as SQLITE_BUSY on Flue's shared conversation store.
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireRunLock, lockPath, readLock } from '../scripts/lib/run-lock.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'qa-lock-'));
const owner = { runId: 'r1', model: 'ollama/x', command: 'qa:manual' };

describe('the run lock', () => {
  it('is taken, recorded and released', () => {
    const dir = root();
    const lock = acquireRunLock(dir, owner);
    assert.equal(lock.ok, true);
    const held = readLock(dir)!;
    assert.equal(held.pid, process.pid);
    assert.equal(held.model, 'ollama/x');
    lock.release();
    assert.equal(existsSync(lockPath(dir)), false);
  });

  it('refuses a second run while a live one holds it, and says who', () => {
    const dir = root();
    // A pid that is certainly alive and is not us: our own parent.
    writeFileSync(lockPath(dir), JSON.stringify({
      pid: process.ppid, model: 'openrouter/deepseek', command: 'qa:manual', startedAt: '2026-09-24T17:00:00Z',
    }));
    const second = acquireRunLock(dir, owner);
    assert.equal(second.ok, false);
    assert.match(second.message!, /Another QA run is already in progress/);
    assert.match(second.message!, /openrouter\/deepseek/);
    assert.match(second.message!, /corrupt each other/);
  });

  it('reclaims a lock whose owner is gone', () => {
    const dir = root();
    // A pid that cannot be running: beyond any plausible pid_max.
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, model: 'ollama/dead' }));
    const lock = acquireRunLock(dir, owner);
    assert.equal(lock.ok, true, 'a crashed run must not block every later one');
    assert.equal(readLock(dir)!.pid, process.pid);
    lock.release();
  });

  it('treats an unreadable lock as absent rather than fatal', () => {
    const dir = root();
    writeFileSync(lockPath(dir), 'not json at all');
    const lock = acquireRunLock(dir, owner);
    assert.equal(lock.ok, true);
    lock.release();
  });

  it('never deletes a lock it does not own', () => {
    const dir = root();
    const lock = acquireRunLock(dir, owner);
    // Someone else took over in the meantime.
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, model: 'other' }));
    lock.release();
    assert.equal(readLock(dir)!.model, 'other', 'the replacing run must keep its lock');
  });

  it('is idempotent on release', () => {
    const dir = root();
    const lock = acquireRunLock(dir, owner);
    lock.release();
    lock.release();
    assert.equal(existsSync(lockPath(dir)), false);
  });
});
