import { readFileSync } from 'node:fs';
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

// Local Ollama server, exposed through its OpenAI-compatible endpoint.
// Keyless, zero-cost, and fully local — no cloud provider is contacted.
//
// `flue run` loads only the agent module (never `app.ts`), so every agent
// module that needs this provider imports this file for its side effect
// instead of relying on a central `app.ts` registration.

/**
 * The window Flue budgets against. It must not exceed the Ollama server's real
 * `num_ctx` (set by OLLAMA_CONTEXT_LENGTH on the machine running Ollama), or
 * the server silently truncates the prompt — which drops the tail of the system
 * prompt, tool definitions included. `npm run check:ollama` compares the two.
 */
const CONTEXT_WINDOW = Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 8192);
// Phase 1 artifacts fit comfortably in 2048. The Phase 2 repo-analysis is
// several times larger, and Qwen emits its reasoning *before* the tool call in
// the same turn: when the two together exceed the cap, the call is truncated
// and the turn ends with no tool call at all. Overridable so a stage that needs
// a bigger artifact can raise it without changing the default for every agent.
const MAX_OUTPUT_TOKENS = Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS ?? 2048);

/**
 * Under WSL2's default NAT networking, the Windows host is the default gateway,
 * and Ollama running on Windows is NOT reachable at 127.0.0.1 from inside WSL.
 * Read the gateway out of /proc/net/route rather than hardcoding it — the
 * address changes whenever WSL restarts.
 *
 * Not used for the default base URL (see `resolveBaseUrl`); `scripts/check-ollama.mjs`
 * probes it and tells you what to export when NAT networking is in play.
 */
export function wslHostAddress(): string | undefined {
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== '00000000' || !gateway) continue;
      // Gateway is a little-endian hex word: reverse the byte pairs.
      const bytes = gateway.match(/../g);
      if (!bytes || bytes.length !== 4) continue;
      return bytes.reverse().map((b) => parseInt(b, 16)).join('.');
    }
  } catch {
    /* fall through to the loopback default */
  }
  return undefined;
}

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
function resolveBaseUrl(): string {
  const configured = process.env.OLLAMA_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return 'http://127.0.0.1:11434/v1';
}

export const OLLAMA_BASE_URL = resolveBaseUrl();

/**
 * Qwen3 returns a `reasoning` block on every assistant turn, and the transcript
 * replays it on each subsequent request. Measured on a 9-call Product Discovery
 * run at 8192 context: ~4,742 tokens of *historical* reasoning — more than the
 * system prompt and every tool definition combined, and ~4x the actual browser
 * evidence. The request reached 114% of the window and the run failed.
 *
 * Qwen's own multi-turn guidance is not to feed previous thinking back in, so
 * dropping it is how the model is meant to be used, not a trick.
 *
 * This strips reasoning from the *request history* only. It cannot affect the
 * current turn's reasoning, which the model generates fresh in its response and
 * which is never part of the request. Assistant `content`, `tool_calls`,
 * `tool_call_id`, tool results, the system prompt, and tool definitions are all
 * left exactly as Pi serialized them, so tool-call/result pairing is untouched.
 *
 * Set OLLAMA_REPLAY_REASONING=true to restore the old behaviour (useful for
 * A/B measurement).
 */
const REPLAY_REASONING = process.env.OLLAMA_REPLAY_REASONING === 'true';

/** Reasoning-carrying keys the OpenAI-completions serializer may put on an assistant message. */
const REASONING_KEYS = ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking'] as const;

function stripHistoricalReasoning(payload: unknown): unknown | undefined {
  if (REPLAY_REASONING) return undefined; // undefined = leave the payload unchanged
  if (typeof payload !== 'object' || payload === null) return undefined;

  const body = payload as { messages?: unknown };
  if (!Array.isArray(body.messages)) return undefined;

  let changed = false;
  const messages = body.messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message;
    const record = message as Record<string, unknown>;
    // Only assistant turns carry reasoning; never touch tool results or user turns.
    if (record.role !== 'assistant') return message;
    if (!REASONING_KEYS.some((key) => key in record)) return message;

    const next = { ...record };
    for (const key of REASONING_KEYS) delete next[key];
    changed = true;
    return next;
  });

  return changed ? { ...body, messages } : undefined;
}

/**
 * Pi's supported payload hook: `stream()` calls `options.onPayload(params)`
 * immediately before the HTTP request and uses the returned object in place of
 * `params`. Flue owns the options it passes, so we compose them here by
 * wrapping the API object our own provider is built with — no Pi or Flue
 * internals are touched, and nothing in node_modules is patched.
 */
function reasoningTrimmingApi() {
  const base = openAICompletionsApi();

  // Compose rather than replace: if a caller ever supplies its own onPayload,
  // run theirs first and strip afterwards, so neither transform is lost.
  const withHook = <T extends { onPayload?: unknown }>(options: T | undefined) => {
    const caller = (options as { onPayload?: (p: unknown, m: unknown) => unknown } | undefined)?.onPayload;
    const onPayload = async (payload: unknown, model: unknown) => {
      const afterCaller = caller ? await caller(payload, model) : undefined;
      const current = afterCaller === undefined ? payload : afterCaller;
      const stripped = stripHistoricalReasoning(current);
      if (stripped !== undefined) return stripped;
      return afterCaller; // undefined when neither transform changed anything
    };
    return { ...(options ?? {}), onPayload } as T;
  };

  return {
    ...base,
    stream: (model: never, context: never, options?: never) => base.stream(model, context, withHook(options)),
    streamSimple: (model: never, context: never, options?: never) =>
      base.streamSimple(model, context, withHook(options)),
  } as ReturnType<typeof openAICompletionsApi>;
}

setProvider(
  createProvider({
    id: 'ollama',
    // Ollama's OpenAI-compatible endpoint ignores the key's value but the
    // installed openai-completions client still requires a non-empty string.
    auth: {
      apiKey: {
        name: 'Ollama (keyless)',
        resolve: async () => ({ auth: { apiKey: 'ollama-local' } }),
      },
    },
    models: [
      {
        id: 'qwen3:14b',
        name: 'Qwen3 14B (local)',
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: OLLAMA_BASE_URL,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_OUTPUT_TOKENS,
        // Agentic tool use, not prose. At Qwen3's default sampling this model
        // drifts: it narrates a tool call in text, or emits one as a
        // `<tool_call>` block inside its reasoning channel where the
        // OpenAI-compat parser cannot see it. Low temperature and tighter
        // nucleus sampling make it far likelier to emit a real structured call.
        // (Thinking itself cannot be turned off here — Ollama's /v1 shim
        // ignores both `enable_thinking` and `chat_template_kwargs`.)
        samplingParams: { temperature: 0.2, top_p: 0.8 },
      },
    ],
    api: reasoningTrimmingApi(),
  }),
);
