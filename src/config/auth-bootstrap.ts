// Authentication bootstrap: the state a QA run's browser starts in.
//
//   QA_AUTH_MODE=none           default — the browser starts signed out, and
//                               Product Discovery handles authentication itself
//   QA_AUTH_MODE=credentials    an existing test account is available; its
//                               values are typed by the browser, never the model
//   QA_AUTH_MODE=storage_state  every browser context starts from a Playwright
//                               storageState file
//
// AUTH BOOTSTRAP prepares the starting state. It is not AUTH DISCOVERY and it
// is not evidence: a loaded session may have expired, and whether the run is
// signed in is only ever what the application shows. Nothing here marks
// authentication resolved, and the Discovery Completion Gate never reads it.
//
// Both mechanisms are Playwright MCP's own, applied when the host starts the
// server (scripts/lib/runtime.mjs):
//
//   --storage-state <path>  With `--isolated`, each MCP client gets a fresh
//                           `browser.newContext({ storageState })`. Playwright
//                           only reads the file; the context lives in memory
//                           and is discarded, so the file is an input template
//                           and one session never inherits another's changes.
//
//   --secrets <file>        A dotenv file of NAME=value. When `browser_type` or
//                           `browser_fill_form` is given text equal to a NAME,
//                           the server fills the value instead; every response
//                           it returns has the value replaced by
//                           `<secret>NAME</secret>`. The model types a name and
//                           only ever sees a name.
//
// Environment parsing (`readAuthBootstrap`) is kept apart from the runtime
// representation (`AuthBootstrapConfig`), so a later named-profile source can
// produce the same object. Nothing built here — errors, notes, telemetry —
// contains a credential value or a storage-state file's contents.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PROJECT_ROOT } from './env.ts';

