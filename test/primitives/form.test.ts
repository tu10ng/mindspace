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

describe('form primitive', () => {
  it('creates draft cons with permanent ids and returns the tempId mapping', async () => {
    const ctx = makeCtx(store, {
      candidates: [
        { tempId: 'a1', kind: 'object', content: { title: '草原', origin: 'llm' } },
        { tempId: 'a2', kind: 'proposition', content: { title: '草很高', origin: 'llm' } },
      ],
    });
    const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
      formed: Array<{ tempId: string; consRef: { consId: string; revision: number } }>;
    };
    expect(out.formed.map((f) => f.tempId)).toEqual(['a1', 'a2']);
    expect(out.formed[0]?.consRef.consId).not.toBe(out.formed[1]?.consRef.consId);
    for (const f of out.formed) {
      const cons = await store.getCons(f.consRef.consId);
      expect(cons?.status).toBe('draft');
      expect(f.consRef.revision).toBe(1);
    }
  });

  it('drafts are not retrievable', async () => {
    const ctx = makeCtx(store, {
      candidates: [{ tempId: 'a1', kind: 'object', content: { title: '独一无二的草本书对象', origin: 'llm' } }],
    });
    const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
      formed: Array<{ consRef: { consId: string } }>;
    };
    const found = await store.search({ text: '独一无二的草本书对象' });
    expect(found.items.some((i) => i.ref.consId === out.formed[0]?.consRef.consId)).toBe(false);
  });

  it('maps kinds to roles and records provenance with sourceRefs', async () => {
    const caseRef = { consId: 'case-x', revision: 1 };
    const ctx = makeCtx(store, {
      candidates: [
        {
          tempId: 'm1',
          kind: 'method',
          content: {
            title: '专用方法',
            aliases: ['方法一'],
            searchTerms: ['专用'],
            instructions: '怎么做',
            applicabilityText: '何时用',
            spec: { kind: 'method', actionId: 'seed.decompose', instructions: '怎么做', applicabilityText: '何时用' },
            sourceRefs: [caseRef],
            origin: 'execution',
          },
        },
      ],
    });
    const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
      formed: Array<{ consRef: { consId: string } }>;
    };
    const rev = await store.getRevision(out.formed[0]?.consRef.consId ?? '', 1);
    expect(rev?.roles).toEqual(['method']);
    expect(rev?.aliases).toEqual(['方法一']);
    expect(rev?.searchTerms).toEqual(['专用']);
    expect(rev?.body).toBe('怎么做');
    expect(rev?.applicabilityText).toBe('何时用');
    expect(rev?.spec?.kind).toBe('method');
    expect(rev?.provenance.source).toBe('llm');
    expect(rev?.provenance.runId).toBe('run-test');
    expect(rev?.provenance.stepId).toBe(ctx.step.id);
    expect(rev?.provenance.sourceRefs).toEqual([caseRef]);
  });

  it('records source=llm for llm products even when the content claims origin execution (§3.1)', async () => {
    const ctx = makeCtx(store, {
      candidates: [{ tempId: 'a1', kind: 'object', content: { title: '执行来源产物', origin: 'execution' } }],
    });
    const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
      formed: Array<{ consRef: { consId: string } }>;
    };
    const rev = await store.getRevision(out.formed[0]?.consRef.consId ?? '', 1);
    expect(rev?.provenance.source).toBe('llm');
    expect(await store.hasIdempotencyKey(`${ctx.step.id}:0`)).toBe(true);
  });

  it('rejects candidates whose tempId collides with an existing cons id (tempId namespace)', async () => {
    const ctx = makeCtx(store, {
      candidates: [{ tempId: 'seed.decompose', kind: 'object', content: { title: '碰撞候选' } }],
    });
    await expect(createPrimitives()['form']?.run(ctx, ctx.step.id)).rejects.toThrow(
      /unauthorized_effect: tempId "seed\.decompose" collides/,
    );
  });
});
