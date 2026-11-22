import type {
  ActionSpec, Cons, ConsEdge, ConsRef, ConsRevision, ConsRole, ConsStatus, EffectKind,
  EventRecord, ExecutionBinding, FlowNode, FlowSpec, MethodBinding, MethodSpec,
  Run, RunAuthorization, Step, TendencySpec,
} from '../../src/types.js';
import type { ConsStoreApi } from '../../src/store/api.js';

export class FakeStore {
  cons: Map<string, Cons> = new Map();
  revisions: Map<string, ConsRevision> = new Map();
  bindings: Map<string, ExecutionBinding> = new Map();
  idempotencyKeys: Set<string> = new Set();
  idempotencyResults: Map<string, unknown> = new Map();
  methodBindings: MethodBinding[] = [];
  runs: Map<string, Run> = new Map();
  steps: Map<string, Step> = new Map();
  events: EventRecord[] = [];
  edges: ConsEdge[] = [];
  authorizations: Map<string, RunAuthorization> = new Map();
  statePatches: Array<Record<string, unknown>> = [];
  private nextEventId = 1;

  async createCons(revision: Omit<ConsRevision, 'revision' | 'createdAt'>, opts?: { stableId?: string }): Promise<Cons> {
    const id = opts?.stableId ?? `c${String(this.cons.size + 1)}`;
    const cons: Cons = { id, currentRevision: 1, activeRevision: 1, status: 'active', createdAt: '2026-01-01T00:00:00Z' };
    this.cons.set(id, cons);
    const rev: ConsRevision = { ...revision, consId: id, revision: 1, createdAt: '2026-01-01T00:00:00Z' };
    this.revisions.set(this.revKey(id, 1), rev);
    return cons;
  }

  async createRevision(consId: string, revision: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'>): Promise<ConsRevision> {
    const cons = this.cons.get(consId);
    if (cons === undefined) {
      throw new Error(`cons ${consId} not found`);
    }
    const next = cons.currentRevision + 1;
    const rev: ConsRevision = { ...revision, consId, revision: next, createdAt: '2026-01-01T00:00:00Z' };
    this.revisions.set(this.revKey(consId, next), rev);
    cons.currentRevision = next;
    if (cons.status !== 'active') {
      cons.activeRevision = next;
    }
    return rev;
  }

  revKey(consId: string, revision: number): string {
    return `${consId}@${String(revision)}`;
  }

  async getCons(consId: string): Promise<Cons | null> {
    return this.cons.get(consId) ?? null;
  }

  async getRevision(consId: string, revision?: number): Promise<ConsRevision | null> {
    const cons = this.cons.get(consId);
    const rev = revision ?? cons?.currentRevision;
    if (rev === undefined) {
      return null;
    }
    return this.revisions.get(this.revKey(consId, rev)) ?? null;
  }

  async setStatus(consId: string, status: ConsStatus): Promise<void> {
    const cons = this.cons.get(consId);
    if (cons !== undefined) {
      cons.status = status;
    }
  }

  async activateRevision(consId: string, revision: number): Promise<void> {
    const cons = this.cons.get(consId);
    if (cons === undefined || !this.revisions.has(this.revKey(consId, revision))) {
      throw new Error(`revision ${consId}@${String(revision)} not found`);
    }
    cons.activeRevision = revision;
  }

  async createEdge(edge: Omit<ConsEdge, 'id'>): Promise<ConsEdge> {
    const full: ConsEdge = { ...edge, id: `e${String(this.edges.length + 1)}` };
    this.edges.push(full);
    return full;
  }

  async listEdges(consId: string, direction: 'from' | 'to' | 'both' = 'both', onlyActive = true): Promise<ConsEdge[]> {
    return this.edges.filter((e) => {
      if (onlyActive && e.status !== 'active') {
        return false;
      }
      if (direction === 'from') {
        return e.from.consId === consId;
      }
      if (direction === 'to') {
        return e.to.consId === consId;
      }
      return e.from.consId === consId || e.to.consId === consId;
    });
  }

  async archiveEdge(edgeId: string): Promise<void> {
    for (const e of this.edges) {
      if (e.id === edgeId) {
        e.status = 'archived';
      }
    }
  }

  async upsertExecutionBinding(b: Omit<ExecutionBinding, 'active'> & { active: boolean }): Promise<void> {
    if (b.active) {
      for (const [key, existing] of this.bindings) {
        if (existing.consId === b.consId && existing.active) {
          this.bindings.set(key, { ...existing, active: false });
        }
      }
    }
    this.bindings.set(`${b.consId}@${String(b.revision)}`, { ...b });
  }

