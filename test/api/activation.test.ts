import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load-main.js';
import { activateConsInTx } from '../../src/primitives/index.js';

let dir: string;
let store: ConsStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ms-activation-'));
  store = openStore(join(dir, 'test.db'));
  await loadSeeds(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createMethod(id: string, actionId: string, body: string): Promise<void> {
  await store.createCons({
    consId: id,
    title: id,
    roles: ['method'],
    body,
    aliases: [],
    searchTerms: [],
    spec: { kind: 'method', actionId, instructions: body, applicabilityText: '' },
    provenance: { source: 'human', sourceRefs: [] },
  }, { stableId: id });
}

describe('F07/F12 shared atomic activation service', () => {
  it('human activation of a method creates the method binding, the method_of edge and the active pointer', async () => {
    await createMethod('hum.method1', 'seed.decompose', '人工专用拆解方法。');
    await store.transaction(async () => {
      await activateConsInTx(store, 'hum.method1', 1, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    const cons = await store.getCons('hum.method1');
    expect(cons?.status).toBe('active');
    expect(cons?.activeRevision).toBe(1);
    const bindings = await store.listActiveMethodBindings('seed.decompose');
    expect(bindings.some((b) => b.methodId === 'hum.method1' && b.methodRevision === 1)).toBe(true);
    const edges = await store.listEdges('hum.method1', 'from', true);
    expect(edges.some((e) => e.relationConsId === 'rel.method_of' && e.to.consId === 'seed.decompose')).toBe(true);
  });

  it('re-activation after a human revision moves the binding to the new revision and reindexes (F05/F12)', async () => {
    await createMethod('hum.method2', 'seed.classify', '人工分类方法第一版。');
    await store.transaction(async () => {
      await activateConsInTx(store, 'hum.method2', 1, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    await store.createRevision('hum.method2', {
      title: 'hum.method2',
      roles: ['method'],
      body: '人工分类方法第二版。',
      aliases: [],
      searchTerms: [],
      spec: { kind: 'method', actionId: 'seed.classify', instructions: '人工分类方法第二版。', applicabilityText: '' },
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.transaction(async () => {
      await activateConsInTx(store, 'hum.method2', 2, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    const bindings = await store.listActiveMethodBindings('seed.classify');
    expect(bindings.find((b) => b.methodId === 'hum.method2')?.methodRevision).toBe(2);
    const cons = await store.getCons('hum.method2');
    expect(cons?.activeRevision).toBe(2);
    const hit = await store.search({ text: '人工分类方法第二版' });
    expect(hit.items.some((i) => i.ref.consId === 'hum.method2' && i.ref.revision === 2)).toBe(true);
  });

  it('leaves no active binding residue when setStatus fails inside the transaction (F07)', async () => {
    const actionId = 'atom.action';
    await store.createCons({
      consId: actionId,
      title: '原子动作',
      roles: ['action'],
      body: '原子性验证用动作。',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'atom.method',
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: actionId });
    await createMethod('atom.method', actionId, '原子激活默认方法。');
    await store.transaction(async () => {
      await activateConsInTx(store, 'atom.method', 1, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    const original = store.setStatus.bind(store);
    store.setStatus = async () => {
      throw new Error('injected setStatus failure');
    };
    await expect(
      store.transaction(async () => {
        await activateConsInTx(store, actionId, 1, { activatedBy: 'human-api' });
      }),
    ).rejects.toThrow('injected setStatus failure');
    store.setStatus = original;
    expect(await store.getActiveExecutionBinding(actionId)).toBeNull();
    expect((await store.getCons(actionId))?.status).toBe('draft');
  });

  it('rejects action drafts whose default method is a draft (F06)', async () => {
    await createMethod('draft.method', 'draft.action', '草稿方法。');
    const actionId = 'draft.action';
    await store.createCons({
      consId: actionId,
      title: '草稿方法动作',
      roles: ['action'],
      body: '默认方法未激活的动作。',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'draft.method',
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: actionId });
    await expect(
      store.transaction(async () => {
        await activateConsInTx(store, actionId, 1, { activatedBy: 'human-api' });
      }),
    ).rejects.toThrow(/is not active/);
    expect(await store.getActiveExecutionBinding(actionId)).toBeNull();
  });

  it('rejects action drafts whose default method belongs to another action (F06)', async () => {
    await createMethod('foreign.method', 'seed.decompose', '属于拆解的方法。');
    await store.transaction(async () => {
      await activateConsInTx(store, 'foreign.method', 1, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    const actionId = 'foreign.action';
    await store.createCons({
      consId: actionId,
      title: '引用他人方法动作',
      roles: ['action'],
      body: '默认方法属于其他动作。',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'foreign.method',
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: actionId });
    await expect(
      store.transaction(async () => {
        await activateConsInTx(store, actionId, 1, { activatedBy: 'human-api' });
      }),
    ).rejects.toThrow(/unauthorized_effect/);
    expect(await store.getActiveExecutionBinding(actionId)).toBeNull();
  });

  it('rejects action drafts using unsupported schema keywords (F10)', async () => {
    const actionId = 'kw.action';
    await store.createCons({
      consId: actionId,
      title: '非法关键字动作',
      roles: ['action'],
      body: '输入 schema 使用 const。',
      aliases: [],
      searchTerms: [],
      spec: {
        kind: 'action',
        inputSchema: { type: 'object', const: 'fixed' },
        outputSchema: { type: 'object' },
        executor: 'llm',
        allowedEffects: ['return_artifacts'],
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethodId: 'kw.method',
      },
      provenance: { source: 'human', sourceRefs: [] },
    }, { stableId: actionId });
    await createMethod('kw.method', actionId, '关键字方法。');
    await store.transaction(async () => {
      await activateConsInTx(store, 'kw.method', 1, { activatedBy: 'human-api' }, { methodBinding: true });
    });
    await expect(
      store.transaction(async () => {
        await activateConsInTx(store, actionId, 1, { activatedBy: 'human-api' });
      }),
    ).rejects.toThrow(/unsupported schema keyword/);
  });
});
