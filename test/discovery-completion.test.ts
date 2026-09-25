// The Discovery Completion Gate (src/lib/discovery-completion.ts).
//
//   npm test
//
// Every browser result below is the literal shape @playwright/mcp returns —
// action results name the code they ran and link a snapshot file; only
// `browser_snapshot` carries the page tree inline. The gate is driven through
// the same `absorbToolResult` the host interceptor calls during a real run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import { absorbToolResult, buildSurface, expandSurface, expectedLocations, extractLinks, type DiscoverySurface } from '../src/lib/discovery-surface.ts';
import { authSignals, classifyBrowserAction } from '../src/lib/discovery-actions.ts';
import {
  COMPLETION_LOG,
  COMPLETION_REASON_CODES,
  completionTracked,
  evaluateDiscoveryCompletion,
  formatCompletionFeedback,
  MAX_FINALIZATION_REJECTIONS,
} from '../src/lib/discovery-completion.ts';
import { completionMetrics, stageMetrics } from '../src/observability/qa-metrics.ts';
import { createAgentInstrumentation } from '../src/observability/agent-langfuse.ts';
import { createLangfuseProcessor, FLUE_OTEL_SCOPE } from '../src/observability/langfuse.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'http://localhost:4444/';

// ---------------------------------------------------------------------------
// Real @playwright/mcp result shapes
// ---------------------------------------------------------------------------

const ran = (code: string, url = TARGET) =>
  `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: ${url}\n- Page Title: QA Task\n### Snapshot\n- [Snapshot](./page.yml)`;

