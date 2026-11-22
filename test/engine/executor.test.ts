import { beforeEach, describe, expect, it } from 'vitest';
import { executeRun, STATE_KEY_CANDIDATES } from '../../src/engine/executor.js';
import type { EngineDeps, StepContext } from '../../src/engine/executor.js';
import type { LlmAttemptLog, LlmAttemptRow } from '../../src/engine/llm_log.js';
import { createMockLlm, createScriptedLlm } from '../../src/llm/mock.js';
import type { ActionSpec, LlmAdapter, Step } from '../../src/types.js';
import {
  FakeStore, actionSpec, makeRun, makeNode, seedAction, seedFlow, seedMethod, seedTendency, selectOutputSchema,
} from './helpers.js';

class FakeLlmLog {
  rows: LlmAttemptRow[] = [];
  async insert(row: LlmAttemptRow): Promise<void> {
    this.rows.push(row);
  }
  async getLastSuccess(stepId: string): Promise<LlmAttemptRow | null> {
    const found = this.rows.filter((r) => r.stepId === stepId && r.errorCode === null);
    return found.at(-1) ?? null;
  }
  asLog(): LlmAttemptLog {
    return this as unknown as LlmAttemptLog;
  }
}

async function seedRelationType(store: FakeStore, id: string): Promise<void> {
  await store.createCons({
    title: id,
    roles: ['relation_type'],
    body: '',
    aliases: [],
    searchTerms: [],
    provenance: { source: 'seed', sourceRefs: [] },
  }, { stableId: id });
}

const artifactsOutput = {
  type: 'object',
  properties: {
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tempId: { type: 'string' }, kind: { type: 'string' }, content: {} },
        required: ['tempId', 'kind', 'content'],
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: { fromTempId: { type: 'string' }, relationConsId: { type: 'string' }, toTempId: { type: 'string' } },
        required: ['fromTempId', 'relationConsId', 'toTempId'],
      },
    },
    executionSummary: { type: 'string' },
  },
  required: ['artifacts', 'links', 'executionSummary'],
} as object;

const linkedOutput = {
  artifacts: [
    { tempId: 'a1', kind: 'object', content: { title: '对象 A' } },
    { tempId: 'a2', kind: 'proposition', content: { text: '命题' } },
  ],
  links: [{ fromTempId: 'a2', relationConsId: 'rel.describes', toTempId: 'a1' }],
  executionSummary: '生成了对象与关系。',
};

async function setupContentHarness(llm: LlmAdapter, seedRelation: boolean): Promise<{ deps: EngineDeps; store: FakeStore; runId: string }> {
  const store = new FakeStore();
  if (seedRelation) {
    await seedRelationType(store, 'rel.describes');
  }
  await seedAction(store, 'test.decompose', actionSpec({
    executor: 'llm',
    inputSchema: { type: 'object' },
    outputSchema: artifactsOutput,
    defaultMethodId: 'm.decompose.default',
  }));
  await seedMethod(store, 'test.decompose', 'm.decompose.default');
  const flowRef = await seedFlow(store, 'flow.content', {
    kind: 'flow',
    entry: 'n_dec',
    nodes: {
      n_dec: makeNode({
        actionId: 'test.decompose',
        outputKey: 'result',
        inputBindings: {
          input: { source: 'literal', value: { text: '语料' } },
          task: { source: 'run' as const, path: 'task' },
        },
        next: 'n_end',
      }),
      n_end: makeNode({ outputKey: 'done', terminal: true }),
    },
  });
  const run = makeRun('run-content', flowRef, '处理语料');
  await store.createRun(run);
  const deps: EngineDeps = { store: store.asApi(), llm, primitives: {} };
  return { deps, store, runId: run.id };
}

const CANDIDATES = [
  { ref: { consId: 'seed.decompose', revision: 1 }, title: '拆解', roles: ['action' as const], summary: '拆解为对象与关系' },
  { ref: { consId: 'seed.classify', revision: 1 }, title: '属于', roles: ['action' as const], summary: '归属候选命题' },
];

const selectedOutput = {
  status: 'selected',
  selected: { consId: 'seed.decompose', revision: 1 },
  usedTendencies: [],
  basisSummary: '组织句子成分',
  usedDefaultFreedom: true,
};

