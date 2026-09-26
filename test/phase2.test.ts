// Phase 2, stage 1 — the Repo Analyzer and the boundary around it.
//
//   npm test
//
// Every invariant here is enforced in host code, by a tool's input schema, or
// by a closed allowlist — none of it depends on a model following instructions.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

import { validateRepoAnalysis, type RepoAnalysis, type RepoFacts } from '../src/lib/semantic-validate.ts';
import { wasWrittenDuring } from '../scripts/lib/stage.mjs';
import {
  assertWiredStages,
  NOT_YET_WIRED,
  PHASE2_AGENTS,
  PHASE2_STAGES,
  UNWIRED_ARTIFACTS,
} from '../scripts/lib/phase2-stages.mjs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One artifact root for the whole file: qa-artifacts.ts reads QA_ARTIFACT_ROOT
// once, when it first loads, and every module that imports it shares that value.
const ROOT = mkdtempSync(join(tmpdir(), 'qa-phase2-'));
process.env.QA_ARTIFACT_ROOT = ROOT;

// ---------------------------------------------------------------------------
// A minimal but realistic Playwright repository to validate against
// ---------------------------------------------------------------------------

const REPO = mkdtempSync(join(tmpdir(), 'qa-target-repo-'));
for (const dir of ['tests', 'pages', 'fixtures', 'api', 'data']) mkdirSync(join(REPO, dir), { recursive: true });
writeFileSync(
  join(REPO, 'package.json'),
  JSON.stringify({
    name: 'demo-e2e',
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': '^1.63.0' },
  }),
);
writeFileSync(join(REPO, 'playwright.config.ts'), 'export default { testDir: "./tests" };\n');
writeFileSync(join(REPO, 'tests', 'login.spec.ts'), 'import { test } from "@playwright/test";\n');
writeFileSync(join(REPO, 'pages', 'LoginPage.ts'), 'export class LoginPage extends BasePage {}\n');
writeFileSync(join(REPO, 'fixtures', 'test.ts'), 'export const test = base.extend({});\n');
writeFileSync(join(REPO, 'api', 'client.ts'), 'export class Client {}\n');
writeFileSync(join(REPO, 'data', 'users.ts'), 'export const users = {};\n');

/** The real evidence shape, backed by the fixture repo above. */
const DIRS = ['tests', 'pages', 'fixtures', 'api', 'data'];
const FILES = [
  'package.json',
  'playwright.config.ts',
  'tests/login.spec.ts',
  'pages/LoginPage.ts',
  'fixtures/test.ts',
  'api/client.ts',
  'data/users.ts',
];
const facts: RepoFacts = {
  rootExists: true,
  exists: (p) => FILES.includes(p) || DIRS.includes(p),
  isDirectory: (p) => DIRS.includes(p),
  hasFiles: (p) => DIRS.includes(p),
  automationDirectories: [...DIRS],
  scripts: new Set(['test']),
  dependencies: new Set(['@playwright/test']),
};

const valid: RepoAnalysis = {
  repository: { packageManager: 'npm', language: 'typescript', testRunner: 'playwright' },
  playwright: { configPath: 'playwright.config.ts', testDir: 'tests' },
  layout: [
    { path: 'tests', kind: 'testDir', purpose: 'Specs', examples: ['tests/login.spec.ts'] },
    { path: 'pages', kind: 'pageObjects', purpose: 'Page objects', examples: ['pages/LoginPage.ts'] },
    { path: 'fixtures', kind: 'fixtures', purpose: 'Shared test object', examples: ['fixtures/test.ts'] },
    { path: 'api', kind: 'apiClients', purpose: 'REST wrapper', examples: ['api/client.ts'] },
    { path: 'data', kind: 'testData', purpose: 'Credentials', examples: ['data/users.ts'] },
  ],
  scripts: [{ name: 'test', purpose: 'Run the suite' }],
  dependencies: [{ name: '@playwright/test', role: 'runner' }],
  conventions: [{ topic: 'pageObjects', rule: 'One class per page', evidencePath: 'pages/LoginPage.ts' }],
  keyFiles: [{ path: 'playwright.config.ts', why: 'testDir and projects' }],
  unknowns: [],
};

const clone = <T>(x: T): T => structuredClone(x);
const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

// ---------------------------------------------------------------------------
// 5. repo-analysis schema validation
// ---------------------------------------------------------------------------

