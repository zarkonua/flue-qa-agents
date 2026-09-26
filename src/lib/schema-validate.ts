// Minimal JSON Schema (draft 2020-12 subset) validator: type, required,
// properties, additionalProperties, items, enum, pattern, minItems. Sufficient for schemas/*.json,
// which use only this subset. Trusted host code only — never exposed to the model
// as a tool the model drives; it runs inside write_qa_artifact's own validation.

export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'boolean' | 'number';
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  /** Strings only. Anchor it: a bug id becomes a file name. */
  pattern?: string;
  minItems?: number;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchemaNode, path = '$'): string[] {
  const errors: string[] = [];

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    }
    return errors;
  }

  if (schema.type) {
    const actual = typeOf(value);
    if (schema.type !== actual) {
      errors.push(`${path}: expected type "${schema.type}", got "${actual}"`);
      return errors;
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
    }
  }

  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }

  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${value.length}`);
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items!, `${path}[${i}]`)));
  }

  return errors;
}
