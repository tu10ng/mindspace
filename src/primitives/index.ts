import { randomUUID } from 'node:crypto';
import type {
  ActionSpec,
  ConsRef,
  ConsRevision,
  ConsRole,
  EffectKind,
  FlowNode,
  FlowSpec,
  SearchResultItem,
  Step,
} from '../types.js';
import type { ConsStoreApi } from '../store/api.js';
import type { PrimitiveFn, StepContext } from '../engine/executor.js';
import { validateFlow } from '../engine/flow.js';

export const REL_METHOD_OF = 'rel.method_of';
export const REL_USED_METHOD = 'rel.used_method';
export const REL_USED_TENDENCY = 'rel.used_tendency';
export const REL_DERIVED_FROM = 'rel.derived_from';
export const REL_PREFERS = 'rel.prefers';
export const REL_AVOIDS = 'rel.avoids';

const MAX_QUERIES = 4;
const PER_QUERY_LIMIT = 20;
const MERGE_LIMIT = 30;
const COLD_START_LIMIT = 30;
const METHOD_BINDING_LIST_LIMIT = 20;
const TENDENCY_LIMIT = 20;

const CHANNEL_ORDER: Record<SearchResultItem['channel'], number> = {
  id: 4,
  name: 3,
  searchTerm: 2,
  fts: 1,
  assoc: 0,
};

