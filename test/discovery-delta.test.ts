// CHANGE 11: host-computed snapshot deltas, and evidence-backed BLOCKED.
//
//   npm test
//
// Driven through the same `absorbToolResult` the host interceptor calls, with
// the literal result shapes @playwright/mcp returns.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BasicTracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import { absorbToolResult, buildSurface, type DiscoverySurface } from '../src/lib/discovery-surface.ts';
import { deltaCounts, extractMessages, formatDelta, HINT_HEADING, publishDeltaCounts, type SurfaceDelta } from '../src/lib/discovery-delta.ts';
import { attemptEvidence, evaluateDiscoveryCompletion } from '../src/lib/discovery-completion.ts';
import { withHostHint } from '../src/lib/surface-instrumentation.ts';
import { completionMetrics } from '../src/observability/qa-metrics.ts';
import { createAgentInstrumentation } from '../src/observability/agent-langfuse.ts';
import { createLangfuseProcessor, FLUE_OTEL_SCOPE } from '../src/observability/langfuse.ts';

const TARGET = 'http://localhost:4444/';
const HELPER = 'http://localhost:8025';

const ran = (code: string, url = TARGET) =>
  `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: ${url}\n### Snapshot\n- [Snapshot](./page.yml)`;
const snapshot = (tree: string, url = TARGET) => `### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``;
const click = (role: string, name: string, url = TARGET) => ran(`await page.getByRole('${role}', { name: '${name}' }).click();`, url);
const type = (name: string, value: string, submit = false) =>
  ran(`await page.getByRole('textbox', { name: '${name}' }).fill('${value}');${submit ? `\nawait page.getByRole('textbox', { name: '${name}' }).press('Enter');` : ''}`);
const navigate = (url: string) => ran(`await page.goto('${url}');`, url);
const toolError = (tool: string) => `### Error\nInvalid arguments for tool "${tool}":\n✖ Invalid input: expected string, received undefined\n  → at target`;

const AUTH_PAGE = `- main [ref=e2]:
  - heading "Notes Console" [level=1] [ref=e5]
  - status [ref=e6]
  - article [ref=e9]:
    - textbox "Email" [ref=e13]
    - textbox "Password" [ref=e15]
    - button "Sign Up" [ref=e16]
    - button "Sign In" [ref=e25]
  - contentinfo:
    - link "Source" [ref=f1]:
      - /url: https://github.example/app`;
const AUTH_ERROR = AUTH_PAGE.replace('- status [ref=e6]', '- status [ref=e6]: User already exists.');
const AFTER_SIGN_UP = AUTH_PAGE.replace(
  '- status [ref=e6]',
  `- status [ref=e6]:\n    - text: Check your inbox to activate your account.\n    - link "Open mailbox" [ref=e50]:\n      - /url: ${HELPER}/view?token=SECRET123`,
);
const SIGNED_IN = `- main [ref=e2]:
  - heading "Notes Console" [level=1] [ref=e5]
  - button "Log out" [ref=e30]
  - button "Create note" [ref=e31]`;

let clock = Date.parse('2026-09-25T10:00:00Z');
function replay(surface: DiscoverySurface, calls: [string, string][]): SurfaceDelta | undefined {
  let last: SurfaceDelta | undefined;
  for (const [tool, text] of calls) {
    const { delta } = absorbToolResult(surface, `mcp__playwright__${tool}`, text, new Date((clock += 1000)));
    if (delta) last = delta;
  }
  return last;
}
const tracked = (page = AUTH_PAGE, aux: string[] = []) => {
  const s = buildSurface(TARGET, page, new Date(clock), { trackCompletion: true });
  s.auxiliaryOrigins = aux;
  return s;
};
const opened = (s: DiscoverySurface, page = AUTH_PAGE) => replay(s, [['browser_navigate', navigate(TARGET)], ['browser_snapshot', snapshot(page)]]);
const codes = (r: { reasons: { code: string }[] }) => [...new Set(r.reasons.map((x) => x.code))].sort();
const blocked = (reason = 'POST_AUTH_DISCOVERY_BLOCKED: the application rejected the sign-up') => ({
  locations: [{ url: TARGET, status: 'BLOCKED', reason }],
});

// ---------------------------------------------------------------------------
// Part 1 — snapshot deltas
// ---------------------------------------------------------------------------