async function setupHarness(llm: LlmAdapter, budgetOverrides?: Partial<{ maxSteps: number; maxLlmCalls: number }>): Promise<{ deps: EngineDeps; store: FakeStore; runId: string }> {
  const store = new FakeStore();
  await seedAction(store, 'test.search', actionSpec({
    executor: 'primitive',
    primitiveKey: 'stub_search',
    allowedEffects: ['read'],
    outputSchema: { type: 'array' },
  }));
  await seedAction(store, 'test.select', actionSpec({
    executor: 'llm',
    allowedEffects: ['return_artifacts'],
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    outputSchema: selectOutputSchema,
    defaultMethodId: 'm.select.default',
  }));
  await seedAction(store, 'test.noop', actionSpec({ executor: 'primitive', primitiveKey: 'noop' }));
  await seedMethod(store, 'test.select', 'm.select.default');
  const flowRef = await seedFlow(store, 'flow.min', {
    kind: 'flow',
    entry: 'n_search',
    nodes: {
      n_search: makeNode({ actionId: 'test.search', outputKey: STATE_KEY_CANDIDATES, next: 'n_select' }),
      n_select: makeNode({
        actionId: 'test.select',
        outputKey: 'selection',
        inputBindings: { task: { source: 'run' as const, path: 'task' } },
        transitions: [
          { field: 'status', equals: 'selected', next: 'n_end' },
          { field: 'status', equals: 'no_candidate', next: 'n_end' },
        ],
      }),
      n_end: makeNode({ actionId: 'test.noop', outputKey: 'done', terminal: true }),
    },
  });
  const run = makeRun('run-1', flowRef, '处理语料', budgetOverrides);
  await store.createRun(run);
  const primitives = {
    stub_search: {
      async run(): Promise<unknown> {
        return CANDIDATES;
      },
    },
    noop: {
      async run(): Promise<unknown> {
        return {};
      },
    },
  };
  const deps: EngineDeps = { store: store.asApi(), llm, primitives };
  return { deps, store, runId: run.id };
}

describe('executeRun happy path', () => {
  it('runs the full flow with a mock llm', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    const stored = await store.getRun(runId);
    expect(stored?.status).toBe('completed');
    const selection = (stored?.state['selection'] as { status: string; selected: { consId: string } }).selected;
    expect(selection.consId).toBe('seed.decompose');
    const steps = await store.listSteps(runId);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(steps.find((s) => s.nodeId === 'n_select')?.methodRef?.consId).toBe('m.select.default');
    const types = (await store.listEvents(runId)).map((e) => e.eventType);
    expect(types).toContain('run_started');
    expect(types).toContain('llm_called');
    expect(types).toContain('step_succeeded');
    expect(types).toContain('run_finished');
    expect(llm.calls).toHaveLength(1);
    const userPrompt = llm.calls[0]?.userPrompt ?? '';
    expect(userPrompt).toContain('seed.decompose');
    expect(userPrompt).toContain('instructions of m.select.default');
    expect(userPrompt).toContain('处理语料');
  });
});

describe('GET /runs/:id currentNode semantics (§15)', () => {
  it('marks the next node id in the step commit transaction and clears it on completion', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    const afterSearch = store.statePatches.find((s) => s['candidates'] !== undefined);
    expect(afterSearch?.['_currentNode']).toBe('n_select');
    const stored = await store.getRun(runId);
    expect(stored?.state['_currentNode']).toBeNull();
  });
});

