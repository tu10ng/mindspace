import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load-main.js';
import { createSeedPrimitives } from '../../src/seed/runtime.js';
import { executeRun } from '../../src/engine/executor.js';
import type { EngineDeps } from '../../src/engine/executor.js';
import { createMockLlm } from '../../src/llm/mock.js';
import type { ConsRef, LlmRequest, Run } from '../../src/types.js';
import { DEFAULT_BUDGET } from '../../src/types.js';
import { EXEC_SUMMARY_PREFIX, requireCorpusMarker, requireExecutionSummaryMarker } from './mock-contract.js';

const M1_TITLE = '嵌套位置描述拆解';
const M1_INSTRUCTIONS = '识别被描述的中心对象，逐层提取位置修饰及其关系，保留完整表达。';
const NEW_ACTION_TITLE = '比较对象';

type DefineMode = 'llm' | 'primitive';

let defineMode: DefineMode = 'llm';

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

function actionConsId(prompt: string): string {
  const first = jsonBlocks(prompt)[0];
  return typeof first?.['consId'] === 'string' ? first['consId'] : '';
}

function selection(status: string, selected: ConsRef | null, freedom: boolean): unknown {
  return { status, selected, usedTendencies: [], basisSummary: 'mock 依据', usedDefaultFreedom: freedom };
}

function defineActionOutput(): Record<string, unknown> {
  if (defineMode === 'primitive') {
    // Attempt to declare unauthorized primitive executor fields; schema rejects it at the boundary.
    return {
      status: 'proposed',
      action: {
        title: NEW_ACTION_TITLE,
        body: '尝试绑定原语的违规动作。',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        executor: 'primitive',
        primitiveKey: 'form',
        freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
        defaultMethod: {
          title: '违规默认方法',
          instructions: '逐项对比两个对象。',
          applicabilityText: '需要比较两个对象时。',
        },
      },
    };
  }
  return {
    status: 'proposed',
    action: {
      title: NEW_ACTION_TITLE,
      body: '比较两个对象的共同点与差异。',
      aliases: ['比较'],
      searchTerms: ['比较', '对象'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
      defaultMethod: {
        title: '比较对象默认方法',
        instructions: '逐项对比两个对象的属性，输出共同点与差异。',
        applicabilityText: '需要比较两个对象时。',
        aliases: [],
        searchTerms: ['比较', '默认方法'],
      },
    },
  };
}

function makeHandler() {
  return (req: LlmRequest): unknown => {
    const action = actionConsId(req.userPrompt);
    const p = req.userPrompt;
    if (action === 'seed.make_query') {
      requireCorpusMarker(p, action);
      return { queries: ['拆解', '位置关系'], roles: ['action'], anchorIds: [] };
    }
    if (action === 'seed.select_action') {
      requireCorpusMarker(p, action);
      return selection('selected', { consId: 'seed.decompose', revision: 1 }, true);
    }
    if (action === 'seed.select_method') {
      requireCorpusMarker(p, action);
      const input = jsonBlocks(p).find((b) => 'defaultMethod' in b && 'candidates' in b) ?? {};
      const candidates = Array.isArray(input['candidates']) ? (input['candidates'] as Array<Record<string, unknown>>) : [];
      const m1 = candidates.find((c) => c['title'] === M1_TITLE && c['ref'] !== undefined) as { ref: ConsRef } | undefined;
      if (m1 !== undefined) {
        return selection('selected', m1.ref, false);
      }
      const fallback = input['defaultMethod'] as ConsRef | undefined;
      return selection('selected', fallback ?? null, true);
    }
    if (action === 'seed.decompose') {
      const marker = requireCorpusMarker(p, action);
      return {
        artifacts: [
          { tempId: 'a1', kind: 'object', content: { title: '中心对象', body: '输入中的中心对象。' } },
          { tempId: 'a2', kind: 'proposition', content: { title: '位置修饰命题', body: '中心对象具有多层位置修饰。' } },
        ],
        links: [
          { fromTempId: 'a2', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'a1' },
        ],
        executionSummary: `拆解了输入句子的组成与位置关系。${EXEC_SUMMARY_PREFIX}${marker}`,
      };
    }
    if (action === 'seed.resolve_entities') {
      const artifactsBlock = jsonBlocks(p).find((b) => 'artifacts' in b) ?? {};
      const artifacts = Array.isArray(artifactsBlock['artifacts']) ? (artifactsBlock['artifacts'] as Array<Record<string, unknown>>) : [];
      return {
        status: 'resolved',
        resolutions: artifacts
          .filter((a) => a['kind'] === 'object' || a['kind'] === 'concept')
          .map((a) => ({ tempId: String(a['tempId'] ?? ''), decision: 'create', basis: 'mock create' })),
      };
    }
    if (action === 'seed.associate_context') {
      return { associations: [] };
    }
    if (action === 'seed.prepare_connections') {
      const artifactsBlock = jsonBlocks(p).find((b) => 'artifacts' in b) ?? {};
      const artifacts = Array.isArray(artifactsBlock['artifacts']) ? (artifactsBlock['artifacts'] as Array<Record<string, unknown>>) : [];
      return {
        metadata: artifacts.map((a) => ({
          tempId: typeof a['tempId'] === 'string' ? a['tempId'] : '',
          aliases: [],
          searchTerms: ['对象'],
        })),
      };
    }
    if (action === 'seed.extract_method') {
      requireExecutionSummaryMarker(p, action);
      const input = jsonBlocks(p).find((b) => 'methodUsed' in b) ?? {};
      const methodUsed = input['methodUsed'] as ConsRef | undefined;
      if (methodUsed !== undefined && methodUsed.consId === 'seed.decompose.default') {
        return {
          status: 'proposed',
          method: {
            title: M1_TITLE,
            actionId: 'seed.decompose',
            applicabilityText: '包含多层位置修饰的句子',
            instructions: M1_INSTRUCTIONS,
            aliases: ['嵌套位置'],
            searchTerms: ['嵌套', '位置'],
          },
        };
      }
      return { status: 'none' };
    }
    if (action === 'seed.extract_tendency') {
      return { status: 'none' };
    }
    if (action === 'seed.define_action') {
      return defineActionOutput();
    }
    throw new Error(`unexpected llm call for action ${action}`);
  };
}

let store: ConsStoreApi;
let deps: EngineDeps;
let llm: ReturnType<typeof createMockLlm>;

async function runSeedFlow(flowId: string, task: string, input: Record<string, unknown>): Promise<Run> {
  const cons = await store.getCons(flowId);
  if (cons === null) {
    throw new Error(`unknown flow ${flowId}`);
  }
  const run: Run = {
    id: randomUUID(),
    entryFlowRef: { consId: flowId, revision: cons.currentRevision },
    task,
    inputRefs: [],
    status: 'queued',
    budget: DEFAULT_BUDGET,
    counters: { steps: 0, llmCalls: 0 },
    state: { input },
  };
  await store.createRun(run);
  return executeRun(deps, run.id);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindspace-seedflows-'));
  store = openStore(join(dir, 'seedflows.db'));
  await loadSeeds(store);
  llm = createMockLlm(makeHandler());
  deps = { store, llm, primitives: createSeedPrimitives() };
});