const snapshot = (tree: string, url = TARGET) =>
  `### Page\n- Page URL: ${url}\n- Page Title: QA Task\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``;

const AUTH_PAGE = `- main [ref=e2]:
  - heading "Notes Console" [level=1] [ref=e5]
  - status [ref=e6]
  - article [ref=e9]:
    - heading "Sign Up" [level=2] [ref=e10]
    - textbox "Email" [ref=e13]
    - textbox "Password" [ref=e15]
    - button "Sign Up" [ref=e16] [cursor=pointer]
  - article [ref=e18]:
    - heading "Sign In" [level=2] [ref=e19]
    - textbox "Email" [ref=e22]
    - textbox "Password" [ref=e24]
    - button "Sign In" [ref=e25] [cursor=pointer]`;

const AUTH_PAGE_WITH_ERROR = AUTH_PAGE.replace('- status [ref=e6]', '- status [ref=e6]: User already exists.');

const SIGNED_IN = `- main [ref=e2]:
  - heading "Notes Console" [level=1] [ref=e5]
  - button "Log out" [ref=e30]
  - link "Notes" [ref=e31]:
    - /url: /notes`;

const NOTES = `- main [ref=e2]:
  - heading "Notes" [level=1] [ref=e40]
  - textbox "Note title" [ref=e41]
  - button "Create note" [ref=e42]
  - button "Log out" [ref=e30]`;

const click = (role: string, name: string, url = TARGET) => ran(`await page.getByRole('${role}', { name: '${name}' }).click();`, url);
const type = (name: string, value: string, submit = false) =>
  ran(`await page.getByRole('textbox', { name: '${name}' }).fill('${value}');${submit ? `\nawait page.getByRole('textbox', { name: '${name}' }).press('Enter');` : ''}`);
const navigate = (url: string) => ran(`await page.goto('${url}');`, url);

let clock = Date.parse('2026-09-24T19:41:00Z');
/** Replay tool calls through the host's own absorb path, one second apart. */
function replay(surface: DiscoverySurface, calls: [string, string][]): DiscoverySurface {
  for (const [tool, text] of calls) absorbToolResult(surface, `mcp__playwright__${tool}`, text, new Date((clock += 1000)));
  return surface;
}

const tracked = () => buildSurface(TARGET, AUTH_PAGE, new Date(clock), { trackCompletion: true });

const explored = (...urls: string[]) => ({ locations: urls.map((url) => ({ url, status: 'EXPLORED' })) });
const codes = (r: { reasons: { code: string }[] }) => [...new Set(r.reasons.map((x) => x.code))].sort();

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('browser action classification', () => {
  it('a click on a button or link is state-changing', () => {
    assert.equal(classifyBrowserAction('browser_click', click('button', 'Sign In'))?.label, 'click on button "Sign In"');
    assert.equal(classifyBrowserAction('browser_click', click('link', 'Notes'))?.kind, 'activate');
  });

  it('focusing a text field is not', () => {
    assert.equal(classifyBrowserAction('browser_click', click('textbox', 'Email')), undefined);
  });

  it('typing is not, but typing and pressing Enter is a submit', () => {
    assert.equal(classifyBrowserAction('browser_type', type('Email', 'a@b.test')), undefined);
    assert.equal(classifyBrowserAction('browser_type', type('Search', 'x', true))?.kind, 'submit');
  });

  it('a bare Enter or Escape is, Tab is not', () => {
    assert.equal(classifyBrowserAction('browser_press_key', ran(`await page.keyboard.press('Enter');`))?.kind, 'key');
    assert.equal(classifyBrowserAction('browser_press_key', ran(`await page.keyboard.press('Escape');`))?.kind, 'key');
    assert.equal(classifyBrowserAction('browser_press_key', ran(`await page.keyboard.press('Tab');`)), undefined);
  });

  it('a navigation is, and so is a selection or a toggle', () => {
    assert.equal(classifyBrowserAction('browser_navigate', navigate('http://localhost:4444/notes'))?.url, 'http://localhost:4444/notes');
    assert.equal(classifyBrowserAction('browser_fill_form', ran(`await page.getByRole('combobox', { name: 'Sort' }).selectOption('Newest');`))?.kind, 'select');
    assert.equal(classifyBrowserAction('browser_fill_form', ran(`await page.getByRole('checkbox', { name: 'Remember me' }).check();`))?.kind, 'toggle');
  });

  it('a click on an element with no stated role is treated as state-changing, not guessed harmless', () => {
    assert.equal(classifyBrowserAction('browser_click', ran(`await page.getByText('Open panel').click();`))?.kind, 'activate');
  });

  it('an error result is not an action, and a snapshot never is', () => {
    assert.equal(classifyBrowserAction('browser_click', '### Error\nInvalid arguments for tool "browser_click"'), undefined);
    assert.equal(classifyBrowserAction('browser_snapshot', snapshot(AUTH_PAGE)), undefined);
  });

  it('reads auth state from accessible names only', () => {
    assert.deepEqual(authSignals(AUTH_PAGE), { authForm: true, signOut: false, password: true, signIn: true });
    assert.deepEqual(authSignals(SIGNED_IN), { authForm: false, signOut: true, password: false, signIn: false });
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('discovery completion gate', () => {
  it('an unverified state-changing action blocks finalization; a snapshot clears it', () => {
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_click', click('button', 'Sign Up')],
    ]);
    const before = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.equal(before.canFinalize, false);
    assert.ok(codes(before).includes('UNVERIFIED_ACTION_OUTCOME'));
    const reason = before.reasons.find((r) => r.code === 'UNVERIFIED_ACTION_OUTCOME')!;
    assert.equal(reason.actionId, 'ACT-002');
    assert.match(reason.message, /click on button "Sign Up"/);

    replay(s, [['browser_snapshot', snapshot(AUTH_PAGE_WITH_ERROR)]]);
    const after = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.ok(!codes(after).includes('UNVERIFIED_ACTION_OUTCOME'));
  });

  it('REGRESSION: sign-up rejected, sign-in unverified, finalize -> rejected; then resolved -> passes', () => {
    // The measured run: sign-up said "User already exists", the agent typed
    // credentials into Sign In, clicked, never looked, and wrote.
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_type', type('Password', 'secret-1')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_PAGE_WITH_ERROR)],
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_type', type('Password', 'secret-1')],
      ['browser_click', click('button', 'Sign In')],
    ]);

    const first = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.equal(first.canFinalize, false);
    assert.deepEqual(codes(first), ['UNRESOLVED_AUTH_STATE', 'UNVERIFIED_ACTION_OUTCOME']);
    assert.match(formatCompletionFeedback(first), /\[UNVERIFIED_ACTION_OUTCOME\] The click on button "Sign In"/);
    assert.match(formatCompletionFeedback(first), /last attempt was the click on button "Sign In"/);

    // The agent looks, signs in successfully, and finds the product proper.
    replay(s, [
      ['browser_snapshot', snapshot(SIGNED_IN)],
      ['browser_click', click('link', 'Notes')],
      ['browser_snapshot', snapshot(NOTES, 'http://localhost:4444/notes')],
    ]);
    const second = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET, 'http://localhost:4444/notes') });
    // Reached, but nothing done there yet.
    assert.deepEqual(codes(second), ['UNEXPLORED_REACHABLE_AREA']);
    assert.match(second.reasons[0].message, /button "create note"/);

    replay(s, [
      ['browser_click', click('button', 'Create note', 'http://localhost:4444/notes')],
      ['browser_snapshot', snapshot(NOTES, 'http://localhost:4444/notes')],
    ]);
    const third = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET, 'http://localhost:4444/notes') });
    assert.equal(third.canFinalize, true, JSON.stringify(third.reasons));
    assert.equal(third.metrics.authenticatedStateSeen, true);
  });

  it('a genuinely blocked sign-in, recorded BLOCKED with a reason, does not block forever', () => {
    // CHANGE 11: "genuinely" now has to be shown — input entered, the submit
    // executed, the result inspected, and the application answered.
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_type', type('Password', 'secret-1')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_PAGE_WITH_ERROR)],
    ]);
    assert.deepEqual(codes(evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) })), ['UNRESOLVED_AUTH_STATE']);
    const r = evaluateDiscoveryCompletion({
      surface: s,
      artifact: { locations: [{ url: TARGET, status: 'BLOCKED', reason: 'POST_AUTH_DISCOVERY_BLOCKED: confirmation mail is not reachable (no mailbox configured)' }] },
    });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
  });

  it('BLOCKED without a reason is not a resolution', () => {
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: { locations: [{ url: TARGET, status: 'BLOCKED', reason: '  ' }] } });
    assert.ok(codes(r).includes('UNRESOLVED_AUTH_STATE'));
  });

  it('a reached area reported SKIPPED_WITH_REASON is resolved', () => {
    const s = replay(buildSurface(TARGET, '- main:\n  - link "Admin":\n    - /url: /admin', new Date(clock), { trackCompletion: true }), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot('- main:\n  - button "Refresh" [ref=e1]\n  - link "Admin" [ref=e2]:\n    - /url: /admin')],
      ['browser_click', click('button', 'Refresh')],
      ['browser_snapshot', snapshot('- main:\n  - button "Refresh" [ref=e1]\n  - link "Admin" [ref=e2]:\n    - /url: /admin')],
      ['browser_navigate', navigate('http://localhost:4444/admin')],
      ['browser_snapshot', snapshot('- main:\n  - button "Rebuild index" [ref=e9]', 'http://localhost:4444/admin')],
    ]);
    const open = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET, 'http://localhost:4444/admin') });
    assert.deepEqual(codes(open), ['UNEXPLORED_REACHABLE_AREA']);
    const skipped = evaluateDiscoveryCompletion({
      surface: s,
      artifact: { locations: [{ url: TARGET, status: 'EXPLORED' }, { url: 'http://localhost:4444/admin', status: 'SKIPPED_WITH_REASON', reason: 'rebuilding the index is an operational action outside discovery' }] },
    });
    assert.equal(skipped.canFinalize, true, JSON.stringify(skipped.reasons));
  });

  it('a snapshot saved to a file is not an observation, and the rejection says why', () => {
    // Measured: the model passed filenames to browser_snapshot, got back only a
    // link to a file it cannot read, and carried on "unsure" what had happened.
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', `### Page\n- Page URL: ${TARGET}\n### Snapshot\n- [Snapshot](./page-after-signup.yml)`],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    const reason = r.reasons.find((x) => x.code === 'UNVERIFIED_ACTION_OUTCOME');
    assert.ok(reason, 'a file-only snapshot must not verify');
    assert.match(reason.message, /passed a filename/);
    assert.match(reason.message, /NO arguments/);
    assert.equal(r.metrics.fileOnlySnapshotCount, 1);
  });

  it('EXPLORED must mean the browser showed it', () => {
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot('- main:\n  - paragraph "Hello"')],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET, 'http://localhost:4444/settings') });
    assert.deepEqual(codes(r), ['UNVERIFIED_EXPLORED_LOCATION']);
    assert.equal(r.reasons[0].location, 'http://localhost:4444/settings');
  });

  it('QUANTITY IS NOT USED: a one-behaviour application finalizes on the first attempt', () => {
    const page = '- main:\n  - heading "Clock"\n  - button "Show time" [ref=e1]';
    const s = replay(buildSurface(TARGET, page, new Date(clock), { trackCompletion: true }), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(page)],
      ['browser_click', click('button', 'Show time')],
      ['browser_snapshot', snapshot(`${page}\n  - status: 10:42`)],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
    assert.deepEqual(r.reasons, []);
  });

  it('has no hard-coded minimum of behaviours, observations, pages or tool calls', () => {
    const source = readFileSync(join(PROJECT, 'src/lib/discovery-completion.ts'), 'utf8');
    // The gate never looks at the behaviour list or any count of findings.
    assert.ok(!/\.behaviors\b/.test(source), 'the gate must not read behaviors');
    assert.ok(!/observations|toolCalls|MIN_/i.test(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  });

  it('bounds rejections per attempt, then tells the agent to stop', () => {
    const s = replay(tracked(), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_click', click('button', 'Sign In')],
    ]);
    const early = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET), rejectionsSoFar: 0 });
    assert.equal(early.exhausted, false);
    const last = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET), rejectionsSoFar: MAX_FINALIZATION_REJECTIONS - 1 });
    assert.equal(last.exhausted, true);
    assert.equal(last.canFinalize, false, 'exhaustion never turns a rejection into a pass');
    assert.match(formatCompletionFeedback(last), /reply BLOCKED/);
  });

  it('reason codes are a stable, closed set', () => {
    assert.deepEqual([...COMPLETION_REASON_CODES], [
      'UNVERIFIED_ACTION_OUTCOME',
      'UNVERIFIED_EXPLORED_LOCATION',
      'UNRESOLVED_AUTH_STATE',
      'UNEXPLORED_REACHABLE_AREA',
      'UNEXPLORED_RELEVANT_NAVIGATION',
      'BLOCKED_WITHOUT_EVIDENCE',
    ]);
    assert.equal(COMPLETION_LOG, 'discovery_completion');
  });

  it('never calls a model and cannot touch provider configuration', () => {
    for (const file of ['src/lib/discovery-completion.ts', 'src/lib/discovery-actions.ts']) {
      const imports = readFileSync(join(PROJECT, file), 'utf8').match(/^import .*$/gm) ?? [];
      for (const line of imports) {
        assert.ok(!/providers|pi-ai|@flue\/runtime|observability|fetch/.test(line), `${file}: ${line}`);
      }
    }
  });

  it('only gates runs whose orchestrator turned tracking on', () => {
    assert.equal(completionTracked(buildSurface(TARGET, AUTH_PAGE)), false);
    assert.equal(completionTracked(tracked()), true);
    assert.equal(completionTracked(undefined), false);
  });

  it('two runs never share action state', () => {
    const a = replay(tracked(), [['browser_click', click('button', 'Sign In')]]);
    const b = tracked();
    assert.equal(a.actions!.length, 1);
    assert.deepEqual(b.actions, []);
    assert.equal(evaluateDiscoveryCompletion({ surface: b, artifact: { locations: [] } }).metrics.unverifiedOutcomeCount, 0);
  });
});