describe('snapshot delta hints', () => {
  it('a newly exposed link is reported, attributed to the action that exposed it', () => {
    const s = tracked(AUTH_PAGE, [HELPER]);
    opened(s);
    const d = replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AFTER_SIGN_UP)],
    ])!;
    assert.deepEqual(d.afterAction, { id: 'ACT-002', label: 'click on button "Sign Up"' });
    assert.deepEqual(d.newNavigation, [{ name: 'Open mailbox', target: `${HELPER}/view`, scope: 'AUXILIARY' }]);
    assert.deepEqual(d.newMessages, ['Check your inbox to activate your account.']);
    const hint = formatDelta(d);
    assert.match(hint, /since your click on button "Sign Up" \(ACT-002\)/);
    assert.match(hint, /New link "Open mailbox" → http:\/\/localhost:8025\/view \(on a configured helper origin\)/);
    assert.match(hint, /New message: "Check your inbox/);
    assert.equal(s.navigation!.find((t) => t.name === 'Open mailbox')?.exposedBy, 'ACT-002', 'same attribution as navigation awareness');
  });

  it('baseline links on the entry page are never "new"', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_ERROR)],
    ])!;
    assert.deepEqual(d.newNavigation, []);
    assert.ok(!formatDelta(d).includes('Source'));
  });

  it('a newly appeared status message is reported', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_ERROR)],
    ])!;
    assert.deepEqual(d.newMessages, ['User already exists.']);
    assert.equal(deltaCounts(d).newStatusCount, 1);
  });

  it('an action that changes nothing yields one short line, not a list', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [['browser_click', click('button', 'Sign In')], ['browser_snapshot', snapshot(AUTH_PAGE)]])!;
    const lines = formatDelta(d).split('\n');
    assert.equal(lines.length, 3, formatDelta(d));
    assert.match(lines[2], /No visible change/);
    assert.deepEqual(deltaCounts(d), {
      surfaceDeltaGenerated: true, newInteractiveCount: 0, newNavigationCount: 0, newStatusCount: 0, removedRelevantElementCount: 0, pageChanged: false,
    });
  });

  it('reports what disappeared when the shell is replaced', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign In')],
      ['browser_snapshot', snapshot(SIGNED_IN)],
    ])!;
    assert.ok(d.newControls.includes('button:log out'));
    assert.ok(d.removedControls.includes('button:sign up'));
    assert.match(formatDelta(d), /No longer shown: .*button "sign up"/);
  });

  it('a navigation reports the page change, not every control on the new page', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [['browser_navigate', navigate('http://localhost:4444/notes')], ['browser_snapshot', snapshot(SIGNED_IN, 'http://localhost:4444/notes')]])!;
    assert.deepEqual(d.pageChanged, { from: '/', to: '/notes' });
    assert.deepEqual(d.newControls, []);
  });

  it('stays bounded however much changes', () => {
    const s = tracked('- main:\n  - button "Start" [ref=e1]');
    opened(s, '- main:\n  - button "Start" [ref=e1]');
    const many = Array.from({ length: 12 }, (_, i) => `  - button "Action ${String.fromCharCode(65 + i)}" [ref=b${i}]`).join('\n');
    const d = replay(s, [['browser_click', click('button', 'Start')], ['browser_snapshot', snapshot(`- main:\n  - button "Start" [ref=e1]\n${many}`)]])!;
    const hint = formatDelta(d);
    assert.match(hint, /and 8 more/);
    assert.ok(hint.length < 600, `${hint.length} chars`);
  });

  it('is only produced on the first look after an action', () => {
    const s = tracked();
    assert.equal(replay(s, [['browser_snapshot', snapshot(AUTH_PAGE)]]), undefined, 'no action, no delta');
    replay(s, [['browser_click', click('button', 'Sign In')]]);
    assert.ok(replay(s, [['browser_snapshot', snapshot(AUTH_PAGE)]]));
    assert.equal(replay(s, [['browser_snapshot', snapshot(AUTH_PAGE)]]), undefined, 'a second look repeats nothing');
  });

  it('never carries a one-time token — hint, surface, counts or verdict', () => {
    const s = tracked(AUTH_PAGE, [HELPER]);
    opened(s);
    const d = replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AFTER_SIGN_UP)],
    ])!;
    const verdict = evaluateDiscoveryCompletion({ surface: s, artifact: { locations: [{ url: TARGET, status: 'EXPLORED' }] } });
    for (const text of [formatDelta(d), JSON.stringify(s), JSON.stringify(deltaCounts(d)), JSON.stringify(verdict)]) {
      assert.ok(!text.includes('SECRET123'));
    }
  });

  it('reads messages only from status and alert regions', () => {
    assert.deepEqual(extractMessages('- status [ref=e1]: Saved.\n- alert [ref=e2]:\n  - text: Password too short\n- paragraph: Welcome back'), [
      'Saved.',
      'Password too short',
    ]);
    assert.deepEqual(extractMessages('- status [ref=e6]'), []);
  });

  it('reaches the model as a separate, labelled block beside the untouched browser output', () => {
    const browser = { content: [{ type: 'text', text: '### Page\n- Page URL: /' }], details: { customTool: 'browser_snapshot' } };
    const out = withHostHint(browser, `${HINT_HEADING} since your previous action\n- New message: "x"`) as typeof browser;
    assert.equal(out.content.length, 2);
    assert.deepEqual(out.content[0], browser.content[0], 'the browser text is unchanged');
    assert.match(out.content[1].text, /^### Host-observed changes/);
    assert.equal(browser.content.length, 1, 'the original result is not mutated');
    assert.equal(withHostHint('plain', 'hint'), 'plain', 'an unknown shape is left alone');
  });

  it('labels itself as the host\'s, not the browser\'s', () => {
    const s = tracked();
    opened(s);
    const d = replay(s, [['browser_click', click('button', 'Sign In')], ['browser_snapshot', snapshot(AUTH_ERROR)]])!;
    assert.match(formatDelta(d), /computed by the Flue host .* not part of the browser's output/);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — evidence-backed BLOCKED
// ---------------------------------------------------------------------------

describe('BLOCKED needs evidence', () => {
  it('BLOCKED with no attempt at all is rejected', () => {
    const s = tracked();
    opened(s);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: blocked() });
    assert.deepEqual(codes(r), ['BLOCKED_WITHOUT_EVIDENCE']);
    assert.match(r.reasons[0].message, /no sign-in or sign-up was ever performed/);
    assert.equal(r.metrics.blockedWithoutEvidence, true);
  });

  it('a tool failure is not the application blocking the flow', () => {
    const s = tracked();
    opened(s);
    replay(s, [
      ['browser_type', toolError('browser_type')],
      ['browser_type', toolError('browser_type')],
      ['browser_click', toolError('browser_click')],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
    ]);
    assert.equal(s.inputs?.length ?? 0, 0, 'a failed type entered nothing');
    assert.equal(s.actions!.filter((a) => a.auth).length, 0, 'a failed click performed nothing');
    assert.deepEqual(codes(evaluateDiscoveryCompletion({ surface: s, artifact: blocked('invalid credentials') })), ['BLOCKED_WITHOUT_EVIDENCE']);
  });

  it('REGRESSION: clicking Sign Up with an empty form, then "invalid credentials", is rejected', () => {
    const s = tracked();
    opened(s);
    replay(s, [['browser_click', click('button', 'Sign Up')], ['browser_snapshot', snapshot(AUTH_PAGE)]]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: blocked('POST_AUTH_DISCOVERY_BLOCKED: invalid credentials') });
    assert.deepEqual(codes(r), ['BLOCKED_WITHOUT_EVIDENCE']);
    assert.match(r.reasons[0].message, /nothing entered in that form/);
  });

  it('an attempt whose result was never inspected is rejected', () => {
    const s = tracked();
    opened(s);
    replay(s, [['browser_type', type('Email', 'qa@example.test')], ['browser_click', click('button', 'Sign Up')]]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: blocked() });
    assert.ok(codes(r).includes('BLOCKED_WITHOUT_EVIDENCE'));
    assert.ok(codes(r).includes('UNVERIFIED_ACTION_OUTCOME'));
  });

  it('an attempt that visibly changed nothing is rejected', () => {
    const s = tracked();
    opened(s);
    replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_PAGE)],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: blocked() });
    assert.deepEqual(codes(r), ['BLOCKED_WITHOUT_EVIDENCE']);
    assert.match(r.reasons[0].message, /showed no change/);
  });

  it('a genuine application blocker is accepted — success is never required', () => {
    const s = tracked();
    opened(s);
    replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_type', type('Password', 'secret-1')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AUTH_ERROR)],
    ]);
    const evidence = attemptEvidence(s, (a) => a.auth)[0];
    assert.deepEqual(
      { input: evidence.inputBefore, inspected: evidence.inspected, outcome: evidence.outcomeObserved, supported: evidence.supported },
      { input: true, inspected: true, outcome: true, supported: true },
    );
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: blocked() });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
    assert.equal(r.metrics.blockedSupported, true);
  });

  it('Enter pressed inside a sign-in form counts as the attempt', () => {
    const s = tracked();
    opened(s);
    replay(s, [['browser_type', type('Password', 'secret-1', true)], ['browser_snapshot', snapshot(AUTH_ERROR)]]);
    assert.equal(s.actions!.at(-1)!.auth, true);
    assert.equal(evaluateDiscoveryCompletion({ surface: s, artifact: blocked() }).canFinalize, true);
  });

  it('a successful flow needs no BLOCKED and gets no BLOCKED reason', () => {
    const s = tracked();
    opened(s);
    replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign In')],
      ['browser_snapshot', snapshot(SIGNED_IN)],
      ['browser_click', click('button', 'Create note')],
      ['browser_snapshot', snapshot(SIGNED_IN)],
    ]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: { locations: [{ url: TARGET, status: 'EXPLORED' }] } });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
    assert.equal(r.metrics.authUnresolved, false);
  });

  it('a reachable continuation still beats BLOCKED — one reason, not two', () => {
    const s = tracked(AUTH_PAGE, [HELPER]);
    opened(s);
    replay(s, [
      ['browser_type', type('Email', 'qa@example.test')],
      ['browser_click', click('button', 'Sign Up')],
      ['browser_snapshot', snapshot(AFTER_SIGN_UP)],
    ]);
    assert.deepEqual(codes(evaluateDiscoveryCompletion({ surface: s, artifact: blocked() })), ['UNEXPLORED_RELEVANT_NAVIGATION']);
  });

  it('a one-behaviour application still finalizes: no quantity, no BLOCKED involved', () => {
    const page = '- main:\n  - button "Show time" [ref=e1]';
    const s = tracked(page);
    opened(s, page);
    replay(s, [['browser_click', click('button', 'Show time')], ['browser_snapshot', snapshot(`${page}\n  - status: 10:42`)]]);
    const r = evaluateDiscoveryCompletion({ surface: s, artifact: { locations: [{ url: TARGET, status: 'EXPLORED' }] } });
    assert.equal(r.canFinalize, true, JSON.stringify(r.reasons));
  });
});

