// Authentication bootstrap (CHANGE 12): configuration, the browser it starts,
// and proof that the test account's values never reach anything the model or
// a trace can see.
//
//   npm test
//
// The browser tests start the real Playwright MCP server with the real launch
// arguments, against a tiny local application, and look at exactly what a
// model would receive: the MCP tool results.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTH_APPLIED_ENV,
  AuthConfigError,
  CREDENTIAL_REFS,
  appliedAuthMode,
  authBootstrapNote,
  authTelemetry,
  formatSecretsFile,
  mcpAuthArgs,
  readAuthBootstrap,
  readAuthMode,
  type AuthBootstrapConfig,
} from '../src/config/auth-bootstrap.ts';
import { absorbToolResult, buildSurface, type DiscoverySurface } from '../src/lib/discovery-surface.ts';
import { evaluateDiscoveryCompletion } from '../src/lib/discovery-completion.ts';
import { formatDelta } from '../src/lib/discovery-delta.ts';
import { resultText } from '../src/lib/surface-instrumentation.ts';
import { redactSecrets } from '../src/observability/content-policy.ts';
import { PathNotAllowedError, resolveInsideRoot } from '../src/lib/trusted-roots.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL_PASSWORD = 'SUPER_SECRET_SENTINEL_123';
const SENTINEL_EMAIL = 'sentinel.user.4711@example.test';
const SENTINEL_TOKEN = 'STORAGE_TOKEN_SENTINEL_456';

