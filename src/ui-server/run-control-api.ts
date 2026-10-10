// Starting, following and cancelling a Phase 1 run from the workspace.
//
//   GET  /api/run-config            what a run may be started with (host configuration; nothing secret)
//   POST /api/runs                  start a Phase 1 run            { pipeline, target, model, freshBrowser, coverageMode?, apiDocsUrl? }
//   POST /api/api-docs/preview      read API documentation and say what live validation would call  { apiDocsUrl, apiBaseUrl? }
//   POST /api/runs/:runId/cancel    cancel a run this workspace started
//   GET  /api/runs/:runId/events    the run's structured events, as Server-Sent Events
//
// Starting and cancelling are privileged: strict bodies, same-origin only (the
// server refuses cross-origin writes), and the controller — never the request —
// decides the command, the environment and which process may be signalled.
//
// The event stream reads the run's own event log (`runs/<run-id>/events.jsonl`,
// redacted when written). It resumes after `Last-Event-ID`, replays a bounded
// window, and ends after the run's final event. Closing it never affects the run.

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as v from 'valibot';
import type { RunHistoryStore } from '../history/run-history-store.ts';
import { RUN_ID } from '../history/types.ts';
import { isFinal, readEventLog, type RunEvent } from '../run-control/events.ts';
import { PIPELINES, RunConfigError } from '../run-control/run-config.ts';
import { COVERAGE_MODES, displayApiDocsUrl, MAX_API_DOCS_URL, normalizeApiDocsUrl } from '../lib/coverage-mode.ts';
import { discoverApiDocument, hasApi } from '../lib/api-discovery.ts';
import { normalizeBaseUrl, OPERATION_KEY, planApiValidation } from '../lib/api-validation.ts';
import { MAX_APPROVED_OPERATIONS } from '../run-control/run-config.ts';
import { RunConflictError, type RunController } from '../run-control/run-controller.ts';
import { RunsApiError } from './runs-api.ts';

type Handler = [string, RegExp, (m: RegExpExecArray, req: IncomingMessage) => Promise<[number, unknown]>];
type ReadBody = <T>(req: IncomingMessage, schema: v.GenericSchema<unknown, T>) => Promise<T>;

const StartBody = v.strictObject({
  pipeline: v.picklist(PIPELINES),
  // Optional: a run that does not explore the interface names none.
  target: v.optional(v.pipe(v.string(), v.maxLength(300))),
  model: v.pipe(v.string(), v.maxLength(200)),
  freshBrowser: v.boolean(),
  // Optional, so a client from before coverage modes still starts an AUTOMATIC run.
  coverageMode: v.optional(v.picklist(COVERAGE_MODES)),
  apiDocsUrl: v.optional(v.pipe(v.string(), v.maxLength(MAX_API_DOCS_URL))),
  liveValidation: v.optional(v.boolean()),
  apiBaseUrl: v.optional(v.pipe(v.string(), v.maxLength(MAX_API_DOCS_URL))),
  approvedOperations: v.optional(v.pipe(v.array(v.pipe(v.string(), v.regex(OPERATION_KEY))), v.maxLength(MAX_APPROVED_OPERATIONS))),
});
const PreviewBody = v.strictObject({
  apiDocsUrl: v.pipe(v.string(), v.maxLength(MAX_API_DOCS_URL)),
  apiBaseUrl: v.optional(v.pipe(v.string(), v.maxLength(MAX_API_DOCS_URL))),
});
const EmptyBody = v.strictObject({});

/** Events replayed to a (re)connecting client at most — the rest are in the archive. */
export const REPLAY_LIMIT = 500;
const POLL_MS = 400;
const HEARTBEAT_MS = 15_000;

function runId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!RUN_ID.test(id)) throw new RunsApiError(400, 'Invalid run id.');
  return id;
}

/** Only what the page needs about who holds the lock — never a pid. */
const holderView = (h: { runId?: string; model?: string; command?: string; startedAt?: string } | undefined) =>
  h ? { runId: h.runId ?? null, model: h.model ?? null, command: h.command ?? null, startedAt: h.startedAt ?? null } : null;

