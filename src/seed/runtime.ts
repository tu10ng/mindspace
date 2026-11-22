import type { ConsRef, ConsRevision } from '../types.js';
import type { PrimitiveFn, StepContext } from '../engine/executor.js';
import { assertTempIdNamespace, connectResultKey, createPrimitives, isRecord, isRef, PrimitiveError } from '../primitives/index.js';

function rewriteIdList(values: unknown, map: Map<string, ConsRef>): { value: unknown; changed: boolean } {
  if (!Array.isArray(values)) return { value: values, changed: false };
  let changed = false;
  const out: unknown[] = [];
  for (const item of values) {
    if (typeof item === 'string') {
      const hit = map.get(item);
      if (hit !== undefined) {
        out.push(hit.consId);
        changed = true;
        continue;
      }
    }
    out.push(item);
  }
  return { value: changed ? out : values, changed };
}

function rewriteTempRefs(spec: unknown, map: Map<string, ConsRef>): { value: unknown; changed: boolean } {
  if (!isRecord(spec)) return { value: spec, changed: false };
  const kind = spec['kind'];
  if (kind === 'method' && typeof spec['actionId'] === 'string') {
    const hit = map.get(spec['actionId']);
    if (hit !== undefined) return { value: { ...spec, actionId: hit.consId }, changed: true };
    return { value: spec, changed: false };
  }
  if (kind === 'action' && typeof spec['defaultMethodId'] === 'string') {
    const hit = map.get(spec['defaultMethodId']);
    if (hit !== undefined) return { value: { ...spec, defaultMethodId: hit.consId }, changed: true };
    return { value: spec, changed: false };
  }
  if (kind === 'tendency') {
    let current: Record<string, unknown> = spec;
    let changed = false;
    for (const key of ['preferIds', 'avoidIds']) {
      const r = rewriteIdList(spec[key], map);
      if (r.changed) {
        current = { ...current, [key]: r.value };
        changed = true;
      }
    }
    return { value: current, changed };
  }
  return { value: spec, changed: false };
}

async function wrappedConnect(base: { run: PrimitiveFn }, ctx: StepContext, stepId: string): Promise<unknown> {
  return ctx.store.transaction(async (): Promise<unknown> => {
    const replay = await ctx.store.getIdempotencyResult(connectResultKey(stepId));
    if (replay !== null) return replay;
    const input = isRecord(ctx.envelope.input) ? { ...ctx.envelope.input } : {};
    const tempMap = new Map<string, ConsRef>();
    const formedRaw = Array.isArray(input['formed']) ? input['formed'] : [];
    for (const f of formedRaw) {
      if (isRecord(f) && typeof f['tempId'] === 'string' && isRef(f['consRef'])) {
        await assertTempIdNamespace(ctx.store, f['tempId']);
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
  });
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