export class PrimitiveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CoreQuery {
  text: string;
  roles?: ConsRole[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRef(value: unknown): value is ConsRef {
  return isRecord(value) && typeof value['consId'] === 'string' && typeof value['revision'] === 'number';
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asRefs(value: unknown): ConsRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRef);
}

async function currentRef(store: ConsStoreApi, consId: string): Promise<ConsRef | null> {
  const cons = await store.getCons(consId);
  return cons === null ? null : { consId, revision: cons.currentRevision };
}

export async function searchCore(
  store: ConsStoreApi,
  queries: CoreQuery[],
  opts?: { limit?: number; coldStartRole?: ConsRole; runId?: string; stepId?: string; expansionTexts?: string[] },
): Promise<SearchResultItem[]> {
  const qs = queries.slice(0, MAX_QUERIES);
  const best = new Map<string, SearchResultItem>();
  const collect = async (text: string, roles?: ConsRole[]): Promise<void> => {
    const query: { text: string; roles?: ConsRole[]; limit: number } = { text, limit: PER_QUERY_LIMIT };
    if (roles !== undefined) query.roles = roles;
    const resp = await store.search(query);
    for (const item of resp.items) {
      const prev = best.get(item.ref.consId);
      if (prev === undefined || CHANNEL_ORDER[item.channel] > CHANNEL_ORDER[prev.channel]) {
        best.set(item.ref.consId, item);
      }
    }
  };
  for (const q of qs) {
    await collect(q.text, q.roles);
  }
  let expandedTexts: string[] = [];
  if (opts !== undefined && opts.coldStartRole !== undefined) {
    const role = opts.coldStartRole;
    const count = await store.countActiveByRole(role);
    if (count <= COLD_START_LIMIT) {
      const listed = await store.listActiveConsByRole(role, COLD_START_LIMIT);
      for (const l of listed) {
        if (!best.has(l.ref.consId)) {
          best.set(l.ref.consId, { ref: l.ref, title: l.title, roles: [role], score: 0, channel: 'assoc' });
        }
      }
    } else if (best.size === 0 && opts.expansionTexts !== undefined) {
      const roles = [...new Set(qs.flatMap((q) => q.roles ?? []))];
      for (const text of opts.expansionTexts.slice(0, 2)) {
        const trimmed = text.trim();
        if (trimmed === '') continue;
        await collect(trimmed, roles.length > 0 ? roles : undefined);
        expandedTexts = [...expandedTexts, trimmed];
      }
    }
  }
  const items = [...best.values()]
    .sort((a, b) => {
      const p = CHANNEL_ORDER[b.channel] - CHANNEL_ORDER[a.channel];
      if (p !== 0) return p;
      return a.ref.consId < b.ref.consId ? -1 : 1;
    })
    .slice(0, (opts !== undefined ? opts.limit : undefined) ?? MERGE_LIMIT);
  if (opts !== undefined && opts.runId !== undefined) {
    await store.appendEvent(
      'retrieval_performed',
      {
        queries: qs,
        coldStartRole: opts.coldStartRole ?? null,
        expandedQueries: expandedTexts,
        items: items.map((i) => ({ consId: i.ref.consId, revision: i.ref.revision, score: i.score, channel: i.channel })),
      },
      opts.runId,
      opts.stepId ?? null,
    );
  }
  return items;
}

export async function tendencyCandidatesCore(
  store: ConsStoreApi,
  queries: CoreQuery[],
  scope: 'action_selection' | 'method_selection',
  anchors: unknown,
): Promise<ConsRef[]> {
  const roleQueries: CoreQuery[] = queries.map((q) => ({
    text: q.text,
    roles: [...(q.roles ?? []), 'tendency' as ConsRole],
  }));
  const items = await searchCore(store, roleQueries, { limit: TENDENCY_LIMIT });
  const ids = new Set<string>();
  for (const item of items) ids.add(item.ref.consId);
  const anchorIds = new Set<string>();
  const addAnchor = (v: unknown): void => {
    if (typeof v === 'string') {
      anchorIds.add(v);
      return;
    }
    if (isRecord(v) && isRef(v['ref'])) {
      anchorIds.add(v['ref'].consId);
      return;
    }
    if (isRef(v)) anchorIds.add(v.consId);
  };
  if (Array.isArray(anchors)) {
    for (const a of anchors) addAnchor(a);
  }
  for (const id of anchorIds) {
    const edges = await store.listEdges(id, 'to', true);
    for (const e of edges) {
      if (e.relationConsId === REL_PREFERS || e.relationConsId === REL_AVOIDS) {
        ids.add(e.from.consId);
      }
    }
  }
  const out: ConsRef[] = [];
  for (const id of ids) {
    if (out.length >= TENDENCY_LIMIT) break;
    const cons = await store.getCons(id);
    if (cons === null || cons.status !== 'active') continue;
    const rev = await store.getRevision(id, cons.currentRevision);
    const spec = rev?.spec;
    if (!isRecord(spec) || spec['kind'] !== 'tendency' || spec['scope'] !== scope) continue;
    out.push({ consId: id, revision: cons.currentRevision });
  }
  return out.sort((a, b) => (a.consId < b.consId ? -1 : a.consId > b.consId ? 1 : 0));
}

export async function methodCandidatesCore(
  store: ConsStoreApi,
  queries: CoreQuery[],
  actionId: string,
  opts?: { runId?: string; stepId?: string },
): Promise<{ items: SearchResultItem[]; defaultMethod: ConsRef | null }> {
  const actionRev = await store.getRevision(actionId);
  const spec = actionRev?.spec;
  const defaultId =
    isRecord(spec) && spec['kind'] === 'action' && typeof spec['defaultMethodId'] === 'string'
      ? spec['defaultMethodId']
      : undefined;
  const bindings = await store.listActiveMethodBindings(actionId);
  const items: SearchResultItem[] = [];
  if (bindings.length <= METHOD_BINDING_LIST_LIMIT) {
    for (const b of bindings) {
      const rev = await store.getRevision(b.methodId, b.methodRevision);
      if (rev === null) continue;
      items.push({
        ref: { consId: b.methodId, revision: b.methodRevision },
        title: rev.title,
        roles: rev.roles,
        score: 200,
        channel: 'searchTerm',
      });
    }
  } else {
    const methodQueries = queries.map((q) => ({
      text: q.text,
      roles: [...(q.roles ?? []), 'method' as ConsRole],
    }));
    const found = await searchCore(store, methodQueries, { limit: MERGE_LIMIT });
    const ids = new Set(bindings.map((b) => b.methodId));
    for (const f of found) {
      if (ids.has(f.ref.consId)) items.push(f);
    }
  }
  let defaultMethod: ConsRef | null = null;
  if (defaultId !== undefined) {
    const ref = await currentRef(store, defaultId);
    if (ref !== null) {
      defaultMethod = ref;
      if (!items.some((i) => i.ref.consId === defaultId)) {
        const rev = await store.getRevision(defaultId, ref.revision);
        items.push({
          ref,
          title: rev?.title ?? defaultId,
          roles: rev?.roles ?? ['method'],
          score: 150,
          channel: 'searchTerm',
        });
      }
    }
  }
  items.sort((a, b) => (a.ref.consId < b.ref.consId ? -1 : 1));
  const capped = items.slice(0, MERGE_LIMIT);
  if (opts !== undefined && opts.runId !== undefined) {
    await store.appendEvent(
      'retrieval_performed',
      {
        kind: 'methods',
        actionId,
        queries,
        items: capped.map((i) => ({ consId: i.ref.consId, revision: i.ref.revision, score: i.score, channel: i.channel })),
      },
      opts.runId,
      opts.stepId ?? null,
    );
  }
  return { items: capped, defaultMethod };
}

async function receivePrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const text = asString(input['text'], '');
  const id = randomUUID();
  await ctx.store.createCons({
    consId: id,
    title: text.slice(0, 40) || '输入',
    roles: ['object'],
    body: text,
    aliases: [],
    searchTerms: [],
    provenance: {
      source: 'input',
      runId: ctx.run.id,
      stepId: ctx.step.id,
      sourceRefs: [],
    },
  });
  await ctx.store.setStatus(id, 'active');
  return { consRef: { consId: id, revision: 1 } };
}

