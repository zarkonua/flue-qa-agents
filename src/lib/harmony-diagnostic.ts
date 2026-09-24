// A sanitized record of the request shape that provoked a provider parse error.
//
// The local gpt-oss builds intermittently fail with
//
//     llama-server chat error: The model produced output that does not match
//     the expected peg-native format
//
// which is Ollama's PEG parser refusing the model's own harmony output. Three
// hypotheses have been tested against the live server and disproved: replaying
// versus stripping historical reasoning, prompt size (Ollama answers a clean
// HTTP 400 on overflow rather than truncating), and streaming with a long
// tool-call history. None reproduce it synthetically, so the remaining way to
// learn anything is to capture the shape of the request that does.
//
// Deliberately *structural*. A full payload dump would carry the page snapshots
// the run is holding — and with them confirmation codes, mailbox ids and
// session values. What lands on disk is counts, roles, names and sizes, and
// even those go through the same redaction every artifact goes through.
//
// This never repairs anything. A failed turn stays failed: converting malformed
// output into a tool call with a regex would hide the very interaction we are
// trying to understand.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QA_ARTIFACT_ROOT } from './qa-artifacts.ts';
import { redactDeep } from './redaction.ts';

export const DIAGNOSTIC_FILE = 'provider-diagnostics.jsonl';

export const diagnosticPath = (): string => join(QA_ARTIFACT_ROOT, DIAGNOSTIC_FILE);

/** The errors worth capturing: a provider-side parse or format failure. */
export function isParserFailure(message: string): boolean {
  return /peg-native|does not match the expected|chat error|parse/i.test(message);
}

/** Rough token estimate. Only ever used to say "large" or "small". */
const estimateTokens = (chars: number) => Math.round(chars / 4);

interface Message {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/**
 * Describe a request without reproducing it.
 *
 * Roles, counts and sizes tell us whether the failure follows a particular
 * message shape — a tool result, a long assistant turn, a specific tool — which
 * is what no synthetic probe has managed to provoke.
 */
export function describeRequest(payload: unknown): Record<string, unknown> {
  const body = (payload ?? {}) as {
    model?: string;
    messages?: Message[];
    tools?: { function?: { name?: string } }[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chars = messages.reduce(
    (total, m) => total + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length),
    0,
  );
  const toolCallTurns = messages.filter((m) => Array.isArray(m?.tool_calls) && m.tool_calls.length > 0).length;

  return {
    model: body.model ?? null,
    stream: body.stream ?? null,
    sampling: { temperature: body.temperature ?? null, topP: body.top_p ?? null, maxTokens: body.max_tokens ?? null },
    messageCount: messages.length,
    roleSequence: messages.map((m) => m?.role ?? '?').join(','),
    // The tail is where a malformed turn would sit.
    lastRoles: messages.slice(-4).map((m) => ({
      role: m?.role ?? '?',
      contentChars: typeof m?.content === 'string' ? m.content.length : undefined,
      toolCalls: Array.isArray(m?.tool_calls) ? m.tool_calls.length : undefined,
      isToolResult: typeof m?.tool_call_id === 'string',
    })),
    historicalToolCallTurns: toolCallTurns,
    historicalToolResults: messages.filter((m) => typeof m?.tool_call_id === 'string').length,
    toolDefinitionCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolNames: Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name ?? '?') : [],
    promptChars: chars,
    estimatedPromptTokens: estimateTokens(chars),
  };
}

/** What came back, by shape rather than by content. */
export function describeResponse(response: unknown): Record<string, unknown> {
  if (typeof response !== 'object' || response === null) return { shape: typeof response };
  const body = response as Record<string, unknown>;
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  return {
    topLevelFields: Object.keys(body),
    finishReason: choice?.finish_reason ?? null,
    producedContent: typeof message?.content === 'string' && message.content.length > 0,
    contentChars: typeof message?.content === 'string' ? message.content.length : 0,
    producedToolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    messageFields: message ? Object.keys(message) : [],
  };
}

export interface HarmonyDiagnostic {
  at: string;
  kind: 'provider-parse-failure';
  error: { status?: number; type?: string; message: string };
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  /** The failing fragment, when the provider gave us one. Redacted. */
  fragment?: string;
  replayReasoning: boolean;
}

/**
 * Append one sanitized record. Never throws: a diagnostic that breaks the run
 * it is diagnosing is worse than no diagnostic.
 */
export function recordHarmonyFailure(entry: Omit<HarmonyDiagnostic, 'at' | 'kind'>): string | undefined {
  try {
    const record: HarmonyDiagnostic = {
      at: new Date().toISOString(),
      kind: 'provider-parse-failure',
      ...entry,
      // Everything, including the error text and any fragment, goes through the
      // same redaction as an artifact. A fragment of a failing turn can quote a
      // confirmation link the run had just opened.
      ...redactDeep({ error: entry.error, request: entry.request, response: entry.response, fragment: entry.fragment }),
    };
    const path = diagnosticPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    return path;
  } catch {
    return undefined;
  }
}
