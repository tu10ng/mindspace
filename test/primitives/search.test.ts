import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrimitives } from '../../src/primitives/index.js';
import { makeCtx, makeStore } from './helpers.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import type { SearchResultItem } from '../../src/types.js';

let store: ConsStoreApi;

beforeEach(async () => {
  store = (await makeStore()).store;
});

afterEach(() => {
  store.close();
});

async function runSearch(input: unknown): Promise<{ items: SearchResultItem[]; defaultMethod?: unknown }> {
  const ctx = makeCtx(store, input);
  const out = await createPrimitives()['search']?.run(ctx, ctx.step.id);
  return out as { items: SearchResultItem[]; defaultMethod?: unknown };
}

describe('search primitive', () => {
  it('finds seed actions by title and returns channel-tagged items', async () => {
    const out = await runSearch({ queries: [{ text: '拆解' }] });
    const hit = out.items.find((i) => i.ref.consId === 'seed.decompose');
    expect(hit).toBeDefined();
    expect(['name', 'searchTerm', 'fts', 'assoc']).toContain(hit?.channel);
  });

  it('narrows by role: a method query does not return actions', async () => {
    const out = await runSearch({ queries: [{ text: '拆解', roles: ['method'] }] });
    expect(out.items.some((i) => i.ref.consId === 'seed.decompose')).toBe(false);
    expect(out.items.some((i) => i.ref.consId === 'seed.decompose.default')).toBe(true);
  });

  it('lists all active actions on cold start when the query misses (§8.4)', async () => {
    const out = await runSearch({ queries: [{ text: '完全不相关的查询词', roles: ['action'] }] });
    expect(out.items.some((i) => i.ref.consId === 'seed.classify')).toBe(true);
    expect(out.items.some((i) => i.ref.consId === 'seed.decompose')).toBe(true);
  });

  it('runs the predefined query expansion above the cold-start threshold and still misses cleanly (§8.4)', async () => {
    for (let i = 0; i < 31; i++) {
      await store.createCons({
        consId: `pad-${i}`,
        title: `填充动作${i}`,
        roles: ['action'],
        body: '',
        aliases: [],
        searchTerms: [],
        provenance: { source: 'human', sourceRefs: [] },
      }, { stableId: `pad-${i}` });
      await store.setStatus(`pad-${i}`, 'active');
    }
    await store.createCons({
      consId: 'expansion-hit',
      title: '标准处理语料动作',
      roles: ['action'],
      body: '',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'expansion-hit' });
    await store.setStatus('expansion-hit', 'active');
    const hit = await runSearch({ queries: [{ text: '完全无法命中的查询词组', roles: ['action'] }] });
    expect(hit.items.some((i) => i.ref.consId === 'expansion-hit')).toBe(true);
    const events = await store.listEvents('run-test', { limit: 100 });
    const last = [...events].reverse().find((e) => e.eventType === 'retrieval_performed');
    expect(((last?.payload as { expandedQueries?: string[] }).expandedQueries ?? []).length).toBeGreaterThan(0);

    await store.setStatus('expansion-hit', 'archived');
    const miss = await runSearch({ queries: [{ text: '再次无法命中的查询词组', roles: ['action'] }] });
    expect(miss.items).toEqual([]);
  });

  it('finds short Chinese names of two characters through the exact/alias channels (§17.1-15)', async () => {
    await store.createCons({
      consId: 'tmp-box',
      title: '一个盒子对象',
      roles: ['object'],
      body: '',
      aliases: ['盒子'],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'tmp-box' });
    await store.setStatus('tmp-box', 'active');
    const out = await runSearch({ queries: [{ text: '盒子' }] });
    expect(out.items.some((i) => i.ref.consId === 'tmp-box')).toBe(true);
  });

  it('merges, dedupes and caps results with stable ordering', async () => {
    const out = await runSearch({
      queries: [
        { text: '拆解' },
        { text: '拆解' },
        { text: '属于' },
        { text: '接收' },
        { text: '搜索' },
      ],
    });
    const ids = out.items.map((i) => i.ref.consId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.items.length).toBeLessThanOrEqual(30);
  });

  it('appends a retrieval_performed event with queries and scored results', async () => {
    await runSearch({ queries: [{ text: '拆解' }] });
    const events = await store.listEvents('run-test', { limit: 100 });
    const ev = events.find((e) => e.eventType === 'retrieval_performed');
    expect(ev).toBeDefined();
    const payload = ev?.payload as { items: Array<{ consId: string; channel: string }> };
    expect(payload.items.some((i) => i.consId === 'seed.decompose')).toBe(true);
  });

  it('returns method bindings plus the default method for an actionId query (§17.1-16)', async () => {
    const out = await runSearch({ queries: [{ text: '拆解' }], actionId: 'seed.decompose' });
    expect(out.items.some((i) => i.ref.consId === 'seed.decompose.default')).toBe(true);
    const dm = out.defaultMethod as { consId: string; revision: number };
    expect(dm.consId).toBe('seed.decompose.default');
    expect(dm.revision).toBeGreaterThanOrEqual(1);
  });

  it('keeps the default method reachable even after a dedicated method is bound', async () => {
    const formCtx = makeCtx(store, {
      candidates: [
        {
          tempId: 'm1',
          kind: 'method',
          content: {
            title: '专用拆解方法',
            aliases: [],
            searchTerms: ['拆解'],
            instructions: '专门拆解',
            spec: { kind: 'method', actionId: 'seed.decompose', instructions: '专门拆解', applicabilityText: '' },
            origin: 'llm',
          },
        },
      ],
    });
    const formed = (await createPrimitives()['form']?.run(formCtx, formCtx.step.id)) as {
      formed: Array<{ tempId: string; consRef: { consId: string; revision: number } }>;
    };
    const connectCtx = makeCtx(store, {
      formed,
      methodBindings: [{ actionId: 'seed.decompose', methodRef: formed.formed[0]?.consRef }],
      activate: true,
    });
    await createPrimitives()['connect']?.run(connectCtx, connectCtx.step.id);
    const out = await runSearch({ queries: [{ text: '拆解' }], actionId: 'seed.decompose' });
    expect(out.items.some((i) => i.ref.consId === formed.formed[0]?.consRef.consId)).toBe(true);
    expect(out.items.some((i) => i.ref.consId === 'seed.decompose.default')).toBe(true);
    expect((out.defaultMethod as { consId: string }).consId).toBe('seed.decompose.default');
  });

  it('reaches explicit id references through anchorIds on the id channel (§6.2 / §8.3-1)', async () => {
    await store.createCons({
      consId: 'anchor-target',
      title: '锚点目标对象',
      roles: ['object'],
      body: '',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'anchor-target' });
    await store.setStatus('anchor-target', 'active');
    const out = await runSearch({ queries: [], anchorIds: ['anchor-target'] });
    const hit = out.items.find((i) => i.ref.consId === 'anchor-target');
    expect(hit).toBeDefined();
    expect(hit?.channel).toBe('id');
  });

  it('returns tendencyScope results as an object-wrapped tendencyRefs array (§6.1)', async () => {
    const ctx = makeCtx(store, { queries: [{ text: '方法内化' }], tendencyScope: 'method_selection', anchorIds: [] });
    const out = await createPrimitives()['search']?.run(ctx, ctx.step.id);
    expect(out).toEqual({ tendencyRefs: [{ consId: 'tendency.case_before_method', revision: 1 }] });
  });

  it('contentActionsOnly excludes actions whose input schema declares keys outside {input, task} (F11)', async () => {
    await store.createCons({
      consId: 'f11.text-action',
      title: '文本键动作',
      roles: ['action'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
        outputSchema: {
          type: 'object',
          properties: {
            artifacts: { type: 'array' },
            links: { type: 'array' },
          },
          required: ['artifacts', 'links'],
        },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'f11.text-action' });
    await store.setStatus('f11.text-action', 'active');
    const unfiltered = await runSearch({ queries: [{ text: '文本键动作', roles: ['action'] }] });
    expect(unfiltered.items.some((i) => i.ref.consId === 'f11.text-action')).toBe(true);
    const filtered = await runSearch({ queries: [{ text: '文本键动作', roles: ['action'] }], contentActionsOnly: true });
    expect(filtered.items.some((i) => i.ref.consId === 'f11.text-action')).toBe(false);
  });

  it('contentActionsOnly excludes actions that close the schema without declaring input and task (F11)', async () => {
    await store.createCons({
      consId: 'f11.closed-action',
      title: '封闭键动作',
      roles: ['action'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object', properties: { input: {} }, required: [], additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: {
            artifacts: { type: 'array' },
            links: { type: 'array' },
          },
          required: ['artifacts', 'links'],
        },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'f11.closed-action' });
    await store.setStatus('f11.closed-action', 'active');
    const filtered = await runSearch({ queries: [{ text: '封闭键动作', roles: ['action'] }], contentActionsOnly: true });
    expect(filtered.items.some((i) => i.ref.consId === 'f11.closed-action')).toBe(false);
  });
});