  async getActiveExecutionBinding(consId: string): Promise<ExecutionBinding | null> {
    let best: ExecutionBinding | null = null;
    for (const b of this.bindings.values()) {
      if (b.consId !== consId || !b.active) continue;
      if (best === null || b.revision > best.revision) best = b;
    }
    return best;
  }

  async getExecutionBinding(consId: string, revision: number): Promise<ExecutionBinding | null> {
    return this.bindings.get(`${consId}@${String(revision)}`) ?? null;
  }

  async insertIdempotencyKey(key: string): Promise<void> {
    this.idempotencyKeys.add(key);
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    return this.idempotencyKeys.has(key);
  }

  async getIdempotencyResult(key: string): Promise<unknown> {
    return this.idempotencyResults.get(key) ?? null;
  }

  async putIdempotencyResult(key: string, result: unknown): Promise<void> {
    if (!this.idempotencyResults.has(key)) {
      this.idempotencyResults.set(key, result);
    }
  }

  async setMethodBinding(actionId: string, methodId: string, methodRevision: number, active: boolean): Promise<void> {
    const existing = this.methodBindings.find((b) => b.actionId === actionId && b.methodId === methodId);
    if (existing !== undefined) {
      existing.methodRevision = methodRevision;
      existing.active = active;
      return;
    }
    this.methodBindings.push({ actionId, methodId, methodRevision, active });
  }

  async listActiveMethodBindings(actionId: string): Promise<MethodBinding[]> {
    return this.methodBindings.filter((b) => b.actionId === actionId && b.active);
  }

  async deactivateMethodBindingsForMethod(methodId: string, keepActionId?: string): Promise<void> {
    for (const b of this.methodBindings) {
      if (b.methodId === methodId && b.active && b.actionId !== keepActionId) {
        b.active = false;
      }
    }
  }

  async createRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async updateRun(runId: string, patch: Partial<Pick<Run, 'status' | 'counters' | 'state'>>): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`run ${runId} not found`);
    }
    if (patch.status !== undefined) {
      run.status = patch.status;
    }
    if (patch.counters !== undefined) {
      run.counters = patch.counters;
    }
    if (patch.state !== undefined) {
      run.state = patch.state;
      this.statePatches.push(patch.state);
    }
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.runs.get(runId) ?? null;
  }

  async putRunAuthorization(runId: string, key: string, record: RunAuthorization): Promise<void> {
    this.authorizations.set(`${runId}::${key}`, { ...record });
  }

  async getRunAuthorization(runId: string, key: string): Promise<RunAuthorization | null> {
    return this.authorizations.get(`${runId}::${key}`) ?? null;
  }

  async upsertStep(step: Step): Promise<void> {
    this.steps.set(step.id, JSON.parse(JSON.stringify(step)) as Step);
  }

  async getStep(runId: string, nodeId: string): Promise<Step | null> {
    return this.steps.get(`${runId}::${nodeId}`) ?? null;
  }

  async getStepById(stepId: string): Promise<Step | null> {
    return this.steps.get(stepId) ?? null;
  }

  async listSteps(runId: string): Promise<Step[]> {
    return [...this.steps.values()].filter((s) => s.runId === runId);
  }

  async appendEvent(eventType: string, payload: unknown, runId?: string | null, stepId?: string | null): Promise<void> {
    this.events.push({
      id: this.nextEventId,
      runId: runId ?? null,
      stepId: stepId ?? null,
      eventType,
      payload,
      createdAt: '2026-01-01T00:00:00Z',
    });
    this.nextEventId += 1;
  }

  async listEvents(runId: string, opts?: { afterId?: number; limit?: number }): Promise<EventRecord[]> {
    let items = this.events.filter((e) => e.runId === runId);
    if (opts?.afterId !== undefined) {
      items = items.filter((e) => e.id > (opts.afterId ?? 0));
    }
    if (opts?.limit !== undefined) {
      items = items.slice(0, opts.limit);
    }
    return items;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async listActiveConsByRole(role: ConsRole, limit?: number): Promise<Array<{ ref: ConsRef; title: string }>> {
    const out: Array<{ ref: ConsRef; title: string }> = [];
    for (const cons of this.cons.values()) {
      if (out.length >= (limit ?? 100)) {
        break;
      }
      if (cons.status !== 'active') {
        continue;
      }
      const rev = this.revisions.get(this.revKey(cons.id, cons.activeRevision));
      if (rev !== undefined && rev.roles.includes(role)) {
        out.push({ ref: { consId: cons.id, revision: cons.activeRevision }, title: rev.title });
      }
    }
    return out;
  }

  close(): void {}

  asApi(): ConsStoreApi {
    return this as unknown as ConsStoreApi;
  }
}