async function searchPrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const rawQueries = Array.isArray(input['queries']) ? input['queries'] : [];
  const extraRoles = Array.isArray(input['roles']) ? (input['roles'] as ConsRole[]) : undefined;
  const queries: CoreQuery[] = [];
  for (const q of rawQueries) {
    if (typeof q === 'string') {
      queries.push(extraRoles === undefined ? { text: q } : { text: q, roles: extraRoles });
    } else if (isRecord(q) && typeof q['text'] === 'string') {
      const roles = Array.isArray(q['roles']) ? (q['roles'] as ConsRole[]) : extraRoles;
      queries.push(roles === undefined ? { text: q['text'] } : { text: q['text'], roles });
    }
  }
  const tendencyScope = input['tendencyScope'];
  if (tendencyScope === 'action_selection' || tendencyScope === 'method_selection') {
    return { tendencyRefs: await tendencyCandidatesCore(ctx.store, queries, tendencyScope, input['anchorIds']) };
  }
  if (typeof input['actionId'] === 'string') {
    const r = await methodCandidatesCore(ctx.store, queries, input['actionId'], {
      runId: ctx.run.id,
      stepId: ctx.step.id,
    });
    return { items: r.items, defaultMethod: r.defaultMethod };
  }
  const wantsActions = queries.some((q) => (q.roles ?? []).includes('action'));
  const limit = typeof input['limit'] === 'number' ? input['limit'] : undefined;
  const anchorIds = Array.isArray(input['anchorIds']) ? input['anchorIds'].filter((v): v is string => typeof v === 'string') : [];
  const anchorQueries: CoreQuery[] = anchorIds.map((id) => ({ text: id, ...(extraRoles === undefined ? {} : { roles: extraRoles }) }));
  const searchOpts: { limit?: number; coldStartRole?: ConsRole; runId: string; stepId: string; expansionTexts?: string[] } = {
    runId: ctx.run.id,
    stepId: ctx.step.id,
  };
  if (limit !== undefined) searchOpts.limit = limit;
  if (wantsActions) {
    searchOpts.coldStartRole = 'action';
    const inputState = ctx.run.state['input'];
    const inputText = isRecord(inputState) && typeof inputState['text'] === 'string' ? inputState['text'] : '';
    searchOpts.expansionTexts = [ctx.run.task, inputText.slice(0, 50)];
  }
  const items = await searchCore(ctx.store, [...anchorQueries, ...queries], searchOpts);
  return { items };
}

const KIND_ROLES: Record<string, ConsRole[]> = {
  object: ['object'],
  proposition: ['proposition'],
  relation: ['relation_type'],
  method: ['method'],
  tendency: ['tendency'],
  action: ['action'],
};

async function formPrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const candidates = Array.isArray(input['candidates']) ? input['candidates'] : [];
  const formed: Array<{ tempId: string; consRef: ConsRef }> = [];
  let opIndex = 0;
  await ctx.store.transaction(async () => {
    for (const c of candidates) {
      if (!isRecord(c)) continue;
      const tempId = asString(c['tempId'], '');
      const kind = asString(c['kind'], 'object');
      const content = isRecord(c['content']) ? c['content'] : {};
      const id = randomUUID();
      const title = asString(content['title'], tempId || id);
      const revInput: Omit<ConsRevision, 'revision' | 'createdAt'> = {
        consId: id,
        title,
        roles: KIND_ROLES[kind] ?? ['object'],
        body: asString(content['body'], asString(content['instructions'], title)),
        aliases: asStringArray(content['aliases']),
        searchTerms: asStringArray(content['searchTerms']),
        provenance: {
          source: 'llm',
          runId: ctx.run.id,
          stepId: ctx.step.id,
          sourceRefs: asRefs(content['sourceRefs']),
        },
      };
      if (typeof content['applicabilityText'] === 'string') {
        revInput.applicabilityText = content['applicabilityText'];
      }
      if (content['spec'] !== undefined && isRecord(content['spec'])) {
        revInput.spec = content['spec'] as unknown as NonNullable<ConsRevision['spec']>;
      }
      await ctx.store.createCons(revInput);
      await ctx.store.insertIdempotencyKey(`${ctx.step.id}:${String(opIndex)}`);
      opIndex += 1;
      formed.push({ tempId, consRef: { consId: id, revision: 1 } });
    }
  });
  return { formed };
}

