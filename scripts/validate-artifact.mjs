#!/usr/bin/env node
// Validates a .qa/*.json hand-off artifact against a JSON Schema, with the same
// Ajv (Draft 2020-12) validation the host applies on every write.
//
// Usage: node scripts/validate-artifact.mjs <artifact.json> <schema.json>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/runtime.mjs';

const { formatSchemaIssue, validateWithSchema } = await import(resolve(ROOT, 'src/lib/schema-validation.ts'));

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const [, , artifactPath, schemaPath] = process.argv;
if (!artifactPath || !schemaPath) fail('usage: validate-artifact.mjs <artifact.json> <schema.json>');

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch (err) {
  fail(`cannot read/parse artifact "${artifactPath}": ${err.message}`);
}

let issues;
try {
  issues = validateWithSchema(schemaPath, artifact);
} catch (err) {
  fail(`cannot use schema "${schemaPath}": ${err.message}`);
}

if (issues.length > 0) {
  console.error(`INVALID: ${artifactPath}`);
  for (const issue of issues) console.error(`  - ${formatSchemaIssue(issue)}`);
  process.exit(1);
}
console.log(`valid: ${artifactPath}`);
