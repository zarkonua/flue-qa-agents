// Field-level diff of two test cases: what a person reads before applying a
// proposal. Pure, so it is tested without a browser.

export interface Step {
  action: string;
  expected: string;
}

/** Any case-shaped object; fields are compared by name. */
export type CaseLike = object;

export type StepChange =
  | { type: 'unchanged'; before: Step; after: Step }
  | { type: 'added'; after: Step }
  | { type: 'removed'; before: Step }
  | { type: 'changed'; before: Step; after: Step };

export type FieldChange =
  | { kind: 'scalar'; field: string; before: unknown; after: unknown }
  | { kind: 'list'; field: string; added: string[]; removed: string[] }
  | { kind: 'object'; field: string; added: string[]; removed: string[]; changed: string[] }
  | { kind: 'steps'; field: 'steps'; changes: StepChange[] };

/** Field order as a reader expects it, then anything else in name order. */
const ORDER = ['title', 'priority', 'types', 'preconditions', 'testData', 'steps', 'expectedResult', 'covers', 'evidenceIds', 'automationCandidate', 'automationReason', 'tags'];

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stepKey = (s: Step) => `${s.action}\u0000${s.expected}`;

/**
 * Steps as a sequence: unchanged steps are matched by longest common
 * subsequence, and a removed step immediately followed by an added one at the
 * same place reads as one changed step.
 */
export function diffSteps(before: Step[], after: Step[]): StepChange[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = stepKey(before[i]) === stepKey(after[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const raw: StepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && stepKey(before[i]) === stepKey(after[j])) raw.push({ type: 'unchanged', before: before[i++], after: after[j++] });
    // On a tie, remove first: a replaced step then reads as removal + addition, paired below.
    else if (j < m && (i === n || lcs[i][j + 1] > lcs[i + 1][j])) raw.push({ type: 'added', after: after[j++] });
    else raw.push({ type: 'removed', before: before[i++] });
  }
  // Pair each run of removals with the additions that follow it.
  const out: StepChange[] = [];
  for (let k = 0; k < raw.length; ) {
    const removed: Step[] = [];
    const added: Step[] = [];
    while (k < raw.length && raw[k].type === 'removed') removed.push((raw[k++] as { before: Step }).before);
    while (k < raw.length && raw[k].type === 'added') added.push((raw[k++] as { after: Step }).after);
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) out.push({ type: 'changed', before: removed[p], after: added[p] });
    for (const s of removed.slice(pairs)) out.push({ type: 'removed', before: s });
    for (const s of added.slice(pairs)) out.push({ type: 'added', after: s });
    if (removed.length === 0 && added.length === 0) out.push(raw[k++]);
  }
  return out;
}

/** Every field that differs between `before` and `after`. The id is never part of a diff. */
export function diffCases(before: CaseLike | undefined, after: CaseLike | undefined): FieldChange[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((f) => f !== 'id')
    .sort((x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99) || x.localeCompare(y));
  const out: FieldChange[] = [];
  for (const field of fields) {
    const [old, next] = [b[field], a[field]];
    if (same(old, next)) continue;
    if (field === 'steps' && (old === undefined || isSteps(old)) && (next === undefined || isSteps(next))) {
      out.push({ kind: 'steps', field, changes: diffSteps((old as Step[]) ?? [], (next as Step[]) ?? []) });
    } else if ((old === undefined || isStrings(old)) && (next === undefined || isStrings(next)) && (isStrings(old) || isStrings(next))) {
      const [o, x] = [(old as string[]) ?? [], (next as string[]) ?? []];
      out.push({ kind: 'list', field, added: x.filter((v) => !o.includes(v)), removed: o.filter((v) => !x.includes(v)) });
    } else if (isPlainObject(old ?? {}) && isPlainObject(next ?? {}) && (isPlainObject(old) || isPlainObject(next))) {
      const [o, x] = [(old ?? {}) as Record<string, unknown>, (next ?? {}) as Record<string, unknown>];
      out.push({
        kind: 'object',
        field,
        added: Object.keys(x).filter((k) => !(k in o)),
        removed: Object.keys(o).filter((k) => !(k in x)),
        changed: Object.keys(x).filter((k) => k in o && !same(o[k], x[k])),
      });
    } else {
      out.push({ kind: 'scalar', field, before: old, after: next });
    }
  }
  return out;
}

function isSteps(v: unknown): v is Step[] {
  return Array.isArray(v) && v.every((s) => isPlainObject(s) && typeof s.action === 'string' && typeof s.expected === 'string');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
