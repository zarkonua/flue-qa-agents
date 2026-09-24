// The automation project contract.
//
// It exists so a later agent does not have to re-read the repository, and the
// only thing that makes that safe is that every field was checked against the
// repository before it was written. These tests are mostly about what the
// contract REFUSES to carry: a path that is not there, a script that is not in
// package.json, a convention citing a file that does not exist.
//
// The repository is faked here rather than read, so the checks can be exercised
// against a repo that is deliberately wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationContract,
  contractGaps,
  contractSummary,
  validateAutomationContract,
  type AutomationContract,
} from '../src/lib/automation-contract.ts';
import type { RepoAnalysis } from '../src/lib/semantic-validate.ts';
import type { RepoEvidence } from '../src/lib/repo-evidence.ts';

/** A repository containing exactly `paths`, with exactly `scripts`. */
function fakeRepo(paths: string[], scripts: string[] = []): RepoEvidence {
  const set = new Set(paths);
  return {
    rootExists: true,
    exists: (p: string) => set.has(p),
    isDirectory: (p: string) => set.has(p) && !p.includes('.'),
    hasFiles: (p: string) => set.has(p),
    automationDirectories: [],
    scripts: new Set(scripts),
    dependencies: new Set(),
  };
}

/** An analysis of a repository shaped like the real target. */
function analysis(over: Partial<RepoAnalysis> = {}): RepoAnalysis {
  return {
    repository: { packageManager: 'npm', language: 'typescript', testRunner: 'playwright' },
    playwright: {
      configPath: 'playwright.config.ts',
      testDir: 'tests',
      baseURL: 'http://localhost:4444',
      usesStorageState: true,
    },
    layout: [
      { path: 'tests/auth', kind: 'testDir', purpose: 'auth specs' },
      { path: 'pages', kind: 'pageObjects', purpose: 'page objects' },
      { path: 'fixtures', kind: 'fixtures', purpose: 'fixtures' },
    ],
    scripts: [
      { name: 'test', command: 'playwright test', purpose: 'run the suite' },
      { name: 'typecheck', command: 'tsc --noEmit', purpose: 'types' },
    ],
    conventions: [
      { topic: 'fixtures', rule: 'Import test and expect from @fixtures/test', evidencePath: 'fixtures/test.ts', evidenceLine: 12 },
      { topic: 'locators', rule: 'Use getByRole, never CSS', evidencePath: 'pages/SignInPage.ts' },
    ],
    keyFiles: [],
    unknowns: [],
    ...over,
  } as RepoAnalysis;
}

const REAL_PATHS = [
  'playwright.config.ts', 'tests', 'tests/auth', 'pages', 'fixtures',
  'fixtures/test.ts', 'pages/SignInPage.ts',
];
const REAL_SCRIPTS = ['test', 'typecheck'];

const build = (a = analysis(), repo = fakeRepo(REAL_PATHS, REAL_SCRIPTS)) =>
  buildAutomationContract(a, repo, { sourceAnalysisSha256: 'abc123', now: new Date('2026-09-24T00:00:00Z') });

// ---------------------------------------------------------------------------

describe('what the contract carries', () => {
  const c = build();

  it('carries the repository basics', () => {
    assert.deepEqual(c.repository, { language: 'typescript', packageManager: 'npm', testRunner: 'playwright' });
  });

  it('takes the test root from the framework config, not a feature subfolder', () => {
    // A real run put `tests/auth` in the layout while the config said `tests`.
    // Trusting the layout would send every new spec into the auth folder.
    assert.equal(c.testRoot?.value, 'tests');
    assert.equal(c.locations.testDir?.value, 'tests/auth', 'the layout entry is still reported as itself');
  });

  it('carries the framework settings with the file that evidences them', () => {
    assert.equal(c.framework?.baseURL?.value, 'http://localhost:4444');
    assert.equal(c.framework?.baseURL?.evidencePath, 'playwright.config.ts');
    assert.equal(c.framework?.usesStorageState?.value, true);
  });

  it('carries the locations a Generator would import from', () => {
    assert.equal(c.locations.pageObjects?.value, 'pages');
    assert.equal(c.locations.fixtures?.value, 'fixtures');
  });

  it('carries conventions with their evidence intact', () => {
    const fixtures = c.conventions.find((x) => x.topic === 'fixtures');
    assert.match(fixtures!.rule, /@fixtures\/test/);
    assert.equal(fixtures!.evidencePath, 'fixtures/test.ts');
    assert.equal(fixtures!.evidenceLine, 12);
  });

  it('ties itself to the analysis it came from', () => {
    assert.equal(c.sourceAnalysisSha256, 'abc123');
  });

  it('validates against its schema', async () => {
    const { schemaErrorsFor } = await import('../src/lib/qa-artifacts.ts');
    assert.deepEqual(schemaErrorsFor('automation-project-contract', c), []);
  });
});

