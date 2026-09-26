// Per-run output, preserved so an A/B comparison has something to compare.
//
// The stable `.qa/*.json` paths stay exactly where they are: the agents' tools
// resolve against a fixed root, and moving that per run would change a security
// boundary to gain a convenience. Instead every finished run is *copied* into
// `.qa/runs/<run-id>/` alongside a metadata file.
//
// The archive-on-start mechanism is a different thing and stays: it preserves
// what a run replaced. This preserves what a run produced, attributed to the
// model that produced it — which the archive cannot do, since it is written
// before the run starts and names the run that displaced it.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** The commit this run's code came from, when the tree is a git repo. */
export function gitCommit(root) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let dirty = false;
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0;
    } catch { /* not fatal */ }
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

export function runDir(artifactRoot, runId) {
  return join(artifactRoot, 'runs', runId);
}

/**
 * Copy this run's artifacts into its own directory and write the metadata that
 * makes the numbers attributable: which model, which provider, which target,
 * how long, and whether it finished.
 */
export function preserveRun({ artifactRoot, projectRoot, runId, model, target, startedAt, files, outcome, extra }) {
  const dir = runDir(artifactRoot, runId);
  mkdirSync(dir, { recursive: true });

  const copied = [];
  for (const name of files) {
    const from = join(artifactRoot, name);
    if (!existsSync(from)) continue;
    // A name may carry a subdirectory — `bugs/BUG-001.json`.
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    copyFileSync(from, join(dir, name));
    copied.push(name);
  }

  const finishedAt = new Date();
  const started = new Date(startedAt);
  const slash = String(model ?? '').indexOf('/');
  const metadata = {
    runId,
    model: model ?? null,
    provider: slash === -1 ? null : String(model).slice(0, slash),
    target: target ?? null,
    startedAt: started.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - started.getTime(),
    outcome,
    gitCommit: gitCommit(projectRoot) ?? null,
    artifacts: copied,
    ...extra,
  };
  writeFileSync(join(dir, 'run-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  return { dir, metadata };
}
