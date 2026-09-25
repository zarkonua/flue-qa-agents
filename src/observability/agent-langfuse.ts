// Langfuse tracing inside one agent process. Loaded only when enabled.
//
// Flue's own OpenTelemetry adapter (`@flue/opentelemetry`) does the projection:
// every prompt becomes an `invoke_agent` span, every model call a `chat` span
// with GenAI token usage, every tool call an `execute_tool` span. This file
// adds only what the adapter cannot know:
//
//   - WHERE the process sits in the QA run. The host passed the stage span's
//     traceparent; spans attach under it, so one run is one trace.
//   - WHAT the call cost the context window. Resolved window and output budget
//     come from the provider registration, prompt tokens from the provider's
//     own usage — context utilisation and pressure follow from those.
//   - WHY a call failed, classified: context overflow, harmony parse error,
//     schema rejection, HTTP error — never conflated with output truncation.
//
// It does that by wrapping the adapter at its two public seams — the `tracer`
// it is given and the `observe` function it returns — so enrichment always
// lands on a span before the adapter ends it. No provider is touched.

import { INVALID_SPAN_CONTEXT, ROOT_CONTEXT, context as otelContext, trace, type Attributes, type Context, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createOpenTelemetryInstrumentation, type OpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';
import { LangfuseOtelSpanAttributes, setLangfuseTraceIdInBaggage } from '@langfuse/core';
import { createObservationAttributes, type LangfuseObservationType } from '@langfuse/tracing';
import type { ObservabilityConfig } from './config.ts';
import { contentPolicy, redactSecrets } from './content-policy.ts';
import type { AgentModelInfo } from './agent.ts';
import { FLUE_OTEL_SCOPE, bounded, createLangfuseProcessor, traceAttributes, traceTags } from './langfuse.ts';
import { readAgentTraceContext, type AgentTraceContext, type RemoteParent } from './propagation.ts';
import { COMPLETION_LOG } from '../lib/discovery-completion.ts';
import { takeDeltaCounts } from '../lib/discovery-delta.ts';
import { classifyError, contextPressure, endToEndTokensPerSecond, pressureLevel, wasTruncated, type ErrorKind } from './signals.ts';

type EnabledConfig = Extract<ObservabilityConfig, { enabled: true }>;

/** Must finish inside `flue run`'s own 5 s shutdown bound, or the flush is cut off. */
const AGENT_SHUTDOWN_TIMEOUT_MS = 3_500;
const STATUS_MESSAGE_MAX = 300;

const TYPE_BY_OPERATION: Record<string, LangfuseObservationType> = {
  chat: 'generation',
  execute_tool: 'tool',
  invoke_agent: 'agent',
};

/** Per-agent-operation roll-up, written onto the `invoke_agent` span when it ends. */
interface OperationStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  truncatedTurns: number;
  failedTurns: number;
  peakPromptTokens?: number;
  peakContextUtilization?: number;
  errorKinds: Set<ErrorKind>;
}

const short = (text: string | undefined) => (text ? redactSecrets(text).split('\n')[0].slice(0, STATUS_MESSAGE_MAX) : undefined);

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const turnKey = (e: { instanceId?: unknown; submissionId?: unknown; turnId?: unknown }) =>
  `t|${str(e.instanceId)}|${str(e.submissionId)}|${str(e.turnId)}`;
const toolKey = (e: { instanceId?: unknown; toolCallId?: unknown }) => `x|${str(e.instanceId)}|${str(e.toolCallId)}`;
const operationKey = (e: { instanceId?: unknown; operationId?: unknown }) => `o|${str(e.instanceId)}|${str(e.operationId)}`;

export interface AgentInstrumentationOptions {
  config: EnabledConfig;
  info: AgentModelInfo;
  parent?: RemoteParent;
  context?: AgentTraceContext;
  /** The tracer spans are really created with. */
  tracer: Tracer;
}

/**
 * The Flue instrumentation for one agent process, with QA context and
 * diagnostics layered on. Pure construction — `installAgentTracing` wires it
 * to a live SDK; tests feed it synthetic Flue events.
 */
