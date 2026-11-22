import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { createMockLlm } from '../../src/llm/mock.js';
import type { ActionSpec, ConsRef, LlmRequest, Run, Step } from '../../src/types.js';
import { EXEC_SUMMARY_PREFIX, requireCorpusMarker, requireExecutionSummaryMarker } from './mock-contract.js';

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

function makeHandler() {
  return (req: LlmRequest): unknown => {
    const action = actionConsId(req.userPrompt);
    const p = req.userPrompt;
    if (action === 'seed.make_query') {
      requireCorpusMarker(p, action);
      return { queries: ['拆解'], roles: ['action'], anchorIds: [] };
    }
    if (action === 'seed.select_action') {
      requireCorpusMarker(p, action);
      return { status: 'selected', selected: { consId: 'seed.decompose', revision: 1 }, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.select_method') {
      requireCorpusMarker(p, action);
      const input = jsonBlocks(p).find((b) => 'defaultMethod' in b && 'candidates' in b) ?? {};
      const fallback = input['defaultMethod'] as ConsRef | undefined;
      return { status: 'selected', selected: fallback ?? null, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.decompose') {
      const marker = requireCorpusMarker(p, action);
      return {
        artifacts: [{ tempId: 'a1', kind: 'object', content: { title: '中心对象' } }],
        links: [],
        executionSummary: `拆解。${EXEC_SUMMARY_PREFIX}${marker}`,
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
      requireExecutionSummaryMarker(p, action);
      return { status: 'none' };
    }
    if (action === 'seed.extract_tendency') {
      return { status: 'none' };
    }
    throw new Error(`unexpected llm call for action ${action}`);
  };
}

const CONTROL_ACTIONS = [
  'seed.receive', 'seed.search', 'seed.form', 'seed.connect', 'seed.record', 'seed.revise',
  'seed.make_query', 'seed.select_action', 'seed.select_method', 'seed.prepare_connections',
  'seed.extract_method', 'seed.extract_tendency', 'seed.define_action',
];

let app: App;
let llm: ReturnType<typeof createMockLlm>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindspace-candidates-'));
  llm = createMockLlm(makeHandler());
  app = await createApp({ dbPath: join(dir, 'candidates.db'), llm });
});

afterAll(() => {
  app.close();
});

function searchActionsStep(steps: Step[]): Step | undefined {
  return steps.find((s) => s.nodeId === 'search_actions');
}

describe('F03 ingest candidates are restricted to the node permission set (§8.2)', () => {
  it('two ingest runs never surface control actions as content candidates', async () => {
    const run1: Run = await app.runIngest('内蒙古高原上的草原上的草很高。UNIQUE_CAND1_CORPUS');
    expect(run1.status).toBe('completed');
    const run2: Run = await app.runIngest('桌子上的盒子上的标签很旧。UNIQUE_CAND2_CORPUS');
    expect(run2.status).toBe('completed');
    for (const run of [run1, run2]) {
      const steps = await app.store.listSteps(run.id);
      const step = searchActionsStep(steps);
      expect(step).toBeDefined();
      const output = step?.output as { items: Array<{ ref: ConsRef }> };
      expect(output.items.length).toBeGreaterThan(0);
      const ids = output.items.map((i) => i.ref.consId);
      for (const control of CONTROL_ACTIONS) {
        expect(ids, control).not.toContain(control);
      }
      for (const id of ids) {
        expect(['seed.decompose', 'seed.classify', 'seed.reference_case'], id).toContain(id);
      }
    }
  });
});

describe('F11 dynamic actions must match the ingest content contract to become candidates', () => {
  it('excludes a top-level-text action from ingest candidates while it stays searchable elsewhere', async () => {
    const spec: ActionSpec = {
      kind: 'action',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
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
      defaultMethodId: 'dyn.text-action.default',
      allowedEffects: ['return_artifacts'],
      freedom: { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false },
    };
    for (const id of ['dyn.text-action', 'dyn.text-action.default']) {
      await app.store.createCons({
        consId: id,
        title: id === 'dyn.text-action' ? '顶层文本动作' : '顶层文本动作默认方法',
        roles: id === 'dyn.text-action' ? ['action'] : ['method'],
        body: '',
        aliases: [],
        searchTerms: [],
        provenance: { source: 'human', sourceRefs: [] },
        ...(id === 'dyn.text-action'
          ? { spec }
          : { spec: { kind: 'method' as const, actionId: 'dyn.text-action', instructions: '按文本处理。', applicabilityText: '' } }),
      }, { stableId: id });
      await app.store.setStatus(id, 'active');
    }
    await app.store.upsertExecutionBinding({
      consId: 'dyn.text-action',
      revision: 1,
      executor: 'llm',
      active: true,
      activatedByStepId: 'seed-test',
    });
    await app.store.setMethodBinding('dyn.text-action', 'dyn.text-action.default', 1, true);

    const run = await app.runIngest('短句。UNIQUE_CAND3_CORPUS');
    expect(run.status).toBe('completed');
    const steps = await app.store.listSteps(run.id);
    const output = searchActionsStep(steps)?.output as { items: Array<{ ref: ConsRef }> };
    expect(output.items.some((i) => i.ref.consId === 'dyn.text-action')).toBe(false);

    const found = await app.store.search({ text: '顶层文本动作', roles: ['action'] });
    expect(found.items.some((i) => i.ref.consId === 'dyn.text-action')).toBe(true);
  });
});