describe('repo-analysis schema', () => {
  it('accepts a well-formed analysis', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.deepEqual(schemaErrorsFor('repo-analysis', valid), []);
  });

  it('requires repository, layout, conventions, keyFiles and unknowns', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const errors = schemaErrorsFor('repo-analysis', {});
    for (const key of ['repository', 'layout', 'conventions', 'keyFiles', 'unknowns']) {
      assert.ok(errors.some((e) => e.includes(`"${key}"`)), `expected a complaint about ${key}: ${errors.join(' | ')}`);
    }
  });

  it('rejects an unknown layout kind', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const bad = clone(valid);
    (bad.layout[0] as { kind: string }).kind = 'sourceCode';
    assert.ok(schemaErrorsFor('repo-analysis', bad).some((e) => e.includes('layout[0].kind')));
  });

  it('rejects unexpected top-level properties', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    const bad = { ...clone(valid), recommendations: ['rewrite everything'] };
    assert.ok(schemaErrorsFor('repo-analysis', bad).some((e) => e.includes('recommendations')));
  });

  it('is registered under its own file name', async () => {
    const { qaArtifactPath } = await import('../src/lib/qa-artifacts.ts');
    assert.ok(qaArtifactPath('repo-analysis').endsWith('repo-analysis.json'));
  });
});

// ---------------------------------------------------------------------------
// Semantic validation: nothing the model asserts about the repo is trusted
// ---------------------------------------------------------------------------

