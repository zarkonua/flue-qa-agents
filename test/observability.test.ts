// Optional Langfuse observability (docs/observability.md).
//
//   npm test
//
// No test here talks to Langfuse. Spans are captured by an in-memory exporter
// handed to the real `LangfuseSpanProcessor`, and the agent side is driven by
// feeding synthetic Flue runtime events to the real `@flue/opentelemetry`
// adapter — so what is asserted is exactly what would be exported.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';

import { readObservabilityConfig, type ObservabilityConfig } from '../src/observability/config.ts';
import { classifyError, contextPressure, endToEndTokensPerSecond, pressureLevel, wasTruncated } from '../src/observability/signals.ts';
import { createRunObservability, NOOP_RUN } from '../src/observability/host.ts';
import { childTraceEnv, CONTEXT_ENV, parseTraceparent, readAgentTraceContext, TRACEPARENT_ENV } from '../src/observability/propagation.ts';
import { createAgentInstrumentation } from '../src/observability/agent-langfuse.ts';
import { createLangfuseProcessor, EXPORT_FAILED_WARNING, FLUE_OTEL_SCOPE } from '../src/observability/langfuse.ts';
import { redactSecrets, SECRET_MASK } from '../src/observability/content-policy.ts';
import { runFunnel, stageMetrics } from '../src/observability/qa-metrics.ts';
import { parseRunningModel } from '../src/observability/ollama-probe.ts';
import { gptOssMaxOutputTokens } from '../src/providers/ollama-settings.ts';
import { authBootstrapNote, authTelemetry, CREDENTIAL_REFS } from '../src/config/auth-bootstrap.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test/fixtures/phase1-approved');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LANGFUSE_VARS = [
  'LANGFUSE_ENABLED',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_TRACING_ENVIRONMENT',
  'LANGFUSE_CAPTURE_IO',
];

/** Run `fn` with exactly these Langfuse variables set, restoring afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(LANGFUSE_VARS.map((k) => [k, process.env[k]]));
  for (const k of LANGFUSE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of LANGFUSE_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

/** Collects spans. Unlike InMemorySpanExporter, shutdown does not discard them. */
class CollectingExporter implements SpanExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (r: ExportResult) => void) {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }
  async shutdown() {}
  async forceFlush() {}
}

class FailingExporter implements SpanExporter {
  calls = 0;
  export(_spans: ReadableSpan[], done: (r: ExportResult) => void) {
    this.calls += 1;
    done({ code: ExportResultCode.FAILED, error: new Error('connect ECONNREFUSED 127.0.0.1:3000') });
  }
  async shutdown() {}
}

/** Never answers — an unreachable server that swallows the request. */
class HangingExporter implements SpanExporter {
  export() {}
  async shutdown() {
    await new Promise(() => {});
  }
  forceFlush() {
    return new Promise<void>(() => {});
  }
}

const CONFIG = (captureIo = false): Extract<ObservabilityConfig, { enabled: true }> => ({
  enabled: true,
  publicKey: 'pk-lf-test-public-0000',
  secretKey: 'sk-lf-test-secret-0000',
  baseUrl: 'http://127.0.0.1:9',
  environment: 'test',
  captureIo,
});

const noFetch = (async () => {
  throw new Error('network disabled in tests');
}) as unknown as typeof fetch;

const attr = (span: ReadableSpan, key: string) => span.attributes[key];
const meta = (span: ReadableSpan, key: string) => span.attributes[`langfuse.observation.metadata.${key}`];
const byName = (spans: ReadableSpan[], name: string) => {
  const found = spans.find((s) => s.name === name);
  assert.ok(found, `no span named "${name}" among: ${spans.map((s) => s.name).join(', ')}`);
  return found;
};
const parentId = (span: ReadableSpan) => span.parentSpanContext?.spanId;

let clock = Date.parse('2026-09-24T10:00:00Z');
const at = () => (clock += 10);