afterAll(() => {
  store.close();
});

describe('seed flow.ingest §17.2 loop without app assembly', () => {
  let run1: Run;
  let m1Id = '';

  it('first run completes on the seed flow and internalizes M1', async () => {
      run1 = await runSeedFlow('flow.ingest', '处理输入语料并内化', { text: '内蒙古高原上的草原上的草很高。UNIQUE_SF1_CORPUS' });
    expect(run1.status).toBe('completed');
    const bindings = await store.listActiveMethodBindings('seed.decompose');
    const dedicated = bindings.find((b) => b.methodId !== 'seed.decompose.default');
    expect(dedicated).toBeDefined();
    m1Id = dedicated?.methodId ?? '';
    const cons = await store.getCons(m1Id);
    expect(cons?.status).toBe('active');
    const rev = await store.getRevision(m1Id, cons?.currentRevision ?? 1);
    expect(rev?.spec?.kind).toBe('method');
    const edges = await store.listEdges(m1Id, 'from', true);
    expect(edges.some((e) => e.relationConsId === 'rel.method_of' && e.to.consId === 'seed.decompose')).toBe(true);
    const internalizeResult = run1.state['internalizeResult'];
    expect(typeof internalizeResult).toBe('object');
    const childRunId = `${run1.id}::sub::internalize`;
    const child = await store.getRun(childRunId);
    expect(child?.status).toBe('completed');
  });

  it('first run used the default method (usedDefaultFreedom recorded)', async () => {
    const steps = await store.listSteps(run1.id);
    const selectMethod = steps.find((s) => s.nodeId === 'select_method');
    const output = selectMethod?.output as { selected: ConsRef; usedDefaultFreedom: boolean };
    expect(output.selected.consId).toBe('seed.decompose.default');
    expect(output.usedDefaultFreedom).toBe(true);
    const execStep = steps.find((s) => s.nodeId === 'execute_action');
    expect(execStep?.methodRef?.consId).toBe('seed.decompose.default');
  });

  it('second run retrieves M1, selects M1 and executes with it (§16.2)', async () => {
    const run2 = await runSeedFlow('flow.ingest', '处理输入语料并内化', { text: '桌子上的盒子上的标签很旧。UNIQUE_SF2_CORPUS' });
    expect(run2.status).toBe('completed');

    const events = await store.listEvents(run2.id, { limit: 1000 });
    const retrieval = events.filter(
      (e) => e.eventType === 'retrieval_performed' && (e.payload as { kind?: string }).kind === 'methods' && JSON.stringify(e.payload).includes(m1Id),
    );
    expect(retrieval.length).toBeGreaterThan(0);

    const steps = await store.listSteps(run2.id);
    const selectMethod = steps.find((s) => s.nodeId === 'select_method');
    expect((selectMethod?.output as { selected: ConsRef }).selected.consId).toBe(m1Id);
    const execStep = steps.find((s) => s.nodeId === 'execute_action');
    expect(execStep?.methodRef?.consId).toBe(m1Id);
    expect(execStep?.actionRef.consId).toBe('seed.decompose');

    const injected = llm.calls.filter((c) => c.userPrompt.includes(M1_INSTRUCTIONS));
    expect(injected).toHaveLength(1);

    const recordStep = steps.find((s) => s.nodeId === 'record_case');
    const caseRef = (recordStep?.output as { caseRef: ConsRef }).caseRef;
    const caseEdges = await store.listEdges(caseRef.consId, 'from', true);
    expect(caseEdges.some((e) => e.relationConsId === 'rel.used_method' && e.to.consId === m1Id)).toBe(true);
  });

  it('does not recurse on content or internalization (§17.1-8, §17.1-9)', async () => {
    expect(llm.calls.filter((c) => actionConsId(c.userPrompt) === 'seed.decompose')).toHaveLength(2);
    expect(llm.calls.filter((c) => actionConsId(c.userPrompt) === 'seed.extract_method')).toHaveLength(2);
    expect(llm.calls.filter((c) => actionConsId(c.userPrompt) === 'seed.make_query')).toHaveLength(2);
  });
});

