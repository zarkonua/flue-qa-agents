// How one QA run's trace crosses the process boundary.
//
// Every stage attempt is its own `flue run` process, so the host hands each
// one the W3C `traceparent` of its stage observation plus a small JSON context
// (run id, stage, attempt, trace name/tags/metadata). Both travel ONLY in the
// environment of the child being spawned — never in the host's own
// `process.env` — so nothing can leak into a later run.
//
// The host always sets both variables, to empty strings when there is nothing
// to propagate. An agent process therefore never inherits a stale context from
// whatever shell or parent process launched the host.

export const TRACEPARENT_ENV = 'QA_OBS_TRACEPARENT';
export const CONTEXT_ENV = 'QA_OBS_CONTEXT';

export interface AgentTraceContext {
  runId: string;
  stage: string;
  attempt: number;
  resumed: boolean;
  traceName: string;
  tags: string[];
  /** Trace-level metadata: strings only, so they filter cleanly in Langfuse. */
  traceMetadata: Record<string, string>;
}

export interface RemoteParent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = /^0+$/;

export function formatTraceparent(parent: RemoteParent): string {
  return `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags.toString(16).padStart(2, '0')}`;
}

/** A valid W3C traceparent, or undefined. All-zero ids are invalid by spec. */
export function parseTraceparent(value: string | undefined): RemoteParent | undefined {
  const match = value ? TRACEPARENT.exec(value.trim()) : null;
  if (!match || ZERO_TRACE.test(match[1]) || ZERO_TRACE.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2], traceFlags: parseInt(match[3], 16) };
}

/** The env a spawned agent needs. Empty values when no trace is active. */
export function childTraceEnv(parent: RemoteParent | undefined, context: AgentTraceContext | undefined): Record<string, string> {
  return {
    [TRACEPARENT_ENV]: parent ? formatTraceparent(parent) : '',
    [CONTEXT_ENV]: parent && context ? JSON.stringify(context) : '',
  };
}

/** Read the propagated context in an agent process. Malformed input is ignored, never fatal. */
export function readAgentTraceContext(env: NodeJS.ProcessEnv = process.env): { parent?: RemoteParent; context?: AgentTraceContext } {
  const parent = parseTraceparent(env[TRACEPARENT_ENV]);
  if (!parent) return {};
  try {
    const raw = JSON.parse(env[CONTEXT_ENV] ?? '');
    if (typeof raw?.runId !== 'string' || typeof raw?.stage !== 'string') return { parent };
    return {
      parent,
      context: {
        runId: raw.runId,
        stage: raw.stage,
        attempt: Number.isInteger(raw.attempt) ? raw.attempt : 1,
        resumed: raw.resumed === true,
        traceName: typeof raw.traceName === 'string' ? raw.traceName : 'qa-run',
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : [],
        traceMetadata:
          raw.traceMetadata && typeof raw.traceMetadata === 'object'
            ? Object.fromEntries(Object.entries(raw.traceMetadata).map(([k, v]) => [k, String(v)]))
            : {},
      },
    };
  } catch {
    return { parent };
  }
}
