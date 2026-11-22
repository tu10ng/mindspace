import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrimitives } from '../../src/primitives/index.js';
import { createSeedPrimitives } from '../../src/seed/runtime.js';
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
  const normalizedContent: Record<string, unknown> = { ...content };
  if (typeof normalizedContent['body'] !== 'string' || normalizedContent['body'].trim() === '') {
    if (kind !== 'method' || typeof normalizedContent['instructions'] !== 'string') {
      normalizedContent['body'] = `${String(normalizedContent['title'] ?? tempId)} 正文`;
    }
  }
  const ctx = makeCtx(store, { candidates: [{ tempId, kind, content: normalizedContent }] });
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
      spec: { kind: 'method', actionId: 'x1', instructions: '逐项对比两个对象。', applicabilityText: '需要比较时。' },
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
        defaultMethodId: 'm',
      },
      origin: 'llm',
    });
    const seededConnect = createSeedPrimitives()['connect'];
    const ctx = makeCtx(store, { formed: [{ tempId: 'm', consRef: method }, { tempId: 'x1', consRef: ref }], activate: true });
    const out = (await seededConnect?.run(ctx, ctx.step.id)) as {
      connected: ConsRef[];
    };
    expect(out.connected).toHaveLength(2);
    expect(out.connected.map((c) => c.consId)).toEqual([method.consId, ref.consId]);
    expect(out.connected.every((c) => c.revision === 2)).toBe(true);
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

  it('rejects edges whose endpoint revision does not exist or is not a positive integer (F13)', async () => {
    const a = await formOne('object', { title: '端点校验甲', origin: 'llm' }, 'a');
    const b = await formOne('object', { title: '端点校验乙', origin: 'llm' }, 'b');
    for (const badRevision of [999, -1, 0]) {
      await expect(
        connect({
          formed: [
            { tempId: 'a', consRef: a },
            { tempId: 'b', consRef: b },
          ],
          edges: [{ from: { consId: a.consId, revision: badRevision }, relationConsId: 'rel.describes', to: 'b' }],
          activate: true,
        }),
      ).rejects.toThrow(/unknown_reference/);
      await expect(
        connect({
          formed: [
            { tempId: 'a', consRef: a },
            { tempId: 'b', consRef: b },
          ],
          edges: [{ from: 'a', relationConsId: 'rel.describes', to: { consId: b.consId, revision: badRevision } }],
          activate: true,
        }),
      ).rejects.toThrow(/unknown_reference/);
    }
    expect(await store.listEdges(a.consId, 'both', false)).toEqual([]);
    expect((await store.getCons(a.consId))?.status).toBe('draft');
    expect((await store.getCons(b.consId))?.status).toBe('draft');
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

  it('replays the same step idempotently: same result, no duplicate edges or events (§14.3 / F04)', async () => {
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
    const first = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[]; connected: ConsRef[] };
    expect(first.edges).toHaveLength(1);
    const eventsAfterFirst = (await store.listEvents('run-test', { limit: 1000 })).length;
    const second = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[]; connected: ConsRef[] };
    expect(second).toEqual(first);
    expect((await store.listEdges(a.consId, 'both', false)).length).toBe(1);
    const eventsAfterSecond = (await store.listEvents('run-test', { limit: 1000 })).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
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
      spec: { kind: 'method', actionId: 'x1', instructions: '按流程执行。', applicabilityText: '' },
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
        defaultMethodId: 'm',
      },
      origin: 'llm',
    });
    const seededConnect = createSeedPrimitives()['connect'];
    const ctx = makeCtx(store, { formed: [{ tempId: 'm', consRef: method }, { tempId: 'x1', consRef: ref }], activate: true });
    await seededConnect?.run(ctx, ctx.step.id);
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