async function resolveEndpoint(
  store: ConsStoreApi,
  value: unknown,
  tempMap: Map<string, ConsRef>,
): Promise<ConsRef | null> {
  if (isRef(value)) {
    const cons = await store.getCons(value.consId);
    return cons === null ? null : value;
  }
  if (typeof value === 'string') {
    const mapped = tempMap.get(value);
    if (mapped !== undefined) return mapped;
    return currentRef(store, value);
  }
  return null;
}

function freedomComplete(freedom: unknown): boolean {
  if (!isRecord(freedom)) return false;
  return (
    typeof freedom['chooseWithinCandidates'] === 'boolean' &&
    typeof freedom['fillExecutionDetails'] === 'boolean' &&
    typeof freedom['proposeNewDefinitions'] === 'boolean'
  );
}

async function validateActionFiveElements(store: ConsStoreApi, rev: ConsRevision, spec: ActionSpec): Promise<void> {
  const missing: string[] = [];
  if (rev.title.trim() === '') missing.push('title');
  if (rev.body.trim() === '') missing.push('body');
  if (!isRecord(spec.inputSchema)) missing.push('inputSchema');
  if (!isRecord(spec.outputSchema)) missing.push('outputSchema');
  if (!freedomComplete(spec.freedom)) missing.push('freedom');
  if (typeof spec.defaultMethodId !== 'string' || spec.defaultMethodId === '') missing.push('defaultMethodId');
  if (missing.length > 0) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: action draft ${rev.consId} is missing required elements: ${missing.join(', ')}`);
  }
  const methodId = spec.defaultMethodId;
  if (methodId === undefined) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: action draft ${rev.consId} is missing required elements: defaultMethodId`);
  }
  const cons = await store.getCons(methodId);
  if (cons === null) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} not found`);
  }
  const mrev = await store.getRevision(cons.id, cons.currentRevision);
  const mspec = mrev?.spec;
  if (!isRecord(mspec) || mspec['kind'] !== 'method') {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} is not a method spec`);
  }
}

async function validateFlowExecutorAction(store: ConsStoreApi, consId: string, spec: ActionSpec): Promise<void> {
  const flowRef = spec.flowRef;
  if (!isRef(flowRef)) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: flow executor action ${consId} has no flowRef`);
  }
  const flowRev = await store.getRevision(flowRef.consId, flowRef.revision);
  const flowSpec = flowRev?.spec;
  if (!isRecord(flowSpec) || flowSpec['kind'] !== 'flow') {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: flowRef ${flowRef.consId} of action ${consId} has no flow spec`);
  }
  const errors = validateFlow(flowSpec as unknown as FlowSpec);
  if (errors.length > 0) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: flow of action ${consId} is invalid: ${errors.join('; ')}`);
  }
  let intersection = new Set<EffectKind>();
  let intersectionSeeded = false;
  for (const [nodeId, nodeRaw] of Object.entries(flowSpec['nodes'] as Record<string, FlowNode>)) {
    const node = nodeRaw;
    if (node === undefined || node.terminal === true) continue;
    if (typeof node.actionId !== 'string' || node.actionId === '') {
      throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: flow node ${nodeId} of ${consId} must reference an action by id`);
    }
    const binding = await store.getActiveExecutionBinding(node.actionId);
    if (binding === null || !binding.active) {
      throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: flow node ${nodeId} references action ${node.actionId} without an active binding`);
    }
    if (binding.executor === 'primitive') {
      throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: flow node ${nodeId} must not reference primitive action ${node.actionId}`);
    }
    const nrev = await store.getRevision(node.actionId, binding.revision);
    const nspec = nrev?.spec;
    if (!isRecord(nspec) || nspec['kind'] !== 'action') {
      throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: flow node ${nodeId} references ${node.actionId} which has no action spec`);
    }
    const effects = new Set<EffectKind>((nspec as ActionSpec).allowedEffects);
    if (!intersectionSeeded) {
      intersection = new Set<EffectKind>(effects);
      intersectionSeeded = true;
    } else {
      const next = new Set<EffectKind>();
      for (const e of intersection) {
        if (effects.has(e)) next.add(e);
      }
      intersection = next;
    }
  }
  const allowed = intersection;
  for (const e of spec.allowedEffects) {
    if (!allowed.has(e)) {
      throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: effect ${e} of ${consId} exceeds the intersection of its node actions' allowed effects`);
    }
  }
}

