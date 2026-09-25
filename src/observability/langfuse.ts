// The Langfuse backend: span processor, exporter and lifecycle helpers.
//
// Only ever loaded through a dynamic import once LANGFUSE_ENABLED=true has been
// validated, so a disabled run never even parses the OpenTelemetry SDK.
//
// Langfuse is observability, not a dependency of the QA run. Two rules follow:
//
//   - an export failure (server down, timeout, 401) is reported ONCE as a
//     short warning and otherwise swallowed; it never reaches a stage;
//   - every flush and shutdown is bounded, so an unreachable server can delay
//     exit by a few seconds at most, never hang it.

import { LANGFUSE_SDK_VERSION, LangfuseOtelSpanAttributes } from '@langfuse/core';
import { LangfuseSpanProcessor, isDefaultExportSpan } from '@langfuse/otel';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Attributes } from '@opentelemetry/api';
import type { ObservabilityConfig } from './config.ts';
import { redactSecrets } from './content-policy.ts';

type EnabledConfig = Extract<ObservabilityConfig, { enabled: true }>;

export const EXPORT_FAILED_WARNING = '[flue] Langfuse trace export failed; QA run continues without remote telemetry.';

/** The instrumentation scope `@flue/opentelemetry` emits agent, tool and task spans under. */
export const FLUE_OTEL_SCOPE = '@flue/opentelemetry';

/** Per-request export timeout. Short: a trace is never worth stalling a run for. */
const EXPORT_TIMEOUT_MS = 5_000;

/**
 * Wraps the real exporter so a failure is a warning, not an error.
 *
 * The BatchSpanProcessor already contains exporter failures; what it does not
 * do is tell anyone. Without this, a wrong key or a stopped server would look
 * exactly like a run that emitted nothing.
 */
export class ResilientExporter implements SpanExporter {
  private warned = false;
  private readonly inner: SpanExporter;
  private readonly warn: (message: string) => void;

  constructor(inner: SpanExporter, warn: (message: string) => void = (m) => console.warn(m)) {
    this.inner = inner;
    this.warn = warn;
  }

  private warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const reason = error instanceof Error ? error.message : error ? String(error) : '';
    const short = redactSecrets(reason).split('\n')[0].slice(0, 200);
    this.warn(short ? `${EXPORT_FAILED_WARNING} (${short})` : EXPORT_FAILED_WARNING);
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) this.warnOnce(result.error);
        done(result);
      });
    } catch (error) {
      this.warnOnce(error);
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch (error) {
      this.warnOnce(error);
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush?.();
    } catch (error) {
      this.warnOnce(error);
    }
  }
}

/**
 * Langfuse's own OTLP endpoint and headers, as `LangfuseSpanProcessor` builds
 * them. Constructed here only so it can be wrapped in `ResilientExporter`.
 */
function langfuseOtlpExporter(config: EnabledConfig): SpanExporter {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
  return new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${auth}`,
      'x-langfuse-sdk-name': 'javascript',
      'x-langfuse-sdk-version': LANGFUSE_SDK_VERSION,
      'x-langfuse-public-key': config.publicKey,
    },
    timeoutMillis: EXPORT_TIMEOUT_MS,
  });
}

export interface ProcessorOptions {
  /** Replace the network exporter — tests use an in-memory one. */
  exporter?: SpanExporter;
  warn?: (message: string) => void;
}

/**
 * The span processor both sides use. Exports Langfuse's default LLM spans plus
 * Flue's own agent/tool/task tree, masks credentials in any Langfuse
 * input/output/metadata attribute, and never uploads media.
 */
export function createLangfuseProcessor(config: EnabledConfig, options: ProcessorOptions = {}): LangfuseSpanProcessor {
  return new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    exporter: new ResilientExporter(options.exporter ?? langfuseOtlpExporter(config), options.warn),
    mediaUploadEnabled: false,
    shouldExportSpan: ({ otelSpan }) => isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name === FLUE_OTEL_SCOPE,
    mask: ({ data }) => (typeof data === 'string' ? redactSecrets(data) : data),
  });
}

/** Resolve after `work` settles or `ms` elapses, whichever is first. Never rejects. */
export async function bounded(work: () => Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          () => 'done' as const,
          () => 'done' as const,
        ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Trace-level attributes, in the keys `propagateAttributes` itself writes. */
export function traceAttributes(t: { name: string; tags: string[]; metadata: Record<string, string> }): Attributes {
  const attributes: Attributes = {
    [LangfuseOtelSpanAttributes.TRACE_NAME]: t.name,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: t.tags,
  };
  for (const [key, value] of Object.entries(t.metadata)) {
    attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`] = value;
  }
  return attributes;
}

/** Bounded, lowercase, filterable tags: `qa`, the command, the provider, the model id's last segment. */
export function traceTags(command: string, model: string): string[] {
  const slash = model.indexOf('/');
  const provider = slash === -1 ? model : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  const shortModel = modelId.split('/').pop() ?? modelId;
  return [...new Set(['qa', command, provider, shortModel].filter(Boolean))].map((t) => t.slice(0, 64));
}