/** One agent operation: a model turn that calls a browser tool, then ends. */
function agentEvents(o: { provider?: string; model?: string; usage?: any; finishReason?: string; error?: any; userText?: string; systemPrompt?: string; toolName?: string; toolArgs?: any; toolResult?: string } = {}) {
  const base = { instanceId: 'inst-1', submissionId: 'sub-1', operationId: 'op-1', agentName: 'product-discovery', conversationId: 'conv-1' };
  const model = o.model ?? 'gpt-oss-20b-q5-49k';
  const providerName = o.provider ?? 'ollama';
  const request = { providerId: providerName, providerName, requestedModel: model, api: 'openai-completions', maxTokens: 12288 };
  const usage = o.usage ?? {
    input: 34920,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 35420,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return [
    { ...base, type: 'operation_start', timestamp: at(), operationKind: 'prompt', eventIndex: 0 },
    {
      ...base,
      type: 'turn_request',
      timestamp: at(),
      turnId: 'turn-1',
      purpose: 'agent',
      request: {
        ...request,
        input: {
          systemPrompt: o.systemPrompt ?? 'SYSTEM PROMPT BODY',
          messages: [{ role: 'user', content: o.userText ?? 'PAGE SNAPSHOT BODY', timestamp: 0 }],
          tools: [],
        },
      },
    },
    {
      ...base,
      type: 'turn',
      timestamp: at(),
      turnId: 'turn-1',
      purpose: 'agent',
      durationMs: 10_000,
      request,
      isError: Boolean(o.error),
      response: o.error
        ? { error: o.error }
        : {
            usage,
            finishReason: o.finishReason ?? 'toolUse',
            output: { role: 'assistant', content: [{ type: 'text', text: 'MODEL ANSWER BODY' }], timestamp: 0 },
          },
    },
    { ...base, type: 'tool_start', timestamp: at(), toolName: o.toolName ?? 'browser_snapshot', toolCallId: 'call-1', args: o.toolArgs ?? { ref: 'e1' }, origin: 'model' },
    {
      ...base,
      type: 'tool',
      timestamp: at(),
      toolName: o.toolName ?? 'browser_snapshot',
      toolCallId: 'call-1',
      isError: false,
      result: o.toolResult ?? `- heading "Home"\n${'- link "x"\n'.repeat(2000)}`,
      durationMs: 120,
      origin: 'model',
    },
    { ...base, type: 'operation', timestamp: at(), operationKind: 'prompt', durationMs: 11_000, isError: false },
  ];
}

/** Drive a whole agent process's worth of events and return its exported spans. */
async function runAgentProcess(env: Record<string, string>, o: Parameters<typeof agentEvents>[0] & { captureIo?: boolean; model?: string } = {}) {
  const exporter = new CollectingExporter();
  const config = CONFIG(o.captureIo ?? false);
  const provider = new BasicTracerProvider({ spanProcessors: [createLangfuseProcessor(config, { exporter })] });
  const { parent, context } = readAgentTraceContext(env);
  const instrumentation = createAgentInstrumentation({
    config,
    info: { model: `${o.provider ?? 'ollama'}/${o.model ?? 'gpt-oss-20b-q5-49k'}`, limits: { contextWindow: 49152, maxOutputTokens: 12288 } },
    parent,
    context,
    tracer: provider.getTracer(FLUE_OTEL_SCOPE),
  });
  for (const event of agentEvents(o)) instrumentation.observe(event as any, {} as any);
  await provider.shutdown();
  return exporter.spans;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('observability configuration', () => {
  it('is disabled by default and needs no credentials', () => {
    assert.deepEqual(withEnv({}, readObservabilityConfig), { enabled: false });
    assert.deepEqual(withEnv({ LANGFUSE_ENABLED: 'false' }, readObservabilityConfig), { enabled: false });
  });

  it('is enabled only by the exact string "true"', () => {
    for (const value of ['TRUE', '1', 'yes', 'on', ' ']) {
      assert.deepEqual(withEnv({ LANGFUSE_ENABLED: value }, readObservabilityConfig), { enabled: false }, value);
    }
  });

  it('names the missing credential when enabled, and never prints the other one', () => {
    assert.throws(
      () => withEnv({ LANGFUSE_ENABLED: 'true', LANGFUSE_SECRET_KEY: 'sk-lf-dont-print-me' }, readObservabilityConfig),
      (error: Error) => {
        assert.equal(error.message, '[flue] Langfuse observability is enabled but LANGFUSE_PUBLIC_KEY is missing.');
        assert.ok(!error.message.includes('sk-lf-dont-print-me'));
        return true;
      },
    );
    assert.throws(
      () => withEnv({ LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-lf-x' }, readObservabilityConfig),
      /\[flue\] Langfuse observability is enabled but LANGFUSE_SECRET_KEY is missing\./,
    );
  });

  it('defaults to Langfuse Cloud, development, and no I/O capture', () => {
    const config = withEnv({ LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }, readObservabilityConfig);
    assert.equal(config.enabled && config.baseUrl, 'https://cloud.langfuse.com');
    assert.equal(config.enabled && config.environment, 'development');
    assert.equal(config.enabled && config.captureIo, false);
  });

  it('supports a self-hosted instance through LANGFUSE_BASE_URL alone', () => {
    const config = withEnv(
      { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_BASE_URL: 'http://langfuse.internal:3000/' },
      readObservabilityConfig,
    );
    assert.equal(config.enabled && config.baseUrl, 'http://langfuse.internal:3000');
  });

  it('rejects a malformed base URL or environment up front', () => {
    const base = { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    assert.throws(() => withEnv({ ...base, LANGFUSE_BASE_URL: 'cloud.langfuse.com' }, readObservabilityConfig), /LANGFUSE_BASE_URL/);
    assert.throws(() => withEnv({ ...base, LANGFUSE_TRACING_ENVIRONMENT: 'Prod' }, readObservabilityConfig), /LANGFUSE_TRACING_ENVIRONMENT/);
  });

  it('the host fails fast with the config error, before any run', async () => {
    await withEnv({ LANGFUSE_ENABLED: 'true' }, async () => {
      await assert.rejects(createRunObservability(), /LANGFUSE_PUBLIC_KEY is missing/);
    });
  });
});

// ---------------------------------------------------------------------------
// Disabled means disabled
// ---------------------------------------------------------------------------

describe('observability when disabled', () => {
  it('returns the no-op implementation, which does nothing', async () => {
    const obs = await createRunObservability({ config: { enabled: false } });
    assert.equal(obs, NOOP_RUN);
    assert.equal(obs.enabled, false);
    obs.startRun({ command: 'qa-manual', runId: 'r', model: 'ollama/qwen3:14b' });
    const stage = obs.startStage({ key: 'discovery', label: 'D', agent: 'a', artifact: 'x' });
    let evaluated = false;
    await stage.end({
      passed: true,
      metrics: () => {
        evaluated = true;
        return {};
      },
    });
    await obs.endRun({ outcome: 'COMPLETE' });
    assert.equal(evaluated, false, 'metrics must not even be computed when disabled');
  });

  it('hands agents blank trace variables, so nothing is inherited from the shell', () => {
    const env = NOOP_RUN.startStage({ key: 'k', label: 'l', agent: 'a', artifact: 'x' }).childEnv({ attempt: 1, resumed: false });
    assert.deepEqual(env, { [TRACEPARENT_ENV]: '', [CONTEXT_ENV]: '' });
  });

  it('initialises nothing and sends nothing, in a real process', () => {
    // A fresh process, because what is being proved is the absence of global
    // side effects: no OpenTelemetry API registration, no fetch, no Langfuse.
    const code = `
      let fetches = 0;
      globalThis.fetch = async () => { fetches += 1; throw new Error('no'); };
      const { createRunObservability } = await import('./src/observability/host.ts');
      const { initAgentObservability } = await import('./src/observability/agent.ts');
      const obs = await createRunObservability();
      obs.startRun({ command: 'qa-manual', runId: 'r', model: 'ollama/gpt-oss-20b-q5-49k' });
      const st = obs.startStage({ key: 'discovery', label: 'D', agent: 'a', artifact: 'x' });
      st.recordAttempt({ attempt: 1, resumed: false, passed: true });
      await st.end({ passed: true });
      await obs.endRun({ outcome: 'COMPLETE' });
      await initAgentObservability({ model: 'ollama/gpt-oss-20b-q5-49k' });
      const otel = globalThis[Symbol.for('opentelemetry.js.api.1')];
      const langfuse = globalThis[Symbol.for('langfuse')];
      console.log(JSON.stringify({ enabled: obs.enabled, fetches, otel: otel === undefined, langfuse: langfuse === undefined }));
    `;
    const env: Record<string, string | undefined> = { ...process.env, QA_ENV_FILE: join(tmpdir(), 'qa-no-such-env-file'), LANGFUSE_ENABLED: 'false' };
    for (const k of LANGFUSE_VARS.slice(1)) delete env[k];
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd: PROJECT, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()!), { enabled: false, fetches: 0, otel: true, langfuse: true });
  });
});

// ---------------------------------------------------------------------------
// Context window arithmetic
// ---------------------------------------------------------------------------

describe('context pressure', () => {
  it('budgets the prompt as the window minus the output budget', () => {
    const p = contextPressure(49152, 12288, 34920);
    assert.equal(p.promptBudget, 36864);
    assert.equal(p.contextUtilization, 0.947);
    assert.equal(p.contextPressureLevel, 'warning');
  });

  it('reports a budget but no utilisation without an authoritative prompt count', () => {
    const p = contextPressure(8192, 2048);
    assert.equal(p.promptBudget, 6144);
    assert.equal(p.contextUtilization, undefined);
    assert.equal(p.contextPressureLevel, undefined);
  });

  it('uses the documented thresholds', () => {
    assert.equal(pressureLevel(0.79), 'normal');
    assert.equal(pressureLevel(0.8), 'warning');
    assert.equal(pressureLevel(0.949), 'warning');
    assert.equal(pressureLevel(0.95), 'critical');
    assert.equal(pressureLevel(1.2), 'critical');
  });

  it('derives an end-to-end rate only when it means something', () => {
    assert.equal(endToEndTokensPerSecond(500, 10_000), 50);
    assert.equal(endToEndTokensPerSecond(0, 10_000), undefined);
    assert.equal(endToEndTokensPerSecond(500, 0), undefined);
    assert.equal(endToEndTokensPerSecond(undefined, 1000), undefined);
  });
});

describe('Ollama output budget (unchanged rule)', () => {
  it('an explicit OLLAMA_MAX_OUTPUT_TOKENS wins outright', () => {
    assert.equal(gptOssMaxOutputTokens(49152, 4096), 4096);
    assert.equal(gptOssMaxOutputTokens(49152, 30000), 30000);
  });

  it('otherwise a quarter of the window', () => {
    assert.equal(gptOssMaxOutputTokens(49152, undefined), 12288);
    assert.equal(gptOssMaxOutputTokens(24576, undefined), 6144);
  });

  it('the registered models resolve the same way, through the real provider', () => {
    const run = (extra: Record<string, string>) => {
      const env: Record<string, string | undefined> = { ...process.env, QA_ENV_FILE: join(tmpdir(), 'qa-no-such-env-file'), ...extra };
      delete env.OLLAMA_MAX_OUTPUT_TOKENS;
      delete env.OLLAMA_CONTEXT_WINDOW;
      Object.assign(env, extra);
      const code = `const m = await import('./src/providers/ollama.ts');
        console.log(JSON.stringify([m.ollamaModelLimits('gpt-oss-20b-q5-49k'), m.ollamaModelLimits('qwen3:14b')]));`;
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd: PROJECT, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').pop()!);
    };
    assert.deepEqual(run({}), [
      { contextWindow: 49152, maxOutputTokens: 12288 },
      { contextWindow: 8192, maxOutputTokens: 2048 },
    ]);
    assert.deepEqual(run({ OLLAMA_MAX_OUTPUT_TOKENS: '4096' })[0], { contextWindow: 49152, maxOutputTokens: 4096 });
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('context overflow is its own kind, never output truncation', () => {
    const overflow = '400 request (52110 tokens) exceeds the available context size (49152 tokens), try increasing it';
    assert.equal(classifyError(overflow), 'context_overflow');
    assert.equal(wasTruncated('length'), true);
    assert.equal(wasTruncated('stop'), false);
    assert.equal(wasTruncated(undefined), false);
  });

  it('recognises the other failure families', () => {
    assert.equal(classifyError('500 chat error: peg-native parse failure'), 'harmony_parse_error');
    assert.equal(classifyError('"test-cases" does not match test-cases.schema.json:\n  - /x'), 'schema_validation_error');
    assert.equal(classifyError('SemanticValidationError: unknown evidence id'), 'semantic_validation_error');
    assert.equal(
      classifyError('"discovered-behavior" is schema-valid but not supported by upstream evidence, so nothing was written (2 problems):'),
      'semantic_validation_error',
    );
    assert.equal(classifyError('503 status code (no body)'), 'provider_http_error');
    assert.equal(classifyError('Request timed out'), 'timeout');
    assert.equal(classifyError('something else'), 'other');
  });
});

// ---------------------------------------------------------------------------
// Trace hierarchy, end to end across the process boundary
// ---------------------------------------------------------------------------

async function simulatedRun(o: { runId: string; exporter: SpanExporter; model?: string; outcome?: 'COMPLETE' | 'FAILED'; captureIo?: boolean }) {
  const model = o.model ?? 'ollama/gpt-oss-20b-q5-49k';
  const obs = await createRunObservability({
    config: CONFIG(o.captureIo),
    exporter: o.exporter,
    fetchImpl: noFetch,
    shutdownTimeoutMs: 1_000,
  });
  obs.startRun({ command: 'qa-manual', runId: o.runId, model, input: { target: 'http://localhost:4444/' } });
  const stage = obs.startStage({ key: 'discovery', label: 'Product Discovery', agent: 'src/agents/product-discovery.ts', artifact: 'discovered-behavior' });
  const env = stage.childEnv({ attempt: 1, resumed: false });
  const [provider, ...rest] = model.split('/');
  const agentSpans = await runAgentProcess(env, { provider, model: rest.join('/'), captureIo: o.captureIo });
  stage.recordAttempt({ attempt: 1, resumed: false, passed: o.outcome !== 'FAILED', durationMs: 11_000, toolCallsTotal: 1, problem: o.outcome === 'FAILED' ? 'discovered-behavior.json fails its schema: /x' : null });
  await stage.end({ passed: o.outcome !== 'FAILED', metrics: () => ({ behaviourCount: 14 }) });
  await obs.endRun({ outcome: o.outcome ?? 'COMPLETE', failedStage: o.outcome === 'FAILED' ? 'discovery' : undefined });
  return { env, agentSpans };
}

describe('trace hierarchy', () => {
  it('run -> stage -> agent -> generation + tool, in one trace', async () => {
    const host = new CollectingExporter();
    const { agentSpans } = await simulatedRun({ runId: 'run-A', exporter: host });

    const root = byName(host.spans, 'qa-manual');
    const stage = byName(host.spans, 'discovery');
    const verdict = byName(host.spans, 'validate-artifact');
    const agent = byName(agentSpans, 'invoke_agent product-discovery');
    const generation = byName(agentSpans, 'chat gpt-oss-20b-q5-49k');
    const tool = byName(agentSpans, 'execute_tool browser_snapshot');

    const traceId = root.spanContext().traceId;
    for (const s of [stage, verdict, agent, generation, tool]) assert.equal(s.spanContext().traceId, traceId, s.name);
    assert.equal(parentId(root), undefined);
    assert.equal(parentId(stage), root.spanContext().spanId);
    assert.equal(parentId(verdict), stage.spanContext().spanId);
    assert.equal(parentId(agent), stage.spanContext().spanId, 'agent attaches directly under its stage');
    assert.equal(parentId(generation), agent.spanContext().spanId);
    assert.equal(parentId(tool), agent.spanContext().spanId, 'tool is a sibling of the generation');

    assert.equal(attr(root, 'langfuse.observation.type'), 'chain');
    assert.equal(attr(stage, 'langfuse.observation.type'), 'chain');
    assert.equal(attr(agent, 'langfuse.observation.type'), 'agent');
    assert.equal(attr(generation, 'langfuse.observation.type'), 'generation');
    assert.equal(attr(tool, 'langfuse.observation.type'), 'tool');

    // Only the host root may be the application root; the agent process defers.
    assert.equal(attr(root, 'langfuse.internal.is_app_root'), true);
    assert.equal(attr(agent, 'langfuse.internal.is_app_root'), undefined, 'agent span must not claim to be the app root');

    assert.equal(attr(root, 'langfuse.trace.name'), 'qa-manual');
    assert.equal(attr(agent, 'langfuse.trace.name'), 'qa-manual');
    assert.deepEqual(attr(root, 'langfuse.trace.tags'), ['qa', 'qa-manual', 'ollama', 'gpt-oss-20b-q5-49k']);
    assert.equal(attr(root, 'langfuse.trace.metadata.runId'), 'run-A');
    assert.equal(attr(root, 'langfuse.environment'), 'test');
    assert.equal(meta(agent, 'stage'), 'discovery');
    assert.equal(meta(agent, 'attempt'), '1');
    assert.equal(meta(stage, 'qa.behaviourCount'), '14');
  });

  it('records context pressure and usage on every generation', async () => {
    const { agentSpans } = await simulatedRun({ runId: 'run-B', exporter: new CollectingExporter() });
    const g = byName(agentSpans, 'chat gpt-oss-20b-q5-49k');
    assert.equal(meta(g, 'contextWindow'), '49152');
    assert.equal(meta(g, 'maxOutputTokens'), '12288');
    assert.equal(meta(g, 'promptBudget'), '36864');
    assert.equal(meta(g, 'promptTokens'), '34920');
    assert.equal(meta(g, 'contextUtilization'), '0.947');
    assert.equal(meta(g, 'contextPressureLevel'), 'warning');
    assert.equal(meta(g, 'outputTokens'), '500');
    assert.equal(meta(g, 'outputTokensPerSecondEndToEnd'), '50');
    assert.equal(meta(g, 'provider'), 'ollama');
    assert.equal(attr(g, 'gen_ai.request.model'), 'gpt-oss-20b-q5-49k');
    assert.deepEqual(JSON.parse(String(attr(g, 'langfuse.observation.usage_details'))), { input: 34920, output: 500, total: 35420 });
    assert.equal(attr(g, 'langfuse.observation.cost_details'), undefined, 'a local model has no cost to report');

    const agent = byName(agentSpans, 'invoke_agent product-discovery');
    assert.equal(meta(agent, 'turns'), '1');
    assert.equal(meta(agent, 'toolCalls'), '1');
    assert.equal(meta(agent, 'peakContextUtilization'), '0.947');
    const tool = byName(agentSpans, 'execute_tool browser_snapshot');
    assert.equal(meta(tool, 'success'), 'true');
    assert.ok(Number(meta(tool, 'resultBytes')) > 10_000);
  });
});

describe('provider normalisation', () => {
  it('OpenRouter: cached and reasoning tokens, and a real cost', async () => {
    const spans = await runAgentProcess(
      {},
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        usage: {
          input: 1000,
          output: 300,
          cacheRead: 200,
          cacheWrite: 0,
          reasoning: 120,
          totalTokens: 1500,
          cost: { input: 0.00004, output: 0.000192, cacheRead: 0.0000032, cacheWrite: 0, total: 0.0002352 },
        },
      },
    );
    const g = byName(spans, 'chat deepseek/deepseek-v4-flash-0731');
    assert.deepEqual(JSON.parse(String(attr(g, 'langfuse.observation.usage_details'))), {
      input: 1200,
      output: 300,
      total: 1500,
      input_cached_tokens: 200,
      output_reasoning_tokens: 120,
    });
    const cost = JSON.parse(String(attr(g, 'langfuse.observation.cost_details')));
    assert.equal(cost.total, 0.0002352);
    assert.equal(meta(g, 'provider'), 'openrouter');
    assert.equal(meta(g, 'reasoningTokens'), '120');
    assert.equal(meta(g, 'costSource'), 'pi-model-catalog');
  });

  it('Ollama: no reasoning split, no cost', async () => {
    const spans = await runAgentProcess({});
    const g = byName(spans, 'chat gpt-oss-20b-q5-49k');
    assert.equal(meta(g, 'reasoningTokens'), undefined);
    assert.equal(attr(g, 'langfuse.observation.cost_details'), undefined);
  });

  it('a truncated response is a warning, not an overflow', async () => {
    const spans = await runAgentProcess({}, { finishReason: 'length' });
    const g = byName(spans, 'chat gpt-oss-20b-q5-49k');
    assert.equal(meta(g, 'wasTruncated'), 'true');
    assert.equal(meta(g, 'contextOverflow'), undefined);
    assert.equal(attr(g, 'langfuse.observation.level'), 'WARNING');
  });

  it('a context overflow is an error, classified as such', async () => {
    const spans = await runAgentProcess({}, {
      error: { type: 'provider_error', message: '400 request (52110 tokens) exceeds the available context size (49152 tokens)' },
    });
    const g = byName(spans, 'chat gpt-oss-20b-q5-49k');
    assert.equal(meta(g, 'errorKind'), 'context_overflow');
    assert.equal(meta(g, 'contextOverflow'), 'true');
    assert.equal(meta(g, 'wasTruncated'), 'false');
    assert.equal(attr(g, 'langfuse.observation.level'), 'ERROR');
    const agent = byName(spans, 'invoke_agent product-discovery');
    assert.equal(meta(agent, 'errorKinds'), 'context_overflow');
  });
});

// ---------------------------------------------------------------------------
// I/O capture
// ---------------------------------------------------------------------------

const CONTENT_KEYS = ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'flue.tool.call.result', 'flue.tool.call.arguments'];

describe('LANGFUSE_CAPTURE_IO', () => {
  it('false: no prompt, response, system prompt or snapshot leaves the process', async () => {
    const spans = await runAgentProcess({}, { captureIo: false });
    for (const span of spans) {
      for (const key of CONTENT_KEYS) assert.equal(span.attributes[key], undefined, `${span.name} carries ${key}`);
      const everything = JSON.stringify(span.attributes);
      for (const body of ['SYSTEM PROMPT BODY', 'PAGE SNAPSHOT BODY', 'MODEL ANSWER BODY', 'heading "Home"']) {
        assert.ok(!everything.includes(body), `${span.name} leaks ${body}`);
      }
    }
  });

  it('true: content is sent, secrets are masked, snapshots are cut short', async () => {
    const spans = await runAgentProcess({}, { captureIo: true, userText: 'use key sk-lf-abcdef0123456789 to log in' });
    const g = byName(spans, 'chat gpt-oss-20b-q5-49k');
    const input = String(attr(g, 'gen_ai.input.messages'));
    assert.ok(input.length > 0);
    assert.ok(!input.includes('sk-lf-abcdef0123456789'));
    assert.ok(input.includes(SECRET_MASK));
    assert.ok(String(attr(g, 'gen_ai.output.messages')).includes('MODEL ANSWER BODY'));
    const tool = byName(spans, 'execute_tool browser_snapshot');
    const result = String(tool.attributes['gen_ai.tool.call.result'] ?? tool.attributes['flue.tool.call.result'] ?? '');
    assert.ok(result.includes('heading'), 'the head of the snapshot is kept');
    assert.ok(Buffer.byteLength(result) < 4_096, `snapshot not truncated: ${Buffer.byteLength(result)} bytes`);
  });

  it('redacts credentials from the environment and by shape', () => {
    const env = { LANGFUSE_SECRET_KEY: 'my-very-own-secret-value', OPENROUTER_API_KEY: undefined } as NodeJS.ProcessEnv;
    const out = redactSecrets('a my-very-own-secret-value b Bearer abc.def.ghi123 c sk-or-v1-0123456789abcdef', env);
    assert.ok(!out.includes('my-very-own-secret-value'));
    assert.ok(!out.includes('abc.def.ghi123'));
    assert.ok(!out.includes('sk-or-v1-0123456789abcdef'));
  });
});

// ---------------------------------------------------------------------------
// Failure isolation and run isolation
// ---------------------------------------------------------------------------

describe('Langfuse failures never break a run', () => {
  it('an export failure warns once and the run completes', async () => {
    const warnings: string[] = [];
    const failing = new FailingExporter();
    const obs = await createRunObservability({ config: CONFIG(), exporter: failing, warn: (m) => warnings.push(m), fetchImpl: noFetch, shutdownTimeoutMs: 1_000 });
    obs.startRun({ command: 'qa-manual', runId: 'r', model: 'ollama/gpt-oss-20b-q5-49k' });
    for (const key of ['discovery', 'analysis']) {
      const st = obs.startStage({ key, label: key, agent: 'a', artifact: 'x' });
      st.recordAttempt({ attempt: 1, resumed: false, passed: true });
      await st.end({ passed: true });
    }
    await obs.endRun({ outcome: 'COMPLETE' });
    assert.ok(failing.calls > 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith(EXPORT_FAILED_WARNING));
    assert.ok(!warnings[0].includes('sk-lf-test-secret-0000'));
  });

  it('an unresponsive server cannot hang the end of a run', async () => {
    const obs = await createRunObservability({ config: CONFIG(), exporter: new HangingExporter(), fetchImpl: noFetch, shutdownTimeoutMs: 300 });
    obs.startRun({ command: 'qa-manual', runId: 'r', model: 'ollama/qwen3:14b' });
    await obs.startStage({ key: 'discovery', label: 'd', agent: 'a', artifact: 'x' }).end({ passed: true });
    const started = Date.now();
    await obs.endRun({ outcome: 'COMPLETE' });
    assert.ok(Date.now() - started < 2_000, `endRun took ${Date.now() - started} ms`);
  });

  it('a throwing metrics function is contained', async () => {
    const host = new CollectingExporter();
    const obs = await createRunObservability({ config: CONFIG(), exporter: host, fetchImpl: noFetch });
    obs.startRun({ command: 'qa-manual', runId: 'r', model: 'ollama/qwen3:14b' });
    await obs.startStage({ key: 'discovery', label: 'd', agent: 'a', artifact: 'x' }).end({
      passed: true,
      metrics: () => {
        throw new Error('bad artifact');
      },
    });
    await obs.endRun({ outcome: 'COMPLETE', output: () => { throw new Error('bad'); } });
    assert.ok(host.spans.some((s) => s.name === 'discovery'));
  });
});

describe('run isolation', () => {
  it('two runs are two traces; nothing crosses between them', async () => {
    const exporter = new CollectingExporter();
    const a = await simulatedRun({ runId: 'run-1', exporter, outcome: 'FAILED' });
    const b = await simulatedRun({ runId: 'run-2', exporter, model: 'openrouter/deepseek/deepseek-v4-flash-0731' });

    const roots = exporter.spans.filter((s) => s.name === 'qa-manual');
    assert.equal(roots.length, 2);
    const [r1, r2] = roots;
    assert.notEqual(r1.spanContext().traceId, r2.spanContext().traceId);
    assert.equal(parentId(r2), undefined, 'a failed run must not become the parent of the next');
    assert.equal(attr(r1, 'langfuse.trace.metadata.runId'), 'run-1');
    assert.equal(attr(r2, 'langfuse.trace.metadata.runId'), 'run-2');
    assert.equal(attr(r2, 'langfuse.trace.metadata.provider'), 'openrouter');
    assert.equal(attr(r1, 'langfuse.observation.level'), 'ERROR');

    // Each run's agent process got its own run's context, and only that.
    assert.equal(parseTraceparent(a.env[TRACEPARENT_ENV])!.traceId, r1.spanContext().traceId);
    assert.equal(parseTraceparent(b.env[TRACEPARENT_ENV])!.traceId, r2.spanContext().traceId);
    assert.equal(JSON.parse(b.env[CONTEXT_ENV]).runId, 'run-2');
    for (const span of b.agentSpans) {
      assert.equal(span.spanContext().traceId, r2.spanContext().traceId, span.name);
      assert.equal(meta(span, 'runId'), 'run-2', span.name);
      assert.equal(meta(span, 'model'), 'openrouter/deepseek/deepseek-v4-flash-0731', span.name);
    }
  });

  it('propagation ignores malformed or zero trace ids', () => {
    assert.equal(parseTraceparent(''), undefined);
    assert.equal(parseTraceparent('00-00000000000000000000000000000000-0000000000000001-01'), undefined);
    assert.equal(parseTraceparent('garbage'), undefined);
    assert.deepEqual(readAgentTraceContext({ [TRACEPARENT_ENV]: 'nope', [CONTEXT_ENV]: '{"runId":"x"}' }), {});
    const env = childTraceEnv({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }, undefined);
    assert.equal(env[TRACEPARENT_ENV], `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('a standalone agent (no host) still traces, as its own root', async () => {
    const spans = await runAgentProcess({});
    const agent = byName(spans, 'invoke_agent product-discovery');
    assert.equal(parentId(agent), undefined);
    assert.equal(attr(agent, 'langfuse.trace.name'), 'product-discovery');
  });
});

// ---------------------------------------------------------------------------
// QA-domain metrics
// ---------------------------------------------------------------------------

describe('QA metrics', () => {
  const read = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
    } catch {
      return undefined;
    }
  };

  it('counts each stage from its own artifact', () => {
    const d = read('discovered-behavior');
    const r = read('requirements-analysis');
    const t = read('test-cases');
    const p = read('automation-prioritization');

    const discovery = stageMetrics('discovery', read, { observationCount: 7 });
    assert.equal(discovery.behaviourCount, d.behaviors.length);
    assert.equal(discovery.openQuestionCount, (d.openQuestions ?? []).length);
    assert.equal(discovery.observationCount, 7);

    const analysis = stageMetrics('analysis', read);
    assert.equal(analysis.acceptancePointCount, r.acceptancePoints.length);
    assert.equal(analysis.ruleCount, (r.businessRules ?? []).length);
    assert.equal(analysis.requirementCount, r.acceptancePoints.length + (r.businessRules ?? []).length);
    assert.equal(analysis.inputBehaviourCount, d.behaviors.length);

    const design = stageMetrics('design', read);
    assert.equal(design.testCaseCount, t.testCases.length);
    assert.equal(design.inputBehaviourCount, d.behaviors.length);
    assert.equal(design.inputAcceptancePointCount, r.acceptancePoints.length);
    assert.equal(design.casesPerBehaviour, Math.round((t.testCases.length / d.behaviors.length) * 100) / 100);
    const typeTotal = Object.values(design.scenarioTypes as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(typeTotal, t.testCases.reduce((n: number, tc: any) => n + (tc.types ?? []).length, 0));

    assert.equal(stageMetrics('prioritization', read).caseCount, p.cases.length);
  });

  it('uses the schema\'s current scenario vocabulary, whatever it is', () => {
    const suite = { testCases: [{ id: 'TC-1', types: ['state-transition', 'accessibility'], covers: [] }] };
    const m = stageMetrics('design', (n) => (n === 'test-cases' ? suite : undefined));
    assert.deepEqual(m.scenarioTypes, { 'state-transition': 1, accessibility: 1 });
    assert.equal(m.casesPerBehaviour, undefined, 'no behaviours, no ratio');
  });

  it('a missing artifact yields no counts rather than zeros', () => {
    assert.deepEqual(stageMetrics('design', () => undefined), {});
    assert.deepEqual(stageMetrics('unknown-stage', read), {});
  });

  it('the run funnel shows where a run narrowed', () => {
    const funnel = runFunnel(read);
    assert.equal(funnel['discovery.behaviourCount'], read('discovered-behavior').behaviors.length);
    assert.equal(funnel['requirements.acceptancePointCount'], read('requirements-analysis').acceptancePoints.length);
    assert.equal(funnel['testGeneration.testCaseCount'], read('test-cases').testCases.length);
  });
});

describe('Ollama running-model probe', () => {
  const ps = (size: number, vram: number) => ({
    models: [{ name: 'gpt-oss-20b-q5-49k:latest', model: 'gpt-oss-20b-q5-49k:latest', size, size_vram: vram, context_length: 49152, details: { quantization_level: 'Q5_K_M', parameter_size: '20.9B' } }],
  });

  it('reports placement only as the API states it', () => {
    assert.deepEqual(parseRunningModel(ps(16e9, 16e9), 'gpt-oss-20b-q5-49k'), {
      name: 'gpt-oss-20b-q5-49k:latest',
      sizeBytes: 16e9,
      sizeVramBytes: 16e9,
      contextLength: 49152,
      fullyGpuResident: true,
      quantization: 'Q5_K_M',
      parameterSize: '20.9B',
    });
    assert.equal(parseRunningModel(ps(16e9, 12e9), 'gpt-oss-20b-q5-49k')?.fullyGpuResident, false);
    assert.equal(parseRunningModel(ps(16e9, 16e9), 'qwen3:14b'), undefined);
    assert.equal(parseRunningModel({}, 'x'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Auth bootstrap (CHANGE 12): safe metadata, and the account never exported
// ---------------------------------------------------------------------------

describe('auth bootstrap telemetry', () => {
  const PASSWORD = 'SUPER_SECRET_SENTINEL_123';
  const EMAIL = 'sentinel.user.4711@example.test';
  const TOKEN = 'STORAGE_TOKEN_SENTINEL_456';

  /** Run `fn` with the account in this process's environment, as `.env` would put it. */
  async function withAccount<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { e: process.env.QA_AUTH_USER_EMAIL, p: process.env.QA_AUTH_USER_PASSWORD };
    process.env.QA_AUTH_USER_EMAIL = EMAIL;
    process.env.QA_AUTH_USER_PASSWORD = PASSWORD;
    try {
      return await fn();
    } finally {
      for (const [k, v] of [['QA_AUTH_USER_EMAIL', saved.e], ['QA_AUTH_USER_PASSWORD', saved.p]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const everything = (spans: ReadableSpan[]) => spans.map((s) => JSON.stringify({ name: s.name, a: s.attributes, e: s.events, st: s.status })).join('\n');
  const assertClean = (text: string) => {
    for (const secret of [PASSWORD, EMAIL, TOKEN]) assert.ok(!text.includes(secret), `trace contains ${secret}`);
  };

  for (const config of [
    { mode: 'credentials' as const, credentials: { email: EMAIL, password: PASSWORD } },
    { mode: 'storage_state' as const, storageStatePath: `/home/x/.qa/auth/${TOKEN}.json` },
  ]) {
    it(`run metadata records authBootstrapMode=${config.mode}, and nothing secret`, async () => {
      const host = new CollectingExporter();
      const obs = await createRunObservability({ config: CONFIG(true), exporter: host, fetchImpl: noFetch, shutdownTimeoutMs: 1_000 });
      obs.startRun({ command: 'qa-manual', runId: `auth-${config.mode}`, model: 'ollama/x', input: { target: 'http://localhost:4444/' }, metadata: authTelemetry(config) });
      await obs.endRun({ outcome: 'COMPLETE' });
      const root = byName(host.spans, 'qa-manual');
      assert.equal(meta(root, 'authBootstrapMode'), config.mode);
      assert.equal(meta(root, 'authBootstrapConfigured'), 'true');
      assertClean(everything(host.spans));
    });
  }

  it('a credential-assisted discovery turn, with I/O capture on, exports no account value', async () => {
    await withAccount(async () => {
      // The worst case: something upstream let the values into every channel.
      const spans = await runAgentProcess({}, {
        captureIo: true,
        systemPrompt: `You are discovery.${authBootstrapNote('credentials')}`,
        userText: `the page says: signed in as ${EMAIL} using ${PASSWORD}`,
        toolName: 'browser_type',
        toolArgs: { target: 'e15', element: 'Password', text: CREDENTIAL_REFS.password, leaked: PASSWORD },
        toolResult: `### Page\n- status: Signed in as <secret>QA_AUTH_USER_EMAIL</secret> (${EMAIL})`,
        error: undefined,
      });
      const text = everything(spans);
      assertClean(text);
      // The reference the model types is not a secret, and is kept.
      assert.ok(text.includes(CREDENTIAL_REFS.password));
      assert.ok(text.includes(SECRET_MASK));
    });
  });

  it('an error message quoting the password is masked', async () => {
    await withAccount(async () => {
      const spans = await runAgentProcess({}, { captureIo: false, error: { message: `login rejected for ${EMAIL}:${PASSWORD}` } });
      assertClean(everything(spans));
    });
  });
});