describe('candidate and tendency authorization', () => {
  it('rejects a selection outside the candidate set', async () => {
    const llm = createMockLlm(() => ({
      ...selectedOutput,
      selected: { consId: 'evil.action', revision: 1 },
    }));
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const steps = await store.listSteps(runId);
    const selectStep: Step | undefined = steps.find((s) => s.nodeId === 'n_select');
    expect(selectStep?.status).toBe('failed');
    expect(selectStep?.errorCode).toBe('unauthorized_action');
    expect(llm.calls).toHaveLength(1);
  });

  it('rejects a pinned revision that differs from the candidate revision', async () => {
    const llm = createMockLlm(() => ({
      ...selectedOutput,
      selected: { consId: 'seed.decompose', revision: 99 },
    }));
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('unauthorized_action');
  });

  it('rejects usedTendencies outside the provided tendencies', async () => {
    const llm = createMockLlm(() => ({ ...selectedOutput, usedTendencies: ['ghost.tendency'] }));
    const { deps, store, runId } = await setupHarness(llm);
    await seedTendency(store, 't.real');
    const stored = await store.getRun(runId);
    if (stored !== null) {
      stored.state = { tendencyRefs: [{ consId: 't.real', revision: 1 }] };
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('unauthorized_action');
  });

  it('accepts usedTendencies drawn from the provided tendencies', async () => {
    const llm = createMockLlm(() => ({ ...selectedOutput, usedTendencies: ['t.real'] }));
    const { deps, runId, store } = await setupHarness(llm);
    await seedTendency(deps.store as unknown as FakeStore, 't.real');
    const fakeStore = deps.store as unknown as FakeStore;
    const stored = await fakeStore.getRun(runId);
    if (stored !== null) {
      stored.state = { tendencyRefs: [{ consId: 't.real', revision: 1 }] };
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    const events = await fakeStore.listEvents(runId);
    const selection = events.find((e) => e.eventType === 'selection_made');
    const payload = selection?.payload as { usedTendencies: string[]; usedTendencyRefs: Array<{ consId: string; revision: number }> };
    expect(payload.usedTendencies).toEqual(['t.real']);
    expect(payload.usedTendencyRefs).toEqual([{ consId: 't.real', revision: 1 }]);
  });
});

describe('repair and retry limits', () => {
  it('performs at most one repair call then fails on invalid json', async () => {
    const llm = createScriptedLlm(['not json', 'still not json']);
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('invalid_json');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.userPrompt).toContain('invalid_json');
  });

  it('recovers when the repair call returns valid output', async () => {
    const llm = createScriptedLlm(['not json', selectedOutput]);
    const { deps, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    expect(llm.calls).toHaveLength(2);
  });

  it('fails with schema_mismatch after one failed repair', async () => {
    const bad = { status: 'selected', usedTendencies: [], basisSummary: 'x' };
    const llm = createScriptedLlm([bad, bad]);
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('schema_mismatch');
    expect(llm.calls).toHaveLength(2);
  });

  it('retries network failures with backoff and then fails with model_unavailable', async () => {
    const llm = createScriptedLlm([new Error('net1'), new Error('net2'), new Error('net3')]);
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('model_unavailable');
    expect(llm.calls).toHaveLength(3);
    expect(run.counters.llmCalls).toBe(3);
  });
});

describe('budget enforcement', () => {
  it('stops with budget_exhausted when maxLlmCalls is zero', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm, { maxLlmCalls: 0 });
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('budget_exhausted');
    const types = (await store.listEvents(runId)).map((e) => e.eventType);
    expect(types).toContain('budget_exhausted');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('budget_exhausted');
    expect(llm.calls).toHaveLength(0);
  });

  it('stops with budget_exhausted when maxSteps is reached', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm, { maxSteps: 1 });
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('budget_exhausted');
    const types = (await store.listEvents(runId)).map((e) => e.eventType);
    expect(types).toContain('budget_exhausted');
    const steps = await store.listSteps(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('succeeded');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('recovery', () => {
  it('does not call the llm again for already succeeded steps', async () => {
    const first = createMockLlm(() => selectedOutput);
    const h1 = await setupHarness(first);
    const run1 = await executeRun(h1.deps, h1.runId);
    expect(run1.status).toBe('completed');
    expect(first.calls).toHaveLength(1);

    const second = createScriptedLlm([]);
    const deps: EngineDeps = { store: h1.store.asApi(), llm: second, primitives: h1.deps.primitives };
    const run2 = await executeRun(deps, h1.runId);
    expect(run2.status).toBe('completed');
    expect(second.calls).toHaveLength(0);
    const events = await h1.store.listEvents(h1.runId);
    expect(events.filter((e) => e.eventType === 'run_started')).toHaveLength(1);
  });

  it('rebuilds state so the flow continues from the next unfinished node', async () => {
    const llm = createScriptedLlm([]);
    const { deps, store, runId } = await setupHarness(llm);
    const stored = await store.getRun(runId);
    if (stored !== null) {
      stored.state = { candidates: CANDIDATES, selection: selectedOutput };
    }
    await store.upsertStep({
      id: `${runId}::n_search`,
      runId,
      nodeId: 'n_search',
      actionRef: { consId: 'test.search', revision: 1 },
      tendencyRefs: [],
      input: { task: '处理语料' },
      status: 'succeeded',
      output: CANDIDATES,
      llmAttemptCount: 0,
    });
    await store.upsertStep({
      id: `${runId}::n_select`,
      runId,
      nodeId: 'n_select',
      actionRef: { consId: 'test.select', revision: 1 },
      methodRef: { consId: 'm.select.default', revision: 1 },
      tendencyRefs: [],
      input: { task: '处理语料' },
      status: 'succeeded',
      output: selectedOutput,
      llmAttemptCount: 1,
    });
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    expect(llm.calls).toHaveLength(0);
    const steps = await store.listSteps(runId);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
  });
});

describe('version pinning', () => {
  it('keeps the pinned action revision even when a new revision appears mid-step', async () => {
    const captured: Array<{ revision: number; body: string }> = [];
    const store = new FakeStore();
    await seedAction(store, 'test.probe', actionSpec({ executor: 'primitive', primitiveKey: 'probe' }), 'v1 body');
    await seedAction(store, 'test.noop', actionSpec({ executor: 'primitive', primitiveKey: 'noop2' }));
    const flowRef = await seedFlow(store, 'flow.pin', {
      kind: 'flow',
      entry: 'n_probe',
      nodes: {
        n_probe: makeNode({ actionId: 'test.probe', outputKey: 'probed', next: 'n_end' }),
        n_end: makeNode({ actionId: 'test.noop', outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-pin', flowRef, 't');
    await store.createRun(run);
    const primitives = {
      noop2: {
        async run(): Promise<unknown> {
          return {};
        },
      },
      probe: {
        async run(ctx: StepContext): Promise<unknown> {
          captured.push({ revision: ctx.envelope.action.ref.revision, body: ctx.envelope.action.body });
          await ctx.store.createRevision('test.probe', {
            title: 'test.probe',
            roles: ['action'],
            body: 'v2 body',
            aliases: [],
            searchTerms: [],
            spec: actionSpec({ executor: 'primitive', primitiveKey: 'probe' }),
            provenance: { source: 'human', sourceRefs: [] },
          });
          return {};
        },
      },
    };
    const deps: EngineDeps = { store: store.asApi(), llm: createScriptedLlm([]), primitives };
    const result = await executeRun(deps, 'run-pin');
    expect(result.status).toBe('completed');
    expect(captured).toEqual([{ revision: 1, body: 'v1 body' }]);
    const cons = await store.getCons('test.probe');
    expect(cons?.currentRevision).toBe(2);
  });
});

describe('resolveAction failures', () => {
  it('fails with missing_binding when the action has no active binding', async () => {
    const store = new FakeStore();
    await seedAction(store, 'test.noop', actionSpec({ executor: 'primitive', primitiveKey: 'noop' }));
    await seedAction(store, 'test.unbound', actionSpec({ executor: 'llm' }));
    await store.upsertExecutionBinding({ consId: 'test.unbound', revision: 1, executor: 'llm', active: false, activatedByStepId: 'seed' });
    const flowRef = await seedFlow(store, 'flow.unbound', {
      kind: 'flow',
      entry: 'n1',
      nodes: {
        n1: makeNode({ actionId: 'test.unbound', outputKey: 'o', next: 'n_end' }),
        n_end: makeNode({ actionId: 'test.noop', outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-unbound', flowRef, 't');
    await store.createRun(run);
    const deps: EngineDeps = { store: store.asApi(), llm: createScriptedLlm([]), primitives: {} };
    const result = await executeRun(deps, 'run-unbound');
    expect(result.status).toBe('failed');
    const events = await store.listEvents('run-unbound');
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('missing_binding');
  });

  it('fails with unauthorized_action when actionFrom does not reference an authorized selection', async () => {
    const { deps, store, runId } = await setupHarness(createScriptedLlm([]));
    const stored = await store.getRun(runId);
    if (stored !== null) {
      stored.state = { candidates: CANDIDATES, fakePick: { consId: 'seed.decompose', revision: 1 } };
    }
    const flow = await store.getRevision('flow.min');
    if (flow?.spec !== undefined && flow.spec.kind === 'flow') {
      flow.spec.nodes['n_select'] = makeNode({
        actionFrom: 'fakePick',
        outputKey: 'selection',
        inputBindings: { task: { source: 'run' as const, path: 'task' } },
        next: 'n_end',
      });
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const events = await store.listEvents(runId);
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('unauthorized_action');
  });
});

describe('input validation', () => {
  beforeEach(() => {
    return Promise.resolve();
  });

  it('fails with schema_mismatch when bound input violates the action input schema', async () => {
    const { deps, store, runId } = await setupHarness(createScriptedLlm([]));
    const stored = await store.getRun(runId);
    if (stored !== null) {
      stored.state = { candidates: CANDIDATES };
    }
    const flow = await store.getRevision('flow.min');
    if (flow?.spec !== undefined && flow.spec.kind === 'flow') {
      flow.spec.nodes['n_select'] = makeNode({
        actionId: 'test.select',
        outputKey: 'selection',
        next: 'n_end',
        inputBindings: { task: { source: 'state' as const, path: 'candidates' } },
      });
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const events = await store.listEvents(runId);
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('schema_mismatch');
  });
});

describe('§7.4 allowed relation types', () => {
  it('rejects links whose relationConsId is not an active relation type with unauthorized_effect', async () => {
    const llm = createMockLlm(() => linkedOutput);
    const { deps, store, runId } = await setupContentHarness(llm, false);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_dec');
    expect(selectStep?.errorCode).toBe('unauthorized_effect');
  });

  it('accepts links whose relationConsId is an active relation type', async () => {
    const llm = createMockLlm(() => linkedOutput);
    const { deps, runId } = await setupContentHarness(llm, true);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
  });
});

describe('§5.1 actionFrom revision pinning', () => {
  async function setupDrift(activateRev2: boolean): Promise<{ deps: EngineDeps; store: FakeStore; captured: Array<{ revision: number; body: string }> }> {
    const store = new FakeStore();
    await seedAction(store, 'test.pick', actionSpec({ executor: 'primitive', primitiveKey: 'probe' }), 'v1 body');
    await seedAction(store, 'test.noop', actionSpec({ executor: 'primitive', primitiveKey: 'noop' }));
    const flowRef = await seedFlow(store, 'flow.drift', {
      kind: 'flow',
      entry: 'n_bump',
      nodes: {
        n_bump: makeNode({ actionId: 'test.noop', outputKey: 'bumped', next: 'n_pick' }),
        n_pick: makeNode({
          actionFrom: 'pick',
          outputKey: 'picked',
          inputBindings: {},
          next: 'n_end',
        }),
        n_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-drift', flowRef, 't');
    run.state = { pick: { consId: 'test.pick', revision: 1, authorized: true } };
    await store.createRun(run);
    await store.upsertStep({
      id: 'run-drift::n_seed',
      runId: 'run-drift',
      nodeId: 'n_seed',
      actionRef: { consId: 'test.select', revision: 1 },
      tendencyRefs: [],
      input: {},
      status: 'succeeded',
      output: { status: 'selected', selected: { consId: 'test.pick', revision: 1 } },
      llmAttemptCount: 0,
    });
    await store.putRunAuthorization('run-drift', 'pick', {
      stepId: 'run-drift::n_seed',
      consId: 'test.pick',
      revision: 1,
      title: 'test.pick',
      candidates: [{ consId: 'test.pick', revision: 1 }],
    });
    const captured: Array<{ revision: number; body: string }> = [];
    const primitives = {
      noop: {
        async run(ctx: StepContext): Promise<unknown> {
          await ctx.store.createRevision('test.pick', {
            title: 'test.pick',
            roles: ['action'],
            body: 'v2 body',
            aliases: [],
            searchTerms: [],
            spec: actionSpec({ executor: 'primitive', primitiveKey: 'probe' }),
            provenance: { source: 'human', sourceRefs: [] },
          });
          if (activateRev2) {
            await ctx.store.upsertExecutionBinding({
              consId: 'test.pick',
              revision: 2,
              executor: 'primitive',
              primitiveKey: 'probe',
              active: true,
              activatedByStepId: 'seed',
            });
          }
          return {};
        },
      },
      probe: {
        async run(ctx: StepContext): Promise<unknown> {
          captured.push({ revision: ctx.envelope.action.ref.revision, body: ctx.envelope.action.body });
          return {};
        },
      },
    };
    const deps: EngineDeps = { store: store.asApi(), llm: createScriptedLlm([]), primitives };
    return { deps, store, captured };
  }

  it('executes the pinned revision when a newer revision exists but the pinned binding stays active', async () => {
    const { deps, captured } = await setupDrift(false);
    const result = await executeRun(deps, 'run-drift');
    expect(result.status).toBe('completed');
    expect(captured).toEqual([{ revision: 1, body: 'v1 body' }]);
  });

  it('fails with missing_binding when activating rev2 deactivated the pinned rev1 binding', async () => {
    const { deps, store, captured } = await setupDrift(true);
    const result = await executeRun(deps, 'run-drift');
    expect(result.status).toBe('failed');
    expect(captured).toEqual([]);
    const events = await store.listEvents('run-drift');
    const failed = events.find((e) => e.eventType === 'step_failed');
    const payload = failed?.payload as { errorCode: string; message: string };
    expect(payload.errorCode).toBe('missing_binding');
    expect(payload.message).toContain('test.pick@1');
    const binding = await store.getExecutionBinding('test.pick', 1);
    expect(binding).not.toBeNull();
    expect(binding?.active).toBe(false);
  });
});

describe('§5 rule 4 branch field validation', () => {
  it('fails with schema_mismatch when a transition references an undeclared output field', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm);
    const flow = await store.getRevision('flow.min');
    if (flow?.spec !== undefined && flow.spec.kind === 'flow') {
      flow.spec.nodes['n_select'] = makeNode({
        actionId: 'test.select',
        outputKey: 'selection',
        inputBindings: { task: { source: 'run' as const, path: 'task' } },
        transitions: [{ field: 'ghostField', equals: 'x', next: 'n_end' }],
      });
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const selectStep = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_select');
    expect(selectStep?.errorCode).toBe('schema_mismatch');
    const events = await store.listEvents(runId);
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { message: string }).message).toContain('not declared');
  });

  it('still evaluates boolean branches on declared fields', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm);
    const flow = await store.getRevision('flow.min');
    if (flow?.spec !== undefined && flow.spec.kind === 'flow') {
      flow.spec.nodes['n_select'] = makeNode({
        actionId: 'test.select',
        outputKey: 'selection',
        inputBindings: { task: { source: 'run' as const, path: 'task' } },
        transitions: [
          { field: 'usedDefaultFreedom', equals: true, next: 'n_alt' },
        ],
        next: 'n_end',
      });
      flow.spec.nodes['n_alt'] = makeNode({ actionId: 'test.noop', outputKey: 'alt', next: 'n_end' });
    }
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    const steps = await store.listSteps(runId);
    expect(steps.some((s) => s.nodeId === 'n_alt')).toBe(true);
  });
});

describe('§9.3 no default method', () => {  it('fails with missing_binding when an llm action has no default method and no verified selection', async () => {
    const store = new FakeStore();
    const llm = createScriptedLlm([]);
    await seedAction(store, 'test.orphan', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }));
    const flowRef = await seedFlow(store, 'flow.orphan', {
      kind: 'flow',
      entry: 'n1',
      nodes: {
        n1: makeNode({ actionId: 'test.orphan', outputKey: 'o', next: 'n_end' }),
        n_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-orphan', flowRef, 't');
    await store.createRun(run);
    const deps: EngineDeps = { store: store.asApi(), llm, primitives: {} };
    const result = await executeRun(deps, 'run-orphan');
    expect(result.status).toBe('failed');
    const events = await store.listEvents('run-orphan');
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('missing_binding');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('§4.1 selection_made covers no_candidate', () => {
  it('records selection_made with selected null for a no_candidate output', async () => {
    const llm = createMockLlm(() => ({
      status: 'no_candidate',
      selected: null,
      usedTendencies: [],
      basisSummary: '当前候选集中没有可用动作。',
      usedDefaultFreedom: false,
    }));
    const { deps, store, runId } = await setupHarness(llm);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    const events = await store.listEvents(runId);
    const selections = events.filter((e) => e.eventType === 'selection_made');
    expect(selections).toHaveLength(1);
    const payload = selections[0]?.payload as { selected: unknown; basisSummary: string; candidates: unknown[]; usedTendencies: string[]; usedTendencyRefs: unknown[] };
    expect(payload.selected).toBeNull();
    expect(payload.basisSummary).toBe('当前候选集中没有可用动作。');
    expect(payload.candidates).toHaveLength(2);
    expect(payload.usedTendencies).toEqual([]);
    expect(payload.usedTendencyRefs).toEqual([]);
  });
});

describe('§4.1/§12 llm_attempts logging', () => {
  it('persists each attempt and enriches the llm_called event payload', async () => {
    const llm = createMockLlm(() => selectedOutput);
    const { deps, store, runId } = await setupHarness(llm);
    const log = new FakeLlmLog();
    const depsWithLog: EngineDeps = { ...deps, llmLog: log.asLog() };
    const run = await executeRun(depsWithLog, runId);
    expect(run.status).toBe('completed');
    expect(log.rows).toHaveLength(1);
    const row = log.rows[0];
    expect(row?.stepId).toBe(`${runId}::n_select`);
    expect(row?.attemptNo).toBe(1);
    expect(row?.model).toBe('mock');
    expect(row?.errorCode).toBeNull();
    expect(JSON.stringify(row?.response)).toContain('seed.decompose');
    const request = row?.request as { maxOutputTokens: number; systemPrompt: string };
    expect(request.maxOutputTokens).toBe(4096);
    expect(request.systemPrompt).toContain('mindSpace');
    const events = await store.listEvents(runId);
    const called = events.find((e) => e.eventType === 'llm_called');
    const payload = called?.payload as Record<string, unknown>;
    expect(payload['promptTemplateVersion']).toBe('v1');
    expect(payload['model']).toBe('mock');
    expect(payload['maxOutputTokens']).toBe(4096);
    expect(payload['stepId']).toBe(`${runId}::n_select`);
    expect(payload['attemptNo']).toBe(1);
    expect(payload['latencyMs']).toBe(0);
  });

  it('records error rows for failed attempts', async () => {
    const llm = createScriptedLlm([new Error('net down'), new Error('net down'), new Error('net down')]);
    const { deps, runId } = await setupHarness(llm);
    const log = new FakeLlmLog();
    const depsWithLog: EngineDeps = { ...deps, llmLog: log.asLog() };
    const run = await executeRun(depsWithLog, runId);
    expect(run.status).toBe('failed');
    expect(log.rows).toHaveLength(3);
    expect(log.rows.every((r) => r.errorCode === 'model_unavailable')).toBe(true);
  });
});

describe('§14.3 recovery of persisted llm responses', () => {
  it('revalidates and commits the persisted response without resending', async () => {
    const first = createMockLlm(() => selectedOutput);
    const h = await setupHarness(first);
    const log = new FakeLlmLog();
    const deps1: EngineDeps = { ...h.deps, llmLog: log.asLog() };
    const run1 = await executeRun(deps1, h.runId);
    expect(run1.status).toBe('completed');

    const step = await h.store.getStep(h.runId, 'n_select');
    expect(step).not.toBeNull();
    if (step !== null) {
      await h.store.upsertStep({ ...step, status: 'running' });
    }
    const stored = await h.store.getRun(h.runId);
    if (stored !== null) {
      const state = { ...stored.state } as Record<string, unknown>;
      delete state['selection'];
      stored.state = state;
    }

    const second = createMockLlm((): unknown => {
      throw new Error('must not be called');
    });
    const deps2: EngineDeps = { store: h.store.asApi(), llm: second, primitives: h.deps.primitives, llmLog: log.asLog() };
    const run2 = await executeRun(deps2, h.runId);
    expect(run2.status).toBe('completed');
    expect(second.calls).toHaveLength(0);
    const events = await h.store.listEvents(h.runId);
    expect(events.some((e) => e.eventType === 'llm_response_recovered')).toBe(true);
    const steps = await h.store.listSteps(h.runId);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
  });
});

describe('subflow budget sharing', () => {
  async function setupSubflowHarness(
    llm: LlmAdapter,
    budget: Partial<{ maxSteps: number; maxLlmCalls: number }>,
  ): Promise<{ deps: EngineDeps; store: FakeStore; runId: string }> {
    const store = new FakeStore();
    await seedAction(store, 'test.fill', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultMethodId: 'm.fill.default',
    }));
    await seedMethod(store, 'test.fill', 'm.fill.default');
    const subFlowRef = await seedFlow(store, 'flow.sub', {
      kind: 'flow',
      entry: 's_fill',
      nodes: {
        s_fill: makeNode({
          actionId: 'test.fill',
          outputKey: 'filled',
          inputBindings: { input: { source: 'literal', value: {} } },
          next: 's_end',
        }),
        s_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const subActionSpec: ActionSpec = {
      kind: 'action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      executor: 'flow',
      flowRef: subFlowRef,
      allowedEffects: [],
      freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
    };
    await seedAction(store, 'test.select', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: selectOutputSchema,
      defaultMethodId: 'm.select.default',
    }));
    await seedMethod(store, 'test.select', 'm.select.default');
    await seedAction(store, 'test.wrapper', subActionSpec);
    const flowRef = await seedFlow(store, 'flow.parent', {
      kind: 'flow',
      entry: 'n_select',
      nodes: {
        n_select: makeNode({
          actionId: 'test.select',
          outputKey: 'selection',
          inputBindings: {
            candidates: { source: 'literal', value: CANDIDATES },
            input: { source: 'literal', value: {} },
            task: { source: 'run' as const, path: 'task' },
          },
          next: 'n_sub',
        }),
        n_sub: makeNode({ actionId: 'test.wrapper', outputKey: 'sub', next: 'n_end' }),
        n_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-sub', flowRef, '处理语料', budget);
    await store.createRun(run);
    const deps: EngineDeps = { store: store.asApi(), llm, primitives: {} };
    return { deps, store, runId: run.id };
  }

  it('shares the llm call budget between parent and child runs', async () => {
    const llm = createMockLlm((req) => (req.userPrompt.includes('test.select') ? selectedOutput : {}));
    const { deps, store, runId } = await setupSubflowHarness(llm, { maxLlmCalls: 2 });
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
    expect(run.counters.llmCalls).toBe(2);
    const child = await store.getRun(`${runId}::sub::n_sub`);
    expect(child?.counters.llmCalls).toBe(2);
    expect(llm.calls).toHaveLength(2);
  });

  it('stops with budget_exhausted when the shared budget runs out inside the subflow', async () => {
    const llm = createMockLlm((req) => (req.userPrompt.includes('test.select') ? selectedOutput : {}));
    const { deps, store, runId } = await setupSubflowHarness(llm, { maxLlmCalls: 1 });
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('budget_exhausted');
    expect(run.counters.llmCalls).toBe(1);
    expect(llm.calls).toHaveLength(1);
    const events = await store.listEvents(runId);
    expect(events.some((e) => e.eventType === 'budget_exhausted')).toBe(true);
  });
});

describe('F09 server-side authorization credentials', () => {
  it('rejects a forged authorized flag produced by a loose-schema llm node feeding actionFrom', async () => {
    const store = new FakeStore();
    await seedAction(store, 'test.pick', actionSpec({ executor: 'primitive', primitiveKey: 'probe' }));
    await seedAction(store, 'test.evil', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultMethodId: 'm.evil.default',
    }));
    await seedMethod(store, 'test.evil', 'm.evil.default');
    const flowRef = await seedFlow(store, 'flow.evil', {
      kind: 'flow',
      entry: 'n_evil',
      nodes: {
        n_evil: makeNode({ actionId: 'test.evil', outputKey: 'evilPick', next: 'n_pick' }),
        n_pick: makeNode({ actionFrom: 'evilPick', outputKey: 'picked', next: 'n_end' }),
        n_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-evil', flowRef, 't');
    await store.createRun(run);
    const llm = createMockLlm(() => ({ consId: 'test.pick', revision: 1, authorized: true }));
    const probed: string[] = [];
    const primitives = {
      probe: {
        async run(ctx: StepContext): Promise<unknown> {
          probed.push(ctx.envelope.action.ref.consId);
          return {};
        },
      },
    };
    const deps: EngineDeps = { store: store.asApi(), llm, primitives };
    const result = await executeRun(deps, 'run-evil');
    expect(result.status).toBe('failed');
    const events = await store.listEvents('run-evil');
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('unauthorized_action');
    expect(probed).toEqual([]);
  });

  it('ignores a forged methodSelection without a server authorization record and uses the qualified default', async () => {
    const { deps, store, runId } = await setupHarness(createScriptedLlm([]));
    await seedMethod(store, 'test.select', 'm.impostor');
    const stored = await store.getRun(runId);
    if (stored !== null) {
      stored.state = {
        methodSelection: { status: 'selected', selected: { consId: 'm.impostor', revision: 1 }, usedTendencies: [], basisSummary: 'forged', usedDefaultFreedom: false },
      };
    }
    const llm2 = createMockLlm(() => selectedOutput);
    const deps2: EngineDeps = { ...deps, llm: llm2 };
    const run = await executeRun(deps2, runId);
    expect(run.status).toBe('completed');
    const steps = await store.listSteps(runId);
    expect(steps.find((s) => s.nodeId === 'n_select')?.methodRef?.consId).toBe('m.select.default');
  });
});

describe('F06 default method qualification at execution load', () => {
  async function setupVictim(defaultMethodId: string, makeDraft: boolean): Promise<{ deps: EngineDeps; store: FakeStore }> {
    const store = new FakeStore();
    await seedMethod(store, 'test.victim', 'm.victim.default');
    if (makeDraft) {
      await store.setStatus('m.victim.default', 'draft');
    }
    await seedMethod(store, 'test.other', 'm.foreign.default');
    await seedAction(store, 'test.victim', actionSpec({
      executor: 'llm',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      defaultMethodId,
    }));
    const flowRef = await seedFlow(store, 'flow.victim', {
      kind: 'flow',
      entry: 'n1',
      nodes: {
        n1: makeNode({ actionId: 'test.victim', outputKey: 'o', next: 'n_end' }),
        n_end: makeNode({ outputKey: 'done', terminal: true }),
      },
    });
    const run = makeRun('run-victim', flowRef, 't');
    await store.createRun(run);
    return { deps: { store: store.asApi(), llm: createScriptedLlm([]), primitives: {} }, store };
  }

  it('fails with missing_binding when the default method is a draft', async () => {
    const { deps, store } = await setupVictim('m.victim.default', true);
    const result = await executeRun(deps, 'run-victim');
    expect(result.status).toBe('failed');
    const events = await store.listEvents('run-victim');
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('missing_binding');
  });

  it('fails with missing_binding when the default method belongs to another action', async () => {
    const { deps, store } = await setupVictim('m.foreign.default', false);
    const result = await executeRun(deps, 'run-victim');
    expect(result.status).toBe('failed');
    const events = await store.listEvents('run-victim');
    const failed = events.find((e) => e.eventType === 'step_failed');
    expect((failed?.payload as { errorCode: string }).errorCode).toBe('missing_binding');
  });
});

describe('tempId namespace enforcement', () => {
  it('rejects llm outputs whose artifact tempId collides with an existing cons id', async () => {
    const llm = createMockLlm(() => ({
      artifacts: [{ tempId: 'test.decompose', kind: 'object', content: { title: '碰撞对象' } }],
      links: [],
      executionSummary: '输出试图劫持真实 cons id 作为 tempId。',
    }));
    const { deps, store, runId } = await setupContentHarness(llm, true);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('failed');
    const step = (await store.listSteps(runId)).find((s) => s.nodeId === 'n_dec');
    expect(step?.errorCode).toBe('unauthorized_effect');
  });

  it('accepts artifact tempIds that do not collide with any cons id', async () => {
    const llm = createMockLlm(() => ({
      artifacts: [{ tempId: 'fresh-temp-1', kind: 'object', content: { title: '正常对象' } }],
      links: [],
      executionSummary: '正常输出。',
    }));
    const { deps, runId } = await setupContentHarness(llm, true);
    const run = await executeRun(deps, runId);
    expect(run.status).toBe('completed');
  });
});
