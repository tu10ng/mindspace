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

async function createDraft(): Promise<string> {
  const ctx = makeCtx(store, {
    candidates: [{ tempId: 'a1', kind: 'method', content: { title: '旧方法', instructions: '旧做法', origin: 'llm' } }],
  });
  const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
    formed: Array<{ consRef: { consId: string } }>;
  };
  return out.formed[0]?.consRef.consId ?? '';
}

describe('revise primitive', () => {
  it('creates a new revision without overwriting the old one', async () => {
    const consId = await createDraft();
    const ctx = makeCtx(store, {
      consId,
      expectedRevision: 1,
      revision: { title: '新方法', roles: ['method'], body: '新做法', aliases: [], searchTerms: ['新'] },
    });
    const out = (await createPrimitives()['revise']?.run(ctx, ctx.step.id)) as { consRef: { consId: string; revision: number } };
    expect(out.consRef.consId).toBe(consId);
    expect(out.consRef.revision).toBe(2);
    const cons = await store.getCons(consId);
    expect(cons?.currentRevision).toBe(2);
    const old = await store.getRevision(consId, 1);
    expect(old?.title).toBe('旧方法');
    const cur = await store.getRevision(consId, 2);
    expect(cur?.title).toBe('新方法');
    expect(cur?.body).toBe('新做法');
  });

  it('returns revision_conflict when expectedRevision does not match (§11.3)', async () => {
    const consId = await createDraft();
    const ctx = makeCtx(store, {
      consId,
      expectedRevision: 1,
      revision: { title: 'v2', roles: ['method'], body: 'b', aliases: [], searchTerms: [] },
    });
    await createPrimitives()['revise']?.run(ctx, ctx.step.id);
    const conflictCtx = makeCtx(store, {
      consId,
      expectedRevision: 1,
      revision: { title: 'v3', roles: ['method'], body: 'c', aliases: [], searchTerms: [] },
    });
    await expect(createPrimitives()['revise']?.run(conflictCtx, conflictCtx.step.id)).rejects.toThrow(
      /revision_conflict/,
    );
    const cons = await store.getCons(consId);
    expect(cons?.currentRevision).toBe(2);
    expect(await store.getRevision(consId, 3)).toBeNull();
  });

  it('rejects unknown cons ids', async () => {
    const ctx = makeCtx(store, {
      consId: 'missing.cons',
      expectedRevision: 1,
      revision: { title: 'x', roles: ['object'], body: '', aliases: [], searchTerms: [] },
    });
    await expect(createPrimitives()['revise']?.run(ctx, ctx.step.id)).rejects.toThrow(
      /not found/,
    );
  });
});
