// The one place that decides which model every agent runs on.
//
// Agents import QA_MODEL from here and pass it to useModel(). Importing this
// module also registers the matching provider with Flue as a side effect, so an
// agent never needs to know whether it is talking to a local Ollama or to
// OpenRouter:
//
//                          QA_MODEL
//                             |
//                  +----------+----------+
//                  |                     |
//              ollama/*             openrouter/*
//                  |                     |
//        ollama.ts: local Qwen     openrouter.ts: Pi's own
//        tuning + reasoning        provider, normal behaviour
//        replay filter
//
// Default with no .env and no QA_MODEL: ollama/qwen3:14b — unchanged.

import { modelId, modelProvider, QA_MODEL } from '../config/env.ts';

export { QA_MODEL };

const provider = modelProvider(QA_MODEL);

/** The resolved window and output budget of QA_MODEL, when the provider declares them. */
let limits: { contextWindow: number; maxOutputTokens: number } | undefined;

switch (provider) {
  case 'ollama': {
    // Registers the Ollama provider, its reasoning-replay filter and its
    // low-variance sampling. Import for the side effect, as before.
    const { ollamaModelLimits } = await import('./ollama.ts');
    limits = ollamaModelLimits(modelId(QA_MODEL));
    break;
  }

  case 'openrouter': {
    const { openRouterModelLimits, registerOpenRouter } = await import('./openrouter.ts');
    registerOpenRouter();
    limits = openRouterModelLimits(modelId(QA_MODEL));
    break;
  }

  default:
    throw new Error(
      `QA_MODEL must be "<provider>/<model>" with provider "ollama" or "openrouter"; got "${QA_MODEL}".\n` +
        'Examples: ollama/qwen3:14b · openrouter/deepseek/deepseek-v4-flash-0731',
    );
}

/** The provider portion of QA_MODEL, for diagnostics that want to report it. */
export const QA_MODEL_PROVIDER = provider;

/** The model id within its provider, for diagnostics. */
export const QA_MODEL_ID = modelId(QA_MODEL);

/** Context window and output budget Flue budgets QA_MODEL against, if known. */
export const QA_MODEL_LIMITS = limits;

// Every agent module imports this file, and `flue run` loads nothing else, so
// this is the one place an agent process can install tracing. A no-op unless
// LANGFUSE_ENABLED=true: nothing Langfuse- or OpenTelemetry-related is even
// loaded otherwise. See docs/observability.md.
const { initAgentObservability } = await import('../observability/agent.ts');
await initAgentObservability({ model: QA_MODEL, limits });
