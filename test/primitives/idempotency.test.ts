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

describe('F04 primitive replay after effect commit without checkpoint', () => {
  it('form replay with the same step returns the same permanent ids and creates no new cons', async () => {
    const ctx = makeCtx(store, {
      candidates: [{ tempId: 'a1', kind: 'object', content: { title: '幂等重放对象', origin: 'llm' } }],
    });
    const first = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
      formed: Array<{ tempId: string; consRef: { consId: string; revision: number } }>;
    };
    const second = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as typeof first;
    expect(second).toEqual(first);
    expect(await store.getRevision(first.formed[0]?.consRef.consId ?? '', 1)).not.toBeNull();
    expect(await store.getRevision(first.formed[0]?.consRef.consId ?? '', 2)).toBeNull();
  });

  it('revise replay with the same step returns the committed revision instead of revision_conflict', async () => {
    const formedCtx = makeCtx(store, {
      candidates: [{ tempId: 'a1', kind: 'method', content: { title: '旧方法', instructions: '旧做法', origin: 'llm' } }],
    });
    const formed = (await createPrimitives()['form']?.run(formedCtx, formedCtx.step.id)) as {
      formed: Array<{ consRef: { consId: string } }>;
    };
    const consId = formed.formed[0]?.consRef.consId ?? '';
    const ctx = makeCtx(store, {
      consId,
      expectedRevision: 1,
      revision: { title: '新方法', roles: ['method'], body: '新做法', aliases: [], searchTerms: ['新'] },
    });
    const first = (await createPrimitives()['revise']?.run(ctx, ctx.step.id)) as { consRef: { consId: string; revision: number } };
    expect(first.consRef.revision).toBe(2);
    const second = (await createPrimitives()['revise']?.run(ctx, ctx.step.id)) as typeof first;
    expect(second).toEqual(first);
    const cons = await store.getCons(consId);
    expect(cons?.currentRevision).toBe(2);
    expect(await store.getRevision(consId, 3)).toBeNull();
  });

  it('receive replay with the same step returns the same input cons', async () => {
    const ctx = makeCtx(store, { text: '幂等接收语料。' });
    const first = (await createPrimitives()['receive']?.run(ctx, ctx.step.id)) as {
      consRef: { consId: string; revision: number };
    };
    const second = (await createPrimitives()['receive']?.run(ctx, ctx.step.id)) as typeof first;
    expect(second).toEqual(first);
    const hits = await store.search({ text: '幂等接收语料' });
    expect(hits.items.filter((i) => i.ref.consId === first.consRef.consId)).toHaveLength(1);
  });
});