describe('what the contract refuses to carry', () => {
  it('drops a location that is not in the repository, and records it', () => {
    const c = build(analysis(), fakeRepo(REAL_PATHS.filter((p) => p !== 'pages'), REAL_SCRIPTS));
    assert.equal(c.locations.pageObjects, undefined, 'a path that is not there is not carried');
    assert.ok(c.verification.pathsMissing.includes('pages'), 'and it is recorded, not silently dropped');
  });

  it('drops a convention whose evidence file does not exist', () => {
    const c = build(analysis(), fakeRepo(REAL_PATHS.filter((p) => p !== 'fixtures/test.ts'), REAL_SCRIPTS));
    assert.ok(!c.conventions.some((x) => x.topic === 'fixtures'), 'an unevidenced rule is an invented rule');
    assert.ok(c.conventions.some((x) => x.topic === 'locators'), 'the evidenced one survives');
  });

  it('drops a script that is not in package.json, and records it', () => {
    const c = build(analysis(), fakeRepo(REAL_PATHS, ['test']));
    assert.deepEqual(c.scripts.map((s) => s.name), ['test']);
    assert.deepEqual(c.verification.scriptsMissing, ['typecheck']);
  });

  it('omits the framework block entirely when the analysis had none', () => {
    const c = build(analysis({ playwright: undefined }));
    assert.equal(c.framework, undefined);
    assert.equal(c.testRoot?.value, 'tests/auth', 'falls back to the layout entry');
  });

  it('carries the analysis unknowns through verbatim', () => {
    const c = build(analysis({ unknowns: ['No CI configuration was found'] }));
    assert.deepEqual(c.unknowns, ['No CI configuration was found']);
  });

  it('reports a clean verification when everything checked out', () => {
    const c = build();
    assert.deepEqual(c.verification.pathsMissing, []);
    assert.deepEqual(c.verification.scriptsMissing, []);
    assert.ok(c.verification.pathsChecked > 0);
  });
});

describe('re-validating a contract later', () => {
  it('passes against the repository it was built from', () => {
    const repo = fakeRepo(REAL_PATHS, REAL_SCRIPTS);
    assert.deepEqual(validateAutomationContract(build(analysis(), repo), repo, 'abc123'), []);
  });

  it('reports a path that has since disappeared', () => {
    const c = build();
    const moved = fakeRepo(REAL_PATHS.filter((p) => p !== 'pages'), REAL_SCRIPTS);
    const problems = validateAutomationContract(c, moved);
    assert.ok(problems.some((p) => p.code === 'MISSING_PATH' && /pages/.test(p.detail)));
  });

  it('reports a script that has since been removed', () => {
    const c = build();
    const problems = validateAutomationContract(c, fakeRepo(REAL_PATHS, ['test']));
    assert.ok(problems.some((p) => p.code === 'MISSING_SCRIPT' && /typecheck/.test(p.detail)));
  });

  it('reports a contract built from a different analysis as stale', () => {
    const repo = fakeRepo(REAL_PATHS, REAL_SCRIPTS);
    const problems = validateAutomationContract(build(analysis(), repo), repo, 'a-different-hash');
    assert.ok(problems.some((p) => p.code === 'STALE_SOURCE'));
  });

  it('reports an untraced convention', () => {
    const c = build();
    (c.conventions[0] as { evidencePath: string }).evidencePath = '';
    const problems = validateAutomationContract(c, fakeRepo(REAL_PATHS, REAL_SCRIPTS));
    assert.ok(problems.some((p) => p.code === 'UNTRACED_CONVENTION'));
  });
});

describe('what a Generator still could not determine', () => {
  it('reports nothing missing for a complete contract', () => {
    assert.deepEqual(contractGaps(build()), []);
  });

  it('names the missing test root', () => {
    const c = build(analysis({ playwright: undefined, layout: [] }));
    assert.ok(contractGaps(c).some((g) => /test root/.test(g)));
  });

  it('names a missing page-object root and fixtures location', () => {
    const c = build(analysis({ layout: [{ path: 'tests/auth', kind: 'testDir', purpose: 'specs' }] }));
    const gaps = contractGaps(c);
    assert.ok(gaps.some((g) => /page-object/.test(g)));
    assert.ok(gaps.some((g) => /fixtures/.test(g)));
  });

  it('names missing conventions rather than proceeding quietly', () => {
    const c = build(analysis({ conventions: [] }));
    assert.ok(contractGaps(c).some((g) => /conventions/.test(g)));
  });

  it('summarises without inventing anything', () => {
    const s = contractSummary(build());
    assert.match(s, /tests/);
    assert.match(s, /convention/);
    assert.doesNotMatch(s, /undefined|NaN/);
  });
});

describe('no agent can author the contract', () => {
  it('is absent from the write picklist', async () => {
    const { writeQaArtifactTool } = await import('../src/tools/qa-artifacts.ts');
    const v = await import('valibot');
    const attempt = v.safeParse(writeQaArtifactTool.input!, {
      name: 'automation-project-contract',
      data: {},
    });
    assert.equal(attempt.success, false, 'the widest write tool must refuse the name');
  });

  it('is readable, so a Generator can follow it', async () => {
    const { readQaArtifactTool } = await import('../src/tools/qa-artifacts.ts');
    const v = await import('valibot');
    const ok = v.safeParse(readQaArtifactTool.input!, { name: 'automation-project-contract' });
    assert.equal(ok.success, true);
  });
});

describe('the skill tells later agents to follow it', () => {
  const skill = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/skills/custom/automation-project-contract/SKILL.md', import.meta.url), 'utf8'),
    );

  it('says the repository has already been read', async () => {
    assert.match(await skill(), /has already been read for you/i);
  });

  it('forbids generic structure where the contract disagrees', async () => {
    const s = await skill();
    assert.match(s, /is \*\*wrong here\*\* unless this contract says otherwise/);
  });

  it('says absent is not permission to invent', async () => {
    const s = await skill();
    assert.match(s, /does not mean "free choice"/);
    assert.match(s, /record it as a blocker/);
  });
});