export function createAgentInstrumentation(o: AgentInstrumentationOptions): OpenTelemetryInstrumentation {
  const { limits } = o.info;
  const remote = o.parent ? { ...o.parent, isRemote: true } : undefined;
  // The stage span in the host, plus the baggage claim that tells Langfuse
  // this process's first span is NOT the application root — the host's run is.
  const rootContext = remote ? setLangfuseTraceIdInBaggage(trace.setSpanContext(ROOT_CONTEXT, remote), remote.traceId) : undefined;

  const spans = new Map<string, Span>();
  const requests = new Map<string, { maxTokens?: number }>();
  const operations = new Map<string, OperationStats>();
  const toolNames = new Map<string, string>();
  /** Set by `onTool`, cleared once the adapter has written that tool's result. */
  let releaseToolName: string | undefined;

  const qaMetadata: Record<string, unknown> = defined({
    runId: o.context?.runId,
    stage: o.context?.stage,
    attempt: o.context?.attempt,
    resumed: o.context?.resumed,
    model: o.info.model,
    contextWindow: limits?.contextWindow,
    maxOutputTokens: limits?.maxOutputTokens,
  });

  function traceLevel(attributes: Attributes): Attributes {
    if (o.context) {
      return traceAttributes({ name: o.context.traceName, tags: o.context.tags, metadata: o.context.traceMetadata });
    }
    // A standalone `flue run` (qa:agentic, qa:review, a diagnostic): its own trace.
    const agent = typeof attributes['flue.agent.name'] === 'string' ? (attributes['flue.agent.name'] as string) : 'flue-run';
    return traceAttributes({ name: agent, tags: traceTags('flue-run', o.info.model), metadata: { model: o.info.model } });
  }

  const tracer: Tracer = {
    startSpan(name: string, options: SpanOptions = {}, ctx?: Context): Span {
      // Coordinator admission spans are Flue's durable-queue internals. Replaced
      // by a pass-through carrying the host stage's context, so the agent's own
      // span attaches directly under its QA stage instead of under a
      // coordinator root that would start a trace of its own.
      if (name === 'flue.coordinator') return trace.wrapSpanContext(remote ?? INVALID_SPAN_CONTEXT);

      const attributes = options.attributes ?? {};
      let parentContext = ctx ?? otelContext.active();
      const hasParent = trace.getSpanContext(parentContext)?.traceId && trace.getSpanContext(parentContext)?.traceId !== INVALID_SPAN_CONTEXT.traceId;
      if (!hasParent && rootContext) parentContext = rootContext;
      if (remote) parentContext = setLangfuseTraceIdInBaggage(parentContext, remote.traceId);

      const operation = typeof attributes['gen_ai.operation.name'] === 'string' ? (attributes['gen_ai.operation.name'] as string) : undefined;
      const type = operation ? TYPE_BY_OPERATION[operation] : undefined;
      const enriched: Attributes = {
        ...attributes,
        ...traceLevel(attributes),
        ...(type ? { [LangfuseOtelSpanAttributes.OBSERVATION_TYPE]: type } : {}),
        ...Object.fromEntries(
          Object.entries(qaMetadata).map(([k, v]) => [`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.${k}`, String(v)]),
        ),
      };
      const span = o.tracer.startSpan(name, { ...options, root: !trace.getSpanContext(parentContext), attributes: enriched }, parentContext);

      const ids = {
        instanceId: attributes['flue.instance.id'],
        submissionId: attributes['flue.submission.id'],
        turnId: attributes['flue.turn.id'],
        operationId: attributes['flue.operation.id'],
        toolCallId: attributes['gen_ai.tool.call.id'],
      };
      if (operation === 'chat') spans.set(turnKey(ids), span);
      if (operation === 'execute_tool') {
        spans.set(toolKey(ids), span);
        toolNames.set(span.spanContext().spanId, String(attributes['gen_ai.tool.name'] ?? ''));
      }
      if (attributes['flue.operation.kind'] !== undefined && ids.operationId !== undefined) spans.set(operationKey(ids), span);
      return span;
    },
    startActiveSpan: ((...args: unknown[]) => (o.tracer.startActiveSpan as (...a: unknown[]) => unknown)(...args)) as Tracer['startActiveSpan'],
  };

  const inner = createOpenTelemetryInstrumentation({
    tracer,
    content: contentPolicy(o.config.captureIo, (scope) => (scope.spanId ? toolNames.get(scope.spanId) : undefined)),
    resolveRootContext: () => rootContext,
  });

  function statsFor(event: { instanceId?: unknown; operationId?: unknown }): OperationStats | undefined {
    if (event.operationId === undefined) return undefined;
    const key = operationKey(event);
    let stats = operations.get(key);
    if (!stats) {
      stats = { turns: 0, toolCalls: 0, toolErrors: 0, truncatedTurns: 0, failedTurns: 0, errorKinds: new Set() };
      operations.set(key, stats);
    }
    return stats;
  }

  function onTurn(event: any): void {
    const key = turnKey(event);
    const span = spans.get(key);
    const request = requests.get(key);
    spans.delete(key);
    requests.delete(key);
    if (!span) return;

    const usage = event.response?.usage;
    const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
    // Pi reports reasoning tokens for some providers; Flue's event type does
    // not declare them, so they are used only when actually present.
    const reasoningTokens = typeof usage?.reasoning === 'number' ? usage.reasoning : undefined;
    // What was actually requested wins over the catalog value.
    const maxOutputTokens = request?.maxTokens ?? event.request?.maxTokens ?? limits?.maxOutputTokens;
    const pressure = limits && maxOutputTokens !== undefined ? contextPressure(limits.contextWindow, maxOutputTokens, promptTokens) : undefined;
    const finishReason: string | undefined = event.response?.finishReason;
    const truncated = wasTruncated(finishReason);
    const errorMessage: string | undefined = event.isError ? (event.response?.error?.message ?? event.response?.error?.type) : undefined;
    const errorKind = event.isError ? classifyError(errorMessage) : undefined;

    const stats = statsFor(event);
    if (stats) {
      stats.turns += 1;
      if (truncated) stats.truncatedTurns += 1;
      if (event.isError) stats.failedTurns += 1;
      if (errorKind) stats.errorKinds.add(errorKind);
      if (promptTokens !== undefined) stats.peakPromptTokens = Math.max(stats.peakPromptTokens ?? 0, promptTokens);
      if (pressure?.contextUtilization !== undefined) {
        stats.peakContextUtilization = Math.max(stats.peakContextUtilization ?? 0, pressure.contextUtilization);
      }
    }

    const cost = usage?.cost;
    span.setAttributes(
      createObservationAttributes('generation', {
        model: event.response?.responseModel ?? event.request?.requestedModel,
        usageDetails: usage
          ? (defined({
              input: promptTokens,
              output: usage.output,
              total: usage.totalTokens,
              input_cached_tokens: usage.cacheRead || undefined,
              output_reasoning_tokens: reasoningTokens,
            }) as Record<string, number>)
          : undefined,
        // Pi's catalog-rate estimate. Zero for local models, so only sent when real.
        costDetails:
          cost && cost.total > 0
            ? (defined({ input: cost.input, output: cost.output, input_cached_tokens: cost.cacheRead || undefined, total: cost.total }) as Record<string, number>)
            : undefined,
        level: event.isError ? 'ERROR' : truncated || pressure?.contextPressureLevel === 'critical' ? 'WARNING' : undefined,
        statusMessage: event.isError ? short(errorMessage) : truncated ? 'output stopped at the max output token limit' : undefined,
        metadata: defined({
          provider: event.request?.providerName,
          providerId: event.request?.providerId,
          requestedModel: event.request?.requestedModel,
          responseModel: event.response?.responseModel,
          ...pressure,
          outputTokens: usage?.output,
          reasoningTokens,
          cacheReadTokens: usage?.cacheRead,
          finishReason,
          providerFinishReason: event.response?.providerFinishReason,
          wasTruncated: truncated,
          durationMs: event.durationMs,
          outputTokensPerSecondEndToEnd: endToEndTokensPerSecond(usage?.output, event.durationMs),
          errorKind,
          errorType: event.response?.error?.type,
          hadParseError: errorKind === 'harmony_parse_error' ? true : undefined,
          contextOverflow: errorKind === 'context_overflow' ? true : undefined,
          costSource: cost && cost.total > 0 ? 'pi-model-catalog' : undefined,
        }),
      }),
    );
  }

  function onTool(event: any): void {
    const key = toolKey(event);
    const span = spans.get(key);
    spans.delete(key);
    const stats = statsFor(event);
    if (stats) {
      stats.toolCalls += 1;
      if (event.isError) stats.toolErrors += 1;
    }
    if (!span) return;
    releaseToolName = span.spanContext().spanId;

    let resultBytes: number | undefined;
    try {
      const serialized = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
      resultBytes = serialized === undefined ? undefined : Buffer.byteLength(serialized);
    } catch {
      /* unserialisable result: leave the size out */
    }
    const message: string | undefined = event.isError
      ? (event.errorInfo?.message ?? (typeof event.result === 'string' ? event.result : undefined))
      : undefined;
    const errorKind = event.isError ? classifyError(message) : undefined;
    if (errorKind && stats) stats.errorKinds.add(errorKind);
    // The host's delta for this snapshot, if it produced one: counts only.
    const delta = takeDeltaCounts(event.toolCallId);

    span.setAttributes(
      createObservationAttributes('tool', {
        level: event.isError ? 'ERROR' : undefined,
        statusMessage: event.isError ? short(message) : undefined,
        metadata: defined({
          toolName: event.toolName,
          durationMs: event.durationMs,
          success: !event.isError,
          resultBytes,
          resultItems: Array.isArray(event.result) ? event.result.length : undefined,
          errorKind,
          errorType: event.errorInfo?.type,
          hadSchemaError: errorKind === 'schema_validation_error' ? true : undefined,
          hadSemanticError: errorKind === 'semantic_validation_error' ? true : undefined,
          ...(delta ?? {}),
        }),
      }),
    );
  }

  function onOperation(event: any): void {
    const key = operationKey(event);
    const span = spans.get(key);
    spans.delete(key);
    const stats = operations.get(key);
    operations.delete(key);
    if (!span) return;
    const errorText = event.isError ? (event.error instanceof Error ? event.error.message : typeof event.error === 'string' ? event.error : event.errorInfo?.message) : undefined;
    const errorKind = event.isError ? classifyError(errorText) : undefined;
    const kinds = new Set(stats?.errorKinds ?? []);
    if (errorKind) kinds.add(errorKind);
    const degraded = (stats?.truncatedTurns ?? 0) > 0 || (stats?.failedTurns ?? 0) > 0 || (stats?.toolErrors ?? 0) > 0;
    span.setAttributes(
      createObservationAttributes('agent', {
        level: event.isError ? 'ERROR' : degraded ? 'WARNING' : undefined,
        statusMessage: event.isError ? short(errorText) : undefined,
        metadata: defined({
          durationMs: event.durationMs,
          turns: stats?.turns ?? 0,
          toolCalls: stats?.toolCalls ?? 0,
          toolErrors: stats?.toolErrors ?? 0,
          failedTurns: stats?.failedTurns ?? 0,
          truncatedTurns: stats?.truncatedTurns ?? 0,
          peakPromptTokens: stats?.peakPromptTokens,
          peakContextUtilization: stats?.peakContextUtilization,
          peakContextPressureLevel: stats?.peakContextUtilization !== undefined ? pressureLevel(stats.peakContextUtilization) : undefined,
          promptBudget: limits ? limits.contextWindow - limits.maxOutputTokens : undefined,
          errorKinds: kinds.size > 0 ? [...kinds].sort().join(',') : undefined,
        }),
      }),
    );
  }

  /**
   * A Discovery Completion Gate verdict, logged by `write_qa_artifact`: an
   * event observation under that tool call, carrying the reason codes. The
   * attributes are already flat and content-free (codes and counts).
   */
  function onLog(event: any): void {
    if (event.message !== COMPLETION_LOG) return;
    const attributes = event.attributes ?? {};
    const tool = spans.get(toolKey({ instanceId: event.instanceId, toolCallId: attributes.toolCallId }));
    const parent = tool ?? (event.operationId !== undefined ? spans.get(operationKey(event)) : undefined);
    const passed = attributes.canFinalize === true;
    o.tracer
      .startSpan(
        'evaluate-discovery-completion',
        {
          attributes: {
            ...traceLevel(attributes),
            ...createObservationAttributes('event', {
              level: passed ? 'DEFAULT' : 'WARNING',
              statusMessage: passed ? undefined : `finalization rejected: ${String(attributes.reasonCodes ?? '')}`,
              output: { canFinalize: passed, reasonCodes: attributes.reasonCodes, reasonCount: attributes.reasonCount },
              metadata: defined({ ...qaMetadata, ...Object.fromEntries(Object.entries(attributes).filter(([k]) => k !== 'tool' && k !== 'toolCallId')) }),
            }),
          },
        },
        parent ? trace.setSpan(ROOT_CONTEXT, parent) : (rootContext ?? ROOT_CONTEXT),
      )
      .end();
  }

  function enrich(event: any): void {
    switch (event.type) {
      case 'log':
        return onLog(event);
      case 'turn_request':
        requests.set(turnKey(event), { maxTokens: event.request?.maxTokens });
        return;
      case 'turn':
        return onTurn(event);
      case 'tool':
        return onTool(event);
      case 'operation':
        return onOperation(event);
    }
  }

  return {
    ...inner,
    observe(event, ctx) {
      try {
        enrich(event);
      } catch {
        // Enrichment is best-effort; the adapter's own projection still runs.
      }
      inner.observe(event, ctx);
      // The content policy needs the tool's name while the adapter writes the
      // result, so the lookup is released only once that has happened.
      if (releaseToolName) toolNames.delete(releaseToolName);
      releaseToolName = undefined;
    },
  };
}

/** Wire the instrumentation to a live OpenTelemetry SDK for this process. */
export function installAgentTracing(config: EnabledConfig, info: AgentModelInfo): void {
  const { parent, context } = readAgentTraceContext();
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'flue-qa-agents' }),
    // No host/process detectors: they would ship the command line — which
    // carries the agent's brief — and the environment's shape with every span.
    autoDetectResources: false,
    spanProcessors: [createLangfuseProcessor(config)],
  });
  sdk.start();

  const instrumentation = createAgentInstrumentation({ config, info, parent, context, tracer: trace.getTracer(FLUE_OTEL_SCOPE) });
  // `flue run` awaits dispose() on close, inside its own bounded shutdown —
  // the one moment the process is guaranteed to still be alive to flush.
  instrument({
    ...instrumentation,
    async dispose() {
      instrumentation.dispose();
      await bounded(() => sdk.shutdown(), AGENT_SHUTDOWN_TIMEOUT_MS);
    },
  });
}