describe('repo-analysis semantic validation', () => {
  it('accepts an analysis whose every path exists', () => {
    assert.deepEqual(validateRepoAnalysis(valid, facts), []);
  });

  it('rejects an invented directory', () => {
    const bad = clone(valid);
    bad.layout.push({ path: 'support', kind: 'helpers', purpose: 'Invented' });
    const errors = validateRepoAnalysis(bad, facts);
    assert.ok(errors.some((e) => e.code === 'UNKNOWN_PATH' && e.value === 'support'));
  });

  it('rejects an invented evidence path for a convention', () => {
    const bad = clone(valid);
    bad.conventions[0].evidencePath = 'pages/BasePage.ts';
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('UNKNOWN_PATH'));
  });

  it('rejects an invented example file', () => {
    const bad = clone(valid);
    bad.layout[0].examples = ['tests/checkout.spec.ts'];
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('UNKNOWN_PATH'));
  });

  it('rejects a key file that is not there', () => {
    const bad = clone(valid);
    bad.keyFiles.push({ path: 'tsconfig.json', why: 'assumed' });
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('UNKNOWN_PATH'));
  });

  it('accepts "./tests" and "tests/" as the same real directory', () => {
    const ok = clone(valid);
    ok.layout[0].path = './tests/';
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  it('rejects an absolute path', () => {
    const bad = clone(valid);
    bad.keyFiles.push({ path: '/etc/passwd', why: 'escape attempt' });
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('BAD_PATH'));
  });

  it('rejects a path escaping the repository with ".."', () => {
    const bad = clone(valid);
    bad.keyFiles.push({ path: '../../.claude/settings.local.json', why: 'escape attempt' });
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('BAD_PATH'));
  });

  it('rejects a file where a directory is required', () => {
    const bad = clone(valid);
    bad.playwright!.testDir = 'playwright.config.ts';
    assert.ok(validateRepoAnalysis(bad, facts).some((e) => e.code === 'BAD_PATH' && /directory/.test(e.details ?? '')));
  });

  it('rejects describing the same directory twice', () => {
    const bad = clone(valid);
    bad.layout.push({ path: './tests', kind: 'other', purpose: 'again' });
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('DUPLICATE_PATH'));
  });

  it('rejects a script that is not in package.json', () => {
    const bad = clone(valid);
    bad.scripts = [{ name: 'test:e2e', purpose: 'invented' }];
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('UNKNOWN_SCRIPT'));
  });

  it('rejects a dependency that is not in package.json', () => {
    const bad = clone(valid);
    bad.dependencies = [{ name: '@faker-js/faker', role: 'invented' }];
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('UNKNOWN_DEPENDENCY'));
  });

  it('skips script and dependency checks when the repo has no package.json', () => {
    const noPkg: RepoFacts = { ...facts, scripts: undefined, dependencies: undefined };
    const a = clone(valid);
    a.scripts = [{ name: 'whatever', purpose: 'unverifiable' }];
    a.dependencies = [{ name: 'whatever', role: 'unverifiable' }];
    assert.deepEqual(validateRepoAnalysis(a, noPkg), []);
  });

  it('rejects a baseURL copied as an expression instead of a value', () => {
    const bad = clone(valid);
    bad.playwright!.baseURL = "process.env.BASE_URL ?? 'http://localhost:4444'";
    assert.ok(codes(validateRepoAnalysis(bad, facts)).includes('NOT_A_LITERAL'));
  });

  it('accepts a literal baseURL', () => {
    const ok = clone(valid);
    ok.playwright!.baseURL = 'http://localhost:4444';
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  // -- completeness: it must have looked, not only been truthful ------------

  it('rejects an analysis that never mentions a directory holding automation', () => {
    const bad = clone(valid);
    bad.layout = bad.layout.filter((l) => l.path !== 'api' && l.path !== 'data');
    const errors = validateRepoAnalysis(bad, facts);
    assert.ok(errors.some((e) => e.code === 'UNEXPLORED_DIRECTORY' && e.value === 'api'));
    assert.ok(errors.some((e) => e.code === 'UNEXPLORED_DIRECTORY' && e.value === 'data'));
  });

  it('accepts a skipped directory when unknowns says why', () => {
    const ok = clone(valid);
    ok.layout = ok.layout.filter((l) => l.path !== 'data');
    ok.unknowns = ['data/ holds seed files in a format I could not read'];
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  it('counts a keyFile inside a directory as describing it', () => {
    const ok = clone(valid);
    ok.layout = ok.layout.filter((l) => l.path !== 'data');
    ok.keyFiles.push({ path: 'data/users.ts', why: 'where credentials come from' });
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  it('rejects an apiClients directory with no file named inside it', () => {
    const bad = clone(valid);
    bad.layout.find((l) => l.path === 'api')!.examples = [];
    const errors = validateRepoAnalysis(bad, facts);
    assert.ok(errors.some((e) => e.code === 'UNINSPECTED_DIRECTORY' && e.value === 'api'));
  });

  it('rejects a testData directory with no file named inside it', () => {
    const bad = clone(valid);
    bad.layout.find((l) => l.path === 'data')!.examples = [];
    assert.ok(validateRepoAnalysis(bad, facts).some((e) => e.code === 'UNINSPECTED_DIRECTORY' && e.value === 'data'));
  });

  it('rejects a page-object directory with no class named inside it', () => {
    const bad = clone(valid);
    bad.layout.find((l) => l.path === 'pages')!.examples = [];
    bad.conventions = [];
    assert.ok(validateRepoAnalysis(bad, facts).some((e) => e.code === 'UNINSPECTED_DIRECTORY' && e.value === 'pages'));
  });

  it("accepts a directory evidenced only by a convention's evidencePath", () => {
    const ok = clone(valid);
    ok.layout.find((l) => l.path === 'fixtures')!.examples = [];
    ok.conventions.push({ topic: 'fixtures', rule: 'Specs import test from fixtures/test.ts', evidencePath: 'fixtures/test.ts' });
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  it('does not demand a file from a directory that has none', () => {
    const emptyDir: RepoFacts = { ...facts, hasFiles: (p) => p !== 'data' };
    const ok = clone(valid);
    ok.layout.find((l) => l.path === 'data')!.examples = [];
    assert.deepEqual(validateRepoAnalysis(ok, emptyDir), []);
  });

  it('does not demand a file inside kinds that are single files or config', () => {
    const ok = clone(valid);
    ok.layout.push({ path: 'playwright.config.ts', kind: 'config', purpose: 'Runner config' });
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  // -- the conventions this analyzer is expected to be able to express -------

  it('can express page-object inheritance, spec naming and tagging', () => {
    const ok = clone(valid);
    ok.conventions = [
      { topic: 'pageObjects', rule: 'Every page object extends BasePage', evidencePath: 'pages/LoginPage.ts' },
      { topic: 'naming', rule: 'Specs are kebab-case .spec.ts under a feature folder', evidencePath: 'tests/login.spec.ts' },
      { topic: 'organization', rule: 'Tests carry @smoke or @regression tags', evidencePath: 'tests/login.spec.ts' },
      { topic: 'testData', rule: 'Credentials come from data/users.ts, never inline', evidencePath: 'data/users.ts' },
      { topic: 'other', rule: 'Setup and teardown go through the API client', evidencePath: 'api/client.ts' },
    ];
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });

  it('rejects an analysis that describes nothing', () => {
    const empty: RepoAnalysis = { ...clone(valid), layout: [], keyFiles: [], conventions: [] };
    assert.ok(codes(validateRepoAnalysis(empty, facts)).includes('EMPTY_ANALYSIS'));
  });

  it('reports a missing repository as a host problem the agent cannot fix', () => {
    const errors = validateRepoAnalysis(valid, { ...facts, rootExists: false });
    assert.deepEqual(codes(errors), ['MISSING_UPSTREAM']);
    assert.match(errors[0].details ?? '', /cannot fix/);
  });

  it('does not fact-check prose judgements', () => {
    const ok = clone(valid);
    ok.risks = ['No fixtures exist yet, so every test will repeat its own setup'];
    ok.unknowns = ['Whether CI runs the suite in parallel'];
    ok.conventions[0].rule = 'Page objects expose readonly Locator fields built with getByRole';
    assert.deepEqual(validateRepoAnalysis(ok, facts), []);
  });
});

// ---------------------------------------------------------------------------
// 7. Repo root security protections still hold
// ---------------------------------------------------------------------------

describe('target repo containment', () => {
  it('rejects the paths the repo tools must never resolve', async () => {
    const { resolveInsideRoot, PathNotAllowedError } = await import('../src/lib/trusted-roots.ts');
    for (const bad of [
      '/etc/passwd',
      '../flue-qa-agents/src/lib/trusted-roots.ts',
      '.git/config',
      '.env',
      '.claude/settings.local.json',
      'tests/../../escape.ts',
      'node_modules/anything',
      'secrets/id_rsa',
      'certs/server.pem',
    ]) {
      assert.throws(() => resolveInsideRoot(REPO, bad), PathNotAllowedError, `should have rejected ${bad}`);
    }
  });

  it('still resolves an ordinary repo-relative path', async () => {
    const { resolveInsideRoot } = await import('../src/lib/trusted-roots.ts');
    assert.equal(resolveInsideRoot(REPO, 'tests/login.spec.ts'), join(REPO, 'tests/login.spec.ts'));
  });

  it('treats a blocked path as non-existent rather than throwing, when gathering evidence', async () => {
    process.env.QA_TARGET_REPO_ROOT = REPO;
    const { collectRepoEvidence } = await import('../src/lib/repo-evidence.ts');
    const evidence = collectRepoEvidence();
    // The module caches TARGET_REPO_ROOT at load; only assert behaviour that
    // holds either way — a blocked path must never report as existing.
    assert.equal(evidence.exists('.git/config'), false);
    assert.equal(evidence.exists('../escape'), false);
    assert.equal(evidence.exists('/etc/passwd'), false);
  });
});

describe('repository evidence is gathered from the real filesystem', () => {
  /** collectRepoEvidence caches the root at import, so ask a child process. */
  const evidenceFor = (root: string) => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '-e',
       'const { collectRepoEvidence } = await import("./src/lib/repo-evidence.ts");' +
       'const e = collectRepoEvidence();' +
       'console.log(JSON.stringify({ dirs: e.automationDirectories, apiHasFiles: e.hasFiles("api"), ' +
       'emptyHasFiles: e.hasFiles("nope"), scripts: [...(e.scripts ?? [])], deps: [...(e.dependencies ?? [])] }));'],
      { cwd: PROJECT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, QA_TARGET_REPO_ROOT: root } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  it('finds every automation directory in the repository', () => {
    const e = evidenceFor(REPO);
    assert.deepEqual([...e.dirs].sort(), ['api', 'data', 'fixtures', 'pages', 'tests']);
  });

  it('knows which directories actually contain files', () => {
    const e = evidenceFor(REPO);
    assert.equal(e.apiHasFiles, true);
    assert.equal(e.emptyHasFiles, false);
  });

  it('reads scripts and dependencies from the repository package.json', () => {
    const e = evidenceFor(REPO);
    assert.deepEqual(e.scripts, ['test']);
    assert.deepEqual(e.deps, ['@playwright/test']);
  });

  it('reports nothing when the repository is not there', () => {
    const e = evidenceFor(join(tmpdir(), 'definitely-not-a-repo-' + Date.now()));
    assert.deepEqual(e.dirs, []);
    assert.equal(e.apiHasFiles, false);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. The agent's tools
// ---------------------------------------------------------------------------

describe('Repo Analyzer capabilities', () => {
  const source = readFileSync(join(PROJECT, 'src/agents/repo-analyzer.ts'), 'utf8');

  it('mounts only read-only repo tools, artifact read, and its own writer', () => {
    for (const tool of ['listRepoDirectoryTool', 'readRepoFileTool', 'searchRepoTool', 'readQaArtifactTool']) {
      assert.ok(source.includes(`useTool(${tool})`), `expected ${tool} to be mounted`);
    }
    assert.ok(source.includes('useTool(writeOwnArtifact)'));
  });

  it('has no browser tools', () => {
    assert.ok(!/browserTools|playwright-mcp|BROWSER_TOOLS/.test(source), 'must not import any browser capability');
  });

  it('has no test-code write or run tools', () => {
    for (const forbidden of ['writeTestFileTool', 'runPlaywrightTestTool', 'runTypecheckTool', 'tools/test-code']) {
      assert.ok(!source.includes(forbidden), `must not mount ${forbidden}`);
    }
  });

  it('cannot write any artifact but its own', async () => {
    const { writeQaArtifactToolFor } = await import('../src/tools/qa-artifacts.ts');
    const tool = writeQaArtifactToolFor(['repo-analysis']);
    assert.equal(v.safeParse(tool.input!, { name: 'repo-analysis', data: {} }).success, true);
    for (const other of ['test-cases', 'automation-prioritization', 'ui-exploration', 'automation-plan', 'discovered-behavior']) {
      assert.equal(v.safeParse(tool.input!, { name: other, data: {} }).success, false, `${other} must be rejected by the input schema`);
    }
  });

  it('cannot name the approval file at all', async () => {
    const { writeQaArtifactToolFor } = await import('../src/tools/qa-artifacts.ts');
    const tool = writeQaArtifactToolFor(['repo-analysis']);
    assert.equal(v.safeParse(tool.input!, { name: 'phase1-approval', data: {} }).success, false);
  });
});

// ---------------------------------------------------------------------------
// 8 & 9. The stage list is a closed allowlist that stops after Repo Analyzer
// ---------------------------------------------------------------------------

describe('Phase 2 orchestration boundary', () => {
  it('runs exactly one stage today: Repo Analyzer', () => {
    assert.equal(PHASE2_STAGES.length, 1);
    assert.equal(PHASE2_STAGES[0].agent, 'src/agents/repo-analyzer.ts');
    assert.equal(PHASE2_STAGES[0].artifact, 'repo-analysis');
  });

  it('does not invoke UI Explorer or Automation Generator', () => {
    const agents = PHASE2_STAGES.map((s) => s.agent);
    for (const unwired of ['src/agents/ui-explorer.ts', 'src/agents/automation-generator.ts']) {
      assert.ok(!agents.includes(unwired), `${unwired} must not be in the stage list`);
      assert.ok(!PHASE2_AGENTS.has(unwired), `${unwired} must not be in the allowlist`);
      assert.ok(NOT_YET_WIRED.includes(unwired));
    }
  });

  it('refuses at startup if an unwired agent is ever added to the stage list', () => {
    assert.throws(
      () => assertWiredStages([{ key: 'x', label: 'x', agent: 'src/agents/ui-explorer.ts', artifact: 'ui-exploration' }]),
      /not a wired Phase 2 agent/,
    );
    assert.throws(
      () => assertWiredStages([{ key: 'x', label: 'x', agent: 'src/agents/automation-generator.ts', artifact: 'automation-plan' }]),
      /not a wired Phase 2 agent/,
    );
  });

  it('watches for artifacts of the unwired stages', () => {
    assert.deepEqual([...UNWIRED_ARTIFACTS].sort(), ['automation-plan', 'ui-exploration']);
  });
});

// ---------------------------------------------------------------------------
// 1 & 2. The gate really does stop everything (end to end, real process)
// ---------------------------------------------------------------------------

describe('Phase 2 entry gate blocks the stage', () => {
  /** Run the real command against an isolated, empty workspace. */
  const runAutomation = (artifactRoot: string, extraEnv: Record<string, string> = {}, args: string[] = []) =>
    spawnSync(process.execPath, ['scripts/qa-automation.mjs', ...args], {
      cwd: PROJECT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, QA_ARTIFACT_ROOT: artifactRoot, QA_TARGET_REPO_ROOT: REPO, ...extraEnv },
    });

  it('refuses with GATE_REFUSED when Phase 1 never ran, and starts no agent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qa-empty-'));
    const result = runAutomation(empty);
    assert.equal(result.status, 4, `expected EXIT.GATE_REFUSED\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /does not exist|not approved/i);
    // No agent was started: nothing wrote a run log or an artifact.
    assert.ok(!result.stdout.includes('Repo Analyzer'), 'must not reach the Repo Analyzer stage');
    assert.ok(!result.stdout.includes('PHASE 2 GATE: OPEN'));
  });

  it('refuses when Phase 1 artifacts exist but nobody approved them', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-unapproved-'));
    const fixtures = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
    for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
      writeFileSync(join(root, `${name}.json`), readFileSync(join(fixtures, `${name}.json`), 'utf8'));
    }
    const result = runAutomation(root);
    assert.equal(result.status, 4, `expected EXIT.GATE_REFUSED\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /not approved/i);
    assert.ok(!result.stdout.includes('Repo Analyzer'));
  });

  it('opens the gate once a person approves, and --gate-only still starts no agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-approved-'));
    const fixtures = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
    for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
      writeFileSync(join(root, `${name}.json`), readFileSync(join(fixtures, `${name}.json`), 'utf8'));
    }
    // Approve in a child process, so the approval is bound to THIS root.
    const approve = spawnSync(process.execPath, ['scripts/qa-approve.mjs'], {
      cwd: PROJECT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, QA_ARTIFACT_ROOT: root },
    });
    assert.equal(approve.status, 0, `approval failed:\n${approve.stdout}\n${approve.stderr}`);

    const result = runAutomation(root, {}, ['--gate-only']);
    assert.equal(result.status, 0, `expected the gate to open\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /PHASE 2 GATE: OPEN/);
    assert.match(result.stdout, /no agent was started/);
    assert.ok(!result.stdout.includes('attempt 1/'), 'no stage may run under --gate-only');
  });
});

// ---------------------------------------------------------------------------
// 6. A stale artifact cannot make a failed attempt pass
// ---------------------------------------------------------------------------

describe('freshness', () => {
  it('does not accept an artifact written before the attempt started', () => {
    const path = join(ROOT, 'stale-repo-analysis.json');
    writeFileSync(path, JSON.stringify(valid));
    const tenMinutesAgo = Date.now() / 1000 - 600;
    utimesSync(path, tenMinutesAgo, tenMinutesAgo);
    assert.equal(wasWrittenDuring(path, Date.now()), false);
  });

  it('accepts an artifact written during the attempt', () => {
    const started = Date.now();
    const path = join(ROOT, 'fresh-repo-analysis.json');
    writeFileSync(path, JSON.stringify(valid));
    assert.equal(wasWrittenDuring(path, started), true);
  });

  it('treats a missing artifact as not fresh', () => {
    assert.equal(wasWrittenDuring(join(ROOT, 'never-written.json'), Date.now()), false);
  });
});

// ---------------------------------------------------------------------------
// 10. Phase 1 is unchanged by the shared orchestration
// ---------------------------------------------------------------------------

describe('Phase 1 is unaffected', () => {
  const manual = readFileSync(join(PROJECT, 'scripts/qa-manual.mjs'), 'utf8');

  it('still runs exactly its four agents, from its own closed allowlist', () => {
    for (const agent of [
      'src/agents/product-discovery.ts',
      'src/agents/behavior-analyst.ts',
      'src/agents/test-designer.ts',
      'src/agents/automation-prioritizer.ts',
    ]) {
      assert.ok(manual.includes(agent), `${agent} must still be a Phase 1 stage`);
    }
    assert.ok(!manual.includes('src/agents/repo-analyzer.ts'), 'Phase 1 must not gain the Phase 2 agent');
  });

  it('still keeps its own conversation-id namespace', () => {
    assert.ok(manual.includes("idPrefix: 'p1'"));
  });

  it('shares one retry policy with Phase 2: even attempts resume, odd start fresh', async () => {
    const { retryMessage } = await import('../scripts/lib/stage.mjs');
    const stage = { artifact: 'repo-analysis' };
    assert.match(retryMessage(stage, 'repo-analysis.json was not written by this attempt.'), /Nothing was saved/);
    assert.match(retryMessage(stage, 'repo-analysis.json fails its schema: x'), /failed host validation/);
  });
});