// ---------------------------------------------------------------------------
// Part 4 — telemetry
// ---------------------------------------------------------------------------

describe('delta and BLOCKED telemetry', () => {
  it('rolls up BLOCKED proposals and verdicts on the stage', () => {
    const m = completionMetrics({
      attempts: [
        { canFinalize: false, reasonCodes: ['BLOCKED_WITHOUT_EVIDENCE'], metrics: { blockedProposed: true } },
        { canFinalize: false, reasonCodes: ['UNRESOLVED_AUTH_STATE'], metrics: { blockedProposed: false } },
        { canFinalize: true, reasonCodes: [], metrics: { blockedProposed: true, authAttemptCount: 2, surfaceDeltaCount: 5 } },
      ],
    });
    assert.equal(m.blockedAttemptCount, 2);
    assert.equal(m.blockedAcceptedCount, 1);
    assert.equal(m.blockedRejectedCount, 1);
    assert.equal(m.blockedWithoutEvidenceCount, 1);
    assert.equal(m.surfaceDeltaCount, 5);
  });

  it('puts delta counts — never text or URLs — on the snapshot\'s tool observation', async () => {
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
    publishDeltaCounts('snap-1', { surfaceDeltaGenerated: true, newInteractiveCount: 1, newNavigationCount: 1, newStatusCount: 1, removedRelevantElementCount: 0, pageChanged: false });
    const base = { instanceId: 'i', submissionId: 's', operationId: 'op', agentName: 'product-discovery', timestamp: Date.now() };
    for (const e of [
      { ...base, type: 'operation_start', operationKind: 'prompt' },
      { ...base, type: 'tool_start', toolName: 'mcp__playwright__browser_snapshot', toolCallId: 'snap-1', args: {}, origin: 'model' },
      { ...base, type: 'tool', toolName: 'mcp__playwright__browser_snapshot', toolCallId: 'snap-1', isError: false, result: 'x', durationMs: 5, origin: 'model' },
      { ...base, type: 'operation', operationKind: 'prompt', durationMs: 10, isError: false },
    ]) inst.observe(e as any, {} as any);
    await provider.shutdown();
    const tool = exporter.spans.find((s) => s.name === 'execute_tool mcp__playwright__browser_snapshot')!;
    const meta = (k: string) => tool.attributes[`langfuse.observation.metadata.${k}`];
    assert.equal(meta('surfaceDeltaGenerated'), 'true');
    assert.equal(meta('newNavigationCount'), '1');
    assert.equal(meta('newStatusCount'), '1');
    assert.ok(!JSON.stringify(tool.attributes).includes('Host-observed'), 'no delta text');
  });
});
