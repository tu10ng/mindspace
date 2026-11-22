import { describe, expect, it } from 'vitest';
import { validateFlow, evaluateTransition } from '../../src/engine/flow.js';
import { resolvePath, checkPath, parsePath } from '../../src/engine/path.js';
import type { FlowNode, FlowSpec } from '../../src/types.js';

function flow(nodes: Record<string, FlowNode>, entry = 'a'): FlowSpec {
  return { kind: 'flow', entry, nodes };
}

const baseNode: FlowNode = { actionId: 'act', inputBindings: {}, outputKey: 'out' };

describe('validateFlow', () => {
  it('accepts a valid linear flow', () => {
    const spec = flow({
      a: { ...baseNode, next: 'b' },
      b: { ...baseNode, terminal: true },
    });
    expect(validateFlow(spec)).toEqual([]);
  });

  it('rejects unknown entry', () => {
    const spec = flow({ a: { ...baseNode, terminal: true } }, 'missing');
    expect(validateFlow(spec)).toHaveLength(1);
  });

  it('rejects both actionId and actionFrom', () => {
    const spec = flow({
      a: { ...baseNode, actionFrom: 'sel', terminal: true },
    });
    expect(validateFlow(spec).join(' ')).toContain('actionId / actionFrom');
  });

  it('rejects neither actionId nor actionFrom on a non-terminal node', () => {
    const spec = flow({
      a: { inputBindings: {}, outputKey: 'out', next: 'b' },
      b: { ...baseNode, terminal: true },
    });
    expect(validateFlow(spec).join(' ')).toContain('actionId / actionFrom');
  });

  it('allows a terminal node without action', () => {
    const spec = flow({
      a: { ...baseNode, next: 'b' },
      b: { inputBindings: {}, outputKey: 'done', terminal: true },
    });
    expect(validateFlow(spec)).toEqual([]);
  });

  it('rejects missing next target', () => {
    const spec = flow({
      a: { ...baseNode, next: 'nowhere' },
    });
    expect(validateFlow(spec).join(' ')).toContain('not found');
  });

  it('rejects missing transition target', () => {
    const spec = flow({
      a: { ...baseNode, transitions: [{ field: 'status', equals: 'ok', next: 'ghost' }] },
    });
    expect(validateFlow(spec).join(' ')).toContain('not found');
  });

  it('rejects cycles', () => {
    const spec = flow({
      a: { ...baseNode, next: 'b' },
      b: { ...baseNode, next: 'a' },
    });
    expect(validateFlow(spec).join(' ')).toContain('cycle');
  });

  it('rejects unreachable nodes', () => {
    const spec = flow({
      a: { ...baseNode, terminal: true },
      orphan: { ...baseNode, terminal: true },
    });
    expect(validateFlow(spec).join(' ')).toContain('unreachable');
  });

  it('rejects terminal node with next', () => {
    const spec = flow({
      a: { ...baseNode, terminal: true, next: 'b' },
      b: { ...baseNode, terminal: true },
    });
    expect(validateFlow(spec).join(' ')).toContain('terminal');
  });
});

