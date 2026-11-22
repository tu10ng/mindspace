import type { FlowNode, FlowSpec } from '../types.js';
import { resolvePath } from './path.js';

export function validateFlow(spec: FlowSpec): string[] {
  const errors: string[] = [];
  if (spec.kind !== 'flow') {
    errors.push('spec.kind must be "flow"');
  }
  const nodes = spec.nodes;
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) {
    return [...errors, 'spec.nodes must be a record of nodes'];
  }
  const ids = Object.keys(nodes);
  if (ids.length === 0) {
    return [...errors, 'flow has no nodes'];
  }
  const entry = spec.entry;
  if (typeof entry !== 'string' || !(entry in nodes)) {
    errors.push(`entry "${String(entry)}" not found in nodes`);
  }
  for (const [id, node] of Object.entries(nodes)) {
    const hasActionId = typeof node.actionId === 'string' && node.actionId.length > 0;
    const hasActionFrom = typeof node.actionFrom === 'string' && node.actionFrom.length > 0;
    if (node.terminal !== true && hasActionId === hasActionFrom) {
      errors.push(`node "${id}": exactly one of actionId / actionFrom is required`);
    }
    if (node.terminal === true && hasActionId && hasActionFrom) {
      errors.push(`node "${id}": exactly one of actionId / actionFrom is required`);
    }
    if (node.inputBindings === null || typeof node.inputBindings !== 'object' || Array.isArray(node.inputBindings)) {
      errors.push(`node "${id}": inputBindings must be a record`);
    }
    if (
      node.optionalInputBindings !== undefined &&
      (node.optionalInputBindings === null || typeof node.optionalInputBindings !== 'object' || Array.isArray(node.optionalInputBindings))
    ) {
      errors.push(`node "${id}": optionalInputBindings must be a record`);
    }
    if (node.allowRelationTypeProposals !== undefined && typeof node.allowRelationTypeProposals !== 'boolean') {
      errors.push(`node "${id}": allowRelationTypeProposals must be a boolean`);
    }
    if (typeof node.outputKey !== 'string' || node.outputKey.length === 0) {
      errors.push(`node "${id}": outputKey must be a non-empty string`);
    } else if (node.outputKey.startsWith('_')) {
      errors.push(`node "${id}": outputKey "${node.outputKey}" is reserved and must not start with "_"`);
    }
    if (node.next !== undefined) {
      if (typeof node.next !== 'string' || !(node.next in nodes)) {
        errors.push(`node "${id}": next "${String(node.next)}" not found`);
      }
    }
    if (node.transitions !== undefined) {
      if (!Array.isArray(node.transitions)) {
        errors.push(`node "${id}": transitions must be an array`);
      } else {
        for (const tr of node.transitions) {
          if (typeof tr.next !== 'string' || !(tr.next in nodes)) {
            errors.push(`node "${id}": transition next "${String(tr.next)}" not found`);
          }
          if (typeof tr.field !== 'string' || tr.field.length === 0) {
            errors.push(`node "${id}": transition field must be a non-empty string`);
          }
          const eq = tr.equals;
          if (typeof eq !== 'string' && typeof eq !== 'number' && typeof eq !== 'boolean' && eq !== null) {
            errors.push(`node "${id}": transition equals must be string | number | boolean | null`);
          }
        }
      }
    }
    if (node.terminal === true && (node.next !== undefined || node.transitions !== undefined)) {
      errors.push(`node "${id}": terminal node must not declare next or transitions`);
    }
  }
  if (typeof entry === 'string' && entry in nodes) {
    const color = new Map<string, 0 | 1 | 2>();
    for (const id of ids) {
      color.set(id, 0);
    }
    const frameStack: Array<{ id: string; outs: string[]; nextIndex: number }> = [];
    const pushFrame = (id: string): void => {
      const node = nodes[id];
      if (node === undefined) {
        return;
      }
      const outs: string[] = [];
      if (node.terminal !== true) {
        if (node.next !== undefined) {
          outs.push(node.next);
        }
        if (node.transitions !== undefined) {
          for (const tr of node.transitions) {
            if (!outs.includes(tr.next)) {
              outs.push(tr.next);
            }
          }
        }
      }
      frameStack.push({ id, outs, nextIndex: 0 });
      color.set(id, 1);
    };
    pushFrame(entry);
    while (frameStack.length > 0) {
      const frame = frameStack[frameStack.length - 1];
      if (frame === undefined) {
        break;
      }
      if (frame.nextIndex >= frame.outs.length) {
        color.set(frame.id, 2);
        frameStack.pop();
        continue;
      }
      const next = frame.outs[frame.nextIndex];
      frame.nextIndex += 1;
      if (next === undefined || !(next in nodes)) {
        continue;
      }
      const nextColor = color.get(next);
      if (nextColor === 1) {
        errors.push(`cycle detected: ${[...frameStack.map((f) => f.id), next].join(' -> ')}`);
      } else if (nextColor === 0) {
        pushFrame(next);
      }
    }
    for (const id of ids) {
      if (color.get(id) !== 2) {
        errors.push(`node "${id}" is unreachable from entry`);
      }
    }
  }
  return errors;
}

export function evaluateTransition(
  node: FlowNode,
  output: unknown,
  declaredFields?: ReadonlySet<string>,
): { next: string | null; error?: string } {
  if (node.terminal === true) {
    return { next: null };
  }
  const matched: string[] = [];
  if (node.transitions !== undefined) {
    for (const tr of node.transitions) {
      if (declaredFields !== undefined) {
        const root = tr.field.split('.')[0]?.split('[')[0] ?? '';
        if (!declaredFields.has(root)) {
          return { next: null, error: `transition field "${tr.field}" is not declared in the output schema` };
        }
      }
      const actual = resolvePath(output, tr.field);
      if (actual === tr.equals) {
        matched.push(tr.next);
      }
    }
  }
  if (matched.length > 1) {
    return { next: null, error: `multiple transitions matched: ${matched.join(', ')}` };
  }
  if (matched.length === 1) {
    return { next: matched[0] ?? null };
  }
  if (node.next !== undefined) {
    return { next: node.next };
  }
  return { next: null, error: 'no transition matched and no default next' };
}
