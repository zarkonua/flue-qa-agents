// Observability configuration: optional, off by default, validated up front.
//
//   LANGFUSE_ENABLED=true          the only value that turns tracing on
//   LANGFUSE_PUBLIC_KEY / _SECRET_KEY   required only when enabled
//   LANGFUSE_BASE_URL              default https://cloud.langfuse.com; any
//                                  self-hosted instance works the same way
//   LANGFUSE_TRACING_ENVIRONMENT   default "development"
//   LANGFUSE_CAPTURE_IO=true       also send prompts, responses and tool I/O
//
// Disabled means disabled: no credentials are read, nothing is initialised, no
// request leaves the machine. Enabled with a missing credential is a
// configuration error raised before any stage starts — never halfway through a
// run. No message built here ever contains a credential's value.

import { envBool, envString } from '../config/env.ts';

export const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
export const DEFAULT_TRACING_ENVIRONMENT = 'development';

export type ObservabilityConfig =
  | { enabled: false }
  | {
      enabled: true;
      publicKey: string;
      secretKey: string;
      baseUrl: string;
      environment: string;
      /** Send prompts, responses and tool payloads. Off by default. */
      captureIo: boolean;
    };

export class ObservabilityConfigError extends Error {
  name = 'ObservabilityConfigError';
}

/**
 * Langfuse accepts lowercase letters, digits, `-` and `_`, and reserves the
 * `langfuse` prefix. Checked here so a typo fails at startup instead of every
 * span being silently rejected by the server.
 */
const ENVIRONMENT_PATTERN = /^(?!langfuse)[a-z0-9_-]{1,40}$/;

export function readObservabilityConfig(): ObservabilityConfig {
  if (!envBool('LANGFUSE_ENABLED')) return { enabled: false };

  for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'] as const) {
    if (envString(name) === undefined) {
      throw new ObservabilityConfigError(`[flue] Langfuse observability is enabled but ${name} is missing.`);
    }
  }

  const baseUrl = (envString('LANGFUSE_BASE_URL') ?? DEFAULT_LANGFUSE_BASE_URL).replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    throw new ObservabilityConfigError(`[flue] LANGFUSE_BASE_URL must be an http(s) URL; got "${baseUrl}".`);
  }

  const environment = envString('LANGFUSE_TRACING_ENVIRONMENT') ?? DEFAULT_TRACING_ENVIRONMENT;
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new ObservabilityConfigError(
      `[flue] LANGFUSE_TRACING_ENVIRONMENT must be lowercase letters, digits, "-" or "_" and must not ` +
        `start with "langfuse"; got "${environment}".`,
    );
  }

  return {
    enabled: true,
    publicKey: envString('LANGFUSE_PUBLIC_KEY') as string,
    secretKey: envString('LANGFUSE_SECRET_KEY') as string,
    baseUrl,
    environment,
    captureIo: envBool('LANGFUSE_CAPTURE_IO'),
  };
}