export async function validateDynamicActionActivation(
  store: ConsStoreApi,
  consId: string,
  revision: number,
): Promise<'llm' | 'flow'> {
  const rev = await store.getRevision(consId, revision);
  if (rev === null) {
    throw new PrimitiveError('unknown_reference', `draft revision ${consId}@${String(revision)} not found`);
  }
  const spec = rev.spec;
  if (!isRecord(spec) || spec['kind'] !== 'action') {
    throw new PrimitiveError('schema_mismatch', `action draft ${consId} has no action spec`);
  }
  const actionSpec = spec as ActionSpec;
  if (actionSpec.executor === 'primitive') {
    throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: action ${consId} must not bind a primitive`);
  }
  if (actionSpec.executor === 'llm' && !actionSpec.allowedEffects.every((x) => x === 'return_artifacts')) {
    throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: llm action ${consId} may only declare return_artifacts`);
  }
  if (actionSpec.executor === 'flow') {
    await validateFlowExecutorAction(store, consId, actionSpec);
  }
  await validateActionFiveElements(store, rev, actionSpec);
  return actionSpec.executor;
}

async function resolveMainActionId(ctx: StepContext): Promise<string | null> {
  const sel = ctx.run.state['actionSelection'];
  if (isRecord(sel) && isRef(sel['selected'])) {
    return sel['selected'].consId;
  }
  const steps = await ctx.store.listSteps(ctx.run.id);
  for (const s of steps) {
    if (s.actionRef.consId !== 'seed.select_action' || !isRecord(s.output)) continue;
    const selected = s.output['selected'];
    if (isRef(selected)) return selected.consId;
  }
  return null;
}

