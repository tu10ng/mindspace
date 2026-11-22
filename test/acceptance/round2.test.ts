import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load-main.js';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { startServer } from '../../src/api/server.js';
import { createMockLlm } from '../../src/llm/mock.js';
import { executeRun } from '../../src/engine/executor.js';
import type { EngineDeps } from '../../src/engine/executor.js';
import { validateFlow } from '../../src/engine/flow.js';
import { validateSchema } from '../../src/schema.js';
import { activateConsInTx, createPrimitives, isContentActionCompatible } from '../../src/primitives/index.js';
import { createSeedPrimitives } from '../../src/seed/runtime.js';
import type { ActionSpec, ConsRef, FlowSpec, LlmRequest, Run } from '../../src/types.js';
import { FakeStore, actionSpec, makeNode, makeRun, seedAction, seedFlow, seedMethod } from '../engine/helpers.js';
import { makeCtx, makeStore } from '../primitives/helpers.js';

function jsonBlocks(prompt: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? '');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      void 0;
    }
  }
  return out;
}

function ingestHandler(selectedAction: string): (req: LlmRequest) => unknown {
  return (req: LlmRequest): unknown => {
    const action = jsonBlocks(req.userPrompt)[0]?.['consId'];
    const p = req.userPrompt;
    if (action === 'seed.make_query') {
      return { queries: ['拆解'], roles: ['action'], anchorIds: [] };
    }
    if (action === 'seed.select_action') {
      return { status: 'selected', selected: { consId: selectedAction, revision: 1 }, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.select_method') {
      const input = jsonBlocks(p).find((b) => 'defaultMethod' in b && 'candidates' in b) ?? {};
      const fallback = input['defaultMethod'] as ConsRef | undefined;
      return { status: 'selected', selected: fallback ?? null, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === selectedAction || action === 'seed.decompose') {
      return {
        artifacts: [{ tempId: 'a1', kind: 'object', content: { title: '中心对象' } }],
        links: [],
        executionSummary: 'mock 拆解',
      };
    }
    if (action === 'seed.prepare_connections') {
      const artifactsBlock = jsonBlocks(p).find((b) => 'artifacts' in b) ?? {};
      const artifacts = Array.isArray(artifactsBlock['artifacts']) ? (artifactsBlock['artifacts'] as Array<Record<string, unknown>>) : [];
      return {
        candidates: artifacts.map((a) => ({ tempId: a['tempId'], kind: a['kind'], content: a['content'] })),
        edges: [],
      };
    }
    if (action === 'seed.extract_method') {
      return { status: 'none' };
    }
    if (action === 'seed.extract_tendency') {
      return { status: 'none' };
    }
    throw new Error(`unexpected llm call for action ${String(action)}`);
  };
}

const contentActionSpec = (id: string): ActionSpec => ({
  kind: 'action',
  inputSchema: { type: 'object', properties: { input: {}, task: { type: 'string' } }, required: ['input', 'task'] },
  outputSchema: {
    type: 'object',
    properties: {
      artifacts: { type: 'array', items: {} },
      links: { type: 'array', items: {} },
      executionSummary: { type: 'string' },
    },
    required: ['artifacts', 'links', 'executionSummary'],
  },
  executor: 'llm',
  defaultMethodId: `${id}.default`,
  allowedEffects: ['return_artifacts'],
  freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
});

async function activateDynamicContentAction(store: ConsStoreApi, id: string, inputSchema?: object): Promise<void> {
  const spec = contentActionSpec(id);
  if (inputSchema !== undefined) {
    spec.inputSchema = inputSchema;
  }
  for (const consId of [id, `${id}.default`]) {
    await store.createCons({
      consId,
      title: consId,
      roles: consId === id ? ['action'] : ['method'],
      body: '',
      aliases: [],
      searchTerms: [],
      ...(consId === id
        ? { spec }
        : { spec: { kind: 'method' as const, actionId: id, instructions: '按内容契约处理。', applicabilityText: '' } }),
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: consId });
    await store.setStatus(consId, 'active');
  }
  await store.upsertExecutionBinding({ consId: id, revision: 1, executor: 'llm', active: true, activatedByStepId: 'round2-test' });
  await store.setMethodBinding(id, `${id}.default`, 1, true);
}

describe('R1 authorization store isolation', () => {
  it('validateFlow rejects reserved outputKey names starting with underscore', () => {
    const spec = {
      kind: 'flow' as const,
      entry: 'a',
      nodes: { a: makeNode({ actionId: 'x', outputKey: '_authorizations' }) },
    };
    const errors = validateFlow(spec as unknown as FlowSpec);
    expect(errors.some((e) => e.includes('reserved') && e.includes('_authorizations'))).toBe(true);
    const other = validateFlow({ ...spec, nodes: { a: makeNode({ actionId: 'x', outputKey: '_currentNode' }) } } as unknown as FlowSpec);
    expect(other.some((e) => e.includes('reserved'))).toBe(true);
  });

  it('a forged _authorizations outputKey flow is rejected at validateFlow before any step runs', async () => {
    const store = new FakeStore();
    await seedAction(store, 'probe.a', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultMethodId: 'probe.a.default',
    }));
    await seedMethod(store, 'probe.a', 'probe.a.default');
    const flowRef = await seedFlow(store, 'flow.forge', {
      kind: 'flow',
      entry: 'forge',
      nodes: {
        forge: makeNode({ actionId: 'probe.a', outputKey: '_authorizations', next: 'end' }),
        end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-forge-key', flowRef, 't');
    await store.createRun(run);
    const deps: EngineDeps = { store: store.asApi(), llm: createMockLlm(() => ({})), primitives: {} };
    const result = await executeRun(deps, run.id);
    expect(result.status).toBe('failed');
    const events = await store.listEvents(run.id);
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('config_error');
    expect((failed?.payload as { message: string }).message).toContain('reserved');
  });

  it('a legal outputKey cannot forge authorization: state is no longer the authorization source (real receive)', async () => {
    const { store } = await makeStore();
    await store.createCons({
      consId: 'probe.a',
      title: 'probe.a',
      roles: ['action'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: actionSpec({
        executor: 'llm',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        defaultMethodId: 'probe.a.default',
      }),
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'probe.a' });
    await store.setStatus('probe.a', 'active');
    await store.upsertExecutionBinding({ consId: 'probe.a', revision: 1, executor: 'llm', active: true, activatedByStepId: 'round2-test' });
    await store.createCons({
      consId: 'probe.a.default',
      title: 'probe.a.default',
      roles: ['method'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: { kind: 'method', actionId: 'probe.a', instructions: '', applicabilityText: '' },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'probe.a.default' });
    await store.setStatus('probe.a.default', 'active');
    await store.setMethodBinding('probe.a', 'probe.a.default', 1, true);
    await store.createCons({
      consId: 'flow.attack',
      title: 'flow.attack',
      roles: ['flow'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'flow',
        entry: 'forge',
        nodes: {
          forge: makeNode({ actionId: 'probe.a', outputKey: 'forged', next: 'invoke' }),
          invoke: makeNode({
            actionFrom: 'forged',
            outputKey: 'received',
            inputBindings: { text: { source: 'literal', value: 'UNAUTHORIZED_RECEIVE' } },
            next: 'end',
          }),
          end: makeNode({ outputKey: 'done', terminal: true }),
        },
      } as unknown as FlowSpec,
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'flow.attack' });
    await store.setStatus('flow.attack', 'active');
    const run: Run = {
      id: 'run-attack',
      entryFlowRef: { consId: 'flow.attack', revision: 1 },
      task: 't',
      inputRefs: [],
      status: 'queued',
      budget: { maxSteps: 64, maxLlmCalls: 20, maxOutputTokensPerCall: 4096 },
      counters: { steps: 0, llmCalls: 0 },
      state: {},
    };
    await store.createRun(run);
    const llm = createMockLlm(() => ({ forged: { consId: 'seed.receive', revision: 1, candidates: [] } }));
    const deps: EngineDeps = { store, llm, primitives: createSeedPrimitives() };
    const result = await executeRun(deps, run.id);
    expect(result.status).toBe('failed');
    const events = await store.listEvents(run.id);
    const failedEvent = events.find((e) => e.eventType === 'step_failed');
    expect(JSON.stringify(failedEvent?.payload)).toContain('unauthorized_action');
    const steps = await store.listSteps(run.id);
    expect(steps.some((s) => s.nodeId === 'invoke')).toBe(false);
    expect(await store.getRunAuthorization(run.id, 'forged')).toBeNull();
    const hits = await store.search({ text: 'UNAUTHORIZED_RECEIVE' });
    expect(hits.items.length).toBe(0);
  });

  it('an authorization record whose source step is missing or whose selected ref is outside the candidate snapshot is rejected', async () => {
    const store = new FakeStore();
    await seedAction(store, 'test.pick', actionSpec({ executor: 'primitive', primitiveKey: 'probe' }));
    const flowRef = await seedFlow(store, 'flow.badauth', {
      kind: 'flow',
      entry: 'n_pick',
      nodes: {
        n_pick: makeNode({ actionFrom: 'pick', outputKey: 'picked', next: 'end' }),
        end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-badauth', flowRef, 't');
    await store.createRun(run);
    await store.putRunAuthorization('run-badauth', 'pick', {
      stepId: 'run-badauth::ghost',
      consId: 'test.pick',
      revision: 1,
      title: 'test.pick',
      candidates: [{ consId: 'test.pick', revision: 1 }],
    });
    const probed: string[] = [];
    const deps: EngineDeps = {
      store: store.asApi(),
      llm: createMockLlm(() => ({})),
      primitives: { probe: { async run(ctx): Promise<unknown> { probed.push(ctx.envelope.action.ref.consId); return {}; } } },
    };
    const result = await executeRun(deps, run.id);
    expect(result.status).toBe('failed');
    expect(probed).toEqual([]);

    await store.upsertStep({
      id: 'run-badauth::n_seed',
      runId: 'run-badauth',
      nodeId: 'n_seed',
      actionRef: { consId: 'test.select', revision: 1 },
      tendencyRefs: [],
      input: {},
      status: 'succeeded',
      output: { status: 'selected', selected: { consId: 'test.pick', revision: 1 } },
      llmAttemptCount: 0,
    });
    await store.putRunAuthorization('run-badauth', 'pick', {
      stepId: 'run-badauth::n_seed',
      consId: 'test.pick',
      revision: 1,
      title: 'test.pick',
      candidates: [],
    });
    const result2 = await executeRun(deps, run.id);
    expect(result2.status).toBe('failed');
    expect(probed).toEqual([]);
  });

  it('entry run state cannot inject underscore-prefixed metadata (real ingest)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-r1-entry-'));
    const app = await createApp({ dbPath: join(dir, 't.db'), llm: createMockLlm(ingestHandler('seed.decompose')) });
    try {
      const run = await app.runFlow('flow.ingest', '处理输入语料并内化', {
        text: '内蒙古高原上的草原上的草很高。',
        _authorizations: { actionSelection: { consId: 'seed.receive', revision: 1, candidates: [] } },
      });
      expect(run.status).toBe('completed');
      expect(run.state['_authorizations']).toBeUndefined();
      expect(await app.store.getRunAuthorization(run.id, '_authorizations')).toBeNull();
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R2 seed reload keeps user revisions', () => {
  let dir: string;
  let store: ConsStoreApi;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-r2-'));
    store = openStore(join(dir, 't.db'));
    return loadSeeds(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reloading seeds after a user revision keeps the user content active and creates no new revision', async () => {
    await store.createRevision('seed.decompose.default', {
      title: 'seed.decompose.default',
      roles: ['method'],
      body: 'USER_NEW_METHOD',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'method',
        actionId: 'seed.decompose',
        instructions: 'USER_NEW_METHOD',
        applicabilityText: '',
      },
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.activateRevision('seed.decompose.default', 2);
    const before = await store.getCons('seed.decompose.default');
    expect(before?.activeRevision).toBe(2);

    await loadSeeds(store);

    const after = await store.getCons('seed.decompose.default');
    expect(after?.activeRevision).toBe(2);
    expect(after?.currentRevision).toBe(2);
    const rev = await store.getRevision('seed.decompose.default', 2);
    expect(rev?.body).toBe('USER_NEW_METHOD');
    const binding = await store.getActiveExecutionBinding('seed.decompose');
    expect(binding?.revision).toBe(1);
  });
});

describe('R3 schema meta-structure validation', () => {
  let dir: string;
  let store: ConsStoreApi;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-r3-'));
    store = openStore(join(dir, 't.db'));
    return loadSeeds(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects activating an action whose inputSchema has a null property sub-schema', async () => {
    const actionId = 'r3.malformed';
    await store.createCons({
      consId: actionId,
      title: actionId,
      roles: ['action'],
      body: '畸形 schema 动作。',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object', properties: { x: null } },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'r3.malformed.default',
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: actionId });
    await store.createCons({
      consId: 'r3.malformed.default',
      title: 'r3.malformed.default',
      roles: ['method'],
      body: '',
      aliases: [],
      searchTerms: [],
      spec: { kind: 'method', actionId, instructions: '', applicabilityText: '' },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'r3.malformed.default' });
    await store.setStatus('r3.malformed.default', 'active');
    await expect(
      store.transaction(async () => {
        await activateConsInTx(store, actionId, 1, { activatedBy: 'round2-test' });
      }),
    ).rejects.toThrow(/inputSchema/);
    expect((await store.getCons(actionId))?.status).toBe('draft');
    expect(await store.getActiveExecutionBinding(actionId)).toBeNull();
  });

  it('runtime validation of a malformed schema returns a controlled schema_mismatch instead of throwing', () => {
    const result = validateSchema({ type: 'object', properties: { x: null } }, { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('R4 human activation audit event is transactional', () => {
  it('rolls back activation when the human_cons_activated event write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-r4-'));
    const app = await createApp({ dbPath: join(dir, 't.db'), llm: createMockLlm(() => { throw new Error('no llm'); }) });
    let server: Server | null = null;
    try {
      await app.store.createCons({
        consId: 'r4.method',
        title: 'r4.method',
        roles: ['method'],
        body: '',
        aliases: [],
        searchTerms: [],
        spec: { kind: 'method', actionId: 'seed.decompose', instructions: '', applicabilityText: '' },
        provenance: { source: 'human', sourceRefs: [] },
      }, { stableId: 'r4.method' });
      const original = app.store.appendEvent.bind(app.store);
      (app.store as { appendEvent: ConsStoreApi['appendEvent'] }).appendEvent = async (eventType, payload, runId, stepId) => {
        if (eventType === 'human_cons_activated') {
          throw new Error('injected audit failure');
        }
        return original(eventType, payload, runId, stepId);
      };
      server = startServer(app, 0);
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${String(port)}/cons/r4.method/activate`, { method: 'POST' });
      expect(res.status).toBe(400);
      const cons = await app.store.getCons('r4.method');
      expect(cons?.status).toBe('draft');
      const bindings = await app.store.listActiveMethodBindings('seed.decompose');
      expect(bindings.some((b) => b.methodId === 'r4.method')).toBe(false);
    } finally {
      server?.close();
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R5 method upgrade and rebinding cleanup', () => {
  let dir: string;
  let store: ConsStoreApi;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-r5-'));
    store = openStore(join(dir, 't.db'));
    return loadSeeds(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function reviseMethod(revision: number, actionId: 'seed.decompose' | 'seed.classify'): Promise<number> {
    const created = await store.createRevision('r5.method', {
      title: 'r5.method',
      roles: ['method'],
      body: `第${String(revision)}版`,
      aliases: [],
      searchTerms: [],
      spec: { kind: 'method', actionId, instructions: `第${String(revision)}版`, applicabilityText: '' },
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.transaction(async () => {
      await activateConsInTx(store, 'r5.method', created.revision, { activatedBy: 'round2-test' }, { methodBinding: true });
    });
    return created.revision;
  }

  it('upgrading and rebinding a method keeps edges and bindings consistent', async () => {
    await store.createCons({
      consId: 'r5.method',
      title: 'r5.method',
      roles: ['method'],
      body: '第1版',
      aliases: [],
      searchTerms: [],
      spec: { kind: 'method', actionId: 'seed.decompose', instructions: '第1版', applicabilityText: '' },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'r5.method' });
    await store.transaction(async () => {
      await activateConsInTx(store, 'r5.method', 1, { activatedBy: 'round2-test' }, { methodBinding: true });
    });

    const rev2 = await reviseMethod(2, 'seed.decompose');
    let edges = await store.listEdges('r5.method', 'from', false);
    let active = edges.filter((e) => e.status === 'active' && e.relationConsId === 'rel.method_of');
    expect(active).toHaveLength(1);
    expect(active[0]?.from.revision).toBe(rev2);
    expect((await store.listActiveMethodBindings('seed.decompose')).find((b) => b.methodId === 'r5.method')?.methodRevision).toBe(rev2);

    const rev3 = await reviseMethod(3, 'seed.classify');
    edges = await store.listEdges('r5.method', 'from', false);
    active = edges.filter((e) => e.status === 'active' && e.relationConsId === 'rel.method_of');
    expect(active).toHaveLength(1);
    expect(active[0]?.from.revision).toBe(rev3);
    expect(active[0]?.to.consId).toBe('seed.classify');
    expect((await store.listActiveMethodBindings('seed.decompose')).some((b) => b.methodId === 'r5.method')).toBe(false);
    expect((await store.listActiveMethodBindings('seed.classify')).find((b) => b.methodId === 'r5.method')?.methodRevision).toBe(rev3);
  });
});

describe('R6 per-store transaction context', () => {
  it('a store B transaction paused mid-way blocks A.transaction reads of B through the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-r6-'));
    const storeA = openStore(join(dir, 'a.db'));
    const storeB = openStore(join(dir, 'b.db'));
    try {
      for (const s of [storeA, storeB]) {
        await s.createCons({
          consId: 'shared.x',
          title: '共享对象',
          roles: ['object'],
          body: '',
          aliases: [],
          searchTerms: [],
          provenance: { source: 'human', sourceRefs: [] },
        }, { stableId: 'shared.x' });
        await s.setStatus('shared.x', 'active');
      }
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const txB = storeB.transaction(async () => {
        await storeB.setStatus('shared.x', 'draft');
        await gate;
      });
      let readerDone = false;
      const reader = storeA.transaction(async () => {
        const cons = await storeB.getCons('shared.x');
        readerDone = true;
        return cons;
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(readerDone).toBe(false);
      release();
      await txB;
      const read = await reader;
      expect(read?.status).toBe('draft');
    } finally {
      storeA.close();
      storeB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R7 content action category permission', () => {
  it('a newly activated contract-compatible action enters ingest candidates and is selected and executed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-r7-'));
    const app = await createApp({ dbPath: join(dir, 't.db'), llm: createMockLlm(ingestHandler('dyn.content')) });
    try {
      await activateDynamicContentAction(app.store, 'dyn.content');
      const run = await app.runIngest('短句语料。');
      expect(run.status).toBe('completed');
      const steps = await app.store.listSteps(run.id);
      const searchStep = steps.find((s) => s.nodeId === 'search_actions');
      const output = searchStep?.output as { items: Array<{ ref: ConsRef }> };
      expect(output.items.some((i) => i.ref.consId === 'dyn.content')).toBe(true);
      const exec = steps.find((s) => s.nodeId === 'execute_action');
      expect(exec?.actionRef.consId).toBe('dyn.content');
      expect(exec?.status).toBe('succeeded');
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an action declaring input as string is excluded from content candidates', async () => {
    const { store } = await makeStore();
    await activateDynamicContentAction(store, 'dyn.str-action', {
      type: 'object',
      properties: { input: { type: 'string' }, task: { type: 'string' } },
      required: ['input', 'task'],
    });
    const ctx = makeCtx(store, { queries: [{ text: 'dyn.str-action', roles: ['action'] }], contentActionsOnly: true });
    const out = (await createPrimitives()['search']?.run(ctx, ctx.step.id)) as { items: Array<{ ref: ConsRef }> };
    expect(out.items.some((i) => i.ref.consId === 'dyn.str-action')).toBe(false);
    const unfilteredCtx = makeCtx(store, { queries: [{ text: 'dyn.str-action', roles: ['action'] }] });
    const unfiltered = (await createPrimitives()['search']?.run(unfilteredCtx, unfilteredCtx.step.id)) as { items: Array<{ ref: ConsRef }> };
    expect(unfiltered.items.some((i) => i.ref.consId === 'dyn.str-action')).toBe(true);
  });

  it('executor honours contentActionsOnly on actionFrom nodes via the shared contract check', async () => {
    const compatible = contentActionSpec('test.content');
    const incompatible = contentActionSpec('test.strcontent');
    incompatible.inputSchema = { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] };
    expect(isContentActionCompatible(compatible)).toBe(true);
    expect(isContentActionCompatible(incompatible)).toBe(false);

    async function runPick(spec: ActionSpec): Promise<{ status: string; errorCode: string | undefined; probed: string[] }> {
      const store = new FakeStore();
      await seedAction(store, spec.defaultMethodId?.slice(0, -8) ?? 'test.x', spec);
      await seedMethod(store, spec.defaultMethodId?.slice(0, -8) ?? 'test.x', `${spec.defaultMethodId ?? 'x'}`);
      const actionId = (spec.defaultMethodId ?? '').replace('.default', '');
      const flowRef = await seedFlow(store, 'flow.pick', {
        kind: 'flow',
        entry: 'n_pick',
        nodes: {
          n_pick: makeNode({
            actionFrom: 'pick',
            contentActionsOnly: true,
            outputKey: 'picked',
            inputBindings: { input: { source: 'literal', value: {} }, task: { source: 'literal', value: 't' } },
            next: 'end',
          }),
          end: makeNode({ outputKey: 'done', terminal: true }),
        },
      });
      const run = makeRun(`run-${actionId}`, flowRef, 't');
      await store.createRun(run);
      await store.upsertStep({
        id: `${run.id}::n_seed`,
        runId: run.id,
        nodeId: 'n_seed',
        actionRef: { consId: 'test.select', revision: 1 },
        tendencyRefs: [],
        input: {},
        status: 'succeeded',
        output: { status: 'selected', selected: { consId: actionId, revision: 1 } },
        llmAttemptCount: 0,
      });
      await store.putRunAuthorization(run.id, 'pick', {
        stepId: `${run.id}::n_seed`,
        consId: actionId,
        revision: 1,
        title: actionId,
        candidates: [{ consId: actionId, revision: 1 }],
      });
      const probed: string[] = [];
      const artifactOutput = { artifacts: [], links: [], executionSummary: 'ok' };
      const deps: EngineDeps = {
        store: store.asApi(),
        llm: createMockLlm(() => artifactOutput),
        primitives: {},
      };
      const result = await executeRun(deps, run.id);
      const steps = await store.listSteps(run.id);
      const evs = await store.listEvents(run.id);
      const failedPayload = evs.find((e) => e.eventType === 'step_failed')?.payload as { errorCode?: string } | undefined;
      const stepError = steps.find((s) => s.nodeId === 'n_pick')?.errorCode;
      return {
        status: result.status,
        errorCode: stepError ?? failedPayload?.errorCode,
        probed: steps.filter((s) => s.nodeId === 'n_pick').map((s) => s.actionRef.consId),
      };
    }

    const ok = await runPick(compatible);
    expect(ok.status).toBe('completed');
    expect(ok.probed).toEqual(['test.content']);
    const bad = await runPick(incompatible);
    expect(bad.status).toBe('failed');
    expect(bad.errorCode).toBe('unauthorized_action');
    expect(bad.probed).toEqual([]);
  });
});

describe('low-level interface hardening', () => {
  let dir: string;
  let store: ConsStoreApi;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-low-'));
    store = openStore(join(dir, 't.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createEdge rejects unknown endpoint revisions with unknown_reference', async () => {
    await store.createCons({
      consId: 'low.a',
      title: 'a',
      roles: ['object'],
      body: '',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: 'low.a' });
    await expect(
      store.createEdge({
        from: { consId: 'low.a', revision: 99 },
        relationConsId: 'low.a',
        to: { consId: 'low.a', revision: 1 },
        status: 'active',
      }),
    ).rejects.toThrow(/unknown_reference/);
    await expect(
      store.createEdge({
        from: { consId: 'low.a', revision: 1.5 },
        relationConsId: 'low.a',
        to: { consId: 'low.a', revision: 1 },
        status: 'active',
      }),
    ).rejects.toThrow(/unknown_reference/);
    const edge = await store.createEdge({
      from: { consId: 'low.a', revision: 1 },
      relationConsId: 'low.a',
      to: { consId: 'low.a', revision: 1 },
      status: 'active',
    });
    expect(edge.id).toBeTruthy();
  });

  it('concurrent bare connect replays collapse to one edge set through the in-transaction cache read', async () => {
    const seeded = await makeStore();
    try {
      const input = {
        formed: [{ tempId: 't1', consRef: { consId: 'low.draft', revision: 1 } }],
        edges: [{ from: 't1', relationConsId: 'rel.describes', to: { consId: 'seed.classify', revision: 1 } }],
        activate: false,
      };
      await seeded.store.createCons({
        consId: 'low.draft',
        title: '草稿',
        roles: ['object'],
        body: '',
        aliases: [],
        searchTerms: [],
        provenance: { source: 'human', sourceRefs: [] },
      }, { stableId: 'low.draft' });
      const ctxA = makeCtx(seeded.store, input, 'run-low-a');
      const ctxB = makeCtx(seeded.store, input, 'run-low-a');
      const connect = createPrimitives()['connect'];
      const [outA, outB] = await Promise.all([
        connect?.run(ctxA, ctxA.step.id),
        connect?.run(ctxB, ctxA.step.id),
      ]);
      expect(outA).toEqual(outB);
      const edges = await seeded.store.listEdges('low.draft', 'from', false);
      expect(edges.filter((e) => e.relationConsId === 'rel.describes')).toHaveLength(1);
    } finally {
      seeded.store.close();
    }
  });
});
