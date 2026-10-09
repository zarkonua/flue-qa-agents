// What a run started from the workspace may be configured with — decided by
// host configuration, shown to the browser, and checked again on every start.
//
// The browser picks among these values; it never supplies one. Nothing secret
// is ever part of the view: a model that needs a key says whether the key is
// configured, never what it is.
//
//   TARGET_URL          the target (and the default)
//   QA_UI_TARGETS       further targets the workspace may start runs against (comma-separated)
//   QA_MODEL            the model (and the default)
//   QA_UI_MODELS        further models the workspace may start runs with (comma-separated)
//   QA_FRESH_BROWSER    the default of the fresh-browser switch
//   QA_COVERAGE_MODE    the default coverage mode (automatic | ui | api)
//   QA_API_DOCS_URL     the default API documentation URL
//
// The API documentation URL is the one value a person types rather than picks:
// where a product keeps its OpenAPI document is not something the host can
// enumerate. It is checked as plain data — http(s), no credentials, bounded —
// and only ever fetched by host code with GET; it never becomes a command or a path.
//   QA_DISCOVERY_AUX_ORIGINS, LANGFUSE_*  shown read-only

import { auxiliaryOrigins } from '../config/auxiliary-origins.ts';
import { envString } from '../config/env.ts';
import { safeTarget } from '../history/run-history-store.ts';
import { readObservabilityConfig } from '../observability/config.ts';
import {
  COVERAGE_MODES, DEFAULT_COVERAGE_MODE, normalizeApiDocsUrl, parseCoverageMode, usesApiDocs, type CoverageMode,
} from '../lib/coverage-mode.ts';

export const PIPELINES = ['PHASE1_MANUAL'] as const;
export type Pipeline = (typeof PIPELINES)[number];

export interface ModelOption { id: string; provider: string; default: boolean; available: boolean; reason?: string }
export interface RunConfigView {
  pipelines: Pipeline[];
  targets: { url: string; default: boolean }[];
  models: ModelOption[];
  freshBrowser: { default: boolean };
  /** The coverage modes a run may be started in, and which one the form starts on. */
  coverageModes: { id: CoverageMode; default: boolean }[];
  /** The API documentation URL the form starts with, when the host configures one. */
  apiDocs: { default: string | null };
  auxiliaryOrigins: string[];
  langfuse: { enabled: boolean; baseUrl?: string };
}

// There is no authentication bootstrap on main: discovery signs up or signs in through the
// product's own UI, so a run has nothing like an auth mode to choose.
// `coverageMode` and `apiDocsUrl` are optional: a client from before coverage modes sends neither and gets AUTOMATIC.
export interface StartRequest { pipeline: Pipeline; target: string; model: string; freshBrowser: boolean; coverageMode?: CoverageMode; apiDocsUrl?: string }
/** What the controller hands the runner: host-configured values, and a checked URL — never a raw string from the browser. */
export interface ValidatedRun { pipeline: Pipeline; target: string; model: string; freshBrowser: boolean; coverageMode: CoverageMode; apiDocsUrl?: string }

export class RunConfigError extends Error {
  name = 'RunConfigError';
}

const list = (name: string) => (envString(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MODEL = /^(ollama|openrouter)\/[A-Za-z0-9._:/-]{1,120}$/;

export function readRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfigView {
  const defaultTarget = safeTarget(env.TARGET_URL);
  const targets = [...new Set([defaultTarget, ...list('QA_UI_TARGETS').map(safeTarget)].filter((t): t is string => t !== null))];
  const defaultModel = env.QA_MODEL?.trim() || 'ollama/qwen3:14b';
  const models = [...new Set([defaultModel, ...list('QA_UI_MODELS')])].filter((m) => MODEL.test(m)).map((id): ModelOption => {
    const provider = id.slice(0, id.indexOf('/'));
    const keyMissing = provider === 'openrouter' && !env.OPENROUTER_API_KEY?.trim();
    return { id, provider, default: id === defaultModel, available: !keyMissing, ...(keyMissing ? { reason: 'OPENROUTER_API_KEY is not configured' } : {}) };
  });
  let langfuse: RunConfigView['langfuse'] = { enabled: false };
  try {
    const c = readObservabilityConfig();
    if (c.enabled) langfuse = { enabled: true, baseUrl: c.baseUrl };
  } catch {
    langfuse = { enabled: false };
  }
  let aux: string[] = [];
  try {
    aux = auxiliaryOrigins();
  } catch {
    aux = [];
  }
  return {
    pipelines: [...PIPELINES],
    targets: targets.map((url) => ({ url, default: url === defaultTarget })),
    models,
    freshBrowser: { default: env.QA_FRESH_BROWSER === 'true' },
    coverageModes: COVERAGE_MODES.map((id) => ({ id, default: id === (parseCoverageMode(env.QA_COVERAGE_MODE) ?? DEFAULT_COVERAGE_MODE) })),
    apiDocs: { default: normalizeApiDocsUrl(env.QA_API_DOCS_URL) ?? null },
    auxiliaryOrigins: aux,
    langfuse,
  };
}

/** Check a start request against the configuration. Returns the host's own values for what was chosen. */
export function validateStartRequest(request: StartRequest, config: RunConfigView): ValidatedRun {
  if (!PIPELINES.includes(request.pipeline)) throw new RunConfigError('Only Phase 1 can be started from the workspace.');
  const target = config.targets.find((t) => t.url === safeTarget(request.target));
  if (!target) throw new RunConfigError('That target is not configured for this workspace (TARGET_URL / QA_UI_TARGETS).');
  const model = config.models.find((m) => m.id === request.model);
  if (!model) throw new RunConfigError('That model is not configured for this workspace (QA_MODEL / QA_UI_MODELS).');
  if (!model.available) throw new RunConfigError(`That model cannot run: ${model.reason}.`);
  if (typeof request.freshBrowser !== 'boolean') throw new RunConfigError('freshBrowser must be true or false.');

  const coverageMode = request.coverageMode === undefined
    ? config.coverageModes.find((m) => m.default)?.id ?? DEFAULT_COVERAGE_MODE
    : config.coverageModes.find((m) => m.id === request.coverageMode)?.id;
  if (!coverageMode) throw new RunConfigError('That coverage mode is not one of: Automatic, UI only, API only.');

  // UI only reads no API documentation, so a URL sent with it is dropped rather than refused.
  let apiDocsUrl: string | undefined;
  if (usesApiDocs(coverageMode)) {
    const raw = request.apiDocsUrl?.trim();
    if (raw) {
      apiDocsUrl = normalizeApiDocsUrl(raw);
      if (!apiDocsUrl) throw new RunConfigError('The API documentation URL must be an http(s) URL without embedded credentials.');
    } else if (request.apiDocsUrl === undefined) {
      // Not sent at all (an older client, or the CLI's own default): the host's configured one applies.
      apiDocsUrl = config.apiDocs.default ?? undefined;
    }
    if (coverageMode === 'API_ONLY' && !apiDocsUrl) {
      throw new RunConfigError('API only needs an API documentation URL: without one there is no documented operation to test.');
    }
  }
  return { pipeline: request.pipeline, target: target.url, model: model.id, freshBrowser: request.freshBrowser, coverageMode, ...(apiDocsUrl ? { apiDocsUrl } : {}) };
}
