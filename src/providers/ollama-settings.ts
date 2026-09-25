// Ollama settings that are pure functions of the environment.
//
// Kept apart from `ollama.ts` because that module registers a provider with
// Flue as a side effect of being imported. The host orchestrator and the tests
// need these values without registering anything.

import { envString } from '../config/env.ts';

/**
 * Explicit configuration always wins; otherwise plain loopback. Loopback is
 * correct for a native Ollama and for WSL in mirrored networking mode (see
 * .wslconfig), which is how this project reaches Ollama on the Windows host
 * without binding it to 0.0.0.0.
 *
 * Under WSL NAT networking, loopback will NOT reach a Windows-hosted Ollama:
 * run `npm run check:ollama`, which prints the OLLAMA_BASE_URL to export. The
 * default deliberately never dials the gateway on its own — on a mirrored or
 * native setup that address is the real LAN router.
 */
export function resolveOllamaBaseUrl(): string {
  const configured = envString('OLLAMA_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  return 'http://127.0.0.1:11434/v1';
}

/**
 * The output budget of a gpt-oss build.
 *
 * Default: a quarter of the window — enough for the reasoning plus a large
 * artifact in the same turn, without crowding out the prompt. An explicit
 * OLLAMA_MAX_OUTPUT_TOKENS wins outright, including a smaller value.
 */
export function gptOssMaxOutputTokens(contextWindow: number, explicitMaxOutput: number | undefined): number {
  return explicitMaxOutput !== undefined ? explicitMaxOutput : Math.floor(contextWindow / 4);
}
