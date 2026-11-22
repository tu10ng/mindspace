import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load.js';
import {
  ALL_SEEDS,
  DEFAULT_METHOD_SEEDS,
  FLOW_SEEDS,
  LLM_ACTION_SEEDS,
  PRIMITIVE_ACTION_SEEDS,
  PRIMITIVE_KEYS,
  RELATION_TYPE_SEEDS,
  TENDENCY_SEEDS,
} from '../../src/seed/seeds.js';
import type { ActionSpec, ConsEdge, FlowNode, FlowSpec } from '../../src/types.js';

let store: ConsStoreApi;

beforeAll(() => {
  store = openStore(':memory:');
  return loadSeeds(store);
});

afterAll(() => {
  store.close();
});

describe('seed catalog', () => {
  it('imports every seed cons as active with seed provenance', async () => {
    for (const seed of ALL_SEEDS) {
      const cons = await store.getCons(seed.id);
      expect(cons, seed.id).not.toBeNull();
      expect(cons?.status, seed.id).toBe('active');
      const rev = await store.getRevision(seed.id);
      expect(rev?.provenance.source, seed.id).toBe('seed');
      expect(rev?.revision, seed.id).toBe(1);
    }
  });

  it('contains the full inventory including P0/P1/P2 linking and summary seeds', () => {
    expect(PRIMITIVE_ACTION_SEEDS.length).toBe(7);
    expect(LLM_ACTION_SEEDS.length).toBe(13);
    expect(RELATION_TYPE_SEEDS.length).toBeGreaterThanOrEqual(8);
    expect(TENDENCY_SEEDS.length).toBe(2);
    expect(FLOW_SEEDS.length).toBe(5);
    expect(DEFAULT_METHOD_SEEDS.length).toBe(20);
    const relationIds = RELATION_TYPE_SEEDS.map((r) => r.id);
    for (const required of ['rel.method_of', 'rel.applies_to', 'rel.prefers', 'rel.avoids', 'rel.derived_from', 'rel.used_method', 'rel.used_tendency', 'rel.part_of', 'rel.describes']) {
      expect(relationIds).toContain(required);
    }
    const llmIds = LLM_ACTION_SEEDS.map((a) => a.id);
    expect(llmIds).toContain('seed.resolve_entities');
    expect(llmIds).toContain('seed.associate_context');
    expect(llmIds).toContain('seed.summarize_topic');
  });

  it('binds the six primitives to their primitiveKey', async () => {
    for (const action of PRIMITIVE_ACTION_SEEDS) {
      const binding = await store.getActiveExecutionBinding(action.id);
      expect(binding, action.id).not.toBeNull();
      expect(binding?.executor).toBe('primitive');
      expect(binding?.primitiveKey, action.id).toBeTruthy();
      expect(PRIMITIVE_KEYS).toContain(binding?.primitiveKey as (typeof PRIMITIVE_KEYS)[number]);
      const spec = (await store.getRevision(action.id))?.spec as ActionSpec;
      expect(spec.primitiveKey).toBe(binding?.primitiveKey);
      expect(spec.executor).toBe('primitive');
      expect(spec.inputSchema).toBeTruthy();
      expect(spec.outputSchema).toBeTruthy();
    }
    const keys = PRIMITIVE_ACTION_SEEDS.map((a) => ((a.spec as ActionSpec).primitiveKey ?? ''));
    expect([...keys].sort()).toEqual([...PRIMITIVE_KEYS].sort());
  });

  it('gives every llm action only return_artifacts and an active binding', async () => {
    for (const action of LLM_ACTION_SEEDS) {
      const spec = (await store.getRevision(action.id))?.spec as ActionSpec;
      expect(spec.executor, action.id).toBe('llm');
      expect(spec.allowedEffects, action.id).toEqual(['return_artifacts']);
      expect(spec.freedom, action.id).toBeTruthy();
      const binding = await store.getActiveExecutionBinding(action.id);
      expect(binding?.executor, action.id).toBe('llm');
    }
  });

  it('makes every default method reachable via method bindings and method_of edges', async () => {
    for (const method of DEFAULT_METHOD_SEEDS) {
      expect(method.methodOf).toBeTruthy();
      const bindings = await store.listActiveMethodBindings(method.methodOf as string);
      expect(bindings.some((b) => b.methodId === method.id), method.id).toBe(true);
      const edges: ConsEdge[] = await store.listEdges(method.id, 'from', true);
      const link = edges.find((e) => e.relationConsId === 'rel.method_of' && e.to.consId === method.methodOf);
      expect(link, method.id).toBeTruthy();
      const defaultBinding = bindings.find((b) => b.methodId === method.id);
      expect(defaultBinding?.methodRevision).toBe(1);
    }
    for (const action of [...PRIMITIVE_ACTION_SEEDS, ...LLM_ACTION_SEEDS]) {
      const spec = (await store.getRevision(action.id))?.spec as ActionSpec;
      expect(spec.defaultMethodId, action.id).toBe(`${action.id}.default`);
      const cons = await store.getCons(spec.defaultMethodId as string);
      expect(cons, action.id).not.toBeNull();
    }
  });

  it('imports the seed tendencies', async () => {
    const rev = await store.getRevision('tendency.case_before_method');
    expect(rev?.roles).toContain('tendency');
    expect(rev?.spec?.kind).toBe('tendency');
    const rev2 = await store.getRevision('tendency.check_existing_objects');
    expect(rev2?.roles).toContain('tendency');
    expect(rev2?.spec?.kind).toBe('tendency');
    expect(await store.countActiveByRole('tendency')).toBe(2);
  });
});