describe('seed flow.define_action §11.1', () => {
  it('registers a new llm action end to end and recalls it (§17.1-3)', async () => {
    defineMode = 'llm';
    const run = await runSeedFlow('flow.define_action', '形成一个用于比较两个对象的动作', { description: '比较两个对象的共同点与差异' });
    expect(run.status).toBe('completed');
    const connected = (run.state['connectedAction'] as { connected: ConsRef[] }).connected;
    expect(connected).toHaveLength(2);
    let actionId = '';
    let methodId = '';
    for (const ref of connected) {
      const rev = await store.getRevision(ref.consId, ref.revision);
      if (rev?.roles.includes('action')) {
        actionId = ref.consId;
        expect(rev.spec?.kind).toBe('action');
      }
      if (rev?.roles.includes('method')) {
        methodId = ref.consId;
      }
    }
    expect(actionId).not.toBe('');
    expect(methodId).not.toBe('');
    const actionCons = await store.getCons(actionId);
    expect(actionCons?.status).toBe('active');
    const binding = await store.getActiveExecutionBinding(actionId);
    expect(binding?.executor).toBe('llm');
    const actionRev = await store.getRevision(actionId, actionCons?.currentRevision ?? 1);
    const spec = actionRev?.spec as { kind: string; defaultMethodId?: string };
    expect(spec.defaultMethodId).toBe(methodId);
    const methodRev = await store.getRevision(methodId);
    const methodSpec = methodRev?.spec as { kind: string; actionId?: string };
    expect(methodSpec.actionId).toBe(actionId);
    const bindings = await store.listActiveMethodBindings(actionId);
    expect(bindings.some((b) => b.methodId === methodId)).toBe(true);
    const found = await store.search({ text: NEW_ACTION_TITLE, roles: ['action'] });
    expect(found.items.some((i) => i.ref.consId === actionId)).toBe(true);
  });

  it('rejects a dynamic action declaring primitive execution (§17.1-6)', async () => {
    defineMode = 'primitive';
    const run = await runSeedFlow('flow.define_action', '形成一个违规动作', { description: '违规' });
    expect(run.status).toBe('failed');
    const steps = await store.listSteps(run.id);
    const failed = steps.find((s) => s.status === 'failed');
    expect(failed?.errorCode).toBe('schema_mismatch');
    expect(run.state['formedAction']).toBeUndefined();
    defineMode = 'llm';
  });
});

describe('seed flow.revise_method §11.3', () => {
  it('revises a method with compare-and-swap and reconnects the binding', async () => {
    const methodId = 'seed.classify.default';
    const run = await runSeedFlow('flow.revise_method', '修订方法', {
      methodId,
      expectedRevision: 1,
      revision: { body: '新的分类说明', provenance: { source: 'human', sourceRefs: [] } },
    });
    expect(run.status).toBe('completed');
    const cons = await store.getCons(methodId);
    expect(cons?.currentRevision).toBe(2);
    const rev = await store.getRevision(methodId, 2);
    expect(rev?.body).toBe('新的分类说明');
    const bindings = await store.listActiveMethodBindings('seed.classify');
    expect(bindings.find((b) => b.methodId === methodId)?.methodRevision).toBe(2);
  });

  it('fails with revision_conflict when expectedRevision is stale', async () => {
    const run = await runSeedFlow('flow.revise_method', '修订方法', {
      methodId: 'seed.classify.default',
      expectedRevision: 1,
      revision: { body: '再次修订', provenance: { source: 'human', sourceRefs: [] } },
    });
    expect(run.status).toBe('failed');
    const steps = await store.listSteps(run.id);
    const failed = steps.find((s) => s.status === 'failed');
    expect(failed?.errorCode).toBe('revision_conflict');
  });
});
