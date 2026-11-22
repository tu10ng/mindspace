import { describe, expect, it } from 'vitest';
import { findUnsupportedKeywords, validateSchema } from '../../src/schema.js';

describe('validateSchema', () => {
  it('accepts matching primitive types', () => {
    expect(validateSchema({ type: 'string' }, 'x').ok).toBe(true);
    expect(validateSchema({ type: 'number' }, 1.5).ok).toBe(true);
    expect(validateSchema({ type: 'integer' }, 2).ok).toBe(true);
    expect(validateSchema({ type: 'boolean' }, false).ok).toBe(true);
    expect(validateSchema({ type: 'null' }, null).ok).toBe(true);
    expect(validateSchema({ type: 'array' }, []).ok).toBe(true);
    expect(validateSchema({ type: 'object' }, {}).ok).toBe(true);
  });

  it('rejects wrong types', () => {
    expect(validateSchema({ type: 'string' }, 1).ok).toBe(false);
    expect(validateSchema({ type: 'integer' }, 1.5).ok).toBe(false);
    expect(validateSchema({ type: 'number' }, NaN).ok).toBe(false);
    expect(validateSchema({ type: 'null' }, 0).ok).toBe(false);
    expect(validateSchema({ type: 'array' }, {}).ok).toBe(false);
  });

  it('checks required and properties', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
      required: ['a'],
    };
    expect(validateSchema(schema, { a: 'x' }).ok).toBe(true);
    const missing = validateSchema(schema, { b: 1 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.join(' ')).toContain('required');
    }
    const bad = validateSchema(schema, { a: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(' ')).toContain('.a');
    }
  });

  it('checks nested structures', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      required: ['items'],
    };
    expect(validateSchema(schema, { items: [{ id: 'a' }, { id: 'b' }] }).ok).toBe(true);
    const bad = validateSchema(schema, { items: [{ id: 'a' }, { nope: 1 }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(' ')).toContain('items[1]');
      expect(bad.errors.join(' ')).toContain('"id"');
    }
  });

  it('checks enum', () => {
    const schema = { type: 'string', enum: ['selected', 'no_candidate'] };
    expect(validateSchema(schema, 'selected').ok).toBe(true);
    expect(validateSchema(schema, 'other').ok).toBe(false);
  });

  it('rejects additional properties when false', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    expect(validateSchema(schema, { a: 'x' }).ok).toBe(true);
    expect(validateSchema(schema, { a: 'x', extra: 1 }).ok).toBe(false);
  });

  it('allows additional properties by default', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateSchema(schema, { a: 'x', extra: 1 }).ok).toBe(true);
  });

  it('accepts type arrays', () => {
    expect(validateSchema({ type: ['string', 'null'] }, null).ok).toBe(true);
    expect(validateSchema({ type: ['string', 'null'] }, 's').ok).toBe(true);
    expect(validateSchema({ type: ['string', 'null'] }, 3).ok).toBe(false);
  });

  it('rejects unsupported keywords instead of silently ignoring them (F10)', () => {
    expect(validateSchema({ type: 'string', const: 'allowed' }, 'forbidden').ok).toBe(false);
    expect(validateSchema({ type: 'object', additionalProperties: false }, { unexpected: true }).ok).toBe(false);
    expect(validateSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }, {}).ok).toBe(false);
    expect(validateSchema({ type: 'number', minimum: 0 }, -10).ok).toBe(false);
    expect(findUnsupportedKeywords({ type: 'string', const: 'allowed' })).toEqual(['const']);
    expect(findUnsupportedKeywords({ type: ['object', 'null'], required: ['x'] })).toEqual([]);
  });

  it('checks required for object|null unions while letting null through (F10)', () => {
    const schema = { type: ['object', 'null'], required: ['x'] };
    expect(validateSchema(schema, null).ok).toBe(true);
    expect(validateSchema(schema, {}).ok).toBe(false);
    expect(validateSchema(schema, { x: 1 }).ok).toBe(true);
  });

  it('rejects forged authorization fields in strict ref schemas (F09/F10)', () => {
    const strict = {
      type: 'object',
      properties: { consId: { type: 'string' }, revision: { type: 'integer' } },
      required: ['consId', 'revision'],
      additionalProperties: false,
    };
    expect(validateSchema(strict, { consId: 'x', revision: 1 }).ok).toBe(true);
    expect(validateSchema(strict, { consId: 'x', revision: 1, authorized: true }).ok).toBe(false);
  });
});
