import { randomUUID } from 'node:crypto';
import type {
  ActionSpec,
  Cons,
  ConsEdge,
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
import { findUnsupportedKeywords, validateSchemaStructure } from '../schema.js';

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

function activeRevisionOf(cons: Cons): number {
  return cons.activeRevision ?? cons.currentRevision;
}

async function activeRef(store: ConsStoreApi, consId: string): Promise<ConsRef | null> {
  const cons = await store.getCons(consId);
  return cons === null ? null : { consId, revision: activeRevisionOf(cons) };
}

async function assertEndpointRevision(store: ConsStoreApi, ref: ConsRef, what: string): Promise<void> {
  if (!Number.isInteger(ref.revision) || ref.revision < 1) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: ${what} ${ref.consId}@${String(ref.revision)} has an invalid revision`);
  }
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: ${what} revision ${ref.consId}@${String(ref.revision)} not found`);
  }
}

export function connectResultKey(stepId: string): string {
  return `${stepId}:connect`;
}

export async function searchCore(
  store: ConsStoreApi,
  queries: CoreQuery[],
  opts?: { limit?: number; coldStartRole?: ConsRole; runId?: string; stepId?: string; expansionTexts?: string[]; allowedIds?: string[] },
): Promise<SearchResultItem[]> {
  const qs = queries.slice(0, MAX_QUERIES);
  const allowedSet = opts !== undefined && opts.allowedIds !== undefined ? new Set(opts.allowedIds) : null;
  const best = new Map<string, SearchResultItem>();
  const collect = async (text: string, roles?: ConsRole[]): Promise<void> => {
    const query: { text: string; roles?: ConsRole[]; limit: number } = { text, limit: PER_QUERY_LIMIT };
    if (roles !== undefined) query.roles = roles;
    const resp = await store.search(query);
    for (const item of resp.items) {
      if (allowedSet !== null && !allowedSet.has(item.ref.consId)) continue;
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
        if (allowedSet !== null && !allowedSet.has(l.ref.consId)) continue;
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
    const rev = await store.getRevision(id, activeRevisionOf(cons));
    const spec = rev?.spec;
    if (!isRecord(spec) || spec['kind'] !== 'tendency' || spec['scope'] !== scope) continue;
    out.push({ consId: id, revision: activeRevisionOf(cons) });
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
    const ref = await activeRef(store, defaultId);
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
  return ctx.store.transaction(async () => {
    const key = `${ctx.step.id}:0`;
    const saved = await ctx.store.getIdempotencyResult(key);
    if (saved !== null) return saved;
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
    const output = { consRef: { consId: id, revision: 1 }, text };
    await ctx.store.putIdempotencyResult(key, output);
    return output;
  });
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
  const searchOpts: { limit?: number; coldStartRole?: ConsRole; runId: string; stepId: string; expansionTexts?: string[]; allowedIds?: string[] } = {
    runId: ctx.run.id,
    stepId: ctx.step.id,
  };
  const allowedActionIds = Array.isArray(input['allowedActionIds']) ? input['allowedActionIds'].filter((v): v is string => typeof v === 'string') : [];
  if (allowedActionIds.length > 0) searchOpts.allowedIds = allowedActionIds;
  if (limit !== undefined) searchOpts.limit = limit;
  if (wantsActions) {
    searchOpts.coldStartRole = 'action';
    const inputState = ctx.run.state['input'];
    const inputText = isRecord(inputState) && typeof inputState['text'] === 'string' ? inputState['text'] : '';
    searchOpts.expansionTexts = [ctx.run.task, inputText.slice(0, 50)];
  }
  let items = await searchCore(ctx.store, [...anchorQueries, ...queries], searchOpts);
  if (input['contentActionsOnly'] === true) {
    const filtered: SearchResultItem[] = [];
    for (const item of items) {
      const rev = await ctx.store.getRevision(item.ref.consId, item.ref.revision);
      if (rev !== null && isContentActionCompatible(rev.spec)) filtered.push(item);
    }
    items = filtered;
  }
  return { items };
}

function isObjectType(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value === 'object';
  if (Array.isArray(value)) return value.length > 0 && value.every((t) => t === 'object');
  return false;
}

function isStringType(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value === 'string';
  if (Array.isArray(value)) return value.length > 0 && value.every((t) => t === 'string');
  return false;
}

function isArrayType(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value === 'array';
  if (Array.isArray(value)) return value.length > 0 && value.every((t) => t === 'array');
  return false;
}

export function isContentActionCompatible(spec: unknown): boolean {
  if (!isRecord(spec) || spec['kind'] !== 'action' || spec['executor'] !== 'llm') return false;
  const inputSchema = isRecord(spec['inputSchema']) ? spec['inputSchema'] : {};
  const inputProperties = isRecord(inputSchema['properties']) ? inputSchema['properties'] : null;
  const inputRequired = Array.isArray(inputSchema['required']) ? inputSchema['required'] : [];
  if (!inputRequired.every((k) => k === 'input' || k === 'task')) return false;
  if (inputProperties !== null) {
    const declared = Object.keys(inputProperties);
    if (!declared.every((k) => k === 'input' || k === 'task')) return false;
    if (inputSchema['additionalProperties'] === false && !(declared.includes('input') && declared.includes('task'))) {
      return false;
    }
    for (const [key, check] of [['input', isObjectType], ['task', isStringType]] as const) {
      const sub = inputProperties[key];
      if (sub !== undefined && !check(isRecord(sub) ? sub['type'] : undefined)) return false;
    }
  }
  const outputSchema = isRecord(spec['outputSchema']) ? spec['outputSchema'] : {};
  const outRequired = Array.isArray(outputSchema['required']) ? outputSchema['required'] : [];
  if (!outRequired.includes('artifacts') || !outRequired.includes('links')) return false;
  const outProperties = isRecord(outputSchema['properties']) ? outputSchema['properties'] : null;
  if (outProperties !== null) {
    for (const key of ['artifacts', 'links']) {
      const sub = outProperties[key];
      if (sub !== undefined && !isArrayType(isRecord(sub) ? sub['type'] : undefined)) return false;
    }
  }
  return true;
}

export async function assertTempIdNamespace(store: ConsStoreApi, tempId: string): Promise<void> {
  if (tempId === '') return;
  const cons = await store.getCons(tempId);
  if (cons !== null) {
    throw new PrimitiveError(
      'unauthorized_effect',
      `unauthorized_effect: tempId "${tempId}" collides with an existing cons id`,
    );
  }
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
  await ctx.store.transaction(async () => {
    let opIndex = 0;
    for (const c of candidates) {
      if (!isRecord(c)) continue;
      const tempId = asString(c['tempId'], '');
      await assertTempIdNamespace(ctx.store, tempId);
      const kind = asString(c['kind'], 'object');
      const content = isRecord(c['content']) ? c['content'] : {};
      const key = `${ctx.step.id}:${String(opIndex)}`;
      opIndex += 1;
      const saved = await ctx.store.getIdempotencyResult(key);
      if (saved !== null && isRecord(saved) && isRef(saved['consRef'])) {
        formed.push({ tempId, consRef: saved['consRef'] });
        continue;
      }
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
      const consRef = { consId: id, revision: 1 };
      await ctx.store.putIdempotencyResult(key, { consRef });
      formed.push({ tempId, consRef });
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
    return activeRef(store, value);
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
  for (const label of ['inputSchema', 'outputSchema'] as const) {
    const schema = label === 'inputSchema' ? spec.inputSchema : spec.outputSchema;
    const structureErrors = validateSchemaStructure(schema);
    if (structureErrors.length > 0) {
      const unsupported = findUnsupportedKeywords(schema);
      const detail = unsupported.length > 0 ? `unsupported schema keywords: ${unsupported.join(', ')}` : structureErrors.join('; ');
      throw new PrimitiveError(
        'schema_mismatch',
        `schema_mismatch: action draft ${rev.consId} has an invalid ${label}: ${detail}`,
      );
    }
  }
  const methodId = spec.defaultMethodId;
  if (methodId === undefined) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: action draft ${rev.consId} is missing required elements: defaultMethodId`);
  }
  const cons = await store.getCons(methodId);
  if (cons === null) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} not found`);
  }
  if (cons.status !== 'active') {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} is not active`);
  }
  const mrev = await store.getRevision(methodId, activeRevisionOf(cons));
  if (mrev === null) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} has no active revision`);
  }
  if (!mrev.roles.includes('method')) {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} is not a method spec`);
  }
  const mspec = mrev.spec;
  if (!isRecord(mspec) || mspec['kind'] !== 'method') {
    throw new PrimitiveError('schema_mismatch', `schema_mismatch: default method ${methodId} of action ${rev.consId} is not a method spec`);
  }
  if (mspec['actionId'] !== rev.consId) {
    throw new PrimitiveError(
      'unauthorized_effect',
      `unauthorized_effect: default method ${methodId} of action ${rev.consId} belongs to action ${String(mspec['actionId'])}`,
    );
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

export interface ActivationMeta {
  activatedBy: string;
  runId?: string | null;
  stepId?: string | null;
}

export async function syncMethodOwnership(
  store: ConsStoreApi,
  actionId: string,
  methodId: string,
  methodRevision: number,
  activatedBy: string,
): Promise<ConsEdge | null> {
  await store.setMethodBinding(actionId, methodId, methodRevision, true);
  await store.deactivateMethodBindingsForMethod(methodId, actionId);
  const edges = await store.listEdges(methodId, 'from', false);
  for (const e of edges) {
    if (e.status !== 'active') continue;
    const stale = e.relationConsId === REL_METHOD_OF && (e.from.revision !== methodRevision || e.to.consId !== actionId);
    if (stale) {
      await store.archiveEdge(e.id);
    }
  }
  const actionCons = await store.getCons(actionId);
  const linked = edges.some(
    (e) => e.status === 'active' && e.relationConsId === REL_METHOD_OF && e.from.revision === methodRevision && e.to.consId === actionId,
  );
  if (actionCons !== null && !linked) {
    const edge = await store.createEdge({
      from: { consId: methodId, revision: methodRevision },
      relationConsId: REL_METHOD_OF,
      to: { consId: actionId, revision: activeRevisionOf(actionCons) },
      createdByStepId: activatedBy,
      status: 'active',
    });
    return edge;
  }
  return null;
}

export async function activateConsInTx(
  store: ConsStoreApi,
  consId: string,
  revision: number,
  meta: ActivationMeta,
  opts?: { methodBinding?: boolean },
): Promise<void> {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: invalid revision ${String(revision)} for ${consId}`);
  }
  const rev = await store.getRevision(consId, revision);
  if (rev === null) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: revision ${consId}@${String(revision)} not found`);
  }
  if (rev.roles.includes('action')) {
    const executor = await validateDynamicActionActivation(store, consId, revision);
    await store.upsertExecutionBinding({
      consId,
      revision,
      executor,
      active: true,
      activatedByStepId: meta.activatedBy,
    });
  }
  if (opts?.methodBinding === true && rev.roles.includes('method')) {
    const spec = rev.spec;
    if (isRecord(spec) && spec['kind'] === 'method' && typeof spec['actionId'] === 'string') {
      const actionId = spec['actionId'];
      const actionCons = await store.getCons(actionId);
      if (actionCons === null) {
        throw new PrimitiveError('unknown_reference', `unknown_reference: method ${consId} references unknown action ${actionId}`);
      }
      await syncMethodOwnership(store, actionId, consId, revision, meta.activatedBy);
    }
  }
  const cons = await store.getCons(consId);
  if (cons === null) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: cons ${consId} not found`);
  }
  if (cons.status !== 'active') {
    await store.setStatus(consId, 'active');
  }
  if (activeRevisionOf(cons) !== revision) {
    await store.activateRevision(consId, revision);
  }
  await store.appendEvent('cons_activated', { consId, revision }, meta.runId ?? null, meta.stepId ?? null);
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
      await assertTempIdNamespace(ctx.store, f['tempId']);
      tempMap.set(f['tempId'], f['consRef']);
      formed.push({ tempId: f['tempId'], consRef: f['consRef'] });
    }
  }
  const activate = input['activate'] !== false;
  const output = await ctx.store.transaction(async (): Promise<unknown> => {
    const saved = await ctx.store.getIdempotencyResult(connectResultKey(stepId));
    if (saved !== null) return saved;
    const edgeIds: string[] = [];
    const createdEdgeRefs: Array<{ id: string; from: ConsRef; relationConsId: string; to: ConsRef }> = [];
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
      await assertEndpointRevision(ctx.store, from, 'edge endpoint');
      await assertEndpointRevision(ctx.store, to, 'edge endpoint');
      const relCons = await ctx.store.getCons(rel);
      if (relCons === null) {
        throw new PrimitiveError('unknown_reference', `relation cons ${rel} not found`);
      }
      const relRev = await ctx.store.getRevision(relCons.id, activeRevisionOf(relCons));
      if (relCons.status !== 'active' || relRev === null || !relRev.roles.includes('relation_type')) {
        throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: relation cons ${rel} is not an active relation_type`);
      }
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
      await assertEndpointRevision(ctx.store, methodRef, 'method reference');
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
      const createdMethodEdge = await syncMethodOwnership(ctx.store, actionId, methodRef.consId, methodRef.revision, stepId);
      const methodCons = await ctx.store.getCons(methodRef.consId);
      if (methodCons !== null && methodCons.status === 'active' && activeRevisionOf(methodCons) !== methodRef.revision) {
        await ctx.store.activateRevision(methodRef.consId, methodRef.revision);
      }
      if (createdMethodEdge !== null) {
        edgeIds.push(createdMethodEdge.id);
        createdEdgeRefs.push({ id: createdMethodEdge.id, from: createdMethodEdge.from, relationConsId: REL_METHOD_OF, to: createdMethodEdge.to });
      }
    }
    if (activate) {
      for (const f of formed) {
        const rev = await ctx.store.getRevision(f.consRef.consId, f.consRef.revision);
        if (rev === null || rev.roles.includes('action')) continue;
        await activateConsInTx(ctx.store, f.consRef.consId, f.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
      for (const f of formed) {
        const rev = await ctx.store.getRevision(f.consRef.consId, f.consRef.revision);
        if (rev === null || !rev.roles.includes('action')) continue;
        await activateConsInTx(ctx.store, f.consRef.consId, f.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
    }
    if (createdEdgeRefs.length > 0) {
      await ctx.store.appendEvent('edges_created', { edges: createdEdgeRefs }, ctx.run.id, stepId);
    }
    await ctx.store.putIdempotencyResult(connectResultKey(stepId), { connected: formed.map((f) => f.consRef), edges: edgeIds });
    return { connected: formed.map((f) => f.consRef), edges: edgeIds };
  });
  return output;
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
      const ref = await activeRef(ctx.store, focus);
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
    const ref = await activeRef(ctx.store, id);
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
  const inputRev = inputRef !== null ? await ctx.store.getRevision(inputRef.consId, inputRef.revision) : null;
  const inputText = inputRev !== null ? inputRev.body : '';
  const artifactDetails: Array<{ ref: ConsRef; title: string; body: string }> = [];
  for (const ref of artifactRefs) {
    const r = await ctx.store.getRevision(ref.consId, ref.revision);
    if (r !== null) artifactDetails.push({ ref, title: r.title, body: r.body });
  }
  const selectionBasis =
    methodSel !== null && typeof methodSel['basisSummary'] === 'string' ? methodSel['basisSummary'] : '';
  const executionSummary = execOut !== null && typeof execOut['executionSummary'] === 'string' ? execOut['executionSummary'] : '';
  const data = {
    runId,
    task: ctx.run.task,
    inputRef,
    inputText,
    candidateActions: candidateRefs(selectActionStep),
    selectedAction,
    selectedMethod,
    methodExecuted: execMethodRef,
    selectionBasis,
    providedTendencies: selectActionStep !== undefined ? selectActionStep.tendencyRefs : [],
    usedTendencies,
    usedDefaultFreedom,
    artifactRefs,
    artifacts: artifactDetails,
    executionSummary,
  };
  const id = randomUUID();
  const output = await ctx.store.transaction(async (): Promise<unknown> => {
    const key = `${ctx.step.id}:0`;
    const savedResult = await ctx.store.getIdempotencyResult(key);
    if (savedResult !== null) return savedResult;
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
    const written = { caseRef, usedDefaultFreedom: data.usedDefaultFreedom, caseData: data };
    await ctx.store.putIdempotencyResult(key, written);
    return written;
  });
  return output;
}

async function revisePrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const consId = asString(input['consId'], '');
  const expectedRevision = typeof input['expectedRevision'] === 'number' ? input['expectedRevision'] : -1;
  const revision = isRecord(input['revision']) ? input['revision'] : {};
  const consRef = await ctx.store.transaction(async (): Promise<ConsRef> => {
    const key = `${ctx.step.id}:0`;
    const saved = await ctx.store.getIdempotencyResult(key);
    if (saved !== null && isRecord(saved) && isRef(saved['consRef'])) {
      return saved['consRef'];
    }
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
    const out = { consId, revision: created.revision };
    await ctx.store.putIdempotencyResult(key, { consRef: out });
    return out;
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
