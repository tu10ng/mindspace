type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  additionalProperties?: boolean;
};

export interface SchemaResult {
  ok: boolean;
  errors: string[];
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected type ${expected.join('|')}, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => v === value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
      return;
    }
  }
  if (schema.type === 'object' || (schema.properties !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value))) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (schema.required !== undefined) {
        for (const key of schema.required) {
          if (!(key in obj)) {
            errors.push(`${path}: missing required property "${key}"`);
          }
        }
      }
      if (schema.properties !== undefined) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (key in obj) {
            check(sub, obj[key], `${path}.${key}`, errors);
          }
        }
      }
      if (schema.additionalProperties === false && schema.properties !== undefined) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) {
            errors.push(`${path}: additional property "${key}" not allowed`);
          }
        }
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item !== undefined) {
        check(schema.items, item, `${path}[${i}]`, errors);
      }
    }
  }
}

export function validateSchema(schema: object, value: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  check(schema as Schema, value, '$', errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
