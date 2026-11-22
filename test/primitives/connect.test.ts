import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrimitives } from '../../src/primitives/index.js';
import { makeCtx, makeStore } from './helpers.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import type { ConsRef } from '../../src/types.js';

let store: ConsStoreApi;

beforeEach(async () => {
  store = (await makeStore()).store;
});

afterEach(() => {
  store.close();
});

async function formOne(
  kind: string,
  content: Record<string, unknown>,
  tempId = 'x1',
): Promise<ConsRef> {
  const ctx = makeCtx(store, { candidates: [{ tempId, kind, content }] });
  const out = (await createPrimitives()['form']?.run(ctx, ctx.step.id)) as {
    formed: Array<{ tempId: string; consRef: ConsRef }>;
  };
  return out.formed[0]?.consRef ?? { consId: '', revision: 0 };
}

async function connect(input: unknown): Promise<unknown> {
  const ctx = makeCtx(store, input);
  return createPrimitives()['connect']?.run(ctx, ctx.step.id);
}

describe('connect primitive', () => {
  it('activates a registered llm action, writes its execution binding and makes it searchable (§17.1-3)', async () => {
    const method = await formOne('method', {
      title: '比较对象默认方法',
      instructions: '逐项对比两个对象。',
      spec: { kind: 'method', actionId: 'pending', instructions: '逐项对比两个对象。', applicabilityText: '需要比较时。' },
      origin: 'llm',
    }, 'm');
    const ref = await formOne('action', {
      title: '比较对象',
      aliases: ['对比'],
      searchTerms: ['比较'],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: method.consId,
      },
      origin: 'llm',
    });
    const out = (await connect({ formed: [{ tempId: 'm', consRef: method }, { tempId: 'x1', consRef: ref }], activate: true })) as {
      connected: ConsRef[];
    };
    expect(out.connected).toEqual([method, ref]);
    const cons = await store.getCons(ref.consId);
    expect(cons?.status).toBe('active');
    const binding = await store.getActiveExecutionBinding(ref.consId);
    expect(binding?.executor).toBe('llm');
    expect(binding?.active).toBe(true);
    const found = await store.search({ text: '比较对象' });
    expect(found.items.some((i) => i.ref.consId === ref.consId)).toBe(true);
  });

  it('rejects a dynamically formed action that binds a primitive or extra effects (§17.1-6)', async () => {
    const bad = await formOne('action', {
      title: '危险动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'primitive',
        primitiveKey: 'connect',
        allowedEffects: ['return_artifacts', 'activate'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
      },
      origin: 'llm',
    });
    await expect(connect({ formed: [{ tempId: 'x1', consRef: bad }], activate: true })).rejects.toThrow(
      /unauthorized_effect/,
    );
    const cons = await store.getCons(bad.consId);
    expect(cons?.status).toBe('draft');
    expect(await store.getActiveExecutionBinding(bad.consId)).toBeNull();
  });

  it('rejects a dynamic action draft missing required elements (§11.1)', async () => {
    const incomplete = await formOne('action', {
      title: '缺要素动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true },
      },
      origin: 'llm',
    });
    await expect(connect({ formed: [{ tempId: 'x1', consRef: incomplete }], activate: true })).rejects.toThrow(
      /schema_mismatch/,
    );
    const cons = await store.getCons(incomplete.consId);
    expect(cons?.status).toBe('draft');
    expect(await store.getActiveExecutionBinding(incomplete.consId)).toBeNull();
  });

  it('rolls the whole transaction back when any part fails (§10.6 / §17.1-11)', async () => {
    const a = await formOne('object', { title: '对象甲', origin: 'llm' }, 'a');
    const b = await formOne('object', { title: '对象乙', origin: 'llm' }, 'b');
    await expect(
      connect({
        formed: [
          { tempId: 'a', consRef: a },
          { tempId: 'b', consRef: b },
        ],
        edges: [
          { from: 'a', relationConsId: 'rel.describes', to: 'b' },
          { from: 'a', relationConsId: 'rel.does_not_exist', to: 'b' },
        ],
        activate: true,
      }),
    ).rejects.toThrow(/relation cons rel.does_not_exist not found/);
    expect((await store.getCons(a.consId))?.status).toBe('draft');
    expect((await store.getCons(b.consId))?.status).toBe('draft');
    expect(await store.listEdges(a.consId, 'both', false)).toEqual([]);
  });

  it('rejects edges whose relation cons is not an active relation_type (§7.4)', async () => {
    const a = await formOne('object', { title: '关系校验甲', origin: 'llm' }, 'a');
    const b = await formOne('object', { title: '关系校验乙', origin: 'llm' }, 'b');
    await expect(
      connect({
        formed: [
          { tempId: 'a', consRef: a },
          { tempId: 'b', consRef: b },
        ],
        edges: [{ from: 'a', relationConsId: 'seed.decompose', to: 'b' }],
        activate: true,
      }),
    ).rejects.toThrow(/unauthorized_effect/);
    expect((await store.getCons(a.consId))?.status).toBe('draft');
    expect((await store.getCons(b.consId))?.status).toBe('draft');
    expect(await store.listEdges(a.consId, 'both', false)).toEqual([]);
  });

  it('resolves temp id endpoints to formed refs and creates active edges', async () => {
    const obj = await formOne('object', { title: '目标对象', origin: 'llm' }, 'o');
    const prop = await formOne('proposition', { title: '关于目标的命题', origin: 'llm' }, 'p');
    const out = (await connect({
      formed: [
        { tempId: 'o', consRef: obj },
        { tempId: 'p', consRef: prop },
      ],
      edges: [{ from: 'p', relationConsId: 'rel.describes', to: 'o' }],
      activate: true,
    })) as { connected: ConsRef[]; edges: string[] };
    expect(out.edges).toHaveLength(1);
    const edges = await store.listEdges(prop.consId, 'from', true);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relationConsId).toBe('rel.describes');
    expect(edges[0]?.to.consId).toBe(obj.consId);
    expect(typeof edges[0]?.createdByStepId).toBe('string');
  });

  it('binds a dedicated method to its action with a method_of edge and keeps the default binding active', async () => {
    const method = await formOne('method', {
      title: '专用拆解方法',
      searchTerms: ['拆解'],
      instructions: '专门拆解',
      spec: { kind: 'method', actionId: 'seed.decompose', instructions: '专门拆解', applicabilityText: '' },
      origin: 'llm',
    });
    await connect({
      formed: [{ tempId: 'm', consRef: method }],
      methodBindings: [{ actionId: 'seed.decompose', methodRef: method }],
      activate: true,
    });
    const bindings = await store.listActiveMethodBindings('seed.decompose');
    expect(bindings.map((b) => b.methodId).sort()).toEqual(['seed.decompose.default', method.consId].sort());
    const edges = await store.listEdges(method.consId, 'from', true);
    expect(edges.some((e) => e.relationConsId === 'rel.method_of' && e.to.consId === 'seed.decompose')).toBe(true);
    expect((await store.getCons(method.consId))?.status).toBe('active');
  });

  it('rejects a method binding whose actionId is not the main action executed by the run (§10.3)', async () => {
    const method = await formOne('method', {
      title: '越权方法',
      instructions: '属于其他动作的方法',
      spec: { kind: 'method', actionId: 'seed.classify', instructions: '属于其他动作的方法', applicabilityText: '' },
      origin: 'llm',
    });
    const ctx = makeCtx(store, {
      formed: [{ tempId: 'm', consRef: method }],
      methodBindings: [{ actionId: 'seed.classify', methodRef: method }],
      activate: true,
    });
    ctx.run.state['actionSelection'] = {
      status: 'selected',
      selected: { consId: 'seed.decompose', revision: 1 },
      usedTendencies: [],
      basisSummary: 'mock',
      usedDefaultFreedom: true,
      consId: 'seed.decompose',
      revision: 1,
      authorized: true,
    };
    await expect(createPrimitives()['connect']?.run(ctx, ctx.step.id)).rejects.toThrow(/unauthorized_effect/);
    expect((await store.listActiveMethodBindings('seed.classify')).some((b) => b.methodId === method.consId)).toBe(false);
    expect((await store.getCons(method.consId))?.status).toBe('draft');
  });

  it('records idempotency keys per write op and re-executing the same step creates no duplicate edges (§14.3)', async () => {
    const a = await formOne('object', { title: '幂等对象甲', origin: 'llm' }, 'a');
    const b = await formOne('object', { title: '幂等对象乙', origin: 'llm' }, 'b');
    const ctx = makeCtx(store, {
      formed: [
        { tempId: 'a', consRef: a },
        { tempId: 'b', consRef: b },
      ],
      edges: [{ from: 'a', relationConsId: 'rel.describes', to: 'b' }],
      activate: true,
    });
    const first = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[] };
    expect(first.edges).toHaveLength(1);
    expect(await store.hasIdempotencyKey(`${ctx.step.id}:0`)).toBe(true);
    expect(await store.hasIdempotencyKey(`${ctx.step.id}:1`)).toBe(true);
    expect(await store.hasIdempotencyKey(`${ctx.step.id}:2`)).toBe(true);
    const second = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[] };
    expect(second.edges).toHaveLength(0);
    expect((await store.listEdges(a.consId, 'both', false)).length).toBe(1);
  });

  it('writes cons_activated and edges_created events inside the connect transaction (§10.6 / §4.1)', async () => {
    const obj = await formOne('object', { title: '事件对象甲', origin: 'llm' }, 'a');
    const prop = await formOne('proposition', { title: '事件命题乙', origin: 'llm' }, 'b');
    await connect({
      formed: [
        { tempId: 'a', consRef: obj },
        { tempId: 'b', consRef: prop },
      ],
      edges: [{ from: 'b', relationConsId: 'rel.describes', to: 'a' }],
      activate: true,
    });
    const events = await store.listEvents('run-test', { limit: 1000 });
    const activated = events.filter((e) => e.eventType === 'cons_activated');
    expect(activated.length).toBe(2);
    const batch = events.filter((e) => e.eventType === 'edges_created' && Array.isArray((e.payload as { edges?: unknown }).edges));
    expect(batch.length).toBe(1);
    interface EdgeDesc {
      from: { consId: string };
      to: { consId: string };
    }
    const payloadEdges = (batch[0]?.payload as { edges: EdgeDesc[] }).edges;
    expect(payloadEdges.some((e) => e.from.consId === prop.consId && e.to.consId === obj.consId)).toBe(true);
  });

  it('registers a flow-executor dynamic action whose effects stay within its nodes (§11.1)', async () => {
    const flowSpec = {
      kind: 'flow' as const,
      entry: 'n_classify',
      nodes: {
        n_classify: {
          actionId: 'seed.classify',
          inputBindings: {},
          outputKey: 'classified',
          next: 'n_end',
        },
        n_end: { inputBindings: {}, outputKey: 'done', terminal: true },
      },
    };
    await store.createCons({
      consId: 'dyn.flow.ref',
      title: '动态小流程',
      roles: ['flow'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: flowSpec,
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'dyn.flow.ref' });
    await store.setStatus('dyn.flow.ref', 'active');
    const method = await formOne('method', {
      title: '流程动作默认方法',
      instructions: '按流程执行。',
      spec: { kind: 'method', actionId: 'pending', instructions: '按流程执行。', applicabilityText: '' },
      origin: 'llm',
    }, 'm');
    const ref = await formOne('action', {
      title: '流程组合动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'flow',
        flowRef: { consId: 'dyn.flow.ref', revision: 1 },
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
        defaultMethodId: method.consId,
      },
      origin: 'llm',
    });
    await connect({ formed: [{ tempId: 'm', consRef: method }, { tempId: 'x1', consRef: ref }], activate: true });
    const cons = await store.getCons(ref.consId);
    expect(cons?.status).toBe('active');
    const binding = await store.getActiveExecutionBinding(ref.consId);
    expect(binding?.executor).toBe('flow');
    const found = await store.search({ text: '流程组合动作' });
    expect(found.items.some((i) => i.ref.consId === ref.consId)).toBe(true);
  });

  it('rejects flow-executor actions whose effects exceed the node actions or that reference primitives (§11.1)', async () => {
    const flowSpec = {
      kind: 'flow' as const,
      entry: 'n1',
      nodes: {
        n1: { actionId: 'seed.classify', inputBindings: {}, outputKey: 'o', next: 'n_end' },
        n_end: { inputBindings: {}, outputKey: 'done', terminal: true },
      },
    };
    await store.createCons({
      consId: 'dyn.flow.bad',
      title: '越权流程',
      roles: ['flow'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: flowSpec,
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'dyn.flow.bad' });
    await store.setStatus('dyn.flow.bad', 'active');
    const method = await formOne('method', {
      title: '越权流程默认方法',
      instructions: '越权。',
      spec: { kind: 'method', actionId: 'pending', instructions: '越权。', applicabilityText: '' },
      origin: 'llm',
    }, 'm');
    const over = await formOne('action', {
      title: '越权流程动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'flow',
        flowRef: { consId: 'dyn.flow.bad', revision: 1 },
        allowedEffects: ['return_artifacts', 'create_draft'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
        defaultMethodId: method.consId,
      },
      origin: 'llm',
    });
    await expect(
      connect({ formed: [{ tempId: 'm', consRef: method }, { tempId: 'x1', consRef: over }], activate: true }),
    ).rejects.toThrow(/unauthorized_effect/);
    expect((await store.getCons(over.consId))?.status).toBe('draft');

    const primFlowSpec = {
      kind: 'flow' as const,
      entry: 'n1',
      nodes: {
        n1: { actionId: 'seed.form', inputBindings: {}, outputKey: 'o', next: 'n_end' },
        n_end: { inputBindings: {}, outputKey: 'done', terminal: true },
      },
    };
    await store.createCons({
      consId: 'dyn.flow.prim',
      title: '引用原语的流程',
      roles: ['flow'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: primFlowSpec,
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'dyn.flow.prim' });
    await store.setStatus('dyn.flow.prim', 'active');
    const primRef = await formOne('action', {
      title: '引用原语的流程动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'flow',
        flowRef: { consId: 'dyn.flow.prim', revision: 1 },
        allowedEffects: [],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
        defaultMethodId: method.consId,
      },
      origin: 'llm',
    });
    await expect(
      connect({ formed: [{ tempId: 'x1', consRef: primRef }], activate: true }),
    ).rejects.toThrow(/unauthorized_effect/);
    expect((await store.getCons(primRef.consId))?.status).toBe('draft');
  });
});
