// Trusted host configuration for the application under test.
//
// Same rule as the filesystem roots in `trusted-roots.ts`: the target is
// operator configuration, never something the model chooses or the user has to
// retype into a prompt. Agents receive it as one injected line; they cannot
// change it, and it gives them no filesystem or config authority.

import { envString } from '../config/env.ts';

/** Raw value, unvalidated. `undefined` when the operator has not set one. */
function rawTargetUrl(): string | undefined {
  return envString('TARGET_URL');
}

export class TargetUrlError extends Error {}

/**
 * Validate and normalise `TARGET_URL`. Throws with a directly actionable
 * message rather than letting a bad value reach a browser agent, where it would
 * surface as an opaque navigation failure several minutes into a run.
 */
export function requireTargetUrl(): string {
  const value = rawTargetUrl();
  if (value === undefined) {
    throw new TargetUrlError(
      'TARGET_URL is not set. Point it at the application under test, for example:\n' +
        '  export TARGET_URL="https://demo.playwright.dev/todomvc"',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TargetUrlError(
      `TARGET_URL is not a valid URL: "${value}". Include the scheme, for example ` +
        '"https://demo.playwright.dev/todomvc".',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TargetUrlError(
      `TARGET_URL must be an http or https URL; got "${parsed.protocol}//" in "${value}".`,
    );
  }

  return parsed.toString();
}

/**
 * The target for an agent render, or `undefined` when unset/invalid.
 *
 * Agent renders use this rather than `requireTargetUrl()` so that a missing
 * target degrades into an explicit BLOCKED instruction the agent can report,
 * instead of a crash inside the render. `scripts/qa.mjs` validates strictly up
 * front, so the normal path never reaches the undefined case.
 */
export function targetUrl(): string | undefined {
  try {
    return requireTargetUrl();
  } catch {
    return undefined;
  }
}
