// Backfill: bring existing `.qa/runs/<run-id>/` archives into the run history,
// and check that the history still matches the archives.
//
// Read-only on the archive — nothing here writes, moves or rewrites a file.
// Idempotent: a run id already recorded is skipped, except a live run whose
// finishing index failed (error code HISTORY_INDEX_FAILED), which is re-indexed
// from its archive. One malformed archive is reported and the rest continue.

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { indexArchive, metricsFromArchive, readArchived, stagesFromRecord, stagesFromRefresh } from './archive.ts';
import type { RunHistoryStore } from './run-history-store.ts';
import { ARTIFACT_FILES, RUN_ID, RUN_KINDS, type ArtifactRow, type RunKind, type RunStatus } from './types.ts';

export const INDEX_FAILED = 'HISTORY_INDEX_FAILED';

export interface ImportReport {
  archivesFound: number;
  imported: string[];
  skipped: string[];
  reindexed: string[];
  malformed: { id: string; reason: string }[];
  metricsRecovered: number;
  artifactsIndexed: number;
}

export function archiveRoot(artifactRoot: string): string {
  return join(artifactRoot, 'runs');
}

function listArchives(artifactRoot: string): string[] {
  const root = archiveRoot(artifactRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    try { return lstatSync(join(root, name)).isDirectory(); } catch { return false; }
  }).sort();
}

/** `2026-09-27T18-07-17-457Z` -> `2026-09-27T18:07:17.457Z`. */
export function startedAtFromRunId(id: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

const iso = (v: unknown): string | undefined => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined);

function statusOf(outcome: unknown, result: unknown): RunStatus {
  const o = typeof outcome === 'string' ? outcome.toLowerCase() : '';
  if (o === 'completed') return 'COMPLETED';
  if (o === 'failed') return 'FAILED';
  if (o === 'interrupted') return 'INTERRUPTED';
  if (result === 'COMPLETE') return 'COMPLETED';
  if (result === 'FAILED') return 'FAILED';
  return 'INTERRUPTED';
}