const scratch = mkdtempSync(join(tmpdir(), 'flue-auth-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const noSecrets = (text: string, where: string) => {
  for (const secret of [SENTINEL_PASSWORD, SENTINEL_EMAIL, SENTINEL_TOKEN]) {
    assert.ok(!text.includes(secret), `${where} contains ${secret}`);
  }
};
const credentials = (): Extract<AuthBootstrapConfig, { mode: 'credentials' }> => ({
  mode: 'credentials',
  credentials: { email: SENTINEL_EMAIL, password: SENTINEL_PASSWORD },
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('auth bootstrap configuration', () => {
  it('defaults to none and needs nothing else', () => {
    assert.deepEqual(readAuthBootstrap({}), { mode: 'none' });
    assert.deepEqual(readAuthBootstrap({ QA_AUTH_MODE: '' }), { mode: 'none' });
    // Stray credentials do nothing unless the mode asks for them.
    assert.deepEqual(readAuthBootstrap({ QA_AUTH_USER_PASSWORD: SENTINEL_PASSWORD, QA_AUTH_STORAGE_STATE: '/nope' }), { mode: 'none' });
  });

  it('rejects an unknown mode, naming the allowed ones', () => {
    assert.throws(() => readAuthMode({ QA_AUTH_MODE: 'cookies' }), (e: Error) => {
      assert.ok(e instanceof AuthConfigError);
      assert.equal(e.message, '[flue] QA_AUTH_MODE must be one of none, credentials, storage_state; got "cookies".');
      return true;
    });
  });

  it('storage_state requires QA_AUTH_STORAGE_STATE', () => {
    assert.throws(() => readAuthBootstrap({ QA_AUTH_MODE: 'storage_state' }), /QA_AUTH_STORAGE_STATE is not set/);
  });

  it('storage_state: a missing file is named by path, and nothing else', () => {
    assert.throws(
      () => readAuthBootstrap({ QA_AUTH_MODE: 'storage_state', QA_AUTH_STORAGE_STATE: '.qa/auth/default-user.json' }, { baseDir: scratch }),
      (e: Error) => {
        assert.equal(e.message, '[flue] Auth storage state file was not found: .qa/auth/default-user.json');
        return true;
      },
    );
    assert.throws(() => readAuthBootstrap({ QA_AUTH_MODE: 'storage_state', QA_AUTH_STORAGE_STATE: scratch }), /is not a file/);
  });

  it('storage_state: a valid file resolves to an absolute path, and its contents are never read into errors', () => {
    const dir = join(scratch, 'cfg');
    mkdirSync(join(dir, 'auth'), { recursive: true });
    writeFileSync(join(dir, 'auth/user.json'), JSON.stringify({ cookies: [{ name: 'session', value: SENTINEL_TOKEN }], origins: [] }));
    const config = readAuthBootstrap({ QA_AUTH_MODE: 'storage_state', QA_AUTH_STORAGE_STATE: 'auth/user.json' }, { baseDir: dir });
    assert.deepEqual(config, { mode: 'storage_state', storageStatePath: join(dir, 'auth/user.json') });
    // A file inside the browser's writable output directory is refused.
    assert.throws(
      () => readAuthBootstrap({ QA_AUTH_MODE: 'storage_state', QA_AUTH_STORAGE_STATE: 'auth/user.json' }, { baseDir: dir, mcpOutputRoot: dir }),
      (e: Error) => {
        assert.match(e.message, /must not live in the browser's output directory/);
        noSecrets(e.message, 'error');
        return true;
      },
    );
  });

  it('credentials requires both values, and never echoes either', () => {
    for (const [env, missing] of [
      [{ QA_AUTH_USER_PASSWORD: SENTINEL_PASSWORD }, 'QA_AUTH_USER_EMAIL'],
      [{ QA_AUTH_USER_EMAIL: SENTINEL_EMAIL }, 'QA_AUTH_USER_PASSWORD'],
      [{ QA_AUTH_USER_EMAIL: SENTINEL_EMAIL, QA_AUTH_USER_PASSWORD: '  ' }, 'QA_AUTH_USER_PASSWORD'],
    ] as const) {
      assert.throws(() => readAuthBootstrap({ QA_AUTH_MODE: 'credentials', ...env }), (e: Error) => {
        assert.equal(e.message, `[flue] QA_AUTH_MODE=credentials but ${missing} is not set.`);
        noSecrets(e.message, 'error');
        return true;
      });
    }
    const config = readAuthBootstrap({ QA_AUTH_MODE: 'credentials', QA_AUTH_USER_EMAIL: SENTINEL_EMAIL, QA_AUTH_USER_PASSWORD: SENTINEL_PASSWORD });
    assert.deepEqual(config, credentials());
  });

  it('telemetry carries the mode and booleans, never an account, path or token', () => {
    assert.deepEqual(authTelemetry({ mode: 'none' }), {
      authBootstrapMode: 'none', authBootstrapConfigured: false, authStorageStateLoaded: false, configuredTestUserAvailable: false,
    });
    const cred = authTelemetry(credentials());
    assert.equal(cred.authBootstrapMode, 'credentials');
    assert.equal(cred.configuredTestUserAvailable, true);
    noSecrets(JSON.stringify(cred), 'telemetry');
    const stored = authTelemetry({ mode: 'storage_state', storageStatePath: `/x/${SENTINEL_TOKEN}.json` });
    assert.equal(stored.authBootstrapMode, 'storage_state');
    // Loaded, not "succeeded": only the application can say whether it is valid.
    assert.equal(stored.authStorageStateLoaded, true);
    assert.ok(!('authBootstrapSucceeded' in stored));
    noSecrets(JSON.stringify(stored), 'telemetry');
  });
});

// ---------------------------------------------------------------------------
// Browser launch arguments
// ---------------------------------------------------------------------------

describe('auth bootstrap launch arguments', () => {
  it('none leaves the server launch exactly as it was', async () => {
    const { mcpServerArgs } = await import('../scripts/mcp-server.mjs');
    assert.deepEqual(mcpAuthArgs({ mode: 'none' }), []);
    assert.deepEqual(mcpServerArgs({ port: '8931', authArgs: mcpAuthArgs({ mode: 'none' }) }), mcpServerArgs({ port: '8931' }));
  });

  it('storage_state hands Playwright the file path, credentials a secrets file — never a value', async () => {
    const { mcpServerArgs } = await import('../scripts/mcp-server.mjs');
    const args = mcpServerArgs({ authArgs: mcpAuthArgs({ mode: 'storage_state', storageStatePath: '/abs/user.json' }) });
    assert.deepEqual(args.slice(-2), ['--storage-state', '/abs/user.json']);
    assert.ok(args.includes('--isolated'), 'storage state is only a template in isolated mode');
    const cred = mcpServerArgs({ authArgs: mcpAuthArgs(credentials(), '/tmp/x/secrets.env') });
    assert.deepEqual(cred.slice(-2), ['--secrets', '/tmp/x/secrets.env']);
    noSecrets(cred.join(' '), 'argv');
    assert.throws(() => mcpAuthArgs(credentials()));
  });

  it('the secrets file round-trips through the server\'s own dotenv parser, literally', () => {
    const { dotenv } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
    for (const password of [SENTINEL_PASSWORD, `p'w"d`, 'with # hash = and spaces ', 'back\\nslash', 'a`b\'c', '"quoted"']) {
      const file = formatSecretsFile({ mode: 'credentials', credentials: { email: SENTINEL_EMAIL, password } });
      assert.deepEqual(dotenv.parse(file), { QA_AUTH_USER_EMAIL: SENTINEL_EMAIL, QA_AUTH_USER_PASSWORD: password }, password);
    }
    assert.throws(
      () => formatSecretsFile({ mode: 'credentials', credentials: { email: SENTINEL_EMAIL, password: `a\n${SENTINEL_PASSWORD}` } }),
      (e: Error) => (noSecrets(e.message, 'error'), /QA_AUTH_USER_PASSWORD must be a single line/.test(e.message)),
    );
  });
});

// ---------------------------------------------------------------------------
// Preflight: the host refuses to start with a broken bootstrap
// ---------------------------------------------------------------------------

describe('auth bootstrap preflight', () => {
  const runManual = (env: Record<string, string>) => {
    const artifactRoot = mkdtempSync(join(scratch, 'qa-'));
    const clean: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('QA_AUTH_') || k.startsWith('LANGFUSE_')) delete clean[k];
    const r = spawnSync(process.execPath, ['scripts/qa-manual.mjs'], {
      cwd: PROJECT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...clean,
        QA_ENV_FILE: join(scratch, 'no-such-env'),
        QA_ARTIFACT_ROOT: artifactRoot,
        TARGET_URL: 'http://localhost:9/',
        ...env,
      },
    });
    return { ...r, artifactRoot };
  };

  it('stops with a clear config error before taking the run lock or touching a browser', () => {
    const cases: [Record<string, string>, string][] = [
      [{ QA_AUTH_MODE: 'bogus' }, 'QA_AUTH_MODE must be one of'],
      [{ QA_AUTH_MODE: 'storage_state' }, 'QA_AUTH_STORAGE_STATE is not set'],
      [{ QA_AUTH_MODE: 'storage_state', QA_AUTH_STORAGE_STATE: '.qa/auth/missing-user.json' }, 'Auth storage state file was not found: .qa/auth/missing-user.json'],
      [{ QA_AUTH_MODE: 'credentials', QA_AUTH_USER_PASSWORD: SENTINEL_PASSWORD }, 'QA_AUTH_USER_EMAIL is not set'],
    ];
    for (const [env, message] of cases) {
      const r = runManual(env);
      assert.equal(r.status, 2, `${JSON.stringify(env)}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes(message), r.stderr);
      noSecrets(r.stdout + r.stderr, 'preflight output');
      assert.ok(!r.stdout.includes('Playwright MCP'), 'no browser was started');
      assert.deepEqual(spawnSync('ls', ['-A', r.artifactRoot], { encoding: 'utf8' }).stdout.trim(), '', 'nothing written, no lock taken');
    }
  });
});

// ---------------------------------------------------------------------------
// What Product Discovery is told
// ---------------------------------------------------------------------------

describe('Product Discovery auth context', () => {
  it('none — and no bootstrap applied — leaves the prompt exactly as it was', () => {
    assert.equal(authBootstrapNote('none'), '');
    assert.equal(authBootstrapNote(undefined), '');
    assert.equal(appliedAuthMode({}), undefined);
    assert.equal(appliedAuthMode({ [AUTH_APPLIED_ENV]: 'none' }), 'none');
    assert.equal(appliedAuthMode({ [AUTH_APPLIED_ENV]: 'bogus' }), undefined);
  });

  it('credentials: names the references to type, never a value', () => {
    const note = authBootstrapNote('credentials');
    assert.ok(note.includes(CREDENTIAL_REFS.email) && note.includes(CREDENTIAL_REFS.password));
    assert.match(note, /never invent credentials/);
    noSecrets(note, 'prompt');
  });

  it('storage_state: a starting point, not a finding', () => {
    const note = authBootstrapNote('storage_state');
    assert.match(note, /may have expired/);
    assert.match(note, /only what the\s+snapshot shows/);
    assert.ok(!/you are (signed in|authenticated)\b/i.test(note.replace(/Whether you are signed in/, '')));
  });
});

// ---------------------------------------------------------------------------
// The real browser: Playwright MCP with the bootstrap's launch arguments
// ---------------------------------------------------------------------------

/**
 * A minimal application with a cookie session. `/` shows a sign-in form or a
 * signed-in page; `/login` accepts only the configured account and, like a
 * careless real application, echoes both values back onto the page.
 */
function startApp(): Promise<{ server: Server; origin: string; logins: { email: string; password: string }[] }> {
  const logins: { email: string; password: string }[] = [];
  const page = (body: string) => `<!doctype html><html><head><title>Auth Fixture</title></head><body><main>${body}</main></body></html>`;
  const server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/login') {
      const email = url.searchParams.get('email') ?? '';
      const password = url.searchParams.get('password') ?? '';
      logins.push({ email, password });
      if (email === SENTINEL_EMAIL && password === SENTINEL_PASSWORD) {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `session=${SENTINEL_TOKEN}; Path=/` });
        res.end(page(`<h1>Welcome</h1><p role="status">Signed in as ${email} using ${password}</p><button>Log out</button>`));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page('<h1>Sign In</h1><p role="status">Invalid credentials</p><form action="/login"><input name="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign In</button></form>'));
      }
      return;
    }
    if (url.pathname === '/logout') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=; Path=/; Max-Age=0' });
      res.end(page('<h1>Signed out</h1><a href="/">Home</a>'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (cookie.includes(`session=${SENTINEL_TOKEN}`)) {
      res.end(page('<h1>Notes</h1><p>Signed in</p><a href="/logout">Log out</a>'));
    } else {
      res.end(page('<h1>Sign In</h1><form action="/login"><input name="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign In</button></form>'));
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    done({ server, origin: `http://localhost:${port}`, logins });
  }));
}

let nextPort = 18_900 + Math.floor(Math.random() * 500);

/** The real launcher's arguments, on a private port and output directory. */
async function startMcp(authArgs: string[]): Promise<{ child: ChildProcess; url: URL } | undefined> {
  const { mcpServerArgs } = await import('../scripts/mcp-server.mjs');
  const port = String(nextPort++);
  const out = mkdtempSync(join(scratch, 'mcp-'));
  const args = mcpServerArgs({ port, authArgs }).map((a: string, i: number, all: string[]) => (all[i - 1] === '--output-dir' ? out : a));
  const child = spawn('npx', args, { cwd: out, stdio: 'ignore', detached: true });
  const url = new URL(`http://localhost:${port}/mcp`);
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  for (let i = 0; i < 90; i++) {
    try {
      const c = new Client({ name: 'auth-test', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(url));
      await c.close();
      return { child, url };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  stop(child);
  return undefined;
}

function stop(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // gone
  }
}

/** One MCP client = one browser context, exactly as one agent attempt gets. */
async function session(url: URL) {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'auth-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url));
  const seen: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as { content?: { text?: string }[]; isError?: boolean };
    const text = resultText(r);
    seen.push(JSON.stringify(args), text);
    return { text, isError: Boolean(r.isError), raw: r };
  };
  return { call, seen, close: () => client.close() };
}

const ref = (text: string, role: string, name: string) => {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(text);
  assert.ok(m, `no ${role} "${name}" in:\n${text}`);
  return m[1];
};

describe('auth bootstrap in a real browser', { timeout: 240_000 }, () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  const servers: ChildProcess[] = [];
  before(async () => {
    app = await startApp();
  });
  after(() => {
    for (const s of servers) stop(s);
    app?.server.close();
  });

  const launch = async (t: { skip: (m: string) => void }, authArgs: string[]) => {
    const mcp = await startMcp(authArgs);
    if (!mcp) {
      t.skip('Playwright MCP could not be started here');
      return undefined;
    }
    servers.push(mcp.child);
    return mcp;
  };

  const storageState = (value: string) => {
    const path = join(mkdtempSync(join(scratch, 'state-')), 'default-user.json');
    writeFileSync(path, JSON.stringify({
      cookies: [{ name: 'session', value, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: app.origin, localStorage: [{ name: 'authToken', value }] }],
    }, null, 2));
    return path;
  };

  it('credentials: the browser types the real values; the model sees only references', async (t) => {
    const secretsDir = mkdtempSync(join(scratch, 'secrets-'));
    const secretsFile = join(secretsDir, 'secrets.env');
    writeFileSync(secretsFile, formatSecretsFile(credentials()), { mode: 0o600 });
    const mcp = await launch(t, mcpAuthArgs(credentials(), secretsFile));
    if (!mcp) return;
    // The host deletes the file once the server is up; the server must not need it again.
    rmSync(secretsDir, { recursive: true, force: true });

    const surface = buildSurface(`${app.origin}/`, '', new Date(), { trackCompletion: true });
    const absorb = (tool: string, text: string) => absorbToolResult(surface, `mcp__playwright__${tool}`, text);
    const s = await session(mcp.url);
    const nav = await s.call('browser_navigate', { url: `${app.origin}/` });
    absorb('browser_navigate', nav.text);
    const form = await s.call('browser_snapshot');
    absorb('browser_snapshot', form.text);

    // Exactly what the model is told to send: the reference, not the value.
    const email = await s.call('browser_type', { target: ref(form.text, 'textbox', 'Email'), element: 'Email', text: CREDENTIAL_REFS.email });
    absorb('browser_type', email.text);
    const password = await s.call('browser_type', { target: ref(form.text, 'textbox', 'Password'), element: 'Password', text: CREDENTIAL_REFS.password, submit: true });
    absorb('browser_type', password.text);
    assert.ok(!email.isError && !password.isError, password.text);
    const landed = await s.call('browser_snapshot');
    const { delta } = absorb('browser_snapshot', landed.text);
    await s.close();

    // The application received the real account…
    assert.deepEqual(app.logins.at(-1), { email: SENTINEL_EMAIL, password: SENTINEL_PASSWORD });
    // …and showed it back, which the browser redacted before the model could read it.
    assert.match(landed.text, /Welcome/);
    assert.ok(landed.text.includes(`<secret>${CREDENTIAL_REFS.password}</secret>`), landed.text);
    assert.ok(landed.text.includes(`<secret>${CREDENTIAL_REFS.email}</secret>`), landed.text);

    // Nothing the model saw, sent, or the host derived from it carries a value.
    noSecrets(s.seen.join('\n'), 'MCP tool arguments and results');
    noSecrets(JSON.stringify(surface), 'discovery surface');
    if (delta) noSecrets(formatDelta(delta), 'surface delta hint');
    const gate = evaluateDiscoveryCompletion({ surface, artifact: { locations: [{ url: `${app.origin}/`, status: 'EXPLORED' }] } });
    noSecrets(JSON.stringify(gate), 'completion gate result');
    // Typing by reference is still real input as far as the evidence rules go.
    assert.ok((surface.inputs ?? []).length >= 2, 'secret-reference input recorded as input');
  });

  it('credentials: a failed credential fill types nothing, leaks nothing, and does not make the app BLOCKED', async (t) => {
    const secretsFile = join(mkdtempSync(join(scratch, 'secrets-')), 'secrets.env');
    writeFileSync(secretsFile, formatSecretsFile(credentials()), { mode: 0o600 });
    const mcp = await launch(t, mcpAuthArgs(credentials(), secretsFile));
    if (!mcp) return;
    const surface = buildSurface(`${app.origin}/`, '', new Date(), { trackCompletion: true });
    const absorb = (tool: string, text: string) => absorbToolResult(surface, `mcp__playwright__${tool}`, text);
    const s = await session(mcp.url);
    absorb('browser_navigate', (await s.call('browser_navigate', { url: `${app.origin}/` })).text);
    absorb('browser_snapshot', (await s.call('browser_snapshot')).text);
    const failed = await s.call('browser_type', { target: 'e999', element: 'Password', text: CREDENTIAL_REFS.password });
    absorb('browser_type', failed.text);
    await s.close();

    assert.ok(failed.isError, 'the fill failed at the tool level');
    noSecrets(s.seen.join('\n'), 'tool error');
    assert.equal((surface.inputs ?? []).length, 0, 'a failed call entered nothing');
    // The model now proposes BLOCKED: CHANGE 11 still demands an observed outcome.
    const gate = evaluateDiscoveryCompletion({
      surface,
      artifact: { locations: [{ url: `${app.origin}/`, status: 'BLOCKED', reason: 'POST_AUTH_DISCOVERY_BLOCKED: could not sign in' }] },
    });
    assert.ok(gate.reasons.some((r) => r.code === 'BLOCKED_WITHOUT_EVIDENCE'), JSON.stringify(gate.reasons));
    assert.equal(gate.canFinalize, false);
  });

  it('storage_state: every session starts from the file; none inherits another, and the file never changes', async (t) => {
    const file = storageState(SENTINEL_TOKEN);
    const before = sha(file);
    const mcp = await launch(t, mcpAuthArgs({ mode: 'storage_state', storageStatePath: file }));
    if (!mcp) return;

    // Run A: starts signed in, then signs out — mutating its own context.
    const a = await session(mcp.url);
    await a.call('browser_navigate', { url: `${app.origin}/` });
    const signedIn = await a.call('browser_snapshot');
    assert.match(signedIn.text, /heading "Notes"/, 'the stored session was applied');
    await a.call('browser_navigate', { url: `${app.origin}/logout` });
    await a.call('browser_navigate', { url: `${app.origin}/` });
    const afterLogout = await a.call('browser_snapshot');
    assert.match(afterLogout.text, /heading "Sign In"/, 'run A really lost its session');
    await a.close();

    // Run B: a fresh context from the same template, untouched by run A.
    const b = await session(mcp.url);
    await b.call('browser_navigate', { url: `${app.origin}/` });
    const fresh = await b.call('browser_snapshot');
    await b.close();
    assert.match(fresh.text, /heading "Notes"/, 'run B inherited run A\'s sign-out');

    assert.equal(sha(file), before, 'the storage-state file was modified');
    noSecrets(a.seen.join('\n') + b.seen.join('\n'), 'MCP results');
  });

  it('storage_state: an expired session lands on sign-in, and the gate treats it as unresolved auth', async (t) => {
    const file = storageState('expired-session');
    const mcp = await launch(t, mcpAuthArgs({ mode: 'storage_state', storageStatePath: file }));
    if (!mcp) return;
    const surface: DiscoverySurface = buildSurface(`${app.origin}/`, '', new Date(), { trackCompletion: true });
    const s = await session(mcp.url);
    absorbToolResult(surface, 'mcp__playwright__browser_navigate', (await s.call('browser_navigate', { url: `${app.origin}/` })).text);
    const snap = await s.call('browser_snapshot');
    absorbToolResult(surface, 'mcp__playwright__browser_snapshot', snap.text);
    await s.close();

    assert.match(snap.text, /heading "Sign In"/, 'the run continues from what the app shows');
    const gate = evaluateDiscoveryCompletion({ surface, artifact: { locations: [{ url: `${app.origin}/`, status: 'EXPLORED' }] } });
    assert.equal(gate.metrics.authFormSeen, true);
    assert.equal(gate.metrics.authenticatedStateSeen, false, 'loading a storage state is not being signed in');
    assert.ok(gate.reasons.some((r) => r.code === 'UNRESOLVED_AUTH_STATE'), JSON.stringify(gate.reasons));
  });
});

// ---------------------------------------------------------------------------
// Trace redaction of the account's values
// ---------------------------------------------------------------------------

describe('auth secrets in traces', () => {
  it('redactSecrets masks the configured account, even a short password', () => {
    const env = { QA_AUTH_USER_PASSWORD: 'hunter2x', QA_AUTH_USER_EMAIL: SENTINEL_EMAIL } as NodeJS.ProcessEnv;
    const out = redactSecrets(`login ${SENTINEL_EMAIL} / hunter2x failed`, env);
    assert.ok(!out.includes('hunter2x') && !out.includes(SENTINEL_EMAIL), out);
    // Too short to mask safely: left alone rather than shredding ordinary text.
    assert.equal(redactSecrets('a b c', { QA_AUTH_USER_PASSWORD: 'a' } as NodeJS.ProcessEnv), 'a b c');
  });
});

describe('storage state is not readable through repository tools', () => {
  it('refuses storage-state files by name and playwright/.auth by segment', () => {
    for (const path of ['storage-state.json', 'e2e/storageState.admin.json', 'fixtures/user.storagestate.json', 'playwright/.auth/user.json']) {
      assert.throws(() => resolveInsideRoot(scratch, path), PathNotAllowedError, path);
    }
    assert.doesNotThrow(() => resolveInsideRoot(scratch, 'tests/auth.setup.ts'));
  });
});
