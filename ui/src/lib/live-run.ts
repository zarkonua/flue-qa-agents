// The Live Run page's state, derived from two sources:
//   - the run as the history records it (GET /api/runs/:id) — survives a page refresh;
//   - the run's event stream (SSE) — arrives as things happen.
// Events win where they are newer; the history fills in everything else.

import { useEffect, useState } from 'react';
import { api, type RunDetail, type RunEvent, type RunStatus } from '../api/client.ts';

export type StageState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SKIPPED' | 'INTERRUPTED';
export interface LiveStage { key: string; label: string; state: StageState; attempts: number; durationMs: number | null; startedAt: string | null; problem: string | null }
export interface LiveState {
  status: RunStatus;
  stages: LiveStage[];
  metrics: Record<string, number>;
  currentStage: LiveStage | undefined;
  currentAttempt: number | null;
  artifacts: { type: string; count?: number; stage?: string }[];
  finalEvent: RunEvent | undefined;
}

const FINAL = new Set(['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED']);
const FINAL_STATUS: Record<string, RunStatus> = { RUN_COMPLETED: 'COMPLETED', RUN_FAILED: 'FAILED', RUN_CANCELLED: 'CANCELLED' };

/** Subscribe to a run's events. EventSource reconnects by itself, resuming after the last id it saw. */
export function useRunEvents(runId: string): { events: RunEvent[]; connected: boolean; ended: boolean } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    setEvents([]);
    setEnded(false);
    const source = new EventSource(api.runEventsUrl(runId));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as RunEvent;
        setEvents((prev) => (prev.length && prev[prev.length - 1].id >= e.id ? (prev.some((p) => p.id === e.id) ? prev : [...prev, e].sort((a, b) => a.id - b.id)) : [...prev, e]));
      } catch { /* not an event */ }
    };
    source.addEventListener('end', () => {
      setEnded(true);
      setConnected(false);
      source.close();
    });
    return () => source.close();
  }, [runId]);
  return { events, connected, ended };
}

export function deriveLiveState(detail: RunDetail, events: RunEvent[]): LiveState {
  const plan = events.find((e) => e.type === 'RUN_STARTED' && e.plan)?.plan ?? detail.plannedStages;
  const recorded = new Map(detail.stages.map((s) => [s.stageName, s]));
  const stages: LiveStage[] = plan.map((p) => {
    const r = recorded.get(p.key);
    return {
      key: p.key,
      label: p.label,
      state: (r?.status as StageState) ?? 'PENDING',
      attempts: r?.attemptCount ?? 0,
      durationMs: r?.durationMs ?? null,
      startedAt: r?.startedAt ?? null,
      problem: r?.errorSummary ?? null,
    };
  });
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const metrics = { ...detail.metrics };
  const artifacts: LiveState['artifacts'] = detail.artifacts.map((type) => ({ type }));
  let status: RunStatus = detail.run.status;
  let finalEvent: RunEvent | undefined;
  let currentAttempt: number | null = null;
  for (const e of events) {
    const s = e.stage ? byKey.get(e.stage) : undefined;
    if (e.type === 'STAGE_STARTED' && s) { s.state = 'RUNNING'; s.startedAt = e.timestamp; }
    if (e.type === 'ATTEMPT_STARTED' && s) { s.attempts = Math.max(s.attempts, e.attempt ?? 1); currentAttempt = e.attempt ?? null; }
    if (e.type === 'STAGE_COMPLETED' && s) { s.state = 'COMPLETED'; if (e.attempt) s.attempts = e.attempt; if (s.startedAt && s.durationMs === null) s.durationMs = Date.parse(e.timestamp) - Date.parse(s.startedAt); }
    if (e.type === 'STAGE_FAILED' && s) { s.state = 'FAILED'; s.problem = e.message; if (e.attempt) s.attempts = e.attempt; }
    if (e.type === 'STAGE_CANCELLED' && s) s.state = 'CANCELLED';
    if (e.type === 'METRIC_UPDATED' && e.metrics) Object.assign(metrics, e.metrics);
    if (e.type === 'ARTIFACT_CREATED' && e.artifactType && !artifacts.some((a) => a.type === e.artifactType)) artifacts.push({ type: e.artifactType, count: e.count, stage: e.stage });
    if (e.type === 'RUN_RUNNING' && status === 'STARTING') status = 'RUNNING';
    if (FINAL.has(e.type)) {
      finalEvent = e;
      status = FINAL_STATUS[e.type];
    }
  }
  // The history is authoritative once the run is over.
  if (!['STARTING', 'RUNNING'].includes(detail.run.status)) status = detail.run.status;
  // A run that ended leaves no stage "running".
  if (!['STARTING', 'RUNNING'].includes(status)) for (const s of stages) if (s.state === 'RUNNING') s.state = status === 'CANCELLED' ? 'CANCELLED' : status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
  const currentStage = stages.find((s) => s.state === 'RUNNING');
  return { status, stages, metrics, currentStage, currentAttempt: currentStage ? currentAttempt : null, artifacts, finalEvent };
}

export const EVENT_FILTERS: { id: string; label: string; test: (e: RunEvent) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'stages', label: 'Stages', test: (e) => e.category === 'RUN' || e.category === 'STAGE' },
  { id: 'agent', label: 'Agent', test: (e) => e.category === 'AGENT' },
  { id: 'browser', label: 'Browser', test: (e) => e.category === 'BROWSER' },
  { id: 'tools', label: 'Tools', test: (e) => e.category === 'TOOL' || e.category === 'BROWSER' },
  { id: 'artifacts', label: 'Artifacts', test: (e) => e.category === 'ARTIFACT' || e.category === 'METRIC' },
  { id: 'errors', label: 'Errors', test: (e) => e.level !== 'info' },
];
