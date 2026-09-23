// The observation ledger: what Product Discovery actually saw, recorded as it
// happens rather than reconstructed from memory at the end.
//
// Why this exists. A measured run explored correctly — navigate, four
// snapshots, three clicks, two types, no tool errors — and then wrote a single
// behavior. The exploration was not the problem; synthesis was. The model held
// ten meaningful observations in its head and preserved one.
//
// So observations stop being something the model remembers. They are appended
// here, one at a time, through a narrow host tool; the host assigns the IDs;
// and at write time the validator requires every one of them to be either
// represented by a behavior or explicitly excluded with a reason.
//
// Append-only by construction. The tool cannot update or delete an entry, the
// model never supplies an ID, and nothing here reaches any path outside the
// artifact root.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QA_ARTIFACT_ROOT } from './qa-artifacts.ts';

/** Enough for a thorough local run; a guard against a runaway loop, not a target. */
export const MAX_OBSERVATIONS = 60;

export interface Observation {
  /** Host-assigned, sequential: OBS-001, OBS-002, … */
  id: string;
  /** The area or location this was seen in. */
  area: string;
  /** What was done, or the state that was entered. */
  action: string;
  /** What was then observed to happen. */
  outcome: string;
  /** Optional pointer to the evidence — a URL, a snapshot ref. */
  evidence?: string;
  recordedAt: string;
}

export interface Ledger {
  /** The run this ledger belongs to; a ledger from an older run is ignored. */
  runId: string;
  observations: Observation[];
  /** Appends refused because the cap was reached. */
  overflow: number;
}

export const LEDGER_FILE = 'discovery-observations.json';
export const ledgerPath = () => join(QA_ARTIFACT_ROOT, LEDGER_FILE);

/** Normalised form used to spot a repeat of something already recorded. */
function fingerprint(area: string, action: string, outcome: string): string {
  return [area, action, outcome]
    .map((v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .join('|');
}

function emptyLedger(runId: string): Ledger {
  return { runId, observations: [], overflow: 0 };
}

/** Start a ledger for this run, discarding anything an earlier run left. */
export function resetLedger(runId: string): Ledger {
  const ledger = emptyLedger(runId);
  writeLedger(ledger);
  return ledger;
}

function writeLedger(ledger: Ledger): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), 'utf8');
}

/**
 * The current run's ledger, or undefined when there is none.
 *
 * `expectedRunId` guards against a ledger left by an earlier run: evidence from
 * a different session is not evidence about this one.
 */
export function readLedger(expectedRunId?: string): Ledger | undefined {
  const path = ledgerPath();
  if (!existsSync(path)) return undefined;
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
    if (expectedRunId !== undefined && ledger.runId !== expectedRunId) return undefined;
    return ledger;
  } catch {
    return undefined;
  }
}

export type AppendResult =
  | { ok: true; observation: Observation; duplicateOf?: string }
  | { ok: false; error: string };

/**
 * Append one observation. The host assigns the ID.
 *
 * A repeat of something already recorded returns the original entry instead of
 * adding a second one — seeing the same behavior twice is not two behaviors,
 * and the accounting rule should not punish thoroughness.
 */
export function appendObservation(input: {
  area: string;
  action: string;
  outcome: string;
  evidence?: string;
}): AppendResult {
  const area = input.area?.trim();
  const action = input.action?.trim();
  const outcome = input.outcome?.trim();
  if (!area || !action || !outcome) {
    return { ok: false, error: 'area, action and outcome are all required and must be non-empty.' };
  }

  const ledger = readLedger();
  if (!ledger) {
    return { ok: false, error: 'No observation ledger exists for this run. This is a host problem — report it and stop.' };
  }

  const print = fingerprint(area, action, outcome);
  const existing = ledger.observations.find((o) => fingerprint(o.area, o.action, o.outcome) === print);
  if (existing) return { ok: true, observation: existing, duplicateOf: existing.id };

  if (ledger.observations.length >= MAX_OBSERVATIONS) {
    ledger.overflow += 1;
    writeLedger(ledger);
    return { ok: false, error: `The ledger is full (${MAX_OBSERVATIONS} observations). Stop exploring and write the artifact.` };
  }

  const observation: Observation = {
    id: `OBS-${String(ledger.observations.length + 1).padStart(3, '0')}`,
    area,
    action,
    outcome,
    evidence: input.evidence?.trim() || undefined,
    recordedAt: new Date().toISOString(),
  };
  ledger.observations.push(observation);
  writeLedger(ledger);
  return { ok: true, observation };
}

/** A compact host-derived summary, for the run log. */
export function ledgerSummary(ledger: Ledger | undefined) {
  if (!ledger) return undefined;
  return {
    recorded: ledger.observations.length,
    overflow: ledger.overflow,
    areas: [...new Set(ledger.observations.map((o) => o.area))].length,
  };
}
