#!/usr/bin/env node
// Validates a .qa/*.json hand-off artifact against its JSON Schema.
// Supports the subset of draft 2020-12 used by schemas/*.schema.json:
// type, required, properties, additionalProperties, items, enum.
//
// Usage: node scripts/validate-artifact.mjs <artifact.json> <schema.json>

import { readFileSync } from 'node:fs';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const [, , artifactPath, schemaPath] = process.argv;
if (!artifactPath || !schemaPath) {
  fail('usage: validate-artifact.mjs <artifact.json> <schema.json>');
}

let artifact;
let schema;
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch (err) {
  fail(`cannot read/parse artifact "${artifactPath}": ${err.message}`);
}
try {
  schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
} catch (err) {
  fail(`cannot read/parse schema "${schemaPath}": ${err.message}`);
}

const errors = [];

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function validate(value, node, path) {
  if (node.enum) {
    if (!node.enum.includes(value)) {
      errors.push(`${path}: expected one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  if (node.type) {
    const actual = typeOf(value);
    if (node.type !== actual) {
      errors.push(`${path}: expected type "${node.type}", got "${actual}"`);
      return;
    }
  }

  if (node.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (node.additionalProperties === false) {
      const allowed = new Set(Object.keys(node.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries(node.properties ?? {})) {
      if (key in value) validate(value[key], propSchema, `${path}.${key}`);
    }
  }

  if (node.type === 'array' && Array.isArray(value) && node.items) {
    value.forEach((item, i) => validate(item, node.items, `${path}[${i}]`));
  }
}

validate(artifact, schema, '$');

if (errors.length > 0) {
  console.error(`INVALID: ${artifactPath} does not match ${schemaPath}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`VALID: ${artifactPath} matches ${schemaPath}`);