// ---------------------------------------------------------------------------
// The write path: rejection writes nothing, the gate is separate from schema
// ---------------------------------------------------------------------------

describe('gated discovered-behavior write', () => {
  const run = (code: string) => {
    const root = mkdtempSync(join(tmpdir(), 'qa-gate-'));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
      cwd: PROJECT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env'), LANGFUSE_ENABLED: 'false' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  it('rejects, writes nothing, records the attempt; then passes once resolved', () => {
    const out = run(`
      const S = await import('./src/lib/discovery-surface.ts');
      const Q = await import('./src/lib/qa-artifacts.ts');
      const { existsSync } = await import('node:fs');
      const page = '- main:\\n  - button "Show time" [ref=e1]';
      const snap = '### Page\\n- Page URL: ${TARGET}\\n### Snapshot\\n\`\`\`yaml\\n' + page + '\\n\`\`\`';
      const clickRes = "### Ran Playwright code\\n\`\`\`js\\nawait page.getByRole('button', { name: 'Show time' }).click();\\n\`\`\`\\n### Page\\n- Page URL: ${TARGET}";
      const s = S.buildSurface('${TARGET}', page, new Date(), { trackCompletion: true });
      S.absorbToolResult(s, 'browser_snapshot', snap);
      S.absorbToolResult(s, 'browser_click', clickRes);
      S.writeSurface(s);
      const artifact = {
        product: 'Clock', conflicts: [], openQuestions: [],
        locations: [{ url: '${TARGET}', status: 'EXPLORED', area: 'Home' }],
        areas: [{ name: 'Home', routes: ['${TARGET}'], notes: [] }],
        behaviors: [{ id: 'BEH-1', area: 'Home', statement: 'Clicking Show time shows the time.', status: 'OBSERVED', source: ['browser snapshot'], confidence: 'high', suspectedIssue: false }],
      };
      let first;
      try { Q.writeQaArtifact('discovered-behavior', artifact); first = 'written'; }
      catch (e) { first = { name: e.name, codes: e.result?.reasons.map((r) => r.code) }; }
      const writtenAfterReject = existsSync(Q.qaArtifactPath('discovered-behavior'));
      const s2 = S.readSurface();
      S.absorbToolResult(s2, 'browser_snapshot', snap);
      S.writeSurface(s2);
      const second = Q.writeQaArtifact('discovered-behavior', artifact);
      console.log(JSON.stringify({
        first, writtenAfterReject,
        second: second.completion?.canFinalize,
        written: existsSync(Q.qaArtifactPath('discovered-behavior')),
        attempts: S.readSurface().completion.attempts.map((a) => [a.canFinalize, a.reasonCodes]),
      }));`);
    assert.deepEqual(out.first, { name: 'DiscoveryIncompleteError', codes: ['UNVERIFIED_ACTION_OUTCOME'] });
    assert.equal(out.writtenAfterReject, false, 'a rejected finalization must write nothing');
    assert.equal(out.second, true);
    assert.equal(out.written, true);
    assert.deepEqual(out.attempts, [[false, ['UNVERIFIED_ACTION_OUTCOME']], [true, []]]);
  });

  it('schema validation stays separate and runs first', () => {
    const out = run(`
      const S = await import('./src/lib/discovery-surface.ts');
      const Q = await import('./src/lib/qa-artifacts.ts');
      const s = S.buildSurface('${TARGET}', '- main', new Date(), { trackCompletion: true });
      S.absorbToolResult(s, 'browser_click', "### Ran Playwright code\\n\`\`\`js\\nawait page.getByRole('button', { name: 'Go' }).click();\\n\`\`\`");
      S.writeSurface(s);
      let err;
      try { Q.writeQaArtifact('discovered-behavior', { product: 'x' }); } catch (e) { err = e.message.split('\\n')[0]; }
      console.log(JSON.stringify({ err, gateRan: (S.readSurface().completion?.attempts.length ?? 0) > 0 }));`);
    assert.match(out.err, /does not match discovered-behavior\.schema\.json/);
    assert.equal(out.gateRan, false, 'an invalid artifact is not a finalization attempt');
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe('completion telemetry', () => {
  it('counts rejected attempts and the final pass', () => {
    const history = {
      attempts: [
        { canFinalize: false, reasonCodes: ['UNVERIFIED_ACTION_OUTCOME', 'UNRESOLVED_AUTH_STATE'] },
        { canFinalize: false, reasonCodes: ['UNRESOLVED_AUTH_STATE'] },
        { canFinalize: true, reasonCodes: [], metrics: { unverifiedOutcomeCount: 0, unexploredAreaCount: 0, authUnresolved: false } },
      ],
    };
    const m = completionMetrics(history);
    assert.equal(m.finalizationAttemptCount, 3);
    assert.equal(m.finalizationRejectedCount, 2);
    assert.equal(m.finalizationPassed, true);
    assert.deepEqual(m.rejectionReasonCodes, { UNVERIFIED_ACTION_OUTCOME: 1, UNRESOLVED_AUTH_STATE: 2 });
    assert.equal(m.lastReasonCodes, undefined);
    assert.equal(m.unverifiedOutcomeCount, 0);
  });

  it('a never-finalized discovery still reports its rejections on the stage', () => {
    const m = stageMetrics('discovery', () => undefined, { completion: { attempts: [{ canFinalize: false, reasonCodes: ['UNRESOLVED_AUTH_STATE'] }] } });
    assert.equal(m.finalizationPassed, false);
    assert.equal(m.lastReasonCodes, 'UNRESOLVED_AUTH_STATE');
    assert.equal(m.behaviourCount, undefined, 'no artifact, no invented behaviour count');
  });

  it('no gate verdicts, no gate metrics', () => {
    assert.deepEqual(completionMetrics(undefined), {});
    assert.deepEqual(completionMetrics({ attempts: [] }), {});
  });

  it('Langfuse receives each verdict as an event under the write_qa_artifact call', async () => {
    class Collect implements SpanExporter {
      spans: ReadableSpan[] = [];
      export(s: ReadableSpan[], done: (r: ExportResult) => void) {
        this.spans.push(...s);
        done({ code: ExportResultCode.SUCCESS });
      }
      async shutdown() {}
    }
    const exporter = new Collect();
    const config = { enabled: true as const, publicKey: 'pk-lf-t', secretKey: 'sk-lf-t', baseUrl: 'http://127.0.0.1:9', environment: 'test', captureIo: false };
    const provider = new BasicTracerProvider({ spanProcessors: [createLangfuseProcessor(config, { exporter })] });
    const inst = createAgentInstrumentation({ config, info: { model: 'ollama/qwen3:14b' }, tracer: provider.getTracer(FLUE_OTEL_SCOPE) });
    const base = { instanceId: 'i', submissionId: 's', operationId: 'op', agentName: 'product-discovery', timestamp: Date.now() };
    const events = [
      { ...base, type: 'operation_start', operationKind: 'prompt' },
      { ...base, type: 'tool_start', toolName: 'write_qa_artifact', toolCallId: 'w1', args: {}, origin: 'model' },
      { ...base, type: 'log', level: 'warn', message: COMPLETION_LOG, attributes: { tool: 'write_qa_artifact', toolCallId: 'w1', canFinalize: false, reasonCodes: 'UNRESOLVED_AUTH_STATE,UNVERIFIED_ACTION_OUTCOME', reasonCount: 2, unverifiedOutcomeCount: 1 } },
      { ...base, type: 'tool', toolName: 'write_qa_artifact', toolCallId: 'w1', isError: true, result: 'Discovery cannot finalize yet', durationMs: 3, origin: 'model' },
      { ...base, type: 'operation', operationKind: 'prompt', durationMs: 10, isError: false },
    ];
    for (const e of events) inst.observe(e as any, {} as any);
    await provider.shutdown();
    const verdict = exporter.spans.find((s) => s.name === 'evaluate-discovery-completion');
    const tool = exporter.spans.find((s) => s.name === 'execute_tool write_qa_artifact');
    assert.ok(verdict && tool);
    assert.equal(verdict.parentSpanContext?.spanId, tool.spanContext().spanId);
    assert.equal(verdict.attributes['langfuse.observation.type'], 'event');
    assert.equal(verdict.attributes['langfuse.observation.level'], 'WARNING');
    assert.equal(verdict.attributes['langfuse.observation.metadata.canFinalize'], 'false');
    assert.equal(verdict.attributes['langfuse.observation.metadata.reasonCodes'], 'UNRESOLVED_AUTH_STATE,UNVERIFIED_ACTION_OUTCOME');
    assert.equal(verdict.attributes['langfuse.observation.metadata.reasonCount'], '2');
  });
});

// ---------------------------------------------------------------------------
// Newly exposed navigation — an extension of the same gate
// ---------------------------------------------------------------------------

describe('newly exposed navigation', () => {
  const MAILBOX = 'http://localhost:8025';
  // After signing up, the application renders a link to where the flow
  // continues — here on another port, with a one-time token in it.
  const AFTER_SIGN_UP = AUTH_PAGE.replace(
    '- status [ref=e6]',
    `- status [ref=e6]:\n    - text: Confirmation sent.\n    - link "Open inbox" [ref=e50]:\n      - /url: ${MAILBOX}/confirm?token=s3cr3t-0ne-time-t0ken`,
  );
  const MAILBOX_PAGE = '- main:\n  - link "Confirm your account" [ref=m1]:\n    - /url: http://localhost:4444/confirm\n  - button "Delete all" [ref=m2]';

  /** Sign up and look: the continuation link is now on the page, unfollowed. */
  const signedUp = (aux: string[]) => {
    const s = tracked();
    s.auxiliaryOrigins = aux;
    return replay(s, [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_type', type('Password', 'secret-1')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AFTER_SIGN_UP)],
    ]);
  };

  it('REGRESSION: finalizing past a newly exposed continuation is rejected, on another origin too', () => {
    const s = signedUp([MAILBOX]);
    const nav = s.navigation!.find((t) => t.origin === MAILBOX)!;
    assert.equal(nav.exposedBy, 'ACT-002', 'credited to the Sign Up click');
    assert.equal(nav.scope, 'AUXILIARY');

    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.deepEqual(codes(r), ['UNEXPLORED_RELEVANT_NAVIGATION'], 'one reason for one situation — no duplicate auth reason');
    const reason = r.reasons[0];
    assert.equal(reason.navigationId, nav.id);
    assert.equal(reason.sourceLocation, TARGET);
    assert.match(reason.message, /After the click on button "Sign Up" \(ACT-002\)/);
    assert.match(reason.message, /Follow it/);
    assert.equal(r.metrics.unexploredRelevantNavigationCount, 1);
    assert.equal(r.metrics.authUnresolved, true);
  });

  it('BLOCKED is not accepted while a reachable continuation is unexplored', () => {
    const r = evaluateDiscoveryCompletion({
      surface: signedUp([MAILBOX]),
      artifact: { locations: [{ url: TARGET, status: 'BLOCKED', reason: 'POST_AUTH_DISCOVERY_BLOCKED: cannot sign in' }] },
    });
    assert.deepEqual(codes(r), ['UNEXPLORED_RELEVANT_NAVIGATION']);
  });

  it('following it clears the reason; the flow is then judged on its own', () => {
    const s = signedUp([MAILBOX]);
    replay(s, [
      ['browser_click', click('link', 'Open inbox')],
      ['browser_snapshot', snapshot(MAILBOX_PAGE, `${MAILBOX}/confirm`)],
    ]);
    const midway = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    const inbox = s.navigation!.find((t) => t.origin === MAILBOX)!;
    assert.ok(inbox.followedAt, 'the inbox link was followed');
    assert.ok(!midway.reasons.some((r) => r.navigationId === inbox.id), 'so it is no longer demanded');
    // The mailbox in turn exposed the next step — the chain is followed link by link.
    const next = midway.reasons.find((r) => r.code === 'UNEXPLORED_RELEVANT_NAVIGATION');
    assert.equal(next?.location, 'http://localhost:4444/confirm');

    replay(s, [
      ['browser_click', click('link', 'Confirm your account', `${MAILBOX}/confirm`)],
      ['browser_snapshot', snapshot(AUTH_PAGE, 'http://localhost:4444/confirm')],
      ['browser_click', click('button', 'Sign In', 'http://localhost:4444/confirm')],
      ['browser_snapshot', snapshot(SIGNED_IN)],
      ['browser_click', click('link', 'Notes')],
      ['browser_snapshot', snapshot(NOTES, 'http://localhost:4444/notes')],
      ['browser_click', click('button', 'Create note', 'http://localhost:4444/notes')],
      ['browser_snapshot', snapshot(NOTES, 'http://localhost:4444/notes')],
    ]);
    const done = evaluateDiscoveryCompletion({
      surface: s,
      artifact: explored(TARGET, 'http://localhost:4444/notes', 'http://localhost:4444/confirm'),
    });
    assert.equal(done.canFinalize, true, JSON.stringify(done.reasons));
    assert.equal(done.metrics.followedRelevantNavigationCount >= 1, true);
  });

  it('an origin this run may not visit is named, never followed, and BLOCKED is then the answer', () => {
    const s = signedUp([]);
    const nav = s.navigation!.find((t) => t.origin === MAILBOX)!;
    assert.equal(nav.scope, 'EXTERNAL');
    const open = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.deepEqual(codes(open), ['UNEXPLORED_RELEVANT_NAVIGATION']);
    assert.match(open.reasons[0].message, /do not follow it/);
    assert.match(open.reasons[0].message, /http:\/\/localhost:8025/);
    const blocked = evaluateDiscoveryCompletion({
      surface: s,
      artifact: { locations: [{ url: TARGET, status: 'BLOCKED', reason: 'POST_AUTH_DISCOVERY_BLOCKED: confirmation needs http://localhost:8025' }] },
    });
    assert.equal(blocked.canFinalize, true, JSON.stringify(blocked.reasons));
  });

  it('an irrelevant external link never blocks completion', () => {
    const page = (extra = '') =>
      `- main:\n  - button "Save" [ref=e1]${extra}\n  - contentinfo:\n    - link "Follow us" [ref=f1]:\n      - /url: https://social.example/brand`;
    const s = replay(buildSurface(TARGET, page(), new Date(clock), { trackCompletion: true }), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(page())],
      ['browser_click', click('button', 'Save')],
      // Even a link that appears only now does not block: no flow is open.
      ['browser_snapshot', snapshot(page('\n  - status: Saved.\n  - link "Share" [ref=e9]:\n    - /url: https://share.example/x'))],
    ]);
    const footer = s.navigation!.find((t) => t.origin === 'https://social.example')!;
    assert.equal(footer.exposedBy, undefined, 'present from the start: not exposed by an action');
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
    assert.equal(r.metrics.crossOriginNavigationCount, 2);
    assert.equal(r.metrics.unexploredRelevantNavigationCount, 0);
  });

  it('an already explored continuation stays resolved and is never demanded again', () => {
    const s = signedUp([MAILBOX]);
    replay(s, [
      ['browser_navigate', navigate(`${MAILBOX}/confirm`)],
      ['browser_snapshot', snapshot(MAILBOX_PAGE, `${MAILBOX}/confirm`)],
      ['browser_navigate', navigate(TARGET)],
      // The product renders the same link again: one target, still followed.
      ['browser_snapshot', snapshot(AFTER_SIGN_UP)],
    ]);
    const mailbox = s.navigation!.filter((t) => t.origin === MAILBOX);
    assert.equal(mailbox.length, 1);
    assert.ok(mailbox[0].followedAt);
    for (let i = 0; i < 3; i += 1) {
      const r = evaluateDiscoveryCompletion({ surface: s, artifact: { locations: [{ url: TARGET, status: 'BLOCKED', reason: 'confirmation link rejected by the mailbox' }] } });
      assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
    }
  });

  it('an action that exposes no navigation leaves the existing rules unchanged', () => {
    const page = '- main:\n  - button "Save changes" [ref=e1]';
    const s = replay(buildSurface(TARGET, page, new Date(clock), { trackCompletion: true }), [
      ['browser_navigate', navigate(TARGET)],
      ['browser_snapshot', snapshot(page)],
      ['browser_click', click('button', 'Save changes')],
      ['browser_snapshot', snapshot(`${page}\n  - status: Changes saved.`)],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.equal(r.canFinalize, true);
    assert.equal(r.metrics.newlyVisibleNavigationCount, 0);
  });

  it('never stores or reports a one-time token from a continuation link', () => {
    const s = signedUp([MAILBOX]);
    const stored = JSON.stringify(s);
    assert.ok(!stored.includes('s3cr3t-0ne-time-t0ken'), 'the surface must not hold the token');
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: explored(TARGET) });
    assert.ok(!JSON.stringify(r).includes('s3cr3t'), 'nor may the verdict');
    // Telemetry carries counts and codes, never URLs.
    for (const value of Object.values(r.metrics)) assert.ok(typeof value === 'number' || typeof value === 'boolean');
  });
});

describe('surface fixes found by the real run', () => {
  it('unquotes YAML link values and ignores same-page fragments', () => {
    const links = extractLinks('- link "Inbox" [ref=e5]:\n  - /url: "#"\n- link "Home":\n  - /url: "http://localhost:8025/"\n- link "Docs":\n  - /url: /docs');
    assert.deepEqual(links.map((l) => l.url), ['http://localhost:8025/', '/docs']);
  });

  it('never mints a phantom location from a quoted fragment', () => {
    const s = tracked();
    s.auxiliaryOrigins = ['http://localhost:8025'];
    replay(s, [['browser_snapshot', snapshot('- main:\n  - link "Inbox (23)" [ref=e5]:\n    - /url: "#"', 'http://localhost:8025/')]]);
    assert.ok(!s.locations.some((l) => l.url.includes('%22')), JSON.stringify(s.locations.map((l) => l.url)));
  });

  it('a configured auxiliary page is not demanded in locations; product pages still are', () => {
    const s = tracked();
    s.auxiliaryOrigins = ['http://localhost:8025'];
    expandSurface(s, 'http://localhost:8025/', 'reached while exploring');
    expandSurface(s, 'http://localhost:4444/notes', 'reached while exploring');
    assert.deepEqual(expectedLocations(s), [TARGET, 'http://localhost:4444/notes']);
  });
});
