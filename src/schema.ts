type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export interface SchemaResult {
  ok: boolean;
  errors: string[];
}

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return isPlainObject(value);
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

export function findUnsupportedKeywords(schema: object): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        found.add(key);
      }
      if (key === 'properties') {
        for (const sub of Object.values(value as Record<string, unknown>)) walk(sub);
      } else if (key === 'items') {
        walk(value);
      }
    }
  };
  walk(schema);
  return [...found];
}

const SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

export function validateSchemaStructure(schema: object): string[] {
  const errors: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!isPlainObject(node)) {
      errors.push(`${path}: schema must be a plain object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        errors.push(`${path}: unsupported schema keyword "${key}"`);
      }
    }
    const type = node['type'];
    if (type !== undefined) {
      const list = Array.isArray(type) ? type : [type];
      if (list.length === 0 || !list.every((t) => typeof t === 'string' && SUPPORTED_TYPES.has(t))) {
        errors.push(`${path}: type must be a supported type or a non-empty array of supported types`);
      }
    }
    const props = node['properties'];
    let propsValid = false;
    if (props !== undefined) {
      if (!isPlainObject(props)) {
        errors.push(`${path}: properties must be an object`);
      } else {
        propsValid = true;
        for (const [key, sub] of Object.entries(props)) {
          walk(sub, `${path}.${key}`);
        }
      }
    }
    const required = node['required'];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((k) => typeof k !== 'string')) {
        errors.push(`${path}: required must be an array of strings`);
      } else if (!propsValid) {
        errors.push(`${path}: required is declared but properties is missing`);
      } else {
        for (const key of required) {
          if (!(key in (props as Record<string, unknown>))) {
            errors.push(`${path}: required key "${key}" is not declared in properties`);
          }
        }
      }
    }
    if (node['items'] !== undefined) {
      walk(node['items'], `${path}.items`);
    }
    const en = node['enum'];
    if (en !== undefined && (!Array.isArray(en) || en.length === 0)) {
      errors.push(`${path}: enum must be a non-empty array`);
    }
    const ap = node['additionalProperties'];
    if (ap !== undefined && typeof ap !== 'boolean') {
      errors.push(`${path}: additionalProperties must be a boolean`);
    }
  };
  walk(schema, '$');
  return errors;
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      errors.push(`${path}: unsupported schema keyword "${key}"`);
    }
  }
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
  if (isPlainObject(value)) {
    const obj = value;
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
    if (schema.additionalProperties === false) {
      const declared = schema.properties === undefined ? new Set<string>() : new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!declared.has(key)) {
          errors.push(`${path}: additional property "${key}" not allowed`);
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
  try {
    check(schema as Schema, value, '$', errors);
  } catch {
    return { ok: false, errors: ['schema_mismatch: malformed schema could not be applied'] };
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
