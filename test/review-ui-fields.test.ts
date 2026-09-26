// What the review screen must show, beyond the fields it already had.
//
// Changes 3-5 added data the screen did not know about: a requirement's
// validation type, whether a discovered behavior survived into the analysis,
// and how a case would be automated. A reviewer reading only the case cards
// could not see any of it, and the point of the screen is that nobody has to
// open the JSON.
//
// The model is built directly here rather than through the server: these are
// assertions about what the screen is given, and test/ui.test.ts already
// covers the server, its routes and its limits.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
const PHASE1 = ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis'];

/**
 * Build the review model in a child process, so QA_ARTIFACT_ROOT is read at
 * module load against a temporary workspace rather than the developer's real one.
 */
function modelFor(mutate?: (artifacts: Record<string, any>) => void): any {
  const root = mkdtempSync(join(tmpdir(), 'qa-review-'));
  const artifacts: Record<string, any> = {};
  for (const name of PHASE1) {
    artifacts[name] = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  }
  mutate?.(artifacts);
  for (const name of PHASE1) writeFileSync(join(root, `${name}.json`), JSON.stringify(artifacts[name], null, 2));

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '-e',
      `const { buildReviewModel } = await import(${JSON.stringify(join(PROJECT, 'src/lib/review-view.ts'))});
       process.stdout.write(JSON.stringify(buildReviewModel()));`,
    ],
    { env: { ...process.env, QA_ARTIFACT_ROOT: root, QA_ENV_FILE: join(tmpdir(), 'no-env-here') }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `model build failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------

describe('the screen shows the requirements, not only the cases', () => {
  const model = modelFor();

  it('lists every acceptance point and business rule', () => {
    assert.ok(model.requirements.length > 0);
    const ids = model.requirements.map((r: any) => r.id);
    assert.ok(ids.includes('AC-1'), `expected AC-1 among ${ids.join(', ')}`);
  });

  it('marks which kind each requirement is', () => {
    for (const r of model.requirements) {
      assert.ok(['acceptancePoint', 'businessRule'].includes(r.kind));
    }
  });

  it('answers the reverse traceability question: what covers this requirement', () => {
    const covered = model.requirements.find((r: any) => r.coveredBy.length > 0);
    assert.ok(covered, 'at least one requirement names the cases that demonstrate it');
    // And it agrees with the case's own covers list, since both derive from the
    // same two artifacts.
    const tc = model.testCases.find((c: any) => c.id === covered.coveredBy[0]);
    assert.ok(tc.covers.some((c: any) => c.id === covered.id), 'the two directions must agree');
  });

  it('shows an uncovered testable requirement as uncovered', () => {
    const m = modelFor((a) => {
      // Drop the case that covers AC-1 without touching anything else.
      a['test-cases'].testCases = a['test-cases'].testCases.filter((c: any) => !(c.covers ?? []).includes('AC-1'));
    });
    const ac1 = m.requirements.find((r: any) => r.id === 'AC-1');
    assert.deepEqual(ac1.coveredBy, []);
    assert.equal(ac1.testable, true, 'still testable — it is simply untested');
    assert.ok(m.coverage.uncoveredIds.includes('AC-1'), 'and the totals agree');
  });

  it('separates a not-testable requirement from an uncovered one', () => {
    const m = modelFor((a) => {
      a['requirements-analysis'].acceptancePoints[0].testable = false;
      a['requirements-analysis'].acceptancePoints[0].notTestableReason = 'Needs a production mailbox.';
      a['test-cases'].testCases = a['test-cases'].testCases.filter(
        (c: any) => !(c.covers ?? []).includes(a['requirements-analysis'].acceptancePoints[0].id),
      );
    });
    const exempt = m.requirements.find((r: any) => r.testable === false);
    assert.ok(exempt);
    assert.match(exempt.notTestableReason, /mailbox/);
    assert.ok(!m.coverage.uncoveredIds.includes(exempt.id), 'exempt is not uncovered');
  });

  it('carries the validation type and the reason behind it', () => {
    const m = modelFor((a) => {
      a['requirements-analysis'].acceptancePoints[0].validationType = 'API';
      a['requirements-analysis'].acceptancePoints[0].validationTypeReason = 'Observed as a request/response pair.';
    });
    const r = m.requirements.find((x: any) => x.validationType);
    assert.equal(r.validationType, 'API');
    assert.match(r.validationTypeReason, /request\/response/);
  });

  it('leaves validationType undefined when the analyst stated none', () => {
    const r = model.requirements.find((x: any) => x.id === 'AC-1');
    assert.equal(r.validationType, undefined, 'absent is honest, not a default');
  });
});

describe('the screen shows how each case would be automated', () => {
  it('carries the strategy and its reason onto the case', () => {
    const m = modelFor((a) => {
      a['automation-prioritization'].cases[0].automationStrategy = 'UI';
      a['automation-prioritization'].cases[0].strategyReason = 'Observed entirely in the DOM.';
    });
    const tc = m.testCases.find((c: any) => c.id === m.testCases[0].id);
    const withStrategy = m.testCases.find((c: any) => c.automationStrategy);
    assert.ok(withStrategy, 'a strategy reaches the screen');
    assert.equal(withStrategy.automationStrategy, 'UI');
    assert.match(withStrategy.strategyReason, /DOM/);
  });

  it('leaves it undefined when the prioritizer stated none', () => {
    const m = modelFor();
    for (const tc of m.testCases) assert.equal(tc.automationStrategy, undefined);
  });

  it('keeps execution mode, automation priority and strategy as separate fields', () => {
    const m = modelFor((a) => {
      a['automation-prioritization'].cases[0].automationStrategy = 'UI';
    });
    const tc = m.testCases.find((c: any) => c.automationStrategy);
    assert.ok(tc.executionMode);
    assert.ok(tc.automationPriority);
    assert.notEqual(tc.executionMode, tc.automationStrategy);
  });
});

describe('the screen reports analysis coverage', () => {
  it('says how many discovered behaviors survived into requirements', () => {
    const m = modelFor();
    assert.ok(m.analysisCoverage, 'present when both artifacts exist');
    assert.equal(m.analysisCoverage.unaccounted, 0);
    assert.ok(m.analysisCoverage.behaviors > 0);
  });

  it('surfaces an unaccounted behavior rather than hiding it', () => {
    const m = modelFor((a) => {
      // Remove the exclusion that accounts for BEH-3 in this fixture.
      delete a['requirements-analysis'].excludedBehaviors;
    });
    assert.ok(m.analysisCoverage.unaccounted > 0);
    assert.ok(m.analysisCoverage.unaccountedIds.includes('BEH-3'));
  });
});

describe('the screen stays a read model', () => {
  const model = modelFor();

  it('computes nothing the host does not already compute', () => {
    // Coverage on the screen is the host's CoverageSummary, not a recount.
    assert.equal(model.coverage.covered + model.coverage.uncovered, model.coverage.testable);
  });

  it('still reports the approval state it is given', () => {
    assert.equal(model.approval.state, 'NONE');
  });

  it('carries no secret, even with a key in the environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-review-secret-'));
    for (const name of PHASE1) copyFileSync(join(FIXTURES, `${name}.json`), join(root, `${name}.json`));
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '-e',
        `const { buildReviewModel } = await import(${JSON.stringify(join(PROJECT, 'src/lib/review-view.ts'))});
         process.stdout.write(JSON.stringify(buildReviewModel()));`,
      ],
      {
        env: {
          ...process.env,
          QA_ARTIFACT_ROOT: root,
          QA_ENV_FILE: join(tmpdir(), 'no-env-here'),
          OPENROUTER_API_KEY: 'sk-or-v1-THIS-MUST-NOT-APPEAR',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /sk-or-v1-THIS-MUST-NOT-APPEAR/);
  });
});

describe('the browser code renders the new data', () => {
  const read = (f: string) => readFileSync(join(PROJECT, 'ui', 'src', f), 'utf8');
  const sources = () => {
    const out: [string, string][] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(join(PROJECT, 'ui', 'src', dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${f.name}` : f.name;
        if (f.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(f.name)) out.push([rel, read(rel)]);
      }
    };
    walk('');
    return out;
  };

  it('renders a requirements table with reverse traceability', () => {
    const page = read('pages/OverviewPage.tsx');
    assert.match(page, /data-testid="requirements"/);
    assert.match(page, /Covered by/);
  });

  it('shows the automation strategy on a case and lets a reviewer filter and search by it', () => {
    const list = read('pages/TestCasesPage.tsx');
    assert.match(list, /automationStrategy/);
    assert.match(list, /aria-label="Strategy"/);
    assert.match(list, /strategyReason/);
  });

  it('calls only its own fixed endpoints, from one module, never an artifact by name', () => {
    for (const [file, text] of sources()) {
      if (file === 'api/client.ts') continue;
      assert.ok(!/fetch\(/.test(text), `${file} must go through api/client.ts`);
    }
    const client = read('api/client.ts');
    const urls = [...client.matchAll(/'(GET|POST)',\s*[`'"]([^`'"]+)/g)].map((m) => m[2]);
    assert.ok(urls.length >= 10);
    for (const url of urls) assert.match(url, /^\/api\//, `the browser may only call /api/*, saw ${url}`);
    assert.ok(!/\.qa\/|\.json['"`]|readFile|writeFile|child_process/.test(client), 'no file or process access');
  });
});
