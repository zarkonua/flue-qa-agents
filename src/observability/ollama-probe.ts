// Facts about the running Ollama model, from Ollama's own `/api/ps`.
//
// The OpenAI-compatible `/v1` endpoint the agents use returns token counts but
// none of Ollama's native timings, so this is the only authoritative source of
// memory placement. Only what the API reports is recorded: `size` and
// `size_vram` are bytes, and a model is "fully GPU resident" only when all of
// it is in VRAM. No GPU or CPU percentage is derived — the API does not give
// enough to state one reliably.

export interface OllamaRunningModel {
  name: string;
  sizeBytes?: number;
  sizeVramBytes?: number;
  contextLength?: number;
  fullyGpuResident?: boolean;
  quantization?: string;
  parameterSize?: string;
}

const PROBE_TIMEOUT_MS = 2_000;

/** Pure: pick and normalise one model out of an `/api/ps` response. */
export function parseRunningModel(body: unknown, modelId: string): OllamaRunningModel | undefined {
  const models = (body as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return undefined;
  const wanted = new Set([modelId, `${modelId}:latest`]);
  const m = models.find((x: any) => wanted.has(x?.name) || wanted.has(x?.model)) as any;
  if (!m) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const size = num(m.size);
  const sizeVram = num(m.size_vram);
  return {
    name: String(m.name ?? m.model),
    ...(size !== undefined ? { sizeBytes: size } : {}),
    ...(sizeVram !== undefined ? { sizeVramBytes: sizeVram } : {}),
    ...(num(m.context_length) !== undefined ? { contextLength: num(m.context_length) } : {}),
    ...(size && sizeVram !== undefined ? { fullyGpuResident: sizeVram >= size } : {}),
    ...(typeof m.details?.quantization_level === 'string' ? { quantization: m.details.quantization_level } : {}),
    ...(typeof m.details?.parameter_size === 'string' ? { parameterSize: m.details.parameter_size } : {}),
  };
}

/** Ask the server; undefined on any failure. Never throws, never waits long. */
export async function ollamaRunningModel(
  baseUrl: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaRunningModel | undefined> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetchImpl(`${root}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    return parseRunningModel(await res.json(), modelId);
  } catch {
    return undefined;
  }
}
