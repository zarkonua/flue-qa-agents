// The Langfuse implementation of `RunObservability`. Loaded only when enabled.
//
// Deliberately uses its own TracerProvider and never registers anything
// globally: every run owns a fresh provider, a fresh root span and its own
// open-stage table, so no span, context or metadata can carry from one run to
// the next — even two instances in one process stay apart.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { LANGFUSE_SDK_VERSION } from '@langfuse/core';
import { createObservationAttributes, type LangfuseObservationType } from '@langfuse/tracing';
import { PROJECT_ROOT, modelId, modelProvider } from '../config/env.ts';
import { resolveOllamaBaseUrl } from '../providers/ollama-settings.ts';
import type { ObservabilityConfig } from './config.ts';
import { redactSecrets } from './content-policy.ts';
import type { AttemptRecord, CreateOptions, RunInfo, RunObservability, StageInfo, StageTrace } from './host.ts';
import { bounded, createLangfuseProcessor, traceAttributes, traceTags } from './langfuse.ts';
import { ollamaRunningModel } from './ollama-probe.ts';
import { childTraceEnv, type AgentTraceContext } from './propagation.ts';
import { attemptProblemFlags } from './signals.ts';

type EnabledConfig = Extract<ObservabilityConfig, { enabled: true }>;

/** Upper bound on the flush at the end of a run. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function flueVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'node_modules/@flue/runtime/package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** Drop undefined/null, stringify the rest: trace metadata filters on strings. */
function stringMetadata(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

function observation(type: LangfuseObservationType, attributes: Parameters<typeof createObservationAttributes>[1]) {
  return createObservationAttributes(type, attributes);
}

export class LangfuseRunObservability implements RunObservability {
  readonly enabled = true;
  private readonly provider: BasicTracerProvider;
  private readonly tracer;
  private root?: Span;
  private context?: Omit<AgentTraceContext, 'stage' | 'attempt' | 'resumed'>;
  private trace?: ReturnType<typeof traceAttributes>;
  private readonly openStages = new Set<Span>();
  private model = '';
  private ended = false;
  private readonly config: EnabledConfig;
  private readonly options: CreateOptions;

  constructor(config: EnabledConfig, options: CreateOptions) {
    this.config = config;
    this.options = options;
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'flue-qa-agents' }),
      spanProcessors: [createLangfuseProcessor(config, { exporter: options.exporter, warn: options.warn })],
    });
    // The Langfuse SDK's own scope, so Langfuse's default filter exports these.
    this.tracer = this.provider.getTracer('langfuse-sdk', LANGFUSE_SDK_VERSION);
  }

  startRun(info: RunInfo): void {
    if (this.root) return;
    this.model = info.model;
    const metadata = stringMetadata({
      runId: info.runId,
      command: info.command,
      model: info.model,
      provider: modelProvider(info.model),
      modelId: modelId(info.model),
      flueVersion: flueVersion(),
      captureIo: this.config.captureIo,
      ...info.metadata,
    });
    const tags = traceTags(info.command, info.model);
    this.context = { runId: info.runId, traceName: info.command, tags, traceMetadata: metadata };
    this.trace = traceAttributes({ name: info.command, tags, metadata });
    this.root = this.tracer.startSpan(
      info.command,
      {
        root: true,
        attributes: {
          ...observation('chain', { input: info.input ? JSON.parse(redactSecrets(JSON.stringify(info.input))) : undefined, metadata }),
          ...this.trace,
        },
      },
      ROOT_CONTEXT,
    );
  }

  startStage(stage: StageInfo): StageTrace {
    if (!this.root || !this.context || this.ended) {
      return { childEnv: () => childTraceEnv(undefined, undefined), recordAttempt: () => {}, end: async () => {} };
    }
    const parentContext = trace.setSpan(ROOT_CONTEXT, this.root);
    const span = this.tracer.startSpan(
      stage.key,
      {
        attributes: {
          ...observation('chain', {
            input: { stage: stage.key, label: stage.label, agent: stage.agent, artifact: stage.artifact },
            metadata: { stage: stage.key, agent: stage.agent, artifact: stage.artifact },
          }),
          ...this.trace,
        },
      },
      parentContext,
    );
    this.openStages.add(span);
    const stageContext = trace.setSpan(ROOT_CONTEXT, span);
    const attempts: AttemptRecord[] = [];
    const base = this.context;

    return {
      childEnv: ({ attempt, resumed }) =>
        childTraceEnv(span.spanContext(), { ...base, stage: stage.key, attempt, resumed }),

      recordAttempt: (a) => {
        attempts.push(a);
        const flags = attemptProblemFlags(a.problem);
        // An event per attempt: the host's verdict, next to the agent run it judges.
        this.tracer
          .startSpan(
            'validate-artifact',
            {
              attributes: {
                ...observation('event', {
                  level: a.passed ? 'DEFAULT' : 'WARNING',
                  statusMessage: a.passed ? undefined : (a.problem ?? undefined),
                  output: { passed: a.passed, problem: a.problem ?? null },
                  metadata: {
                    stage: stage.key,
                    artifact: stage.artifact,
                    attempt: a.attempt,
                    resumed: a.resumed,
                    agentExitCode: a.agentExitCode,
                    durationMs: a.durationMs,
                    toolCallsTotal: a.toolCallsTotal,
                    toolCallsByTool: a.toolCallsByTool,
                    ...flags,
                  },
                }),
                ...this.trace,
              },
            },
            stageContext,
          )
          .end();
      },

      end: async ({ passed, metrics }) => {
        if (!this.openStages.has(span)) return;
        let qa: Record<string, unknown> = {};
        try {
          qa = metrics?.() ?? {};
        } catch {
          /* a metrics bug must never break a run */
        }
        const retryCount = Math.max(0, attempts.length - 1);
        const problems = attempts.map((a) => attemptProblemFlags(a.problem));
        const ollama = await this.ollamaInfo();
        span.setAttributes(
          observation('chain', {
            output: { passed, attempts: attempts.length, ...qa },
            level: passed ? (retryCount > 0 ? 'WARNING' : 'DEFAULT') : 'ERROR',
            statusMessage: passed ? undefined : (attempts.at(-1)?.problem ?? 'stage failed'),
            metadata: {
              passed,
              attempts: attempts.length,
              retryCount,
              wasRetried: retryCount > 0,
              hadParseError: problems.some((p) => p.hadParseError),
              hadSchemaError: problems.some((p) => p.hadSchemaError),
              hadSemanticError: problems.some((p) => p.hadSemanticError),
              notWrittenAttempts: problems.filter((p) => p.notWritten).length,
              durationMs: attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
              toolCallsTotal: attempts.reduce((sum, a) => sum + (a.toolCallsTotal ?? 0), 0),
              ...Object.fromEntries(Object.entries(qa).map(([k, v]) => [`qa.${k}`, v])),
              ...ollama,
            },
          }),
        );
        if (!passed) span.setStatus({ code: SpanStatusCode.ERROR, message: 'stage failed' });
        span.end();
        this.openStages.delete(span);
      },
    };
  }

  /** Running-model facts from Ollama, while the model is still loaded. */
  private async ollamaInfo(): Promise<Record<string, unknown>> {
    if (modelProvider(this.model) !== 'ollama') return {};
    const info = await ollamaRunningModel(resolveOllamaBaseUrl(), modelId(this.model), this.options.fetchImpl);
    return info ? Object.fromEntries(Object.entries(info).map(([k, v]) => [`ollama.${k}`, v])) : {};
  }

  async endRun({ outcome, failedStage, output }: Parameters<RunObservability['endRun']>[0]): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      for (const span of this.openStages) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'run ended before the stage did' });
        span.end();
      }
      this.openStages.clear();
      if (this.root) {
        let result: Record<string, unknown> = {};
        try {
          result = output?.() ?? {};
        } catch {
          /* see StageTrace.end */
        }
        this.root.setAttributes(
          observation('chain', {
            output: { outcome, ...(failedStage ? { failedStage } : {}), ...result },
            level: outcome === 'COMPLETE' ? 'DEFAULT' : 'ERROR',
            statusMessage: outcome === 'COMPLETE' ? undefined : `failed at ${failedStage ?? 'unknown stage'}`,
            metadata: { outcome, ...(failedStage ? { failedStage } : {}), ...result },
          }),
        );
        if (outcome !== 'COMPLETE') this.root.setStatus({ code: SpanStatusCode.ERROR });
        this.root.end();
      }
    } finally {
      await bounded(() => this.provider.shutdown(), this.options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    }
  }
}