describe('tempId namespace and structured temp rewrite', () => {
  it('rejects formed tempIds that collide with existing cons ids and leaves specs intact', async () => {
    const method = await formOne('method', {
      title: '受控命名空间方法',
      instructions: 'use zz carefully',
      spec: { kind: 'method', actionId: 'seed.decompose', instructions: 'use zz carefully', applicabilityText: 'zz' },
    }, 'zz');
    await expect(
      connect({ formed: [{ tempId: 'seed.decompose', consRef: method }], activate: true }),
    ).rejects.toThrow(/unauthorized_effect: tempId "seed\.decompose" collides/);
    const seededConnect = createSeedPrimitives()['connect'];
    const ctx = makeCtx(store, { formed: [{ tempId: 'seed.decompose', consRef: method }], activate: true });
    await expect(seededConnect?.run(ctx, ctx.step.id)).rejects.toThrow(/unauthorized_effect/);
    const cons = await store.getCons(method.consId);
    expect(cons?.currentRevision).toBe(1);
    expect(cons?.status).toBe('draft');
    const seedMethodCons = await store.getCons('seed.decompose.default');
    expect(seedMethodCons?.currentRevision).toBe(1);
    const seedMethodRev = await store.getRevision('seed.decompose.default', 1);
    expect((seedMethodRev?.spec as { actionId?: string } | undefined)?.actionId).toBe('seed.decompose');
  });

  it('rewrites temp refs only on declared spec field paths (method.actionId, action.defaultMethodId)', async () => {
    const method = await formOne('method', {
      title: '局部改写方法',
      instructions: 'zz',
      spec: { kind: 'method', actionId: 'seed.classify', instructions: 'zz', applicabilityText: 'zz' },
    }, 'zz');
    const obj = await formOne('object', { title: '改写目标对象' }, 'zz2');
    const seededConnect = createSeedPrimitives()['connect'];
    const ctx = makeCtx(store, {
      formed: [
        { tempId: 'zz', consRef: method },
        { tempId: 'zz2', consRef: obj },
      ],
      activate: true,
    });
    const out = (await seededConnect?.run(ctx, ctx.step.id)) as { connected: ConsRef[] };
    expect(out.connected[0]?.revision).toBe(1);
    const rev = await store.getRevision(method.consId, 1);
    expect(rev?.spec).toMatchObject({ kind: 'method', actionId: 'seed.classify' });
    expect((rev?.spec as { instructions?: string; applicabilityText?: string } | undefined)?.instructions).toBe('zz');
    expect((rev?.spec as { applicabilityText?: string } | undefined)?.applicabilityText).toBe('zz');
  });

  it('rewrites tendency preferIds and avoidIds temp refs', async () => {
    const tendency = await formOne('tendency', {
      title: '倾向改写',
      spec: {
        kind: 'tendency',
        scope: 'action_selection',
        applicabilityText: '',
        preferenceText: '',
        preferIds: ['p1'],
        avoidIds: [],
      },
    }, 't1');
    const preferred = await formOne('object', { title: '倾向偏好对象' }, 'p1');
    const ctx = makeCtx(store, {
      formed: [
        { tempId: 't1', consRef: tendency },
        { tempId: 'p1', consRef: preferred },
      ],
      activate: true,
    });
    const out = (await createSeedPrimitives()['connect']?.run(ctx, ctx.step.id)) as { connected: ConsRef[] };
    expect(out.connected[0]?.revision).toBe(2);
    const rev = await store.getRevision(tendency.consId, 2);
    expect((rev?.spec as { preferIds?: string[] } | undefined)?.preferIds).toEqual([preferred.consId]);
  });
});

describe('connect idempotency atomicity', () => {
  it('writes the idempotency result inside the effect transaction: crash replay creates no duplicate edges', async () => {
    const a = await formOne('object', { title: '崩溃甲' }, 'a');
    const b = await formOne('object', { title: '崩溃乙' }, 'b');
    const ctx = makeCtx(store, {
      formed: [
        { tempId: 'a', consRef: a },
        { tempId: 'b', consRef: b },
      ],
      edges: [{ from: 'a', relationConsId: 'rel.describes', to: 'b' }],
      activate: true,
    });
    const realPut = store.putIdempotencyResult.bind(store);
    let armed = true;
    store.putIdempotencyResult = async (key: string, result: unknown): Promise<void> => {
      await realPut(key, result);
      if (armed && key.endsWith(':connect')) {
        armed = false;
        throw new Error('injected crash after key write');
      }
    };
    await expect(createPrimitives()['connect']?.run(ctx, ctx.step.id)).rejects.toThrow('injected crash after key write');
    store.putIdempotencyResult = realPut;
    expect(await store.listEdges(a.consId, 'both', false)).toEqual([]);
    expect((await store.getCons(a.consId))?.status).toBe('draft');
    expect(await store.getIdempotencyResult(`${ctx.step.id}:connect`)).toBeNull();
    const replay = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[]; connected: ConsRef[] };
    expect(replay.edges).toHaveLength(1);
    expect((await store.listEdges(a.consId, 'both', false)).length).toBe(1);
    expect((await store.getCons(a.consId))?.status).toBe('active');
    const again = (await createPrimitives()['connect']?.run(ctx, ctx.step.id)) as { edges: string[]; connected: ConsRef[] };
    expect(again).toEqual(replay);
    expect((await store.listEdges(a.consId, 'both', false)).length).toBe(1);
  });

  it('keeps the temp-rewrite revision inside the connect transaction: crash replay does not stack revisions', async () => {
    const method = await formOne('method', {
      title: '改写崩溃方法',
      instructions: 'x',
      spec: { kind: 'method', actionId: 'x1', instructions: 'x', applicabilityText: '' },
    }, 'm');
    const ref = await formOne('action', {
      title: '改写崩溃动作',
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'm',
      },
    }, 'x1');
    const ctx = makeCtx(store, {
      formed: [
        { tempId: 'm', consRef: method },
        { tempId: 'x1', consRef: ref },
      ],
      activate: true,
    });
    const seededConnect = createSeedPrimitives()['connect'];
    const realPut = store.putIdempotencyResult.bind(store);
    let armed = true;
    store.putIdempotencyResult = async (key: string, result: unknown): Promise<void> => {
      await realPut(key, result);
      if (armed && key.endsWith(':connect')) {
        armed = false;
        throw new Error('injected crash after key write');
      }
    };
    await expect(seededConnect?.run(ctx, ctx.step.id)).rejects.toThrow('injected crash after key write');
    store.putIdempotencyResult = realPut;
    expect((await store.getCons(method.consId))?.currentRevision).toBe(1);
    expect((await store.getCons(ref.consId))?.currentRevision).toBe(1);
    const out = (await seededConnect?.run(ctx, ctx.step.id)) as { connected: ConsRef[] };
    expect(out.connected.every((c) => c.revision === 2)).toBe(true);
    expect((await store.getCons(method.consId))?.currentRevision).toBe(2);
    expect((await store.getRevision(method.consId, 2))?.spec).toMatchObject({ kind: 'method', actionId: ref.consId });
  });
});
