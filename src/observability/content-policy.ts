// What conversation content may leave the machine in a trace. One place.
//
// LANGFUSE_CAPTURE_IO=false (default): no prompt, response, system prompt, tool
// definition, tool argument or tool result is exported — only structure,
// counts, timings and errors. Prompts here carry whole accessibility
// snapshots and repository files; they are large, and they are the product
// under test.
//
// LANGFUSE_CAPTURE_IO=true: content is exported, but every string still passes
// through `redactSecrets`, and browser tool results — accessibility snapshots
// — are cut to a short head, never shipped whole.
//
// In both modes an exception's MESSAGE is kept (redacted, short): a trace that
// cannot say why a call failed is not worth having. Stack traces never leave.

import { truncateContent } from '@flue/runtime/telemetry';
import type { ContentOption, GenAIContentScope, GenAIContentType } from '@flue/runtime/telemetry';
import { redactDeep } from '../lib/redaction.ts';

const IO_TYPES = new Set<GenAIContentType>([
  'input_messages',
  'output_messages',
  'system_instructions',
  'tool_definitions',
  'tool_description',
  'tool_arguments',
  'tool_result',
]);

/** Accessibility snapshots are big and product-specific; a head is enough to debug with. */
const BROWSER_RESULT_MAX_BYTES = 2_048;
const EXCEPTION_MESSAGE_MAX_BYTES = 1_024;

/** Environment variables whose values must never appear in a trace, even by accident. */
const SECRET_ENV_NAMES = ['LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'OPENROUTER_API_KEY'];

/** Well-known credential shapes, masked wherever they occur in a string. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-lf-[A-Za-z0-9-]{8,}/g, // Langfuse secret key
  /\bpk-lf-[A-Za-z0-9-]{8,}/g, // Langfuse public key
  /\bsk-or-[A-Za-z0-9-]{8,}/g, // OpenRouter
  /\bsk-[A-Za-z0-9_-]{20,}/g, // generic OpenAI-style
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, // Authorization header values
];

export const SECRET_MASK = '<redacted-secret>';

/**
 * Mask credentials in a string: the literal values of this process's secret
 * environment variables, known key shapes, then the project's own URL
 * parameter redaction.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join(SECRET_MASK);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, SECRET_MASK);
  return redactDeep(out);
}

function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactValue) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out as unknown as T;
  }
  return value;
}

const isBrowserTool = (scope: GenAIContentScope, toolName: string | undefined) =>
  scope.contentType === 'tool_result' && !!toolName && /(^|__)browser_/.test(toolName);

/**
 * The Flue content option for this configuration. `toolNameOf` resolves the
 * tool a content scope belongs to, since the scope itself carries no name.
 */
export function contentPolicy(captureIo: boolean, toolNameOf: (scope: GenAIContentScope) => string | undefined = () => undefined): ContentOption {
  return {
    transform(content, scope) {
      if (scope.contentType === 'exception_stacktrace') return undefined;
      if (scope.contentType === 'exception_message') {
        return truncateContent(redactValue(content), { maxBytes: EXCEPTION_MESSAGE_MAX_BYTES });
      }
      if (IO_TYPES.has(scope.contentType) && !captureIo) return undefined;
      const redacted = redactValue(content);
      if (isBrowserTool(scope, toolNameOf(scope))) {
        return truncateContent(redacted, { maxBytes: BROWSER_RESULT_MAX_BYTES });
      }
      return redacted;
    },
  };
}
