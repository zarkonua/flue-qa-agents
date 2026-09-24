// Host-side browser evidence collection.
//
// The MCP conversation only. All parsing, classification, deduplication and
// bounding lives in `src/lib/browser-evidence.ts`, which is pure and tested
// without a browser; this file is the part that cannot be.
//
// Runs AFTER Product Discovery, in the host's own browser session, replaying
// the locations discovery reported as visited. See the header of
// `browser-evidence.ts` for why it cannot instead read the agent's session.
//
// Security posture, and why this is not a widening of the attack surface:
//
//   * Three tools are ever called: `browser_navigate`, `browser_console_messages`
//     and `browser_network_requests`. All three are read-only observers.
//   * `browser_evaluate` and `browser_run_code_unsafe` are never called here,
//     exactly as they are never mounted on an agent.
//   * Both evidence tools accept a `filename` argument that WRITES the output
//     to a file under the server's workspace root. It is never passed. The
//     text form is what we want, and a filesystem write is not this code's job.
//   * The URLs visited come from the host's own surface/discovery records and
//     are checked against the run's origin before use, so a location injected
//     into an artifact cannot send the browser somewhere else.
//   * No model input reaches this code. The model cannot request a collection,
//     cannot choose a URL, and cannot write the resulting artifact.

import { resolve } from 'node:path';
import { ROOT } from './runtime.mjs';

const lib = await import(resolve(ROOT, 'src/lib/browser-evidence.ts'));
const { writeQaArtifact } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));

/** Per-call ceiling. A hung page must not stall the whole run. */
const CALL_TIMEOUT_MS = 30_000;

const textOf = (result) => (result?.content ?? []).map((c) => c.text ?? '').join('\n');

/** The URL the browser actually ended on, from the navigate result. */
function finalUrlFrom(navText) {
  const line = navText.split('\n').find((l) => /^\s*-?\s*Page URL:/i.test(l));
  return line?.replace(/^\s*-?\s*Page URL:\s*/i, '').trim() || undefined;
}

/**
 * The status of the main document request for `url`.
 *
 * The network log is per-navigation, so the entry whose URL matches the one we
 * asked for (or the one we landed on) is the document itself.
 */
function documentStatus(requests, requestedUrl, finalUrl) {
  const match = requests.find((r) => r.url === finalUrl) ?? requests.find((r) => r.url === requestedUrl);
  return match?.status;
}

/**
 * Collect page-load evidence for `locations` and write `discovery-evidence`.
 *
 * Returns the artifact, or `undefined` when no browser is configured — a run
 * without a browser produces no evidence rather than an empty artifact
 * claiming a clean bill of health.
 */
export async function collectBrowserEvidence({ mcpUrl, target, origin, locations, runId }) {
  if (!mcpUrl || locations.length === 0) return undefined;

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'flue-qa-evidence', version: '1.0.0' });

  const evidenceLocations = [];
  let accumulated = { findings: [], overflow: 0 };

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

    for (const requestedUrl of locations) {
      // Same-origin only. The locations come from host records, but this is
      // the point where a URL turns into a real navigation, so it is checked
      // here rather than trusted from upstream.
      let sameOrigin = false;
      try {
        sameOrigin = new URL(requestedUrl).origin === origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        evidenceLocations.push({
          requestedUrl,
          redirected: false,
          collected: false,
          error: `not on the run's origin (${origin}) — not visited`,
        });
        continue;
      }

      const call = (name, args) =>
        client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });

      let navText;
      try {
        const nav = await call('browser_navigate', { url: requestedUrl });
        navText = textOf(nav);
        if (nav.isError) throw new Error(navText.split('\n')[0] || 'navigation reported an error');
      } catch (error) {
        evidenceLocations.push({
          requestedUrl,
          redirected: false,
          collected: false,
          error: error.message,
        });
        accumulated = lib.accumulate(
          [{ type: 'NAVIGATION_FAILED', location: requestedUrl, detail: `Could not open: ${error.message}` }],
          accumulated,
        );
        continue;
      }

      const finalUrl = finalUrlFrom(navText);

      // `level: 'warning'` includes errors — the server's levels are
      // cumulative by severity. `all` is left false so each location gets the
      // messages from ITS load rather than the whole session repeated.
      let consoleMessages = [];
      let requests = [];
      let collectionError;
      try {
        consoleMessages = lib.parseConsoleMessages(textOf(await call('browser_console_messages', { level: 'warning' })));
        requests = lib.parseNetworkRequests(textOf(await call('browser_network_requests', { static: true })));
      } catch (error) {
        collectionError = error.message;
      }

      const status = documentStatus(requests, requestedUrl, finalUrl);
      // A URL holding a one-time credential cannot be faithfully replayed: the
      // agent already spent the token. Record that with the location so a real
      // failure here is not mistaken for a defect.
      const singleUse = lib.singleUseParam(requestedUrl);
      evidenceLocations.push({
        requestedUrl,
        ...(finalUrl ? { finalUrl } : {}),
        ...(status !== undefined ? { status } : {}),
        redirected: finalUrl !== undefined && finalUrl !== requestedUrl,
        collected: collectionError === undefined,
        ...(collectionError ? { error: collectionError } : {}),
        ...(singleUse
          ? {
              replayCaveat:
                `URL carries a single-use parameter ("${singleUse}"). Product Discovery consumed it ` +
                'during exploration, so a failure collected here may be caused by replaying a spent ' +
                'token rather than by a defect.',
            }
          : {}),
      });

      const raw = lib.markReplaySuspects(
        lib.dropRedundantResourceEchoes([
          ...lib.classifyConsole(consoleMessages, requestedUrl),
          ...lib.classifyNetwork(requests, requestedUrl),
        ]),
        requestedUrl,
      );
      accumulated = lib.accumulate(raw, accumulated);
    }
  } finally {
    await client.close().catch(() => {});
  }

  const evidence = lib.buildEvidence({
    runId,
    target,
    origin,
    locations: evidenceLocations,
    accumulated,
  });

  // Written by the host. No agent holds `discovery-evidence` in its write
  // picklist, so this is the only path that can produce the file.
  writeQaArtifact('discovery-evidence', evidence);
  return evidence;
}

export { lib as evidenceLib };
