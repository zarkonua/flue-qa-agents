// Proposals come from a model and may be malformed — showing an INVALID one is
// part of the job. These read any value as the shape a component expects,
// without trusting it.

export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : v === undefined || v === null || v === '' ? [] : [String(v)];

export const steps = (v: unknown): { action: string; expected: string }[] =>
  Array.isArray(v)
    ? v.map((s) => (s && typeof s === 'object'
      ? { action: String((s as { action?: unknown }).action ?? ''), expected: String((s as { expected?: unknown }).expected ?? '') }
      : { action: String(s), expected: '' }))
    : [];

export const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
