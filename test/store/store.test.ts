import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import type { ConsRevision, ConsRole } from '../../src/types.js';

type RevisionInput = Omit<ConsRevision, 'revision' | 'createdAt'>;

let dir: string;
let store: ConsStoreApi;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-store-'));
  store = openStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function revInput(over: Partial<RevisionInput> = {}): RevisionInput {
  return {
    consId: 'pending',
    title: '测试对象',
    roles: ['object'] as ConsRole[],
    body: '内蒙古高原上的草原，草很高。',
    aliases: ['草原'],
    searchTerms: ['高原'],
    provenance: { source: 'human', sourceRefs: [] },
    ...over,
  };
}

async function makeActiveCons(over: Partial<RevisionInput> = {}): Promise<string> {
  const cons = await store.createCons(revInput(over));
  await store.setStatus(cons.id, 'active');
  return cons.id;
}

describe('cons and revisions', () => {
  it('creates a draft cons with revision 1', async () => {
    const cons = await store.createCons(revInput(), { stableId: 'obj.one' });
    expect(cons.id).toBe('obj.one');
    expect(cons.status).toBe('draft');
    expect(cons.currentRevision).toBe(1);
    const rev = await store.getRevision('obj.one');
    expect(rev?.title).toBe('测试对象');
    expect(rev?.provenance.source).toBe('human');
    expect(rev?.aliases).toEqual(['草原']);
  });

  it('revisions are immutable and current revision advances', async () => {
    const cons = await store.createCons(revInput());
    const rev2 = await store.createRevision(cons.id, {
      title: '修订后的对象',
      roles: ['object'],
      body: '新内容',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [{ consId: cons.id, revision: 1 }] },
    });
    expect(rev2.revision).toBe(2);
    const old = await store.getRevision(cons.id, 1);
    expect(old?.title).toBe('测试对象');
    const latest = await store.getRevision(cons.id);
    expect(latest?.title).toBe('修订后的对象');
    const c = await store.getCons(cons.id);
    expect(c?.currentRevision).toBe(2);
  });
});

