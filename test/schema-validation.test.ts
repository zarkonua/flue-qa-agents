// Structural validation with Ajv (JSON Schema Draft 2020-12).
//
//   npm test
//
// Behaviour, not implementation: what is accepted, what is rejected and where
// the error points, that nothing is modified, and that every schema compiles.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compiledSchemaCount,
  displayPath,
  formatSchemaIssue,
  schemaValidator,
  validateWithSchema,
} from '../src/lib/schema-validation.ts';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = join(PROJECT, 'schemas');
const FIXTURES = join(PROJECT, 'test', 'fixtures', 'phase1-approved');
const scratch = mkdtempSync(join(tmpdir(), 'schema-validation-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const schema = (name: string) => join(SCHEMAS, `${name}.schema.json`);
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

describe('every schema', () => {
  const files = readdirSync(SCHEMAS).filter((f) => f.endsWith('.schema.json'));

  it('is found', () => assert.ok(files.length >= 12, files.join(', ')));

  for (const file of files) {
    it(`${file} declares Draft 2020-12 and compiles in strict mode`, () => {
      assert.equal(JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8')).$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(typeof schemaValidator(join(SCHEMAS, file)), 'function');
    });
  }

  it('covers every schema the artifact registry uses', async () => {
    const { registeredSchemaFiles } = await import('../src/lib/qa-artifacts.ts');
    for (const file of registeredSchemaFiles()) assert.ok(files.includes(file), `${file} is registered but missing`);
  });

  it('a broken schema fails loudly at compile time, not silently at validation', () => {
    const bad = join(scratch, 'bad.schema.json');
    writeFileSync(bad, JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', requird: ['x'] }));
    assert.throws(() => schemaValidator(bad), /strict mode: unknown keyword: "requird"/);
  });
});

describe('what is accepted and rejected', () => {
  const valid = () => structuredClone(fixture('test-cases'));

  it('accepts every approved Phase 1 fixture', () => {
    for (const name of ['discovered-behavior', 'requirements-analysis', 'test-cases', 'automation-prioritization', 'defect-analysis']) {
      assert.deepEqual(validateWithSchema(schema(name), fixture(name)), [], name);
    }
  });

  it('rejects a missing required property, pointing at the property', () => {
    const data = valid();
    delete data.testCases[0].title;
    assert.deepEqual(validateWithSchema(schema('test-cases'), data), [
      { path: '/testCases/0/title', keyword: 'required', message: 'missing required property "title"' },
    ]);
  });

  it('rejects a wrong primitive type, top-level and nested', () => {
    const data = valid();
    data.feature = 42;
    data.testCases[1].steps[0].expected = ['not', 'a', 'string'];
    const issues = validateWithSchema(schema('test-cases'), data);
    assert.deepEqual(paths(issues), ['/feature', '/testCases/1/steps/0/expected']);
    assert.ok(issues.every((i) => i.keyword === 'type' && i.message === 'must be string'));
  });

  it('rejects a value outside an enum, and names the allowed values', () => {
    const data = valid();
    data.testCases[0].priority = 'P9';
    const [issue] = validateWithSchema(schema('test-cases'), data);
    assert.equal(issue.path, '/testCases/0/priority');
    assert.equal(issue.message, 'must be one of ["P0","P1","P2","P3"]');
  });

  it('rejects additional properties where the schema forbids them', () => {
    const data = valid();
    data.testCases[0].shadowField = 'x';
    assert.deepEqual(validateWithSchema(schema('test-cases'), data), [
      { path: '/testCases/0/shadowField', keyword: 'additionalProperties', message: 'unexpected property "shadowField"' },
    ]);
  });

  it('validates every array item, not only the first', () => {
    const data = valid();
    data.testCases[1].types = ['positive', 'chaos'];
    assert.deepEqual(paths(validateWithSchema(schema('test-cases'), data)), ['/testCases/1/types/1']);
  });

  it('enforces pattern and minItems', () => {
    const analysis = fixture('defect-analysis');
    analysis.findings[0].id = 'D1';
    assert.deepEqual(validateWithSchema(schema('defect-analysis'), analysis).map((i) => i.keyword), ['pattern']);
    const bug = { id: 'BUG-001', steps: [] };
    assert.ok(validateWithSchema(schema('bug-report'), bug).some((i) => i.keyword === 'minItems' && i.path === '/steps'));
  });

  it('reports every independent problem in one pass', () => {
    const data = valid();
    data.feature = 1;
    delete data.openQuestions;
    data.testCases[0].priority = 'urgent';
    data.testCases[1].tags = 'not-an-array';
    data.bonus = true;
    assert.deepEqual(paths(validateWithSchema(schema('test-cases'), data)).sort(), [
      '/bonus', '/feature', '/openQuestions', '/testCases/0/priority', '/testCases/1/tags',
    ]);
  });

  it('supports union types such as nullable values (none of the current schemas use them)', () => {
    const file = join(scratch, 'nullable.schema.json');
    writeFileSync(file, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['note'],
      properties: { note: { type: ['string', 'null'] } },
      additionalProperties: false,
    }));
    assert.deepEqual(validateWithSchema(file, { note: null }), []);
    assert.deepEqual(validateWithSchema(file, { note: 'x' }), []);
    assert.deepEqual(paths(validateWithSchema(file, { note: 3 })), ['/note']);
  });
});

describe('validation never changes what it validates', () => {
  it('no coercion, no defaults, no removal — a frozen object validates as-is', () => {
    const data = deepFreeze({ ...fixture('automation-prioritization'), extra: 'kept' });
    const before = JSON.stringify(data);
    const issues = validateWithSchema(schema('automation-prioritization'), data);
    assert.deepEqual(paths(issues), ['/extra'], 'the unknown property is reported, not removed');
    assert.equal(JSON.stringify(data), before);
  });

  it('"5" is not a number', () => {
    const data = { total: '5', manual: 0, automation: 0, automationHigh: 0, automationMedium: 0, automationLow: 0 };
    const review = { status: 'APPROVED', issues: [], suggestedChanges: [], summary: data };
    assert.deepEqual(paths(validateWithSchema(schema('test-cases-review'), review)), ['/summary/total']);
    assert.equal(data.total, '5');
  });
});

describe('compiled once', () => {
  it('a schema is compiled on first use and reused', () => {
    const first = schemaValidator(schema('test-cases'));
    const count = compiledSchemaCount();
    for (let i = 0; i < 50; i++) validateWithSchema(schema('test-cases'), fixture('test-cases'));
    assert.equal(schemaValidator(schema('test-cases')), first);
    assert.equal(compiledSchemaCount(), count);
  });

  it('artifact writes do not recompile', async () => {
    const qa = await import('../src/lib/qa-artifacts.ts');
    qa.schemaErrorsFor('test-cases', fixture('test-cases'));
    const count = compiledSchemaCount();
    for (let i = 0; i < 20; i++) qa.schemaErrorsFor('test-cases', fixture('test-cases'));
    assert.equal(compiledSchemaCount(), count);
  });
});

describe('error display', () => {
  it('JSON Pointer to the host path style, with escaped tokens', () => {
    assert.equal(displayPath(''), '$');
    assert.equal(displayPath('/testCases/0/steps/12/expected'), '$.testCases[0].steps[12].expected');
    assert.equal(displayPath('/a~1b/c~0d'), '$.a/b.c~d');
    assert.equal(formatSchemaIssue({ path: '/x', keyword: 'type', message: 'must be string' }), '$.x: must be string');
  });

  it('schemaErrorsFor keeps returning one readable line per problem', async () => {
    const qa = await import('../src/lib/qa-artifacts.ts');
    const data = structuredClone(fixture('test-cases'));
    delete data.testCases[0].title;
    assert.deepEqual(qa.schemaErrorsFor('test-cases', data), ['$.testCases[0].title: missing required property "title"']);
  });
});

describe('npm run validate', () => {
  const cli = (artifact: string, schemaFile: string) =>
    spawnSync(process.execPath, ['scripts/validate-artifact.mjs', artifact, schemaFile], { cwd: PROJECT, encoding: 'utf8', timeout: 60_000 });

  it('accepts a valid artifact', () => {
    const r = cli(join(FIXTURES, 'test-cases.json'), schema('test-cases'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /valid/);
  });

  it('rejects an invalid one with every problem and its path', () => {
    const data = fixture('test-cases');
    data.testCases[0].priority = 'P9';
    delete data.feature;
    const file = join(scratch, 'bad-test-cases.json');
    writeFileSync(file, JSON.stringify(data));
    const r = cli(file, schema('test-cases'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\$\.feature: missing required property "feature"/);
    assert.match(r.stderr, /\$\.testCases\[0\]\.priority: must be one of/);
  });
});
