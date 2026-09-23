// OpenRouter provider, used only when QA_MODEL is `openrouter/...`.
//
// Pi 0.83 already ships an OpenRouter provider: the right base URL, the
// OpenAI-completions API, and API-key auth from OPENROUTER_API_KEY. We use it
// as-is rather than writing our own — this file adds exactly one thing.
//
// Deliberately NOT shared with the Ollama provider: the reasoning-replay
// filter, the 8192-token context and the low-variance sampling in
// `ollama.ts` exist for local Qwen through Ollama's /v1 shim. OpenRouter gets
// Pi's normal behaviour.

import { setProvider } from '@flue/runtime';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { envString } from '../config/env.ts';

/**
 * Dated snapshots OpenRouter serves that Pi 0.83's generated catalog does not
 * list yet. Verified against https://openrouter.ai/api/v1/models — the undated
 * `deepseek/deepseek-v4-flash` IS in the catalog, this snapshot is not, and the
 * two differ (1,310,720 vs 1,048,576 context).
 *
 * Shape copied from the catalog's own `deepseek/deepseek-v4-flash` entry so it
 * behaves identically, with the snapshot's real limits and pricing.
 *
 * DELETE THIS whole block once the dependency's catalog includes these ids —
 * nothing else in the codebase depends on it.
 */
const MISSING_FROM_PI_CATALOG = [
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek: DeepSeek V4 Flash 0731',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    provider: 'openrouter',
    reasoning: true,
    input: ['text'],
    // USD per million tokens, matching the catalog's units.
    cost: { input: 0.04, output: 0.64, cacheRead: 0.016, cacheWrite: 0 },
    contextWindow: 1_310_720,
    maxTokens: 943_718,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: 'openrouter',
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
] as const;

/** True when the id is one we had to declare locally. */
export function isLocallyRegistered(modelId: string): boolean {
  return MISSING_FROM_PI_CATALOG.some((m) => m.id === modelId);
}

/** True when Pi's own catalog already knows this OpenRouter model id. */
export function isInPiCatalog(modelId: string): boolean {
  return Object.hasOwn(OPENROUTER_MODELS, modelId);
}

/**
 * Register OpenRouter with Flue. Throws a clear error when the key is missing,
 * before any agent starts — the failure is a configuration mistake, not
 * something a model can recover from.
 *
 * The key is read here, host-side, and handed to Pi. It is never logged, never
 * put in an artifact, and never reaches an agent prompt or tool.
 */
export function registerOpenRouter(): void {
  if (envString('OPENROUTER_API_KEY') === undefined) {
    throw new Error(
      'QA_MODEL selects OpenRouter but OPENROUTER_API_KEY is not configured.\n' +
        'Add it to .env or the process environment.',
    );
  }

  // Pi's createProvider() hides the catalog behind getModels() rather than a
  // plain array, so extend that one function and leave everything else — base
  // URL, auth, the OpenAI-completions API — exactly as Pi ships it.
  const base = openrouterProvider();
  const baseGetModels = base.getModels.bind(base);
  setProvider({
    ...base,
    getModels: () => {
      const models = baseGetModels();
      const known = new Set(models.map((m: { id: string }) => m.id));
      return [...models, ...MISSING_FROM_PI_CATALOG.filter((m) => !known.has(m.id))];
    },
  } as typeof base);
}
