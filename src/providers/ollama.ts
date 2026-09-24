import { readFileSync } from 'node:fs';
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { envBool, envInt, envString } from '../config/env.ts';
import { describeRequest, isParserFailure, recordHarmonyFailure } from '../lib/harmony-diagnostic.ts';

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
const CONTEXT_WINDOW = envInt('OLLAMA_CONTEXT_WINDOW', 8192);
/**
 * Whether the operator set these explicitly.
 *
 * Both variables have a per-model default — 8192/2048 for Qwen, and the real
 * `num_ctx` of each gpt-oss build. Without this distinction the same variable
 * meant two different things: it set Qwen's window outright, while for gpt-oss
 * it was ignored (context) or acted only as a floor (output). Setting
 * OLLAMA_MAX_OUTPUT_TOKENS=4096 to constrain gpt-oss silently did nothing.
 * Explicit now always wins, for every model.
 */
const CONTEXT_WINDOW_IS_EXPLICIT = envString('OLLAMA_CONTEXT_WINDOW') !== undefined;
const MAX_OUTPUT_IS_EXPLICIT = envString('OLLAMA_MAX_OUTPUT_TOKENS') !== undefined;
// Phase 1 artifacts fit comfortably in 2048. The Phase 2 repo-analysis is
// several times larger, and Qwen emits its reasoning *before* the tool call in
// the same turn: when the two together exceed the cap, the call is truncated
// and the turn ends with no tool call at all. Overridable so a stage that needs
// a bigger artifact can raise it without changing the default for every agent.
const MAX_OUTPUT_TOKENS = envInt('OLLAMA_MAX_OUTPUT_TOKENS', 2048);

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
  const configured = envString('OLLAMA_BASE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  return 'http://127.0.0.1:11434/v1';
}

export const OLLAMA_BASE_URL = resolveBaseUrl();

/**
 * Locally built gpt-oss-20b variants, whose tag encodes the context window the
 * Modelfile was built with (`-49k` -> 49152). Declaring them here is what makes
 * `QA_MODEL=ollama/gpt-oss-20b-q5-49k` resolve at all: Pi only knows the models
 * a provider lists, so an id that is pulled in Ollama but absent from this array
 * fails the run at startup with "unknown model".
 *
 * The context comes from the tag rather than OLLAMA_CONTEXT_WINDOW because that
 * single env var cannot describe five variants at once, and budgeting a 49k
 * model against 8192 would waste six sevenths of its window.
 *
 * The numbers are the Modelfiles' real `num_ctx`, read from `/api/show`, NOT
 * derived from the tag. The tag is approximate: `-49k` is built at 49152, which
 * is 48 * 1024, so computing `49 * 1024` gives 50176 and overshoots the real
 * window by 1024 tokens. Flue would then budget against a window the server
 * does not have, and the server silently truncates the prompt — dropping the
 * tail of the system prompt, tool definitions included. `npm run check:ollama`
 * is the way to confirm these against a running server.
 *
 * Unlike Qwen, this family emits a clean structured tool call at its default
 * sampling — verified against the running server — so no sampling override is
 * imposed. It does reason before answering, in a channel of its own, which is
 * why `reasoning` is true and why the output budget is generous: the reasoning
 * and the tool call share one turn, and a truncated turn yields no call at all.
 */
const GPT_OSS_CONTEXTS: Record<string, number> = {
  'gpt-oss-20b-q5-49k': 49_152,
  'gpt-oss-20b-q5-32k': 32_768,
  'gpt-oss-20b-q5-24k': 24_576,
  'gpt-oss-20b-q5-16k': 16_384,
  'gpt-oss-20b-q5': 8_192,
};

const GPT_OSS_MODELS = Object.entries(GPT_OSS_CONTEXTS).map(([tag, measuredContext]) => {
  // An explicitly configured window overrides the measured one, so the operator
  // can budget below the server's num_ctx deliberately. It must never exceed it:
  // Ollama truncates silently, dropping the tail of the system prompt.
  const contextWindow = CONTEXT_WINDOW_IS_EXPLICIT ? CONTEXT_WINDOW : measuredContext;
  return {
    id: tag,
    name: `GPT-OSS 20B (local, ${Math.round(contextWindow / 1024)}k)`,
    api: 'openai-completions' as const,
    provider: 'ollama',
    baseUrl: OLLAMA_BASE_URL,
    reasoning: true,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // Default: a quarter of the window — enough for the reasoning plus a large
    // artifact in the same turn, without crowding out the prompt. An explicit
    // OLLAMA_MAX_OUTPUT_TOKENS wins outright, including a smaller value.
    maxTokens: MAX_OUTPUT_IS_EXPLICIT ? MAX_OUTPUT_TOKENS : Math.floor(contextWindow / 4),
  };
});

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
const REPLAY_REASONING = envBool('OLLAMA_REPLAY_REASONING');

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

  // The payload we last handed to the server, so a failure can be described
  // without the caller having to thread it through. Structural only — see
  // `harmony-diagnostic.ts` for why nothing here is a payload dump.
  let lastRequest: Record<string, unknown> | undefined;

  const withCapture = <T extends { onPayload?: unknown }>(options: T | undefined) => {
    const hooked = withHook(options) as T & { onPayload: (p: unknown, m: unknown) => unknown };
    const inner = hooked.onPayload;
    return {
      ...hooked,
      onPayload: async (payload: unknown, model: unknown) => {
        const result = await inner(payload, model);
        // Describe what actually goes on the wire: the transformed payload when
        // a hook changed it, the original when none did.
        lastRequest = describeRequest(result === undefined ? payload : result);
        return result;
      },
    } as T;
  };

  /**
   * Record a provider parse failure and rethrow it unchanged.
   *
   * The run stays failed on purpose. Turning malformed output into a tool call
   * — by regex or otherwise — would hide the interaction we are trying to
   * understand, and would put invented content into an evidence-graded
   * artifact.
   */
  const capturing = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isParserFailure(message)) {
        const status = Number(/\b(\d{3})\b/.exec(message)?.[1]);
        const where = recordHarmonyFailure({
          error: { status: Number.isFinite(status) ? status : undefined, message },
          request: lastRequest ?? { note: 'no payload was captured before the failure' },
          replayReasoning: REPLAY_REASONING,
        });
        if (where) console.error(`[ollama] provider parse failure recorded: ${where}`);
      }
      throw error;
    }
  };

  return {
    ...base,
    stream: (model: never, context: never, options?: never) =>
      capturing(() => base.stream(model, context, withCapture(options))),
    streamSimple: (model: never, context: never, options?: never) =>
      capturing(() => base.streamSimple(model, context, withCapture(options))),
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
      ...GPT_OSS_MODELS,
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
