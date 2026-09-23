// The configuration layer: .env loading, precedence, and model selection.
//
//   npm test
//
// Most of these run the real modules in a child process, because `.env` is
// loaded once at import time and `QA_MODEL` is read once — a single process
// cannot observe more than one configuration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run a snippet against the real modules, with a controlled environment.
 *
 * `env` replaces the inherited environment for the variables it names; passing
 * `undefined` unsets one. The project's own `.env` is neutralised by pointing
 * the loader at an empty directory unless a test asks otherwise.
 */
function run(code: string, env: Record<string, string | undefined> = {}) {
  const clean = { ...process.env };
  // Never let the developer's own .env or shell leak into an assertion.
  for (const key of ['QA_MODEL', 'OPENROUTER_API_KEY', 'TARGET_URL', 'OLLAMA_MAX_OUTPUT_TOKENS', 'QA_STAGE_ATTEMPTS']) {
    delete clean[key];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  // Isolate from whatever .env the developer happens to have: these tests
  // assert precedence and defaults, and must not depend on a local file.
  clean.QA_ENV_FILE = clean.QA_ENV_FILE ?? join(tmpdir(), 'qa-no-such-env-file');
  return spawnSync(process.execPath, ['--experimental-strip-types', '-e', code], {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 60_000,
    env: clean,
  });
}

const out = (r: { stdout: string; stderr: string; status: number | null }) => {
  assert.equal(r.status, 0, `exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout.trim().split('\n').pop() ?? '';
};

// ---------------------------------------------------------------------------
// .env loading and precedence
// ---------------------------------------------------------------------------

describe('.env loading', () => {
  it('is optional — the project works with no .env at all', () => {
    // The real project may or may not have one; either way importing must work
    // and the default model must be intact when nothing sets QA_MODEL.
    const r = run('const { QA_MODEL } = await import("./src/config/env.ts"); console.log(QA_MODEL);');
    assert.equal(out(r), 'ollama/qwen3:14b');
  });

  it('applies code defaults when neither the shell nor .env sets a value', () => {
    const r = run(`
      const { envInt, envString, envBool } = await import("./src/config/env.ts");
      console.log(JSON.stringify({
        i: envInt("QA_DOES_NOT_EXIST_AT_ALL", 4),
        s: envString("QA_DOES_NOT_EXIST_AT_ALL") ?? null,
        b: envBool("QA_DOES_NOT_EXIST_AT_ALL"),
      }));`);
    assert.deepEqual(JSON.parse(out(r)), { i: 4, s: null, b: false });
  });

  it('a shell variable overrides .env', () => {
    // The project's own .env sets nothing in a clean checkout, so prove
    // precedence against a .env we control, loaded the same way.
    const dir = mkdtempSync(join(tmpdir(), 'qa-env-'));
    writeFileSync(join(dir, '.env'), 'QA_PRECEDENCE_PROBE=from-dotenv\n');
    const r = run(
      `process.loadEnvFile(${JSON.stringify(join(dir, '.env'))});
       console.log(process.env.QA_PRECEDENCE_PROBE);`,
      { QA_PRECEDENCE_PROBE: 'from-shell' },
    );
    assert.equal(out(r), 'from-shell', 'loadEnvFile must not overwrite an existing variable');
  });

  it('reads a value from .env when the shell does not set it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-env-'));
    writeFileSync(join(dir, '.env'), 'QA_PRECEDENCE_PROBE=from-dotenv\n');
    const r = run(
      `process.loadEnvFile(${JSON.stringify(join(dir, '.env'))});
       console.log(process.env.QA_PRECEDENCE_PROBE);`,
      { QA_PRECEDENCE_PROBE: undefined },
    );
    assert.equal(out(r), 'from-dotenv');
  });

  it('rejects a non-numeric value where a number is required', () => {
    const r = run(
      'const { envInt } = await import("./src/config/env.ts"); envInt("OLLAMA_MAX_OUTPUT_TOKENS", 2048);',
      { OLLAMA_MAX_OUTPUT_TOKENS: 'lots' },
    );
    assert.notEqual(r.status, 0, 'an invalid number must fail loudly');
    assert.match(r.stderr, /must be a positive integer/);
  });

  it('rejects a negative or zero value where a positive integer is required', () => {
    for (const bad of ['0', '-1', '2.5']) {
      const r = run('const { envInt } = await import("./src/config/env.ts"); envInt("QA_STAGE_ATTEMPTS", 4);', {
        QA_STAGE_ATTEMPTS: bad,
      });
      assert.notEqual(r.status, 0, `"${bad}" should be rejected`);
    }
  });

  it('resolves the project root from the module, not the working directory', () => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e',
       `const { PROJECT_ROOT } = await import(${JSON.stringify(join(PROJECT, 'src/config/env.ts'))}); console.log(PROJECT_ROOT);`],
      { cwd: tmpdir(), encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(out(r), PROJECT);
  });
});

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

describe('model selection', () => {
  const selected = (env: Record<string, string | undefined>) =>
    run(
      `const m = await import("./src/providers/model.ts");
       console.log(JSON.stringify({ model: m.QA_MODEL, provider: m.QA_MODEL_PROVIDER, id: m.QA_MODEL_ID }));`,
      env,
    );

  it('defaults to the local Ollama model when QA_MODEL is unset', () => {
    const r = selected({ QA_MODEL: undefined });
    assert.deepEqual(JSON.parse(out(r)), { model: 'ollama/qwen3:14b', provider: 'ollama', id: 'qwen3:14b' });
  });

  it('selects Ollama explicitly', () => {
    const r = selected({ QA_MODEL: 'ollama/qwen3:14b' });
    assert.equal(JSON.parse(out(r)).provider, 'ollama');
  });

  it('works on Ollama with no OPENROUTER_API_KEY present', () => {
    const r = selected({ QA_MODEL: 'ollama/qwen3:14b', OPENROUTER_API_KEY: undefined });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(out(r)).provider, 'ollama');
  });

  it('selects OpenRouter and splits the two-segment model id correctly', () => {
    const r = selected({
      QA_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731',
      OPENROUTER_API_KEY: 'test-key-not-real',
    });
    assert.deepEqual(JSON.parse(out(r)), {
      model: 'openrouter/deepseek/deepseek-v4-flash-0731',
      provider: 'openrouter',
      id: 'deepseek/deepseek-v4-flash-0731',
    });
  });

  it('fails early and clearly when OpenRouter is selected without a key', () => {
    const r = selected({
      QA_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731',
      OPENROUTER_API_KEY: undefined,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /QA_MODEL selects OpenRouter but OPENROUTER_API_KEY is not configured/);
    assert.match(r.stderr, /Add it to \.env or the process environment/);
  });

  it('rejects an unknown provider with a usable message', () => {
    const r = selected({ QA_MODEL: 'acme/some-model' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /provider "ollama" or "openrouter"/);
  });

  it('registers the target model so Flue can resolve it', () => {
    const r = run(
      `const { isInPiCatalog, isLocallyRegistered } = await import("./src/providers/openrouter.ts");
       console.log(JSON.stringify({
         inCatalog: isInPiCatalog("deepseek/deepseek-v4-flash-0731"),
         local: isLocallyRegistered("deepseek/deepseek-v4-flash-0731"),
         undatedInCatalog: isInPiCatalog("deepseek/deepseek-v4-flash"),
       }));`,
      { OPENROUTER_API_KEY: 'test-key-not-real' },
    );
    const got = JSON.parse(out(r));
    // If a dependency bump ever adds the dated snapshot upstream, the local
    // descriptor in openrouter.ts becomes removable — this test says so.
    assert.equal(got.local, true, 'the dated snapshot must be registered locally');
    assert.equal(got.undatedInCatalog, true, "Pi's catalog has the undated model, which is why only the snapshot is local");
    if (got.inCatalog) {
      assert.fail('Pi now ships deepseek-v4-flash-0731 — delete MISSING_FROM_PI_CATALOG in src/providers/openrouter.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('the API key stays host-side', () => {
  const SECRET = 'sk-or-v1-DO-NOT-LEAK-THIS-VALUE';

  it('never appears in the error raised when configuration is wrong', () => {
    const r = run('const { envInt } = await import("./src/config/env.ts"); envInt("QA_STAGE_ATTEMPTS", 4);', {
      QA_STAGE_ATTEMPTS: 'nonsense',
      OPENROUTER_API_KEY: SECRET,
    });
    assert.ok(!r.stderr.includes(SECRET), 'the key must not appear in stderr');
    assert.ok(!r.stdout.includes(SECRET), 'the key must not appear in stdout');
  });

  it('never appears when the provider is registered', () => {
    const r = run(
      `await import("./src/providers/model.ts"); console.log("registered");`,
      { QA_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731', OPENROUTER_API_KEY: SECRET },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  });

  it('is not reachable through the repo-reading tools', async () => {
    const { resolveInsideRoot, PathNotAllowedError } = await import('../src/lib/trusted-roots.ts');
    for (const attempt of ['.env', '.env.local', 'config/.env', '../flue-qa-agents/.env']) {
      assert.throws(() => resolveInsideRoot(PROJECT, attempt), PathNotAllowedError, `must refuse ${attempt}`);
    }
  });

  it('is not an artifact any agent can name', async () => {
    const { writeQaArtifactToolFor } = await import('../src/tools/qa-artifacts.ts');
    const v = await import('valibot');
    const tool = writeQaArtifactToolFor(['repo-analysis']);
    for (const name of ['.env', 'env', 'phase1-approval']) {
      assert.equal(v.safeParse(tool.input!, { name, data: {} }).success, false);
    }
  });
});
