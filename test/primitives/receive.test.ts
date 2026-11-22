import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrimitives } from '../../src/primitives/index.js';
import { makeCtx, makeStore } from './helpers.js';
import type { ConsStoreApi } from '../../src/store/api.js';

let store: ConsStoreApi;

beforeEach(async () => {
  store = (await makeStore()).store;
});

afterEach(() => {
  store.close();
});

describe('receive primitive', () => {
  it('saves input text as an active input cons with input provenance', async () => {
    const ctx = makeCtx(store, { text: '内蒙古高原上的草原上的草很高。', task: '处理语料' });
    const out = (await createPrimitives()['receive']?.run(ctx, ctx.step.id)) as {
      consRef: { consId: string; revision: number };
    };
    expect(out.consRef.revision).toBe(1);
    const cons = await store.getCons(out.consRef.consId);
    expect(cons?.status).toBe('active');
    const rev = await store.getRevision(out.consRef.consId, 1);
    expect(rev?.roles).toContain('object');
    expect(rev?.body).toBe('内蒙古高原上的草原上的草很高。');
    expect(rev?.provenance.source).toBe('input');
    expect(rev?.provenance.runId).toBe('run-test');
    expect(rev?.provenance.stepId).toBe(ctx.step.id);
  });

  it('activates and indexes the input so later retrieval can find it', async () => {
    const ctx = makeCtx(store, { text: '内蒙古高原上的草原上的草很高。' });
    const out = (await createPrimitives()['receive']?.run(ctx, ctx.step.id)) as { consRef: { consId: string } };
    const found = await store.search({ text: '内蒙古高原上的草原' });
    expect(found.items.some((i) => i.ref.consId === out.consRef.consId)).toBe(true);
  });
});