describe('seed flows', () => {
  const flowIds = FLOW_SEEDS.map((f) => f.id);

  function nodesOf(spec: FlowSpec): [string, FlowNode][] {
    return Object.entries(spec.nodes);
  }

  it('all four flows exist and are active with flow bindings', async () => {
    for (const id of flowIds) {
      const cons = await store.getCons(id);
      expect(cons?.status, id).toBe('active');
      const binding = await store.getActiveExecutionBinding(id);
      expect(binding?.executor, id).toBe('flow');
    }
  });

  it('has structurally valid FlowSpecs: entry exists, referenced actions exist, no dangling targets, acyclic', async () => {
    for (const flow of FLOW_SEEDS) {
      const spec = (await store.getRevision(flow.id))?.spec as FlowSpec;
      expect(spec.kind, flow.id).toBe('flow');
      expect(spec.nodes[spec.entry], `${flow.id} entry`).toBeTruthy();

      for (const [nodeId, node] of nodesOf(spec)) {
        if (node.actionId !== undefined) {
          const target = await store.getCons(node.actionId);
          expect(target, `${flow.id}.${nodeId} -> ${node.actionId}`).not.toBeNull();
          const binding = await store.getActiveExecutionBinding(node.actionId);
          expect(binding, `${flow.id}.${nodeId} -> ${node.actionId}`).not.toBeNull();
        } else {
          expect(node.actionFrom !== undefined || node.terminal === true, `${flow.id}.${nodeId}`).toBe(true);
        }
        expect(node.outputKey, `${flow.id}.${nodeId}`).toBeTruthy();
        const targets = [
          ...(node.next !== undefined ? [node.next] : []),
          ...(node.transitions ?? []).map((t) => t.next),
        ];
        for (const t of targets) {
          expect(spec.nodes[t], `${flow.id}.${nodeId} -> ${t}`).toBeTruthy();
        }
      }

      const visited = new Set<string>();
      const stack: Array<{ id: string; path: Set<string> }> = [{ id: spec.entry, path: new Set() }];
      while (stack.length > 0) {
        const frame = stack.pop();
        if (frame === undefined) break;
        const node = spec.nodes[frame.id];
        expect(node, `${flow.id}.${frame.id}`).toBeTruthy();
        if (frame.path.has(frame.id)) throw new Error(`cycle in ${flow.id} at ${frame.id}`);
        visited.add(frame.id);
        const nexts = [
          ...(node?.next !== undefined ? [node.next] : []),
          ...(node?.transitions ?? []).map((t) => t.next),
        ];
        for (const n of nexts) {
          if (n === undefined) continue;
          const nextPath = new Set(frame.path);
          nextPath.add(frame.id);
          stack.push({ id: n, path: nextPath });
        }
      }
      for (const [nodeId] of nodesOf(spec)) {
        expect(visited.has(nodeId) || nodeId === spec.entry, `${flow.id} unreachable node ${nodeId}`).toBe(true);
      }
    }
  });

  it('flow.ingest contains double selection and a no_candidate branch', async () => {
    const spec = (await store.getRevision('flow.ingest'))?.spec as FlowSpec;
    const ids = Object.keys(spec.nodes);
    expect(ids).toContain('select_action');
    expect(ids).toContain('select_method');
    const selectAction = spec.nodes['select_action'];
    expect(selectAction?.transitions?.some((t) => t.equals === 'no_candidate')).toBe(true);
    const noCandidateTarget = selectAction?.transitions?.find((t) => t.equals === 'no_candidate')?.next;
    expect(noCandidateTarget).toBeTruthy();
    const terminal = Object.values(spec.nodes).some((n) => n.terminal === true);
    expect(terminal).toBe(true);
  });

  it('flow.internalize marks its phase distinctly from the main phase', async () => {
    const spec = (await store.getRevision('flow.internalize'))?.spec as FlowSpec;
    const phases = Object.values(spec.nodes)
      .map((n) => n.inputBindings['phase'])
      .filter((b): b is { source: 'literal'; value: unknown } => b?.source === 'literal')
      .map((b) => b.value);
    expect(phases).toContain('internalize');
    expect(phases).not.toContain('main');
    const ingestSpec = (await store.getRevision('flow.ingest'))?.spec as FlowSpec;
    const ingestPhases = Object.values(ingestSpec.nodes)
      .map((n) => n.inputBindings['phase'])
      .filter((b): b is { source: 'literal'; value: unknown } => b?.source === 'literal')
      .map((b) => b.value);
    expect(ingestPhases).toContain('main');
  });
});

describe('idempotent import', () => {
  it('a second import inserts nothing new', async () => {
    const consBefore = new Map<string, number>();
    for (const seed of ALL_SEEDS) {
      const cons = await store.getCons(seed.id);
      consBefore.set(seed.id, cons?.currentRevision ?? 0);
    }
    const edgesBefore = await store.listEdges('seed.decompose.default', 'both', false);
    await store.appendEvent('test.marker', { n: 1 }, 'seed-test', null);
    const markerEvents = await store.listEvents('seed-test');
    const markerId = markerEvents[markerEvents.length - 1]?.id as number;

    await loadSeeds(store);

    for (const seed of ALL_SEEDS) {
      const cons = await store.getCons(seed.id);
      expect(cons?.currentRevision, seed.id).toBe(consBefore.get(seed.id));
      expect(cons?.status, seed.id).toBe('active');
    }
    const edgesAfter = await store.listEdges('seed.decompose.default', 'both', false);
    expect(edgesAfter.length).toBe(edgesBefore.length);
    await store.appendEvent('test.marker', { n: 2 }, 'seed-test', null);
    const after = await store.listEvents('seed-test');
    const lastId = after[after.length - 1]?.id as number;
    expect(lastId).toBe(markerId + 1);
  });
});