export function importArchives(store: RunHistoryStore, artifactRoot: string, options: { stageLabels?: Record<string, string> } = {}): ImportReport {
  const report: ImportReport = { archivesFound: 0, imported: [], skipped: [], reindexed: [], malformed: [], metricsRecovered: 0, artifactsIndexed: 0 };
  for (const id of listArchives(artifactRoot)) {
    report.archivesFound += 1;
    const dir = join(archiveRoot(artifactRoot), id);
    try {
      if (!RUN_ID.test(id)) throw new Error('directory name is not a run id');
      const existing = store.getRun(id);
      if (existing) {
        if (existing.errorCode === INDEX_FAILED && existing.status !== 'RUNNING') {
          const metrics = metricsFromArchive(dir);
          const artifacts = indexArchive(dir);
          store.finishRun(id, { status: existing.status, finishedAt: existing.finishedAt ?? new Date().toISOString(), errorCode: null, errorSummary: null, archiveRelPath: `runs/${id}`, metrics, artifacts });
          report.reindexed.push(id);
          report.metricsRecovered += Object.keys(metrics).length;
          report.artifactsIndexed += artifacts.length;
        } else {
          report.skipped.push(id);
        }
        continue;
      }

      const meta = readArchived(dir, ARTIFACT_FILES.RUN_METADATA);
      const phase1 = readArchived(dir, ARTIFACT_FILES.RUN_RECORD);
      const phase2 = readArchived(dir, ARTIFACT_FILES.PHASE2_RUN_RECORD);
      const record = phase1 ?? phase2;
      if (!meta && !record) throw new Error('no run-metadata.json or run record');
      const refresh = readArchived(dir, ARTIFACT_FILES.REFRESH_RECORD);
      const startedAt = iso(meta?.startedAt) ?? iso(record?.startedAt) ?? startedAtFromRunId(id);
      if (!startedAt) throw new Error('no readable start time');
      const finishedAt = iso(meta?.finishedAt) ?? iso(record?.finishedAt) ?? null;
      const duration = Number(meta?.durationMs);
      // Newer archives name their kind; older ones were all Phase 1 runs unless they hold a Phase 2 record.
      const kind: RunKind = RUN_KINDS.includes(meta?.kind as RunKind) ? (meta!.kind as RunKind) : !phase1 && phase2 ? 'PHASE2_AUTOMATION' : 'PHASE1_MANUAL';
      const status = statusOf(meta?.outcome, record?.result);
      const failedStage = typeof record?.failedStage === 'string' ? record.failedStage : undefined;
      const metrics = metricsFromArchive(dir);
      const artifacts: ArtifactRow[] = indexArchive(dir);

      store.importRun({
        run: {
          id, kind, status, startedAt, finishedAt,
          durationMs: Number.isFinite(duration) && duration >= 0 ? duration : finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
          model: typeof meta?.model === 'string' ? meta.model : typeof record?.model === 'string' ? record.model : null,
          target: typeof meta?.target === 'string' ? meta.target : typeof record?.target === 'string' ? record.target : null,
          gitCommit: typeof meta?.gitCommit === 'string' ? meta.gitCommit : null,
          authMode: typeof meta?.authBootstrapMode === 'string' ? meta.authBootstrapMode : null,
          archiveRelPath: `runs/${id}`,
          errorCode: status === 'FAILED' ? (failedStage ? 'STAGE_FAILED' : 'RUN_FAILED') : null,
          errorSummary: status === 'FAILED' && failedStage ? `Stopped at ${options.stageLabels?.[failedStage] ?? failedStage}.` : null,
        },
        stages: record ? stagesFromRecord(record, options.stageLabels ?? {}) : stagesFromRefresh(refresh, options.stageLabels ?? {}),
        metrics,
        artifacts,
      });
      report.imported.push(id);
      report.metricsRecovered += Object.keys(metrics).length;
      report.artifactsIndexed += artifacts.length;
    } catch (error) {
      report.malformed.push({ id: id.slice(0, 80), reason: (error as Error).message.split('\n')[0].slice(0, 200) });
    }
  }
  return report;
}

export interface VerifyReport {
  runs: number;
  archivesNotRecorded: string[];
  running: string[];
  problems: { runId: string; problem: string }[];
}

/** Compare the history with the archives on disk. Reads only. */
export function verifyHistory(store: RunHistoryStore, artifactRoot: string): VerifyReport {
  const report: VerifyReport = { runs: 0, archivesNotRecorded: [], running: [], problems: [] };
  const recorded = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const page = store.listRuns({ limit: 100, offset });
    for (const run of page.runs) {
      report.runs += 1;
      recorded.add(run.id);
      if (run.status === 'RUNNING') report.running.push(run.id);
      if (run.errorCode === INDEX_FAILED) report.problems.push({ runId: run.id, problem: 'artifact index failed when the run finished; run npm run qa:history:import to rebuild it' });
      if (!run.archiveRelPath) continue;
      const dir = join(archiveRoot(artifactRoot), run.id);
      if (!existsSync(dir)) {
        report.problems.push({ runId: run.id, problem: 'archive directory is missing' });
        continue;
      }
      const onDisk = new Map(indexArchive(dir).map((a) => [a.relativePath, a]));
      const indexed = store.getArtifacts(run.id);
      for (const a of indexed) {
        const disk = onDisk.get(a.relativePath);
        if (!disk) report.problems.push({ runId: run.id, problem: `${a.relativePath} is indexed but missing from the archive` });
        else if (disk.sha256 !== a.sha256) report.problems.push({ runId: run.id, problem: `${a.relativePath} changed since it was indexed` });
      }
      const known = new Set(indexed.map((a) => a.relativePath));
      for (const path of onDisk.keys()) if (!known.has(path)) report.problems.push({ runId: run.id, problem: `${path} is in the archive but not indexed` });
    }
    if (page.runs.length < 100) break;
  }
  report.archivesNotRecorded = listArchives(artifactRoot).filter((id) => !recorded.has(id));
  return report;
}
