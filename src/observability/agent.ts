// Agent-process observability: the one call `src/providers/model.ts` makes.
//
// Disabled (the default): reads one environment variable and returns. Nothing
// else is imported, registered or contacted.
//
// Enabled: installs the Langfuse-backed Flue instrumentation for this `flue run`
// process. A configuration error is fatal — the same fail-fast the host
// applies — but a failure to *start* tracing is not: the agent is the job,
// tracing is not.

import { readObservabilityConfig } from './config.ts';

export interface AgentModelInfo {
  /** QA_MODEL, `provider/model`. */
  model: string;
  /** The resolved window and output budget Flue budgets this model against. */
  limits?: { contextWindow: number; maxOutputTokens: number };
}

let installed = false;

export async function initAgentObservability(info: AgentModelInfo): Promise<void> {
  const config = readObservabilityConfig();
  if (!config.enabled || installed) return;
  installed = true;
  try {
    const { installAgentTracing } = await import('./agent-langfuse.ts');
    installAgentTracing(config, info);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.warn(`[flue] Langfuse tracing could not start; the agent runs without it. (${reason})`);
  }
}
