#!/usr/bin/env node
// Local Phase 1 review UI.
//
//   npm run qa:ui        ->  http://127.0.0.1:4445
//
// A read-and-approve screen over the artifacts `npm run qa:manual` produced, so
// a review does not mean scrolling test-cases.json next to
// automation-prioritization.json.
//
// Trust model, unchanged from the CLI:
//   - the browser never reads .qa; this process does, through the same host
//     libraries the scripts use;
//   - approving calls approvePhase1() — the identical function behind
//     `npm run qa:approve`. Schema validation, semantic validation, the SHA-256
//     lock and the structural rules all still apply, and the UI cannot weaken
//     them because it does not implement them;
//   - the only writable actions are two fixed ones. No path, command, artifact
//     name or argument ever comes from the browser;
//   - bound to 127.0.0.1. Nothing here is authenticated, so nothing here
//     listens on a public interface.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { EXIT, ROOT } from './lib/runtime.mjs';

const { envInt, envString } = await import(resolve(ROOT, 'src/config/env.ts'));
const { buildReviewModel } = await import(resolve(ROOT, 'src/lib/review-view.ts'));
const { approvePhase1 } = await import(resolve(ROOT, 'src/lib/phase1-gate.ts'));
const { QA_ARTIFACT_ROOT } = await import(resolve(ROOT, 'src/lib/qa-artifacts.ts'));

const PORT = envInt('QA_UI_PORT', 4445);
// Deliberately not configurable from the browser, and not from a stray env var
// that a shared machine might set: a local review tool has no login.
const HOST = envString('QA_UI_HOST') ?? '127.0.0.1';

// A fixed map, not a path join: the URL cannot name a file. Adding a file here
// is a source change, which is the point.
const UI_DIR = join(ROOT, 'src', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    // This UI reads local QA artifacts; nothing should embed or fetch it.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

const json = (res, status, value) => send(res, status, JSON.stringify(value));

/** Run one fixed host command. Nothing about it comes from the request. */
function runFixed(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let output = '';
    const take = (chunk) => {
      output += chunk;
      if (output.length > 40_000) output = output.slice(-40_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => done({ code: 1, output: String(error.message) }));
    child.on('close', (code) => done({ code: code ?? 1, output }));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      return send(res, 200, readFileSync(join(UI_DIR, file)), type);
    }

    if (req.method === 'GET' && path === '/api/review') {
      return json(res, 200, { ok: true, artifactRoot: QA_ARTIFACT_ROOT, model: buildReviewModel() });
    }

    if (req.method === 'POST' && path === '/api/approve') {
      // The same call `npm run qa:approve` makes. `acceptFindings` is NOT
      // exposed: overriding a semantic finding is a deliberate act that should
      // carry the friction of a command line.
      const result = approvePhase1();
      if (!result.ok) {
        return json(res, 409, {
          ok: false,
          reason: result.reason,
          missing: result.state.missing,
          schemaErrors: result.state.schemaErrors,
          blocking: result.state.hard,
          findings: result.state.findings,
        });
      }
      return json(res, 200, { ok: true, approval: result.approval });
    }

    if (req.method === 'POST' && path === '/api/reprioritize') {
      // Re-runs stage 4 only, through the real orchestrator — the same thing
      // `npm run qa:prioritize` does. Fixed argv; the browser supplies nothing.
      const { code, output } = await runFixed([join(ROOT, 'scripts', 'qa-manual.mjs'), '--from', 'prioritization']);
      return json(res, code === 0 ? 200 : 500, { ok: code === 0, exitCode: code, output: output.slice(-8000) });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    // Never leak a stack or a path the browser did not already know about.
    console.error(`[qa:ui] ${path}:`, error);
    return json(res, 500, { ok: false, error: 'Internal error — see the terminal running npm run qa:ui.' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Set QA_UI_PORT to another port.\n`);
    process.exit(EXIT.BAD_CONFIG);
  }
  console.error(error);
  process.exit(EXIT.FAILED);
});

server.listen(PORT, HOST, () => {
  console.log('\nPhase 1 review UI');
  console.log(`  ${`http://${HOST}:${PORT}`}`);
  console.log(`  artifacts: ${QA_ARTIFACT_ROOT}`);
  console.log('\nApproving here is identical to npm run qa:approve. Ctrl-C to stop.\n');
});

export { server };