async function connectPrimitive(ctx: StepContext, stepId: string): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const formedRaw = Array.isArray(input['formed']) ? input['formed'] : [];
  const tempMap = new Map<string, ConsRef>();
  const formed: Array<{ tempId: string; consRef: ConsRef }> = [];
  for (const f of formedRaw) {
    if (isRecord(f) && typeof f['tempId'] === 'string' && isRef(f['consRef'])) {
      tempMap.set(f['tempId'], f['consRef']);
      formed.push({ tempId: f['tempId'], consRef: f['consRef'] });
    }
  }
  const activate = input['activate'] !== false;
  const edgeIds: string[] = [];
  const createdEdgeRefs: Array<{ id: string; from: ConsRef; relationConsId: string; to: ConsRef }> = [];
  const activatedRefs: ConsRef[] = [];
  await ctx.store.transaction(async () => {
    let opIndex = 0;
    const claim = async (): Promise<boolean> => {
      const key = `${stepId}:${String(opIndex)}`;
      opIndex += 1;
      if (await ctx.store.hasIdempotencyKey(key)) return false;
      await ctx.store.insertIdempotencyKey(key);
      return true;
    };
    for (const f of formed) {
      const rev = await ctx.store.getRevision(f.consRef.consId, f.consRef.revision);
      if (rev === null) {
        throw new PrimitiveError('unknown_reference', `draft revision ${f.consRef.consId}@${String(f.consRef.revision)} not found`);
      }
    }
    const edges = Array.isArray(input['edges']) ? input['edges'] : [];
    for (const e of edges) {
      if (!isRecord(e)) continue;
      const from = await resolveEndpoint(ctx.store, e['from'], tempMap);
      const to = await resolveEndpoint(ctx.store, e['to'], tempMap);
      const rel = e['relationConsId'];
      if (from === null || to === null || typeof rel !== 'string') {
        throw new PrimitiveError('unknown_reference', 'edge endpoint or relation type unresolved');
      }
      const relCons = await ctx.store.getCons(rel);
      if (relCons === null) {
        throw new PrimitiveError('unknown_reference', `relation cons ${rel} not found`);
      }
      const relRev = await ctx.store.getRevision(relCons.id, relCons.currentRevision);
      if (relCons.status !== 'active' || relRev === null || !relRev.roles.includes('relation_type')) {
        throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: relation cons ${rel} is not an active relation_type`);
      }
      if (await claim()) {
        const edge = await ctx.store.createEdge({
          from,
          relationConsId: rel,
          to,
          createdByStepId: stepId,
          status: 'active',
        });
        edgeIds.push(edge.id);
        createdEdgeRefs.push({ id: edge.id, from, relationConsId: rel, to });
      }
    }
    const formedIds = new Set(formed.map((f) => f.consRef.consId));
    const mainActionId = await resolveMainActionId(ctx);
    const bindings = Array.isArray(input['methodBindings']) ? input['methodBindings'] : [];
    for (const b of bindings) {
      if (!isRecord(b) || typeof b['actionId'] !== 'string' || !isRef(b['methodRef'])) continue;
      const actionId = b['actionId'];
      const methodRef = b['methodRef'];
      if (!formedIds.has(actionId) && mainActionId !== null && actionId !== mainActionId) {
        throw new PrimitiveError(
          'unauthorized_effect',
          `unauthorized_effect: method binding actionId ${actionId} is not the main action ${mainActionId} executed by this run`,
        );
      }
      const mrev = await ctx.store.getRevision(methodRef.consId, methodRef.revision);
      if (mrev === null) {
        throw new PrimitiveError('unknown_reference', `method revision ${methodRef.consId}@${String(methodRef.revision)} not found`);
      }
      if (!isRecord(mrev.spec) || mrev.spec['kind'] !== 'method') {
        throw new PrimitiveError('schema_mismatch', `${methodRef.consId} is not a method`);
      }
      if (mrev.spec['actionId'] !== actionId) {
        throw new PrimitiveError(
          'unauthorized_effect',
          `unauthorized_effect: method ${methodRef.consId} declares actionId ${String(mrev.spec['actionId'])} but is bound to ${actionId}`,
        );
      }
      if (await claim()) {
        await ctx.store.setMethodBinding(actionId, methodRef.consId, methodRef.revision, true);
      }
      const existing = await ctx.store.listEdges(methodRef.consId, 'from', true);
      const actionCons = await ctx.store.getCons(actionId);
      const alreadyLinked = existing.some((x) => x.relationConsId === REL_METHOD_OF && x.to.consId === actionId);
      if (await claim() && actionCons !== null && !alreadyLinked) {
        const edge = await ctx.store.createEdge({
          from: methodRef,
          relationConsId: REL_METHOD_OF,
          to: { consId: actionId, revision: actionCons.currentRevision },
          createdByStepId: stepId,
          status: 'active',
        });
        edgeIds.push(edge.id);
        createdEdgeRefs.push({ id: edge.id, from: methodRef, relationConsId: REL_METHOD_OF, to: { consId: actionId, revision: actionCons.currentRevision } });
      }
    }
    for (const f of formed) {
      if (!activate) continue;
      const rev = await ctx.store.getRevision(f.consRef.consId, f.consRef.revision);
      if (rev === null) continue;
      if (rev.roles.includes('action')) {
        const executor = await validateDynamicActionActivation(ctx.store, f.consRef.consId, f.consRef.revision);
        if (await claim()) {
          await ctx.store.upsertExecutionBinding({
            consId: f.consRef.consId,
            revision: f.consRef.revision,
            executor,
            active: true,
            activatedByStepId: stepId,
          });
        }
      }
      if (await claim()) {
        await ctx.store.setStatus(f.consRef.consId, 'active');
        activatedRefs.push(f.consRef);
      }
    }
    if (createdEdgeRefs.length > 0) {
      await ctx.store.appendEvent('edges_created', { edges: createdEdgeRefs }, ctx.run.id, stepId);
    }
    for (const r of activatedRefs) {
      await ctx.store.appendEvent('cons_activated', { consId: r.consId, revision: r.revision }, ctx.run.id, stepId);
    }
  });
  return { connected: formed.map((f) => f.consRef), edges: edgeIds };
}

function outputOf(step: Step | undefined): Record<string, unknown> | null {
  if (step === undefined || !isRecord(step.output)) return null;
  return step.output;
}

function candidateRefs(step: Step | undefined): ConsRef[] {
  if (step === undefined || !isRecord(step.input) || !Array.isArray(step.input['candidates'])) return [];
  const out: ConsRef[] = [];
  for (const c of step.input['candidates']) {
    if (isRecord(c) && isRef(c['ref'])) out.push(c['ref']);
  }
  return out;
}

async function caseDerivedFreedom(store: ConsStoreApi, focus: ConsRef, fallback: Record<string, unknown>): Promise<boolean> {
  const rev = await store.getRevision(focus.consId, focus.revision);
  if (rev !== null && rev.roles.includes('case')) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rev.body);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && typeof parsed['usedDefaultFreedom'] === 'boolean') {
      return parsed['usedDefaultFreedom'];
    }
  }
  return fallback['usedDefaultFreedom'] === true;
}

async function recordPrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const runId = asString(input['runId'], ctx.run.id);
  if (input['phase'] === 'internalize') {
    const focus = input['focus'];
    const methodSelection = isRecord(input['methodSelection']) ? input['methodSelection'] : {};
    if (isRef(focus)) {
      return { caseRef: focus, usedDefaultFreedom: await caseDerivedFreedom(ctx.store, focus, methodSelection) };
    }
    if (typeof focus === 'string') {
      const ref = await currentRef(ctx.store, focus);
      if (ref !== null) {
        return { caseRef: ref, usedDefaultFreedom: await caseDerivedFreedom(ctx.store, ref, methodSelection) };
      }
    }
    throw new PrimitiveError('schema_mismatch', 'internalize phase record requires a case focus');
  }
  const steps = await ctx.store.listSteps(runId);
  const byAction = (id: string): Step | undefined => steps.find((s) => s.actionRef.consId === id);
  const receiveStep = byAction('seed.receive');
  const selectActionStep = byAction('seed.select_action');
  const selectMethodStep = byAction('seed.select_method');
  const actionSel = outputOf(selectActionStep);
  const methodSel = outputOf(selectMethodStep);
  const selectedAction =
    actionSel !== null && isRef(actionSel['selected']) ? actionSel['selected'] : null;
  const selectedMethod =
    methodSel !== null && isRef(methodSel['selected']) ? methodSel['selected'] : null;
  const execStep =
    selectedAction === null
      ? undefined
      : steps.find((s) => s.actionRef.consId === selectedAction.consId && s.actionRef.revision === selectedAction.revision);
  const connectStep = byAction('seed.connect');
  const receiveOut = outputOf(receiveStep);
  const inputRef = receiveOut !== null && isRef(receiveOut['consRef']) ? receiveOut['consRef'] : null;
  const connectOut = outputOf(connectStep);
  const artifactRefs = connectOut !== null && Array.isArray(connectOut['connected']) ? asRefs(connectOut['connected']) : [];
  const execOut = outputOf(execStep);
  const tendencyIds: string[] = [];
  for (const sel of [actionSel, methodSel]) {
    if (sel === null || !Array.isArray(sel['usedTendencies'])) continue;
    for (const t of sel['usedTendencies']) {
      if (typeof t === 'string') tendencyIds.push(t);
      else if (isRef(t)) tendencyIds.push(t.consId);
    }
  }
  const usedTendencies: ConsRef[] = [];
  for (const id of tendencyIds) {
    const ref = await currentRef(ctx.store, id);
    if (ref !== null) usedTendencies.push(ref);
  }
  const execMethodRef = execStep !== undefined && execStep.methodRef !== undefined ? execStep.methodRef : null;
  const effectiveMethod = execMethodRef ?? selectedMethod;
  const actionRevForDefault = selectedAction !== null ? await ctx.store.getRevision(selectedAction.consId, selectedAction.revision) : null;
  const actionSpecRaw = actionRevForDefault?.spec;
  const defaultMethodId =
    isRecord(actionSpecRaw) && actionSpecRaw['kind'] === 'action' && typeof actionSpecRaw['defaultMethodId'] === 'string'
      ? actionSpecRaw['defaultMethodId']
      : null;
  let usedDefaultFreedom = true;
  if (effectiveMethod !== null) {
    usedDefaultFreedom = defaultMethodId !== null && effectiveMethod.consId === defaultMethodId;
  }
  const data = {
    runId,
    task: ctx.run.task,
    inputRef,
    candidateActions: candidateRefs(selectActionStep),
    selectedAction,
    selectedMethod,
    methodExecuted: execMethodRef,
    providedTendencies: selectActionStep !== undefined ? selectActionStep.tendencyRefs : [],
    usedTendencies,
    usedDefaultFreedom,
    artifactRefs,
    executionSummary: execOut !== null && typeof execOut['executionSummary'] === 'string' ? execOut['executionSummary'] : '',
  };
  const id = randomUUID();
  await ctx.store.createCons({
    consId: id,
    title: `案例：${ctx.run.task.slice(0, 30)}`,
    roles: ['case'],
    body: JSON.stringify(data),
    aliases: [],
    searchTerms: [],
    provenance: {
      source: 'execution',
      runId,
      stepId: ctx.step.id,
      sourceRefs: inputRef !== null ? [inputRef] : [],
    },
  });
  await ctx.store.setStatus(id, 'active');
  const caseRef = { consId: id, revision: 1 };
  if (inputRef !== null) {
    await ctx.store.createEdge({
      from: caseRef,
      relationConsId: REL_DERIVED_FROM,
      to: inputRef,
      createdByStepId: ctx.step.id,
      status: 'active',
    });
  }
  if (execStep !== undefined && execStep.methodRef !== undefined) {
    await ctx.store.createEdge({
      from: caseRef,
      relationConsId: REL_USED_METHOD,
      to: execStep.methodRef,
      createdByStepId: ctx.step.id,
      status: 'active',
    });
  }
  for (const t of usedTendencies) {
    await ctx.store.createEdge({
      from: caseRef,
      relationConsId: REL_USED_TENDENCY,
      to: t,
      createdByStepId: ctx.step.id,
      status: 'active',
    });
  }
  return { caseRef, usedDefaultFreedom: data.usedDefaultFreedom };
}

async function revisePrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const consId = asString(input['consId'], '');
  const expectedRevision = typeof input['expectedRevision'] === 'number' ? input['expectedRevision'] : -1;
  const revision = isRecord(input['revision']) ? input['revision'] : {};
  const consRef = await ctx.store.transaction(async (): Promise<ConsRef> => {
    const cons = await ctx.store.getCons(consId);
    if (cons === null) {
      throw new PrimitiveError('unknown_reference', `cons ${consId} not found`);
    }
    if (cons.currentRevision !== expectedRevision) {
      throw new PrimitiveError(
        'revision_conflict',
        `revision_conflict: expected revision ${String(expectedRevision)} but current is ${String(cons.currentRevision)}`,
      );
    }
    const old = await ctx.store.getRevision(consId, expectedRevision);
    const provenance: ConsRevision['provenance'] = isRecord(revision['provenance'])
      ? (revision['provenance'] as unknown as ConsRevision['provenance'])
      : { source: 'human', sourceRefs: [] };
    const fields: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'> = {
      title: asString(revision['title'], old?.title ?? consId),
      roles: Array.isArray(revision['roles']) ? (revision['roles'] as ConsRole[]) : (old?.roles ?? ['object']),
      body: asString(revision['body'], old?.body ?? ''),
      aliases: asStringArray(revision['aliases'] ?? old?.aliases),
      searchTerms: asStringArray(revision['searchTerms'] ?? old?.searchTerms),
      provenance,
    };
    if (typeof revision['applicabilityText'] === 'string') {
      fields.applicabilityText = revision['applicabilityText'];
    } else if (old?.applicabilityText !== undefined) {
      fields.applicabilityText = old.applicabilityText;
    }
    if (revision['spec'] !== undefined && isRecord(revision['spec'])) {
      fields.spec = revision['spec'] as unknown as NonNullable<ConsRevision['spec']>;
    } else if (old?.spec !== undefined) {
      fields.spec = old.spec;
    }
    const created = await ctx.store.createRevision(consId, fields);
    await ctx.store.insertIdempotencyKey(`${ctx.step.id}:0`);
    return { consId, revision: created.revision };
  });
  return { consRef };
}

export function createPrimitives(): Record<string, { run: PrimitiveFn }> {
  return {
    receive: { run: (ctx: StepContext): Promise<unknown> => receivePrimitive(ctx) },
    search: { run: (ctx: StepContext): Promise<unknown> => searchPrimitive(ctx) },
    form: { run: (ctx: StepContext): Promise<unknown> => formPrimitive(ctx) },
    connect: { run: (ctx: StepContext, stepId: string): Promise<unknown> => connectPrimitive(ctx, stepId) },
    record: { run: (ctx: StepContext): Promise<unknown> => recordPrimitive(ctx) },
    revise: { run: (ctx: StepContext): Promise<unknown> => revisePrimitive(ctx) },
  };
}