export const AUTH_MODES = ['none', 'credentials', 'storage_state'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The references the model types in place of the account's values. They are
 * the configuration variables' own names: the browser substitutes the value,
 * and redacts it back to `<secret>NAME</secret>` in everything it returns.
 */
export const CREDENTIAL_REFS = {
  email: 'QA_AUTH_USER_EMAIL',
  password: 'QA_AUTH_USER_PASSWORD',
} as const;

/** Values that must never leave the host, in a trace or anywhere else. */
export const AUTH_SECRET_ENV_NAMES: readonly string[] = [CREDENTIAL_REFS.email, CREDENTIAL_REFS.password];

/**
 * Set by the host after it started the browser with a bootstrap applied, and
 * read by agents it spawns. An agent run without the host (`flue run` alone)
 * gets no bootstrap note, because no bootstrap was applied to its browser.
 */
export const AUTH_APPLIED_ENV = 'QA_AUTH_BOOTSTRAP_APPLIED';

export type AuthBootstrapConfig =
  | { mode: 'none' }
  | {
      mode: 'credentials';
      /** The account. Values for the browser only — never a prompt, log or trace. */
      credentials: { email: string; password: string };
    }
  | {
      mode: 'storage_state';
      /** Absolute path of the storageState file. The path may be shown; the contents never. */
      storageStatePath: string;
    };

export class AuthConfigError extends Error {
  name = 'AuthConfigError';
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

/** The mode alone. Safe anywhere — it reads no credential. */
export function readAuthMode(env: Env = process.env): AuthMode {
  const raw = value(env, 'QA_AUTH_MODE');
  if (raw === undefined) return 'none';
  if ((AUTH_MODES as readonly string[]).includes(raw)) return raw as AuthMode;
  throw new AuthConfigError(`[flue] QA_AUTH_MODE must be one of ${AUTH_MODES.join(', ')}; got "${raw}".`);
}

export interface ReadOptions {
  /** Relative storage-state paths resolve against this. Default: the project root. */
  baseDir?: string;
  /**
   * The browser server's own writable workspace. A storage state there could
   * be overwritten through a browser tool's `filename`, so it is refused.
   */
  mcpOutputRoot?: string;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The run's bootstrap, validated. Throws `AuthConfigError` naming what is
 * wrong — a variable or a path, never a value. Call it before the run starts.
 */
export function readAuthBootstrap(env: Env = process.env, options: ReadOptions = {}): AuthBootstrapConfig {
  const mode = readAuthMode(env);

  if (mode === 'credentials') {
    for (const name of [CREDENTIAL_REFS.email, CREDENTIAL_REFS.password]) {
      if (value(env, name) === undefined) {
        throw new AuthConfigError(`[flue] QA_AUTH_MODE=credentials but ${name} is not set.`);
      }
    }
    // The password is used verbatim — surrounding spaces may be part of it.
    const password = env[CREDENTIAL_REFS.password] as string;
    return { mode, credentials: { email: value(env, CREDENTIAL_REFS.email) as string, password } };
  }

  if (mode === 'storage_state') {
    const configured = value(env, 'QA_AUTH_STORAGE_STATE');
    if (configured === undefined) {
      throw new AuthConfigError('[flue] QA_AUTH_MODE=storage_state but QA_AUTH_STORAGE_STATE is not set.');
    }
    const path = resolve(options.baseDir ?? PROJECT_ROOT, configured);
    if (!existsSync(path)) throw new AuthConfigError(`[flue] Auth storage state file was not found: ${configured}`);
    if (!statSync(path).isFile()) throw new AuthConfigError(`[flue] Auth storage state is not a file: ${configured}`);
    if (options.mcpOutputRoot !== undefined && isInside(path, resolve(options.mcpOutputRoot))) {
      throw new AuthConfigError(
        `[flue] Auth storage state must not live in the browser's output directory (${options.mcpOutputRoot}), ` +
          `where a browser tool can overwrite it: ${configured}`,
      );
    }
    return { mode, storageStatePath: path };
  }

  return { mode: 'none' };
}

/** Extra Playwright MCP arguments for this bootstrap. `secretsFile` is required for credentials. */
export function mcpAuthArgs(config: AuthBootstrapConfig, secretsFile?: string): string[] {
  if (config.mode === 'storage_state') return ['--storage-state', config.storageStatePath];
  if (config.mode === 'credentials') {
    if (secretsFile === undefined) throw new Error('credentials bootstrap needs a secrets file');
    return ['--secrets', secretsFile];
  }
  return [];
}

/**
 * The account as a dotenv file for `--secrets`, with each value taken
 * literally: quoted with a quote character it does not contain, since the
 * server's parser strips one pair of quotes and expands escapes only inside
 * double quotes. A value that cannot be written literally is refused, by name.
 */
export function formatSecretsFile(config: Extract<AuthBootstrapConfig, { mode: 'credentials' }>): string {
  const entries: [string, string][] = [
    [CREDENTIAL_REFS.email, config.credentials.email],
    [CREDENTIAL_REFS.password, config.credentials.password],
  ];
  return entries
    .map(([name, v]) => {
      if (/[\r\n]/.test(v)) throw new AuthConfigError(`[flue] ${name} must be a single line.`);
      const quote = ["'", '`', '"'].find((q) => !v.includes(q) && (q !== '"' || !/\\[nr]/.test(v)));
      if (quote === undefined) throw new AuthConfigError(`[flue] ${name} contains characters the browser's secrets file cannot hold.`);
      return `${name}=${quote}${v}${quote}\n`;
    })
    .join('');
}

/** For the console: what was applied. Names a path, never a value. */
export function describeAuthBootstrap(config: AuthBootstrapConfig): string {
  if (config.mode === 'storage_state') {
    return `storage_state — every browser context starts from ${relative(PROJECT_ROOT, config.storageStatePath) || config.storageStatePath} (read only)`;
  }
  if (config.mode === 'credentials') return 'credentials — a configured test account, typed by the browser by reference';
  return 'none — the browser starts signed out';
}

/** Run-level telemetry. Mode and booleans only: no account, path, cookie or token. */
export function authTelemetry(config: AuthBootstrapConfig): Record<string, string | boolean> {
  return {
    authBootstrapMode: config.mode,
    authBootstrapConfigured: config.mode !== 'none',
    // Applied to the browser — which says nothing about whether the session is valid.
    authStorageStateLoaded: config.mode === 'storage_state',
    configuredTestUserAvailable: config.mode === 'credentials',
  };
}

/**
 * What Product Discovery is told about how its browser was prepared. Empty for
 * `none`, so the default prompt is exactly what it was before this existed.
 */
export function authBootstrapNote(mode: AuthMode | undefined): string {
  if (mode === 'storage_state') {
    return (
      `\n\n## Auth bootstrap\nThe browser context was initialized from a stored session. That is a starting ` +
      `point, not a finding: the session may have expired. Whether you are signed in is only what the ` +
      `snapshot shows. If the application presents sign-in, treat it like any other sign-in flow; no ` +
      `credentials are configured for this run. Never record "the user is authenticated" unless you saw it.`
    );
  }
  if (mode === 'credentials') {
    return (
      `\n\n## Auth bootstrap\nA configured test account is available. To sign in with it, type these exact ` +
      `references as the field values — the browser enters the real values, which you never see:\n` +
      `- email / username: ${CREDENTIAL_REFS.email}\n- password: ${CREDENTIAL_REFS.password}\n` +
      `Results show them back as <secret>NAME</secret>. Use this account instead of registering one, and ` +
      `never invent credentials for signing in. Whether sign-in worked is what the snapshot shows afterwards.`
    );
  }
  return '';
}

/** The mode the host applied to this process's browser, if any. */
export function appliedAuthMode(env: Env = process.env): AuthMode | undefined {
  const raw = value(env, AUTH_APPLIED_ENV);
  return raw !== undefined && (AUTH_MODES as readonly string[]).includes(raw) ? (raw as AuthMode) : undefined;
}