describe('edges and bindings', () => {
  it('creates and lists edges with direction and active filters', async () => {
    const a = await makeActiveCons({ consId: 'obj.a', title: '对象A', aliases: [] });
    const b = await makeActiveCons({ consId: 'obj.b', title: '对象B', aliases: [] });
    const rel = await makeActiveCons({ consId: 'obj.rel', title: '描述', roles: ['relation_type'], aliases: [] });
    const edge = await store.createEdge({
      from: { consId: a, revision: 1 },
      relationConsId: rel,
      to: { consId: b, revision: 1 },
      status: 'active',
    });
    expect(edge.id).toBeTruthy();
    expect((await store.listEdges(a, 'from', true)).length).toBe(1);
    expect((await store.listEdges(b, 'to', true)).length).toBe(1);
    expect((await store.listEdges(a, 'both', true)).length).toBe(1);
    await store.createEdge({
      from: { consId: b, revision: 1 },
      relationConsId: rel,
      to: { consId: a, revision: 1 },
      status: 'archived',
    });
    expect((await store.listEdges(b, 'from', true)).length).toBe(0);
    expect((await store.listEdges(b, 'from', false)).length).toBe(1);
  });

  it('keeps a single active execution binding per cons', async () => {
    const id = await makeActiveCons({ title: '动作X', roles: ['action'], aliases: [] });
    await store.upsertExecutionBinding({
      consId: id,
      revision: 1,
      executor: 'primitive',
      primitiveKey: 'receive',
      active: true,
      activatedByStepId: 's1',
    });
    await store.createRevision(id, {
      title: '动作X',
      roles: ['action'],
      body: 'v2',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.upsertExecutionBinding({
      consId: id,
      revision: 2,
      executor: 'primitive',
      primitiveKey: 'receive',
      active: true,
      activatedByStepId: 's2',
    });
    const active = await store.getActiveExecutionBinding(id);
    expect(active?.revision).toBe(2);
    expect(active?.primitiveKey).toBe('receive');
    const pinnedOld = await store.getExecutionBinding(id, 1);
    expect(pinnedOld?.revision).toBe(1);
    expect(pinnedOld?.active).toBe(false);
    const pinnedNew = await store.getExecutionBinding(id, 2);
    expect(pinnedNew?.active).toBe(true);
    expect(await store.getExecutionBinding(id, 99)).toBeNull();
  });

  it('inserts idempotency keys with insert-or-ignore semantics', async () => {
    await store.insertIdempotencyKey('step-1:0');
    await store.insertIdempotencyKey('step-1:0');
    expect(await store.hasIdempotencyKey('step-1:0')).toBe(true);
    expect(await store.hasIdempotencyKey('step-1:1')).toBe(false);
  });

  it('manages method bindings', async () => {
    const action = await makeActiveCons({ consId: 'm.action', title: '拆解', roles: ['action'], aliases: [] });
    const m1 = await makeActiveCons({ consId: 'm.one', title: '方法一', roles: ['method'], aliases: [] });
    const m2 = await makeActiveCons({ consId: 'm.two', title: '方法二', roles: ['method'], aliases: [] });
    await store.setMethodBinding(action, m1, 1, true);
    await store.setMethodBinding(action, m2, 1, false);
    const list = await store.listActiveMethodBindings(action);
    expect(list.length).toBe(1);
    expect(list[0]?.methodId).toBe(m1);
    await store.setMethodBinding(action, m1, 2, true);
    const updated = await store.listActiveMethodBindings(action);
    expect(updated[0]?.methodRevision).toBe(2);
  });
});

describe('runs, steps and events', () => {
  it('round-trips runs, steps and events', async () => {
    const flow = { consId: 'flow.ingest', revision: 1 };
    await store.createRun({
      id: 'run-1',
      entryFlowRef: flow,
      task: '处理语料',
      inputRefs: [],
      status: 'queued',
      budget: { maxSteps: 64, maxLlmCalls: 20, maxOutputTokensPerCall: 4096 },
      counters: { steps: 0, llmCalls: 0 },
      state: {},
    });
    await store.updateRun('run-1', { status: 'running', counters: { steps: 1, llmCalls: 0 }, state: { x: 1 } });
    const run = await store.getRun('run-1');
    expect(run?.status).toBe('running');
    expect(run?.state).toEqual({ x: 1 });

    await store.upsertStep({
      id: 'step-1',
      runId: 'run-1',
      nodeId: 'receive',
      actionRef: { consId: 'seed.receive', revision: 1 },
      tendencyRefs: [],
      input: { text: '你好' },
      status: 'succeeded',
      llmAttemptCount: 0,
    });
    await store.upsertStep({
      id: 'step-1',
      runId: 'run-1',
      nodeId: 'receive',
      actionRef: { consId: 'seed.receive', revision: 1 },
      tendencyRefs: [],
      input: { text: '你好' },
      status: 'succeeded',
      output: { consRef: { consId: 'c1', revision: 1 } },
      llmAttemptCount: 0,
    });
    const step = await store.getStep('run-1', 'receive');
    expect(step?.output).toEqual({ consRef: { consId: 'c1', revision: 1 } });
    expect((await store.listSteps('run-1')).length).toBe(1);

    await store.appendEvent('run_started', { task: '处理语料' }, 'run-1', null);
    await store.appendEvent('step_succeeded', { stepId: 'step-1' }, 'run-1', 'step-1');
    await store.appendEvent('step_failed', { code: 'x' }, 'run-1', 'step-1');
    const events = await store.listEvents('run-1');
    expect(events.map((e) => e.eventType)).toEqual(['run_started', 'step_succeeded', 'step_failed']);
    expect(events[0]?.id).toBeLessThan(events[1]?.id as number);
    const paged = await store.listEvents('run-1', { afterId: events[0]?.id as number, limit: 1 });
    expect(paged.length).toBe(1);
    expect(paged[0]?.eventType).toBe('step_succeeded');
  });
});

describe('transactions', () => {
  it('rolls back all writes when the transaction fails', async () => {
    await expect(
      store.transaction(async () => {
        await store.createCons(revInput({ consId: 'tx.one', title: '事务对象' }));
        await store.createCons(revInput({ consId: 'tx.two', title: '事务对象二' }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.getCons('tx.one')).toBeNull();
    expect(await store.getCons('tx.two')).toBeNull();
    const events = await store.listEvents('__none__');
    expect(events.length).toBe(0);
  });

  it('commits when the transaction succeeds', async () => {
    await store.transaction(async () => {
      await store.createCons(revInput({ consId: 'tx.ok', title: '事务成功' }));
    });
    expect(await store.getCons('tx.ok')).not.toBeNull();
  });

  it('serializes writes through the single queue', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.createCons(revInput({ consId: `q.${i}`, title: `队列${i}` })),
      ),
    );
    expect(new Set(ids.map((c) => c.id)).size).toBe(10);
  });
});

describe('llm attempts', () => {
  it('inserts attempts idempotently on step_id+attempt_no and returns the last success', async () => {
    const row = {
      stepId: 'run-1::n1',
      attemptNo: 1,
      request: { systemPrompt: 's', userPrompt: 'u' },
      response: { text: '{"ok":true}' },
      model: 'mock',
      usage: { inputTokens: 3, outputTokens: 5 },
      latencyMs: 7,
      errorCode: null,
    };
    await store.insertLlmAttempt(row);
    await store.insertLlmAttempt({ ...row, response: { text: '{"ok":2}' } });
    await store.insertLlmAttempt({
      stepId: 'run-1::n1',
      attemptNo: 2,
      request: null,
      response: null,
      model: null,
      usage: null,
      latencyMs: null,
      errorCode: 'model_unavailable',
    });
    const last = await store.getLastLlmSuccess('run-1::n1');
    expect(last?.attemptNo).toBe(1);
    expect(last?.response).toEqual({ text: '{"ok":2}' });
    expect(last?.model).toBe('mock');
    expect(last?.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
    expect(last?.latencyMs).toBe(7);
    expect(last?.errorCode).toBeNull();
    expect(await store.getLastLlmSuccess('no-such-step')).toBeNull();
  });
});

describe('search', () => {
  it('does not index draft cons', async () => {
    await store.createCons(revInput({ consId: 'd1', title: '锡林郭勒草原' }));
    const res = await store.search({ text: '锡林郭勒草原' });
    expect(res.items.length).toBe(0);
  });

  it('indexes active cons and removes archived ones', async () => {
    const id = await makeActiveCons({ consId: 'a1', title: '锡林郭勒草原' });
    const found = await store.search({ text: '锡林郭勒草原' });
    expect(found.items.some((i) => i.ref.consId === id)).toBe(true);
    await store.setStatus(id, 'archived');
    const gone = await store.search({ text: '锡林郭勒草原' });
    expect(gone.items.length).toBe(0);
  });

  it('finds short Chinese queries through exact and bounded LIKE channels', async () => {
    await makeActiveCons({ consId: 'a2', title: '桌子上的盒子', aliases: ['草原'], searchTerms: ['标签'] });
    const byAlias = await store.search({ text: '草原' });
    expect(byAlias.items[0]?.ref.consId).toBe('a2');
    expect(byAlias.items[0]?.channel).toBe('name');
    const byTerm = await store.search({ text: '标签' });
    expect(byTerm.items[0]?.channel).toBe('searchTerm');
    const bySubstring = await store.search({ text: '盒子' });
    expect(bySubstring.items.some((i) => i.ref.consId === 'a2')).toBe(true);
  });

  it('matches 3+ char Chinese text via FTS ranking', async () => {
    await makeActiveCons({ consId: 'a3', title: '普通条目', body: '内蒙古高原上的草原，草很高。', aliases: [], searchTerms: [] });
    const res = await store.search({ text: '高原上的草原' });
    expect(res.items.some((i) => i.ref.consId === 'a3' && i.channel === 'fts')).toBe(true);
  });

  it('returns explicit id channel first', async () => {
    await makeActiveCons({ consId: 'zz.id-hit', title: '特别对象' });
    const res = await store.search({ text: 'zz.id-hit' });
    expect(res.items[0]?.channel).toBe('id');
  });

  it('truncates over-limit results keeping id and exact-name channels over fts (§8.3)', async () => {
    await makeActiveCons({ consId: '靶心词组abc', title: '显式对象', aliases: [], searchTerms: [], body: '无关内容' });
    await makeActiveCons({ consId: 'name-hit', title: '名称对象', aliases: ['靶心词组abc'], searchTerms: [], body: '无关内容' });
    for (let i = 0; i < 8; i++) {
      await makeActiveCons({ consId: `fts-${i}`, title: `排名对象${i}`, aliases: [], searchTerms: [], body: `正文包含靶心词组abc编号${i}` });
    }
    const res = await store.search({ text: '靶心词组abc', limit: 3 });
    expect(res.items).toHaveLength(3);
    expect(res.items[0]?.ref.consId).toBe('靶心词组abc');
    expect(res.items[0]?.channel).toBe('id');
    expect(res.items.some((i) => i.ref.consId === 'name-hit' && i.channel === 'name')).toBe(true);
    expect(res.items.filter((i) => i.channel === 'fts').length).toBe(1);
  });

  it('role filters only narrow', async () => {
    await makeActiveCons({ consId: 'r1', title: '阿尔法条目', roles: ['object'], aliases: [], searchTerms: [] });
    await makeActiveCons({ consId: 'r2', title: '阿尔法动作', roles: ['action'], aliases: [], searchTerms: [] });
    const all = await store.search({ text: '阿尔法' });
    expect(all.items.length).toBe(2);
    const narrowed = await store.searchByRole({ text: '阿尔法' }, ['action']);
    expect(narrowed.items.map((i) => i.ref.consId)).toEqual(['r2']);
  });

  it('expands one hop through active edges with the assoc channel', async () => {
    const x = await makeActiveCons({ consId: 'x1', title: '关联源对象', aliases: [], searchTerms: [] });
    const y = await makeActiveCons({ consId: 'y1', title: '关联目标对象', aliases: [], searchTerms: [] });
    const rel = await makeActiveCons({ consId: 'rel1', title: '描述', roles: ['relation_type'], aliases: [] });
    await store.createEdge({
      from: { consId: x, revision: 1 },
      relationConsId: rel,
      to: { consId: y, revision: 1 },
      status: 'active',
    });
    const res = await store.search({ text: '关联源对象' });
    expect(res.items.some((i) => i.ref.consId === 'y1' && i.channel === 'assoc')).toBe(true);
  });

  it('counts and lists active cons by role', async () => {
    await makeActiveCons({ consId: 'c1', title: '动作一', roles: ['action'], aliases: [] });
    await makeActiveCons({ consId: 'c2', title: '动作二', roles: ['action'], aliases: [] });
    await store.createCons(revInput({ consId: 'c3', title: '动作三', roles: ['action'] }));
    expect(await store.countActiveByRole('action')).toBe(2);
    const list = await store.listActiveConsByRole('action');
    expect(list.map((l) => l.ref.consId)).toEqual(['c1', 'c2']);
  });

  it('reindexes the current revision after a new revision is created', async () => {
    const id = await makeActiveCons({ consId: 'rev.idx', title: '旧标题内容' });
    await store.createRevision(id, {
      title: '全新标题内容',
      roles: ['object'],
      body: 'b',
      aliases: [],
      searchTerms: [],
      provenance: { source: 'human', sourceRefs: [] },
    });
    const hit = await store.search({ text: '全新标题内容' });
    expect(hit.items[0]?.ref.consId).toBe('rev.idx');
    const stale = await store.search({ text: '旧标题内容' });
    expect(stale.items.length).toBe(0);
  });
});

describe('reopen and migrations', () => {
  it('is idempotent when reopening the same database file', async () => {
    const path = join(dir, 'test.db');
    await makeActiveCons({ consId: 'persist.me', title: '持久化对象' });
    store.close();
    const reopened = openStore(path);
    const cons = await reopened.getCons('persist.me');
    expect(cons?.status).toBe('active');
    const res = await reopened.search({ text: '持久化对象' });
    expect(res.items.length).toBe(1);
    reopened.close();
    store = openStore(path);
  });
});
