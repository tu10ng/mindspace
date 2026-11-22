import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrimitives } from '../../src/primitives/index.js';
import { makeCtx, makeStore } from './helpers.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import type { ConsRef, Run, Step } from '../../src/types.js';

let store: ConsStoreApi;
const RUN_ID = 'run-case';

beforeEach(async () => {
  store = (await makeStore()).store;
});

afterEach(() => {
  store.close();
});

async function seedRunSteps(): Promise<{ inputRef: ConsRef; methodRef: ConsRef }> {
  const run: Run = {
    id: RUN_ID,
    entryFlowRef: { consId: 'app.flow.ingest_main', revision: 1 },
    task: '处理语料',
    inputRefs: [],
    status: 'running',
    budget: { maxSteps: 64, maxLlmCalls: 20, maxOutputTokensPerCall: 4096 },
    counters: { steps: 0, llmCalls: 0 },
    state: {},
  };
  await store.createRun(run);
  for (const id of ['input-cons', 'formed-1']) {
    await store.createCons({
      consId: id,
      title: id,
      roles: ['object'],
      body: '',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'input', sourceRefs: [] },
    }, { stableId: id });
    await store.setStatus(id, 'active');
  }
  const inputRef: ConsRef = { consId: 'input-cons', revision: 1 };
  const methodRef: ConsRef = { consId: 'seed.decompose.default', revision: 1 };
  const steps: Step[] = [
    {
      id: `${RUN_ID}::receive`,
      runId: RUN_ID,
      nodeId: 'receive',
      actionRef: { consId: 'seed.receive', revision: 1 },
      tendencyRefs: [],
      input: { text: '输入句子' },
      status: 'succeeded',
      output: { consRef: inputRef },
      llmAttemptCount: 0,
    },
    {
      id: `${RUN_ID}::select_action`,
      runId: RUN_ID,
      nodeId: 'select_action',
      actionRef: { consId: 'seed.select_action', revision: 1 },
      tendencyRefs: [],
      input: {
        candidates: [
          { ref: { consId: 'seed.decompose', revision: 1 }, title: '拆解' },
          { ref: { consId: 'seed.classify', revision: 1 }, title: '属于' },
        ],
      },
      status: 'succeeded',
      output: {
        status: 'selected',
        selected: { consId: 'seed.decompose', revision: 1 },
        usedTendencies: [],
        basisSummary: '组织句子成分',
        usedDefaultFreedom: true,
      },
      llmAttemptCount: 1,
    },
    {
      id: `${RUN_ID}::select_method`,
      runId: RUN_ID,
      nodeId: 'select_method',
      actionRef: { consId: 'seed.select_method', revision: 1 },
      tendencyRefs: [],
      input: { candidates: [{ ref: methodRef, title: '拆解默认方法' }], defaultMethod: methodRef },
      status: 'succeeded',
      output: {
        status: 'selected',
        selected: methodRef,
        usedTendencies: [],
        basisSummary: '使用默认方法',
        usedDefaultFreedom: true,
      },
      llmAttemptCount: 1,
    },
    {
      id: `${RUN_ID}::execute_action`,
      runId: RUN_ID,
      nodeId: 'execute_action',
      actionRef: { consId: 'seed.decompose', revision: 1 },
      methodRef,
      tendencyRefs: [],
      input: { input: { consRef: inputRef }, task: '处理语料' },
      status: 'succeeded',
      output: { artifacts: [], links: [], executionSummary: '拆解了输入句子。' },
      llmAttemptCount: 1,
    },
    {
      id: `${RUN_ID}::connect_content`,
      runId: RUN_ID,
      nodeId: 'connect_content',
      actionRef: { consId: 'seed.connect', revision: 1 },
      tendencyRefs: [],
      input: { formed: [] },
      status: 'succeeded',
      output: { connected: [{ consId: 'formed-1', revision: 1 }], edges: [] },
      llmAttemptCount: 0,
    },
  ];
  for (const s of steps) {
    await store.upsertStep(s);
  }
  return { inputRef, methodRef };
}

