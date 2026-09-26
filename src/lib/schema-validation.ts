// Structural validation of JSON artifacts against schemas/*.schema.json, with
// Ajv (JSON Schema Draft 2020-12). The schema files are the source of truth;
// this module only compiles them and reports, in the repository's own terms,
// where an object does not match.
//
// It answers one question — "does this JSON have the declared shape?" — and
// nothing else. Whether its claims are supported by evidence is
// `semantic-validate.ts`, run after this and kept apart from it.
//
// Validation is read-only. The Ajv instance is configured so that it can never
// change what it checks: no type coercion, no defaults filled in, no
// additional properties removed. An invalid object is rejected, never
// repaired, so the object that passed is exactly the object that is written.
//
// Trusted host code only; never mounted as a tool.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * One configured instance for the process.
 *
 *   strict           unknown keywords, ambiguous types and similar schema
 *                    mistakes fail at compile time instead of being ignored
 *   allErrors        report every problem in one pass — an agent fixes them
 *                    all in one retry instead of one per attempt
 *   allowUnionTypes  `"type": ["string", "null"]` is valid Draft 2020-12;
 *                    strict mode alone would refuse it
 *
 * `coerceTypes`, `useDefaults` and `removeAdditional` stay at their default,
 * off: each would modify the object being validated.
 */
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });

/** Compiled validators, one per schema file for the life of the process. */
const compiled = new Map<string, ValidateFunction>();

/**
 * The validator for a schema file, compiled on first use and cached by its
 * absolute path. Throws if the file is not valid JSON or not a valid schema.
 */
export function schemaValidator(schemaPath: string): ValidateFunction {
  const key = resolve(schemaPath);
  let validate = compiled.get(key);
  if (validate === undefined) {
    const schema = JSON.parse(readFileSync(key, 'utf8')) as object;
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

/** How many schema files have been compiled in this process. */
export function compiledSchemaCount(): number {
  return compiled.size;
}

/**
 * One schema violation. `path` is a JSON Pointer to the offending value — for
 * a missing or unexpected property, to that property itself.
 */
export interface SchemaIssue {
  path: string;
  keyword: string;
  message: string;
}

const escapeToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1');

function issueOf(e: ErrorObject): SchemaIssue {
  const params = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'required': {
      const name = String(params.missingProperty);
      return { path: `${e.instancePath}/${escapeToken(name)}`, keyword: e.keyword, message: `missing required property "${name}"` };
    }
    case 'additionalProperties': {
      const name = String(params.additionalProperty);
      return { path: `${e.instancePath}/${escapeToken(name)}`, keyword: e.keyword, message: `unexpected property "${name}"` };
    }
    case 'enum':
      // The allowed values are what lets an agent correct itself.
      return { path: e.instancePath, keyword: e.keyword, message: `must be one of ${JSON.stringify(params.allowedValues)}` };
    default:
      return { path: e.instancePath, keyword: e.keyword, message: e.message ?? e.keyword };
  }
}

/** Every way `value` fails the schema in `schemaPath`; empty when it matches. Never modifies `value`. */
export function validateWithSchema(schemaPath: string, value: unknown): SchemaIssue[] {
  const validate = schemaValidator(schemaPath);
  if (validate(value)) return [];
  const seen = new Set<string>();
  const issues: SchemaIssue[] = [];
  for (const issue of (validate.errors ?? []).map(issueOf)) {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

/** `/testCases/0/title` -> `$.testCases[0].title`, the path style the rest of the host reports in. */
export function displayPath(pointer: string): string {
  if (pointer === '') return '$';
  return (
    '$' +
    pointer
      .slice(1)
      .split('/')
      .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
      .map((t) => (/^\d+$/.test(t) ? `[${t}]` : `.${t}`))
      .join('')
  );
}

/** One line per issue: `$.testCases[0].title: missing required property "title"`. */
export function formatSchemaIssue(issue: SchemaIssue): string {
  return `${displayPath(issue.path)}: ${issue.message}`;
}
