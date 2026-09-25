// Run-level observability for the host orchestrators (qa:manual, qa:automation).
//
//   qa-manual                 chain  — one QA run, one trace
//   ├── discovery             chain  — one per stage, named by its stage key
//   │   ├── invoke_agent …    agent  — one per attempt, from the agent process
//   │   │   ├── chat <model>  generation
//   │   │   └── execute_tool  tool
//   │   └── validate-artifact event  — the host's verdict on that attempt
//   └── analysis …
//
// The orchestrators talk only to the `RunObservability` interface below. When
// LANGFUSE_ENABLED is not "true" they get `NOOP_RUN`, which does nothing at all
// — the Langfuse implementation, and every OpenTelemetry package behind it, is
// never even imported.

import { readObservabilityConfig, type ObservabilityConfig } from './config.ts';
import { childTraceEnv } from './propagation.ts';

export interface RunInfo {
  /** Trace name, and the command the run came from: `qa-manual`, `qa-automation`. */
  command: string;
  runId: string;
  model: string;
  /** Anything else worth filtering or reading on the trace root. Scalars only. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
  /** The trace input a reviewer sees first. */
  input?: Record<string, unknown>;
}

export interface StageInfo {
  key: string;
  label: string;
  agent: string;
  artifact: string;
}

/** One entry of `runStage`'s attempt log, as the host recorded it. */
export interface AttemptRecord {
  attempt: number;
  resumed: boolean;
  conversationId?: string;
  agentExitCode?: number;
  durationMs?: number;
  toolCallsTotal?: number;
  toolCallsByTool?: Record<string, number>;
  passed: boolean;
  problem?: string | null;
}

type Lazy<T> = () => T;

export interface StageTrace {
  /** Env for the agent process of one attempt: its parent span and run context. */
  childEnv(attempt: { attempt: number; resumed: boolean }): Record<string, string>;
  recordAttempt(attempt: AttemptRecord): void;
  /** `metrics` is only evaluated when tracing is on. */
  end(result: { passed: boolean; metrics?: Lazy<Record<string, unknown>> }): Promise<void>;
}

export interface RunObservability {
  readonly enabled: boolean;
  startRun(info: RunInfo): void;
  startStage(stage: StageInfo): StageTrace;
  /** End the trace and flush it. Bounded; never throws. */
  endRun(result: { outcome: 'COMPLETE' | 'FAILED'; failedStage?: string; output?: Lazy<Record<string, unknown>> }): Promise<void>;
}

const NOOP_STAGE: StageTrace = {
  // Blank values, so an agent never inherits a trace context from the shell.
  childEnv: () => childTraceEnv(undefined, undefined),
  recordAttempt: () => {},
  end: async () => {},
};

export const NOOP_RUN: RunObservability = {
  enabled: false,
  startRun: () => {},
  startStage: () => NOOP_STAGE,
  endRun: async () => {},
};

export interface CreateOptions {
  config?: ObservabilityConfig;
  /** Tests: capture spans instead of sending them. */
  exporter?: import('@opentelemetry/sdk-trace-base').SpanExporter;
  warn?: (message: string) => void;
  /** Tests: stand-in for the Ollama `/api/ps` probe. */
  fetchImpl?: typeof fetch;
  /** Upper bound on the end-of-run flush. Default 5 s. */
  shutdownTimeoutMs?: number;
}

/**
 * The observability for one QA run. Throws `ObservabilityConfigError` when
 * Langfuse is enabled but misconfigured — call it before any stage starts.
 */
export async function createRunObservability(options: CreateOptions = {}): Promise<RunObservability> {
  const config = options.config ?? readObservabilityConfig();
  if (!config.enabled) return NOOP_RUN;
  const { LangfuseRunObservability } = await import('./host-langfuse.ts');
  return new LangfuseRunObservability(config, options);
}