describe('evaluateTransition', () => {
  it('follows the matching branch', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [
        { field: 'status', equals: 'selected', next: 'x' },
        { field: 'status', equals: 'no_candidate', next: 'y' },
      ],
    };
    expect(evaluateTransition(node, { status: 'no_candidate' })).toEqual({ next: 'y' });
  });

  it('errors when multiple branches match', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [
        { field: 'status', equals: 'selected', next: 'x' },
        { field: 'status', equals: 'selected', next: 'y' },
      ],
    };
    const result = evaluateTransition(node, { status: 'selected' });
    expect(result.next).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).toContain('multiple');
  });

  it('errors when nothing matches and no default next', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [{ field: 'status', equals: 'selected', next: 'x' }],
    };
    const result = evaluateTransition(node, { status: 'no_candidate' });
    expect(result.next).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('falls back to default next', () => {
    const node: FlowNode = {
      ...baseNode,
      next: 'fallback',
      transitions: [{ field: 'status', equals: 'selected', next: 'x' }],
    };
    expect(evaluateTransition(node, { status: 'other' })).toEqual({ next: 'fallback' });
  });

  it('terminal node has no next', () => {
    expect(evaluateTransition({ ...baseNode, terminal: true }, {})).toEqual({ next: null });
  });

  it('rejects transitions on fields not declared in the output schema', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [{ field: 'status', equals: 'selected', next: 'x' }],
    };
    const result = evaluateTransition(node, { status: 'selected' }, new Set(['other']));
    expect(result.next).toBeNull();
    expect(result.error).toContain('not declared');
  });

  it('accepts nested paths whose root field is declared', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [{ field: 'selected.status', equals: 'ok', next: 'x' }],
    };
    expect(evaluateTransition(node, { selected: { status: 'ok' } }, new Set(['selected']))).toEqual({ next: 'x' });
  });

  it('supports boolean branch fields such as usedDefaultFreedom', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [
        { field: 'usedDefaultFreedom', equals: false, next: 'skip' },
      ],
      next: 'fallback',
    };
    const declared = new Set(['usedDefaultFreedom', 'status']);
    expect(evaluateTransition(node, { usedDefaultFreedom: false }, declared)).toEqual({ next: 'skip' });
    expect(evaluateTransition(node, { usedDefaultFreedom: true }, declared)).toEqual({ next: 'fallback' });
  });

  it('treats an undeclared field miss as undefined that must not match equals null', () => {
    const node: FlowNode = {
      ...baseNode,
      transitions: [{ field: 'ghost', equals: null, next: 'x' }],
    };
    const result = evaluateTransition(node, {}, new Set(['status']));
    expect(result.next).toBeNull();
    expect(result.error).toContain('not declared');
  });
});

describe('path safety', () => {
  const root = { a: { b: { c: 1 } }, list: [{ name: 'first' }] };

  it('resolves nested own properties', () => {
    expect(resolvePath(root, 'a.b.c')).toBe(1);
  });

  it('resolves numeric index', () => {
    expect(resolvePath(root, 'list[0].name')).toBe('first');
  });

  it('returns undefined for missing paths', () => {
    expect(resolvePath(root, 'a.b.missing')).toBeUndefined();
    expect(resolvePath(root, 'nope')).toBeUndefined();
  });

  it('rejects __proto__ access', () => {
    expect(checkPath('a.__proto__')).not.toBeNull();
    expect(resolvePath(root, 'a.__proto__')).toBeUndefined();
    expect(resolvePath(root, '__proto__.polluted')).toBeUndefined();
  });

  it('rejects constructor and prototype', () => {
    expect(checkPath('constructor')).not.toBeNull();
    expect(checkPath('a.constructor.name')).not.toBeNull();
    expect(checkPath('a.prototype.x')).not.toBeNull();
  });

  it('rejects function call syntax', () => {
    expect(checkPath('a(b)')).not.toBeNull();
    expect(resolvePath(root, 'a(b)')).toBeUndefined();
    expect(resolvePath(root, 'a.b.c()')).toBeUndefined();
  });

  it('does not follow inherited properties', () => {
    const crafted: Record<string, unknown> = {};
    Object.defineProperty(Object.getPrototypeOf(crafted), 'inherited', { value: 42, configurable: true });
    expect(resolvePath(crafted, 'inherited')).toBeUndefined();
    delete (Object.getPrototypeOf(crafted) as Record<string, unknown>)['inherited'];
  });

  it('rejects malformed paths', () => {
    expect(parsePath('a..b')).toHaveProperty('error');
    expect(parsePath('a[xx]')).toHaveProperty('error');
    expect(parsePath('.a')).toHaveProperty('error');
    expect(parsePath('')).toHaveProperty('error');
  });
});
