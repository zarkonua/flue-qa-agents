// The run event contract: the only shape that reaches the workspace's live view.
//
// Host code emits events through `normalizeEvent`, which keeps a closed set of
// fields, bounds them, and redacts every string with the same redaction as
// artifacts and traces. Nothing from an agent, a tool or a library is passed
// through as-is: a tool event carries the tool's name and outcome, never its
// arguments or result.
//
// Events are appended to `.qa/runs/<run-id>/events.jsonl` as they happen — by
// the CLI and by a workspace-started run alike — and the workspace streams
// that file over SSE. The file is the event log: ordered, reconnectable by id,
// and still there after the run, the server or the browser restarts.

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitizeText } from '../history/run-history-store.ts';
import { METRIC_NAME } from '../history/types.ts';

export const EVENT_TYPES = [
  'RUN_STARTED', 'RUN_RUNNING', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED',
  'STAGE_STARTED', 'STAGE_COMPLETED', 'STAGE_FAILED', 'STAGE_CANCELLED',
  'ATTEMPT_STARTED', 'ATTEMPT_FAILED',
  'TOOL_STARTED', 'TOOL_COMPLETED', 'TOOL_FAILED',
  'ARTIFACT_CREATED',
  'METRIC_UPDATED',
  'LOG',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** How the live log groups events for its filters. */
export const EVENT_CATEGORIES = ['RUN', 'STAGE', 'AGENT', 'BROWSER', 'TOOL', 'ARTIFACT', 'METRIC', 'LOG'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export type EventLevel = 'info' | 'warn' | 'error';

export interface RunEvent {
  id: number;
  runId: string;
  timestamp: string;
  type: EventType;
  category: EventCategory;
  level: EventLevel;
  message: string;
  stage?: string;
  stageLabel?: string;
  attempt?: number;
  tool?: string;
  artifactType?: string;
  count?: number;
  metrics?: Record<string, number>;
  /** RUN_STARTED only: the stages this run will execute, in order. */
  plan?: { key: string; label: string }[];
  status?: string;
  errorCode?: string;
}

export type EventInput = Omit<RunEvent, 'id' | 'runId' | 'timestamp' | 'category' | 'level'> & { level?: EventLevel; category?: EventCategory };

/** Hard ceilings: an event log is a view of a run, never a dump of it. */
export const MAX_EVENTS_PER_RUN = 5000;
const MAX_MESSAGE = 300;

function categoryOf(type: EventType, tool?: string): EventCategory {
  if (type.startsWith('RUN_')) return 'RUN';
  if (type.startsWith('STAGE_')) return 'STAGE';
  if (type.startsWith('ATTEMPT_')) return 'AGENT';
  if (type.startsWith('TOOL_')) return tool?.startsWith('browser_') ? 'BROWSER' : 'TOOL';
  if (type === 'ARTIFACT_CREATED') return 'ARTIFACT';
  if (type === 'METRIC_UPDATED') return 'METRIC';
  return 'LOG';
}

const word = (v: unknown, max = 60) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(v) ? v.slice(0, max) : undefined);

/** One host-controlled event: closed fields, bounded, redacted. Throws on an unknown type. */
export function normalizeEvent(runId: string, id: number, input: EventInput, now = new Date()): RunEvent {
  if (!EVENT_TYPES.includes(input.type)) throw new Error(`Unknown run event type: ${String(input.type).slice(0, 40)}`);
  const tool = word(input.tool)?.replace(/^mcp__[a-z0-9]+__/, '');
  const event: RunEvent = {
    id,
    runId,
    timestamp: now.toISOString(),
    type: input.type,
    category: input.category && EVENT_CATEGORIES.includes(input.category) ? input.category : categoryOf(input.type, tool),
    level: input.level === 'warn' || input.level === 'error' ? input.level : input.type.endsWith('_FAILED') ? 'error' : 'info',
    message: sanitizeText(input.message, MAX_MESSAGE) ?? input.type,
  };
  const stage = word(input.stage);
  if (stage) event.stage = stage;
  const label = sanitizeText(input.stageLabel, 60);
  if (label) event.stageLabel = label;
  if (Number.isInteger(input.attempt) && input.attempt! > 0) event.attempt = input.attempt;
  if (tool) event.tool = tool;
  const artifactType = word(input.artifactType);
  if (artifactType) event.artifactType = artifactType;
  if (Number.isInteger(input.count) && input.count! >= 0) event.count = input.count;
  if (input.metrics) {
    const metrics = Object.fromEntries(Object.entries(input.metrics).filter(([k, v]) => METRIC_NAME.test(k) && Number.isFinite(v)).slice(0, 60));
    if (Object.keys(metrics).length > 0) event.metrics = metrics;
  }
  if (Array.isArray(input.plan)) {
    event.plan = input.plan.slice(0, 20).map((p) => ({ key: word(p.key) ?? 'stage', label: sanitizeText(p.label, 60) ?? p.key }));
  }
  const status = word(input.status);
  if (status) event.status = status;
  const errorCode = word(input.errorCode);
  if (errorCode) event.errorCode = errorCode;
  return event;
}

/**
 * Append-only writer for one run's event log. Never throws into the run: an
 * event that cannot be written is dropped (the run's history and archive are
 * the record; the event log is a view).
 */
export class EventLogWriter {
  private nextId = 1;
  private written = 0;
  private truncated = false;
  readonly path: string;
  readonly runId: string;
  private readonly onEvent?: (e: RunEvent) => void;

  constructor(path: string, runId: string, options: { onEvent?: (e: RunEvent) => void } = {}) {
    this.path = path;
    this.runId = runId;
    this.onEvent = options.onEvent;
    // Continue numbering if the log already exists (a resumed writer never reuses an id).
    if (existsSync(path)) {
      const last = readEventLog(path, { tail: 1 }).at(-1);
      if (last) this.nextId = last.id + 1;
      this.written = this.nextId - 1;
    }
  }

  emit(input: EventInput): RunEvent | undefined {
    try {
      // Past the ceiling only the run's outline is kept: stages, artifacts, metrics and the end.
      const outline = !input.type.startsWith('TOOL_') && input.type !== 'LOG';
      if (this.written >= MAX_EVENTS_PER_RUN && !outline) {
        if (this.truncated) return undefined;
        this.truncated = true;
        input = { type: 'LOG', level: 'warn', message: `Event log reached ${MAX_EVENTS_PER_RUN} events; tool and log events are no longer recorded for this run.` };
      }
      const event = normalizeEvent(this.runId, this.nextId, input);
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
      this.nextId += 1;
      this.written += 1;
      this.onEvent?.(event);
      return event;
    } catch {
      return undefined;
    }
  }
}

/**
 * Read an event log: events after `afterId`, at most `limit` (the most recent
 * ones), or the last `tail`. Malformed lines are skipped — the file is read by
 * the server, and a half-written last line must not break the stream.
 */
export function readEventLog(path: string, options: { afterId?: number; limit?: number; tail?: number } = {}): RunEvent[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  // Bounded read: never more than the last 4 MB of a log.
  const start = Math.max(0, size - 4 * 1024 * 1024);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // a partial first line
  const events: RunEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RunEvent;
      if (Number.isInteger(e.id) && EVENT_TYPES.includes(e.type)) events.push(e);
    } catch { /* a line still being written */ }
  }
  const after = options.afterId ?? 0;
  const selected = events.filter((e) => e.id > after);
  const limit = options.tail ?? options.limit;
  return limit !== undefined ? selected.slice(-limit) : selected;
}

export const isFinal = (e: RunEvent) => e.type === 'RUN_COMPLETED' || e.type === 'RUN_FAILED' || e.type === 'RUN_CANCELLED';
