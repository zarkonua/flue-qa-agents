// Deterministic diagnostics derived from facts the run already has.
//
// Everything here is a pure function over numbers and strings the provider or
// the host produced. Nothing is estimated, and nothing is a quality judgement:
// a "critical" context pressure says the prompt nearly filled its budget, not
// that the model did badly.

import { isParserFailure } from '../lib/harmony-diagnostic.ts';

export type ContextPressureLevel = 'normal' | 'warning' | 'critical';

export interface ContextPressure {
  contextWindow: number;
  maxOutputTokens: number;
  /** contextWindow - maxOutputTokens: what the prompt may occupy. */
  promptBudget: number;
  promptTokens?: number;
  /** promptTokens / promptBudget, only when the provider reported promptTokens. */
  contextUtilization?: number;
  contextPressureLevel?: ContextPressureLevel;
}

/** < 0.80 normal, >= 0.80 warning, >= 0.95 critical. */
export function pressureLevel(utilization: number): ContextPressureLevel {
  if (utilization >= 0.95) return 'critical';
  if (utilization >= 0.8) return 'warning';
  return 'normal';
}

/**
 * Context pressure from resolved runtime values. `promptTokens` must be the
 * provider's authoritative count; without it there is a budget but no
 * utilisation, rather than a guess.
 */
export function contextPressure(contextWindow: number, maxOutputTokens: number, promptTokens?: number): ContextPressure {
  const promptBudget = contextWindow - maxOutputTokens;
  const result: ContextPressure = { contextWindow, maxOutputTokens, promptBudget };
  if (promptTokens !== undefined && Number.isFinite(promptTokens) && promptBudget > 0) {
    const contextUtilization = Math.round((promptTokens / promptBudget) * 1000) / 1000;
    result.promptTokens = promptTokens;
    result.contextUtilization = contextUtilization;
    result.contextPressureLevel = pressureLevel(contextUtilization);
  }
  return result;
}

/**
 * Output tokens per second of wall-clock turn time. End-to-end: the duration
 * includes prompt processing and network time, so it is lower than a pure
 * decode rate. Undefined whenever the division would not mean anything.
 */
export function endToEndTokensPerSecond(outputTokens: number | undefined, durationMs: number | undefined): number | undefined {
  if (!outputTokens || !durationMs || durationMs <= 0) return undefined;
  return Math.round((outputTokens / (durationMs / 1000)) * 100) / 100;
}

export type ErrorKind =
  | 'context_overflow'
  | 'harmony_parse_error'
  | 'schema_validation_error'
  | 'semantic_validation_error'
  | 'provider_http_error'
  | 'timeout'
  | 'aborted'
  | 'other';

/**
 * Classify a provider, model or tool failure message.
 *
 * Context overflow is checked first and kept distinct from output truncation:
 * overflow is a REQUEST the server refused ("request (…) exceeds the available
 * context size"), truncation is a RESPONSE that stopped at its output limit
 * (finishReason "length"), which is never an error and never lands here.
 */
export function classifyError(message: string | undefined): ErrorKind {
  const text = message ?? '';
  if (/exceeds the available context size|context[ _-]?length[ _-]?exceeded|maximum context length|context window|prompt is too long|too many tokens/i.test(text)) {
    return 'context_overflow';
  }
  if (/does not match [\w.-]+\.schema\.json|fails its schema|not valid JSON/i.test(text)) return 'schema_validation_error';
  // SemanticValidationError: "… is schema-valid but not supported by upstream evidence …"
  if (/semantic|not supported by upstream evidence/i.test(text)) return 'semantic_validation_error';
  if (/timed? ?out|ETIMEDOUT|deadline exceeded/i.test(text)) return 'timeout';
  if (/\babort(ed)?\b/i.test(text)) return 'aborted';
  if (isParserFailure(text)) return 'harmony_parse_error';
  if (/\b(4\d\d|5\d\d)\b/.test(text) && /status|http|error/i.test(text)) return 'provider_http_error';
  return 'other';
}

/** Output ended because it hit its token limit. Distinct from context overflow. */
export function wasTruncated(finishReason: string | undefined): boolean {
  return finishReason === 'length';
}

/** How the host saw an attempt fail, from the problem string `runStage` records. */
export function attemptProblemFlags(problem: string | null | undefined) {
  const text = problem ?? '';
  return {
    notWritten: /was not written|does not exist/.test(text),
    hadParseError: /is not valid JSON/.test(text),
    hadSchemaError: /fails its schema/.test(text),
    hadSemanticError: /fails semantic validation/.test(text),
  };
}