export function runControlRoutes(deps: { controller?: RunController; readBody: ReadBody }): Handler[] {
  const controller = () => {
    if (!deps.controller) throw new RunsApiError(503, 'Starting runs is not available on this server.');
    return deps.controller;
  };
  return [
    ['GET', /^\/api\/run-config$/, async () => {
      const c = controller();
      const active = c.activeRun();
      return [200, {
        config: c.config(),
        activeRun: active ? { runId: active.runId, status: active.status, model: active.model, coverageMode: active.coverageMode, startedAt: active.startedAt, cancelRequested: active.cancelRequested } : null,
        lockHolder: holderView(c.lockHolder()),
      }];
    }],

    ['POST', /^\/api\/runs$/, async (_m, req) => {
      const request = await deps.readBody(req, StartBody);
      try {
        const run = controller().start(request);
        return [202, { runId: run.runId, status: run.status }];
      } catch (error) {
        if (error instanceof RunConfigError) throw new RunsApiError(400, error.message);
        if (error instanceof RunConflictError) {
          const h = holderView(error.holder);
          throw new RunsApiError(409, `${error.message}${h?.runId ? ` Run: ${h.runId}.` : ''}${h?.model ? ` Model: ${h.model}.` : ''}${h?.startedAt ? ` Started: ${h.startedAt}.` : ''}`);
        }
        throw error;
      }
    }],

    // Reads the documentation — one bounded GET by host code, exactly what starting a run does —
    // and reports what live validation would call. Nothing is sent to the API itself.
    ['POST', /^\/api\/api-docs\/preview$/, async (_m, req) => {
      const body = await deps.readBody(req, PreviewBody);
      const config = controller().config();
      const docsUrl = normalizeApiDocsUrl(body.apiDocsUrl);
      if (!docsUrl) throw new RunsApiError(400, 'The API documentation URL must be an http(s) URL without embedded credentials.');
      const rawBase = body.apiBaseUrl?.trim();
      const baseUrl = rawBase ? normalizeBaseUrl(rawBase) : config.apiValidation.baseUrl ?? undefined;
      if (rawBase && !baseUrl) throw new RunsApiError(400, 'The API base URL must be an http(s) URL without embedded credentials.');
      const { discovery, spec } = await discoverApiDocument(docsUrl);
      const documentation = { status: discovery.status, reason: discovery.reason ?? null, title: discovery.title ?? null, url: displayApiDocsUrl(docsUrl), operations: discovery.endpoints.length };
      if (!hasApi(discovery) || !spec) return [200, { documentation, plan: null, credentialsConfigured: config.apiValidation.credentialsConfigured }];
      const plan = planApiValidation(spec, discovery, {
        docsUrl, baseUrlOverride: baseUrl, targetUrl: config.targets.find((t) => t.default)?.url,
        allowedHosts: [...config.targets.map((t) => t.url), ...config.apiValidation.extraAllowedHosts], environment: config.apiValidation.environment,
      });
      return [200, { documentation, plan, credentialsConfigured: config.apiValidation.credentialsConfigured }];
    }],

    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, async (m, req) => {
      const id = runId(m[1]);
      await deps.readBody(req, EmptyBody);
      try {
        if (!controller().cancel(id)) throw new RunsApiError(404, 'That run is not active in this workspace.');
      } catch (error) {
        if (error instanceof RunConflictError) throw new RunsApiError(409, error.message);
        throw error;
      }
      return [202, { accepted: true }];
    }],
  ];
}

const SSE_PATH = /^\/api\/runs\/([^/]+)\/events$/;

/** Serve `GET /api/runs/:runId/events`, or return false when the path is not that. */
export function serveRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: { artifactRoot: string; history?: () => RunHistoryStore; controller?: RunController },
): boolean {
  const m = SSE_PATH.exec(path);
  if (!m || req.method !== 'GET') return false;
  const id = runId(m[1]);
  let known = false;
  try {
    known = !!deps.history?.().getRun(id);
  } catch { /* history unavailable: the controller may still know the run */ }
  if (!known && !deps.controller?.getRun(id)) throw new RunsApiError(404, 'No such run.');

  // Resume point: the browser's Last-Event-ID on reconnect, or ?after= on a fresh page.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('after') ?? '0';
  if (!/^\d{1,9}$/.test(raw)) throw new RunsApiError(400, 'Invalid event id.');
  let lastId = Number(raw);

  const log = join(deps.artifactRoot, 'runs', id, 'events.jsonl');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let ended = false;
  const send = (e: RunEvent) => {
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    lastId = e.id;
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    res.write('event: end\ndata: {}\n\n');
    res.end();
  };
  /** Is the run over, by the history's account? (A run with no final event yet but a closed row has nothing more coming.) */
  const closed = () => {
    try {
      const row = deps.history?.().getRun(id);
      if (row) return row.status !== 'STARTING' && row.status !== 'RUNNING';
    } catch { /* fall through */ }
    const c = deps.controller?.getRun(id);
    return c ? !deps.controller?.activeRun() || deps.controller.activeRun()!.runId !== id : true;
  };

  let quietTicks = 0;
  const tick = () => {
    if (ended) return;
    const fresh = readEventLog(log, { afterId: lastId, limit: REPLAY_LIMIT });
    for (const e of fresh) send(e);
    if (fresh.some(isFinal)) return finish();
    // A run that ended without a final event (it could not write one) still ends the stream — after a short grace.
    quietTicks = fresh.length === 0 && closed() ? quietTicks + 1 : 0;
    if (quietTicks >= 3) finish();
  };
  const poll = setInterval(tick, POLL_MS);
  const heartbeat = setInterval(() => { if (!ended) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  // The browser leaving stops this stream — never the run.
  req.on('close', () => {
    ended = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  });
  tick();
  return true;
}
