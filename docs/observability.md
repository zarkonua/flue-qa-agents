# Observability (Langfuse)

Optional tracing of QA runs in [Langfuse](https://langfuse.com), so that runs on different
models (local Ollama, OpenRouter, others later) can be compared by what actually happened:
which stage narrowed the output, which call filled the context window, which one failed and why.

Langfuse is the tracing backend and the dashboard. The `.qa/` artifacts remain the source of
truth for QA output; nothing about them changes whether tracing is on or off.

## Disable (the default)

```env
LANGFUSE_ENABLED=false
```

Or leave it unset. Only the exact value `true` enables tracing. When disabled:

- no Langfuse account or credentials are needed, and none are read;
- no OpenTelemetry or Langfuse module is loaded, nothing is registered globally;
- no network request is made to Langfuse;
- providers, retries, artifacts and run locking behave exactly as before.

## Enable

```env
LANGFUSE_ENABLED=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
```

Keys come from your Langfuse project under **Settings → API Keys**. A missing key stops the
run before any stage starts, with the variable named in the message:

```text
[flue] Langfuse observability is enabled but LANGFUSE_PUBLIC_KEY is missing.
```

No message ever contains a key's value.

### Self-hosted

Change `LANGFUSE_BASE_URL` and nothing else, e.g. `LANGFUSE_BASE_URL=http://localhost:3000`.
Spans go to that instance's OpenTelemetry endpoint (`/api/public/otel/v1/traces`).

### Capturing prompts and responses

```env
LANGFUSE_CAPTURE_IO=true
```

Off by default. Prompts in this project carry whole accessibility snapshots and repository
files: they are large, they cost storage, and they are the product under test. With capture
off, traces still carry structure, models, token counts, timings, context pressure, tool names,
QA counts and errors. With it on, prompts, responses and tool I/O are sent too, and still:

- known credentials are masked (the values of `LANGFUSE_*_KEY` and `OPENROUTER_API_KEY`, key
  shapes like `sk-lf-…` and `Bearer …`, and secret-looking URL parameters);
- browser tool results (accessibility snapshots) are cut to a 2 KB head;
- stack traces are never sent. A failure's short, redacted message is sent in both modes.

## Trace shape

One QA run is one trace, even though every stage attempt runs in its own `flue run` process.
The host passes each process the W3C `traceparent` of its stage, so the pieces join up:

```text
qa-manual                         chain       one run; input = target/plan, output = funnel
├── discovery                     chain       one per stage (the orchestrator's stage key)
│   ├── invoke_agent product-discovery   agent   one per attempt (the agent process)
│   │   ├── chat gpt-oss-20b-q5-49k      generation  one per model call
│   │   ├── execute_tool browser_click   tool
│   │   └── …
│   └── validate-artifact         event       the host's verdict on that attempt
├── analysis …
├── design …
└── prioritization …
```

`qa-automation` produces the same shape with its `repo-analyzer` stage. An agent started on its
own (`qa:agentic`, `qa:review`, a diagnostic) is traced as its own trace, named after the agent.

Trace tags are `qa`, the command, the provider and the model, e.g.
`qa · qa-manual · ollama · gpt-oss-20b-q5-49k`. Trace metadata carries `runId`, `model`,
`provider`, `flueVersion`, `gitCommit` and the run options.

## What each observation records

**Generation** (every model call, any provider), all from the provider's own response or the
resolved model registration, never estimated:

| Field | Meaning |
|---|---|
| `contextWindow`, `maxOutputTokens` | Resolved runtime values Flue budgets against. For Ollama gpt-oss builds `maxOutputTokens` is `OLLAMA_MAX_OUTPUT_TOKENS` if set, else a quarter of the window |
| `promptBudget` | `contextWindow − maxOutputTokens` |
| `promptTokens`, `outputTokens`, `cacheReadTokens`, `reasoningTokens` | Provider usage. Reasoning tokens only when the provider reports them |
| `contextUtilization` | `promptTokens / promptBudget` |
| `contextPressureLevel` | `normal` < 0.80 ≤ `warning` < 0.95 ≤ `critical`. A diagnostic, not a judgement |
| `finishReason`, `wasTruncated` | `length` means the **output** hit its limit |
| `errorKind`, `contextOverflow` | A **request** the server refused for size is `context_overflow`, kept separate from truncation. Other kinds: `harmony_parse_error`, `provider_http_error`, `timeout`, … |
| `outputTokensPerSecondEndToEnd` | Output tokens ÷ wall-clock turn time (includes prompt processing) |
| usage / cost | Langfuse usage details; cost only when non-zero (Pi's catalog rates, `costSource=pi-model-catalog`) |

**Agent** (one attempt): `turns`, `toolCalls`, `toolErrors`, `failedTurns`, `truncatedTurns`,
`peakPromptTokens`, `peakContextUtilization`, `errorKinds`, plus `stage`, `attempt`, `resumed`.

**Tool**: `toolName`, `durationMs`, `success`, `resultBytes`, and on failure `errorKind` —
`schema_validation_error` / `semantic_validation_error` when `write_qa_artifact` rejected the
object.

**Stage**: `attempts`, `retryCount`, `wasRetried`, `hadParseError`, `hadSchemaError`,
`hadSemanticError`, `notWrittenAttempts`, and for Ollama the running model's facts from
`/api/ps`: `ollama.contextLength`, `ollama.sizeBytes`, `ollama.sizeVramBytes`, and
`ollama.fullyGpuResident` (only when all of it is in VRAM; no GPU/CPU percentage is derived).

**Discovery completion gate** (see [VALIDATION.md](VALIDATION.md#discovery-finalizing-is-gated)):
each finalization attempt is an `evaluate-discovery-completion` event under its
`write_qa_artifact` call, with `canFinalize`, `reasonCodes`, `reasonCount`, and the gate's
counts (`unverifiedOutcomeCount`, `unexploredAreaCount`, `authUnresolved`, …). The discovery
stage carries `qa.finalizationAttemptCount`, `qa.finalizationRejectedCount`,
`qa.finalizationPassed`, `qa.rejectionReasonCodes` and `qa.lastReasonCodes`, plus the
navigation counts `qa.visibleNavigationCount`, `qa.newlyVisibleNavigationCount`,
`qa.crossOriginNavigationCount`, `qa.followedRelevantNavigationCount` and
`qa.unexploredRelevantNavigationCount`, and the BLOCKED roll-up `qa.blockedAttemptCount`,
`qa.blockedAcceptedCount`, `qa.blockedRejectedCount`, `qa.blockedWithoutEvidenceCount`,
`qa.authAttemptCount`, `qa.surfaceDeltaCount`. The first snapshot after an action carries the
host delta's counts on its tool observation: `surfaceDeltaGenerated`, `newInteractiveCount`,
`newNavigationCount`, `newStatusCount`, `removedRelevantElementCount`, `pageChanged`. No link
URL and no delta text is ever sent — counts and codes only.

### QA metrics

Counted by the host from the validated artifact, prefixed `qa.` on the stage, so a trace shows
where a run narrowed. They are facts, not quality scores.

| Stage | Metrics |
|---|---|
| `discovery` | `behaviourCount`, `behaviourStatus`, `areaCount`, `openQuestionCount`, `locationsVisited/Blocked/Skipped`, `observationCount` |
| `analysis` | `inputBehaviourCount`, `behavioursAnalyzed`, `acceptancePointCount`, `ruleCount` (business rules), `requirementCount`, `openQuestionCount`, `validationTypes` |
| `design` | `inputBehaviourCount`, `inputAcceptancePointCount`, `testCaseCount`, `scenarioTypes` (the schema's current vocabulary), `casesPerBehaviour`, `casesPerAcceptancePoint`, coverage |
| `prioritization` | `caseCount`, `executionMode`, `automationPriority`, `automationStrategy` |
| `repo-analyzer` | `layoutCount`, `conventionCount`, `keyFileCount`, `riskCount`, `unknownCount` |

The run's output repeats the funnel — `discovery.behaviourCount`,
`requirements.acceptancePointCount`, `testGeneration.testCaseCount` — so 14 → 15 → 2 (design
collapsed rich input) reads differently from 2 → 2 → 2 (the narrowing happened upstream) at a
glance.

## Failure behaviour

- Misconfiguration (enabled, key missing, malformed URL or environment) fails **before** the
  run, with exit code 2.
- Once a run has started, Langfuse being down, slow or rejecting spans never fails it. The
  first export failure prints one line and the run carries on:
  `[flue] Langfuse trace export failed; QA run continues without remote telemetry.`
- Flushing is bounded: at most ~5 s at the end of a run, ~3.5 s at the end of each agent
  process (inside `flue run`'s own 5 s shutdown bound).
- An interrupted run (Ctrl-C) loses its un-flushed run and stage observations; the agent
  observations already sent stay grouped under the same trace id.

## Where it lives

| | |
|---|---|
| `src/observability/config.ts` | The variables above, validated |
| `src/observability/host.ts` | The interface the orchestrators use; no-op when disabled |
| `src/observability/host-langfuse.ts` | Run, stage and attempt observations |
| `src/observability/agent-langfuse.ts` | Agent process: `@flue/opentelemetry` plus QA context and diagnostics |
| `src/observability/content-policy.ts` | What content may leave, and redaction |
| `src/observability/qa-metrics.ts` | QA counts from artifacts |
| `src/observability/signals.ts` | Context pressure, error classification |

Built on Langfuse's OpenTelemetry SDK (`@langfuse/otel`, `@langfuse/tracing`) and Flue's own
GenAI adapter (`@flue/opentelemetry`). Nothing Langfuse-specific reaches QA domain code; the
spans are standard OpenTelemetry, so another OTel backend would need only a different span
processor.