export function actionSpec(fields: {
  executor: 'primitive' | 'llm' | 'flow';
  primitiveKey?: string;
  allowedEffects?: EffectKind[];
  inputSchema?: object;
  outputSchema?: object;
  defaultMethodId?: string;
}): ActionSpec {
  return {
    kind: 'action',
    inputSchema: fields.inputSchema ?? { type: 'object' },
    outputSchema: fields.outputSchema ?? { type: 'object' },
    executor: fields.executor,
    ...(fields.primitiveKey !== undefined ? { primitiveKey: fields.primitiveKey } : {}),
    ...(fields.defaultMethodId !== undefined ? { defaultMethodId: fields.defaultMethodId } : {}),
    allowedEffects: fields.allowedEffects ?? ['return_artifacts'],
    freedom: { chooseWithinCandidates: true, fillExecutionDetails: true, proposeNewDefinitions: false },
  };
}

export async function seedAction(
  store: FakeStore,
  id: string,
  spec: ActionSpec,
  body = `body of ${id}`,
): Promise<void> {
  await store.createCons({
    title: id,
    roles: ['action' as ConsRole],
    body,
    aliases: [],
    searchTerms: [],
    spec,
    provenance: { source: 'seed', sourceRefs: [] },
  }, { stableId: id });
  await store.upsertExecutionBinding({
    consId: id,
    revision: 1,
    executor: spec.executor,
    ...(spec.primitiveKey !== undefined ? { primitiveKey: spec.primitiveKey } : {}),
    active: true,
    activatedByStepId: 'seed',
  });
}

export async function seedMethod(store: FakeStore, actionId: string, id: string, spec?: Partial<MethodSpec>): Promise<void> {
  await store.createCons({
    title: id,
    roles: ['method' as ConsRole],
    body: `body of ${id}`,
    aliases: [],
    searchTerms: [],
    spec: {
      kind: 'method',
      actionId,
      instructions: spec?.instructions ?? `instructions of ${id}`,
      applicabilityText: spec?.applicabilityText ?? 'always',
    },
    provenance: { source: 'seed', sourceRefs: [] },
  }, { stableId: id });
  await store.setMethodBinding(actionId, id, 1, true);
}

export async function seedFlow(store: FakeStore, id: string, spec: FlowSpec): Promise<ConsRef> {
  await store.createCons({
    title: id,
    roles: ['flow' as ConsRole],
    body: '',
    aliases: [],
    searchTerms: [],
    spec,
    provenance: { source: 'seed', sourceRefs: [] },
  }, { stableId: id });
  return { consId: id, revision: 1 };
}

export function makeNode(fields: Partial<FlowNode> & Pick<FlowNode, 'outputKey'>): FlowNode {
  return { inputBindings: {}, ...fields };
}

export async function seedTendency(store: FakeStore, id: string, spec?: Partial<TendencySpec>): Promise<ConsRef> {
  await store.createCons({
    title: id,
    roles: ['tendency' as ConsRole],
    body: '',
    aliases: [],
    searchTerms: [],
    spec: {
      kind: 'tendency',
      scope: spec?.scope ?? 'action_selection',
      applicabilityText: spec?.applicabilityText ?? 'always',
      preferenceText: spec?.preferenceText ?? 'prefer seeds',
      preferIds: spec?.preferIds ?? [],
      avoidIds: spec?.avoidIds ?? [],
    },
    provenance: { source: 'seed', sourceRefs: [] },
  }, { stableId: id });
  return { consId: id, revision: 1 };
}

export function makeRun(id: string, entryFlowRef: ConsRef, task: string, overrides?: Partial<Run['budget']>): Run {
  return {
    id,
    entryFlowRef,
    task,
    inputRefs: [],
    status: 'queued',
    budget: {
      maxSteps: overrides?.maxSteps ?? 64,
      maxLlmCalls: overrides?.maxLlmCalls ?? 20,
      maxOutputTokensPerCall: overrides?.maxOutputTokensPerCall ?? 4096,
    },
    counters: { steps: 0, llmCalls: 0 },
    state: {},
  };
}

export const selectOutputSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['selected', 'no_candidate'] },
    selected: {
      type: ['object', 'null'],
      properties: {
        consId: { type: 'string' },
        revision: { type: 'integer' },
      },
      required: ['consId', 'revision'],
    },
    usedTendencies: { type: 'array', items: { type: 'string' } },
    basisSummary: { type: 'string' },
    usedDefaultFreedom: { type: 'boolean' },
  },
  required: ['status', 'selected', 'usedTendencies', 'basisSummary', 'usedDefaultFreedom'],
} as object;
