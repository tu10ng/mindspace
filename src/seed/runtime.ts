import type { ConsRef, ConsRevision } from '../types.js';
import type { PrimitiveFn, StepContext } from '../engine/executor.js';
import { createPrimitives, isRecord, isRef, PrimitiveError } from '../primitives/index.js';

function rewriteTempRefs(value: unknown, map: Map<string, ConsRef>): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const hit = map.get(value);
    if (hit !== undefined) {
      return { value: hit.consId, changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const r = rewriteTempRefs(item, map);
      out.push(r.value);
      changed = changed || r.changed;
    }
    return { value: changed ? out : value, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = rewriteTempRefs(item, map);
      out[key] = r.value;
      changed = changed || r.changed;
    }
    return { value: changed ? out : value, changed };
  }
  return { value, changed: false };
}

async function wrappedConnect(base: { run: PrimitiveFn }, ctx: StepContext, stepId: string): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? { ...ctx.envelope.input } : {};
  const tempMap = new Map<string, ConsRef>();
  const formedRaw = Array.isArray(input['formed']) ? input['formed'] : [];
  for (const f of formedRaw) {
    if (isRecord(f) && typeof f['tempId'] === 'string' && isRef(f['consRef'])) {
      tempMap.set(f['tempId'], f['consRef']);
    }
  }
  const formedOut: Array<{ tempId: string; consRef: ConsRef }> = [];
  for (const [tempId, ref] of [...tempMap.entries()]) {
    const rev = await ctx.store.getRevision(ref.consId, ref.revision);
    if (rev === null || rev.spec === undefined) {
      formedOut.push({ tempId, consRef: ref });
      continue;
    }
    const rewritten = rewriteTempRefs(rev.spec, tempMap);
    if (!rewritten.changed) {
      formedOut.push({ tempId, consRef: ref });
      continue;
    }
    const fields: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'> = {
      title: rev.title,
      roles: rev.roles,
      body: rev.body,
      aliases: rev.aliases,
      searchTerms: rev.searchTerms,
      provenance: rev.provenance,
    };
    if (rev.applicabilityText !== undefined) {
      fields.applicabilityText = rev.applicabilityText;
    }
    fields.spec = rewritten.value as NonNullable<ConsRevision['spec']>;
    const created = await ctx.store.createRevision(ref.consId, fields);
    const newRef: ConsRef = { consId: ref.consId, revision: created.revision };
    tempMap.set(tempId, newRef);
    formedOut.push({ tempId, consRef: newRef });
  }
  let bindings: unknown[] | undefined;
  if (Array.isArray(input['methodBindings'])) {
    bindings = [];
    for (const b of input['methodBindings']) {
      if (!isRecord(b)) {
        bindings.push(b);
        continue;
      }
      const out: Record<string, unknown> = { ...b };
      if (typeof out['actionId'] === 'string') {
        const hit = tempMap.get(out['actionId']);
        if (hit !== undefined) {
          out['actionId'] = hit.consId;
        }
      }
      if (typeof out['methodRef'] === 'string') {
        const hit = tempMap.get(out['methodRef']);
        if (hit !== undefined) {
          out['methodRef'] = hit;
        } else {
          const cons = await ctx.store.getCons(out['methodRef']);
          if (cons === null) {
            throw new PrimitiveError('unknown_reference', `method temp id "${out['methodRef']}" unresolved`);
          }
          out['methodRef'] = { consId: cons.id, revision: cons.currentRevision };
        }
      }
      bindings.push(out);
    }
  }
  if ((bindings === undefined || bindings.length === 0) && isRef(input['bindMethodRevision'])) {
    const ref = input['bindMethodRevision'];
    const rev = await ctx.store.getRevision(ref.consId, ref.revision);
    const spec = rev?.spec;
    if (isRecord(spec) && spec['kind'] === 'method' && typeof spec['actionId'] === 'string') {
      bindings = [{ actionId: spec['actionId'], methodRef: ref }];
    }
  }
  const newInput: Record<string, unknown> = { ...input };
  if (formedRaw.length > 0) {
    newInput['formed'] = formedOut;
  }
  if (bindings !== undefined) {
    newInput['methodBindings'] = bindings;
  }
  const newCtx: StepContext = { ...ctx, envelope: { ...ctx.envelope, input: newInput } };
  return base.run(newCtx, stepId);
}

export function createSeedPrimitives(): Record<string, { run: PrimitiveFn }> {
  const base = createPrimitives();
  const connect = base['connect'];
  if (connect === undefined) {
    throw new Error('connect primitive is not registered');
  }
  return {
    ...base,
    connect: { run: (ctx: StepContext, stepId: string): Promise<unknown> => wrappedConnect(connect, ctx, stepId) },
  };
}
