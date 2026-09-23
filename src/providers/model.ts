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

switch (provider) {
  case 'ollama':
    // Registers the Ollama provider, its reasoning-replay filter and its
    // low-variance sampling. Import for the side effect, as before.
    await import('./ollama.ts');
    break;

  case 'openrouter': {
    const { registerOpenRouter } = await import('./openrouter.ts');
    registerOpenRouter();
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