describe('record primitive', () => {
  it('extracts a main-phase case from the event/step log, not from model recall (§10.2)', async () => {
    const { inputRef, methodRef } = await seedRunSteps();
    const ctx = makeCtx(store, { runId: RUN_ID, phase: 'main' });
    const out = (await createPrimitives()['record']?.run(ctx, ctx.step.id)) as { caseRef: ConsRef };
    expect(out.caseRef.revision).toBe(1);
    const cons = await store.getCons(out.caseRef.consId);
    expect(cons?.status).toBe('active');
    const rev = await store.getRevision(out.caseRef.consId, 1);
    expect(rev?.roles).toEqual(['case']);
    const data = JSON.parse(rev?.body ?? '{}') as Record<string, unknown>;
    expect(data['inputRef']).toEqual(inputRef);
    expect(data['selectedAction']).toEqual({ consId: 'seed.decompose', revision: 1 });
    expect(data['selectedMethod']).toEqual(methodRef);
    expect(data['methodExecuted']).toEqual(methodRef);
    expect(data['usedDefaultFreedom']).toBe(true);
    expect(data['artifactRefs']).toEqual([{ consId: 'formed-1', revision: 1 }]);
    expect(data['executionSummary']).toBe('拆解了输入句子。');
    expect(rev?.provenance.source).toBe('execution');
    expect(rev?.provenance.sourceRefs).toEqual([inputRef]);
  });

  it('creates used_method and derived_from edges from the log', async () => {
    const { inputRef, methodRef } = await seedRunSteps();
    const ctx = makeCtx(store, { runId: RUN_ID, phase: 'main' });
    const out = (await createPrimitives()['record']?.run(ctx, ctx.step.id)) as { caseRef: ConsRef };
    const edges = await store.listEdges(out.caseRef.consId, 'from', true);
    expect(edges.some((e) => e.relationConsId === 'rel.used_method' && e.to.consId === methodRef.consId)).toBe(true);
    expect(edges.some((e) => e.relationConsId === 'rel.derived_from' && e.to.consId === inputRef.consId)).toBe(true);
  });

  it('resolves string tendency ids into used_tendency edges', async () => {
    await seedRunSteps();
    await store.createCons({
      consId: 'tend-1',
      title: 'prefer decompose',
      roles: ['tendency'],
      body: '',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'llm', sourceRefs: [] },
    }, { stableId: 'tend-1' });
    await store.setStatus('tend-1', 'active');
    const steps = await store.listSteps(RUN_ID);
    const sel = steps.find((s) => s.nodeId === 'select_action');
    expect(sel).toBeDefined();
    if (sel === undefined) return;
    sel.output = {
      status: 'selected',
      selected: { consId: 'seed.decompose', revision: 1 },
      usedTendencies: ['tend-1'],
      basisSummary: 't',
      usedDefaultFreedom: false,
    };
    await store.upsertStep(sel);
    const ctx = makeCtx(store, { runId: RUN_ID, phase: 'main' });
    const out = (await createPrimitives()['record']?.run(ctx, ctx.step.id)) as { caseRef: ConsRef };
    const edges = await store.listEdges(out.caseRef.consId, 'from', true);
    expect(edges.some((e) => e.relationConsId === 'rel.used_tendency' && e.to.consId === 'tend-1')).toBe(true);
    const rev = await store.getRevision(out.caseRef.consId, 1);
    const data = JSON.parse(rev?.body ?? '{}') as Record<string, unknown>;
    expect(data['usedTendencies']).toEqual([{ consId: 'tend-1', revision: 1 }]);
  });

  it('does not extract a new case for the internalize phase and passes the focus through (§10.5)', async () => {
    await seedRunSteps();
    const focus: ConsRef = { consId: 'main-case', revision: 1 };
    const before = await store.listEvents(RUN_ID, { limit: 1000 });
    const ctx = makeCtx(store, { runId: RUN_ID, phase: 'internalize', focus });
    const out = (await createPrimitives()['record']?.run(ctx, ctx.step.id)) as { caseRef: ConsRef };
    expect(out.caseRef).toEqual(focus);
    const after = await store.listEvents(RUN_ID, { limit: 1000 });
    expect(after.length - before.length).toBe(0);
  });
});
