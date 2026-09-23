// Centralized runtime configuration.
//
// Loads the project-root `.env` once, using Node's built-in support — no
// `dotenv` dependency. Precedence is the usual one and is tested:
//
//     shell / process environment   >   .env   >   code default
//
// Node's `loadEnvFile()` does not overwrite variables that are already set, so
// a value exported in the shell always wins. `.env` is optional: a project with
// no `.env` behaves exactly as it did before this module existed.
//
// `.env` is part of the control plane and holds secrets. It is git-ignored, and
// the repo-reading tools refuse `.env` by name at any depth
// (`src/lib/trusted-roots.ts`), so no agent, browser or MCP tool can read it.
// Nothing here is mounted as a tool.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root, resolved from this module rather than from `process.cwd()`. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Which file to load. `QA_ENV_FILE` points the loader elsewhere — used by the
 * tests to isolate themselves from the developer's own `.env`, and useful for
 * a CI profile. Set it to a path that does not exist to load nothing at all.
 * It can only come from the real environment, never from `.env` itself.
 */
const ENV_PATH = process.env.QA_ENV_FILE?.trim() || resolve(PROJECT_ROOT, '.env');

let loaded = false;

/**
 * Load `.env` from the project root, at most once per process.
 *
 * Called at import time so that every entry point — `npm run qa:*`, a direct
 * `flue run <agent>`, and the tests — sees the same configuration without
 * needing to remember to call anything.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(ENV_PATH)) return;
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (error) {
    // A malformed .env should be loud but not fatal to a run that may not need
    // any of its values. Never echo the file's contents: it holds secrets.
    console.warn(`Warning: could not parse ${ENV_PATH}: ${(error as Error).message}`);
  }
}

loadEnv();

/** Trimmed value of `name`, or undefined when unset or empty. */
export function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * A positive integer from the environment, or `fallback`.
 *
 * Throws on a value that is present but not a positive integer: silently
 * falling back would hide a typo in a context window or a timeout, and those
 * fail much later and much more confusingly.
 */
export function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}".`);
  }
  return value;
}

/** True only for the exact string "true"; anything else is false. */
export function envBool(name: string, fallback = false): boolean {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  return raw === 'true';
}

/**
 * The model every agent uses, in Flue's canonical `provider/model` form.
 *
 * Default keeps the previous behaviour exactly: with no `.env` and no
 * `QA_MODEL`, agents run on the local Ollama model as before.
 */
export const QA_MODEL = envString('QA_MODEL') ?? 'ollama/qwen3:14b';

/** Which provider `QA_MODEL` selects. */
export function modelProvider(model: string = QA_MODEL): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(0, slash);
}

/** The model id within its provider — `openrouter/deepseek/x` -> `deepseek/x`. */
export function modelId(model: string = QA_MODEL): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}
