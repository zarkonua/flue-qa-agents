// The provider diagnostic: structural, sanitized, and never a repair.
//
//   npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describeRequest, describeResponse, isParserFailure } from '../src/lib/harmony-diagnostic.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = '424242';

describe('it recognises the failure it exists for', () => {
  it('matches the real provider message', () => {
    assert.ok(isParserFailure(
      '500: {"message":"llama-server chat error: map[code:500 message:The model produced output that ' +
      'does not match the expected peg-native format type:server_error]"}',
    ));
  });

  it('ignores unrelated failures', () => {
    for (const other of ['connect ECONNREFUSED 127.0.0.1:11434', 'AbortError: timeout', 'database is locked'])
      assert.ok(!isParserFailure(other), other);
  });
});

describe('it describes shape, not content', () => {
  const payload = {
    model: 'gpt-oss-20b-q5-49k', stream: true, temperature: 0.2, max_tokens: 16384,
    messages: [
      { role: 'system', content: 'x'.repeat(4000) },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: `- Page URL: http://h/app?confirm_code=${CODE}` },
      { role: 'user', content: 'continue' },
    ],
    tools: [{ function: { name: 'browser_snapshot' } }, { function: { name: 'browser_click' } }],
  };

  it('captures the structure a synthetic probe could not provoke', () => {
    const d = describeRequest(payload);
    assert.equal(d.messageCount, 4);
    assert.equal(d.roleSequence, 'system,assistant,tool,user');
    assert.equal(d.historicalToolCallTurns, 1);
    assert.equal(d.historicalToolResults, 1);
    assert.equal(d.toolDefinitionCount, 2);
    assert.deepEqual(d.toolNames, ['browser_snapshot', 'browser_click']);
    assert.ok((d.estimatedPromptTokens as number) > 900);
  });

  it('carries no message content', () => {
    const text = JSON.stringify(describeRequest(payload));
    assert.ok(!text.includes(CODE), 'a confirmation code must never reach a diagnostic');
    assert.ok(!text.includes('x'.repeat(50)), 'prompt text must not be dumped');
    assert.ok(!text.includes('continue'));
  });

  it('describes a response by its fields', () => {
    const d = describeResponse({
      choices: [{ finish_reason: 'length', message: { content: 'partial', tool_calls: [], role: 'assistant' } }],
      usage: {},
    });
    assert.equal(d.finishReason, 'length');
    assert.equal(d.producedContent, true);
    assert.deepEqual(d.messageFields, ['content', 'tool_calls', 'role']);
  });
});

describe('what it writes to disk', () => {
  it('redacts the record, and appends rather than overwrites', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-diag-'));
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e', `
        const H = await import("./src/lib/harmony-diagnostic.ts");
        const entry = (n) => ({
          error: { status: 500, message: "peg-native failure near ?confirm_code=${CODE}" },
          request: { model: "gpt-oss", note: "turn " + n },
          fragment: "<|channel|>commentary ?token=${CODE}",
          replayReasoning: false,
        });
        H.recordHarmonyFailure(entry(1));
        console.log(H.recordHarmonyFailure(entry(2)));`],
      { cwd: PROJECT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env') } },
    );
    assert.equal(r.status, 0, r.stderr);
    const written = readFileSync(r.stdout.trim().split('\n').pop()!, 'utf8');
    const lines = written.trim().split('\n');
    assert.equal(lines.length, 2, 'each failure is a new line, not a replacement');
    assert.ok(!written.includes(CODE), 'the diagnostic must not persist a transient code');
    assert.ok(written.includes('<redacted>'));
    assert.equal(JSON.parse(lines[0]).kind, 'provider-parse-failure');
  });
});
