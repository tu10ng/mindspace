import { randomUUID } from 'node:crypto';
import type {
  ActionSpec,
  Cons,
  ConsEdge,
  ConsRef,
  ConsRevision,
  ConsRole,
  EffectKind,
  EntityCandidate,
  EntityResolutionItem,
  FlowNode,
  FlowSpec,
  RelatedStatementItem,
  SearchResultItem,
  StatementCandidate,
  Step,
} from '../types.js';
import type { ConsStoreApi } from '../store/api.js';
import type { PrimitiveFn, StepContext } from '../engine/executor.js';
import { validateFlow } from '../engine/flow.js';
import { findUnsupportedKeywords, validateSchema, validateSchemaStructure } from '../schema.js';

export const REL_METHOD_OF = 'rel.method_of';
export const REL_USED_METHOD = 'rel.used_method';
export const REL_USED_TENDENCY = 'rel.used_tendency';
export const REL_DERIVED_FROM = 'rel.derived_from';
export const REL_PREFERS = 'rel.prefers';
export const REL_AVOIDS = 'rel.avoids';
export const REL_DESCRIBES = 'rel.describes';
export const REL_PART_OF = 'rel.part_of';

export const TRUSTED_SNAPSHOT_ENTITY_CONTEXT = 'entity_context';
export const TRUSTED_SNAPSHOT_ENTITY_RESOLUTION = 'entity_resolution';
export const TRUSTED_SNAPSHOT_SUMMARY_CONTEXT = 'summary_context';

export interface TrustedEntityContextSnapshot {
  objectRefs: ConsRef[];
  statementRefs: ConsRef[];
  truncated: { objects: boolean; statements: boolean };
}

export interface TrustedEntityResolutionSnapshot {
  batchStepId: string;
  candidateSnapshotStepId: string | null;
  resolutions: EntityResolutionItem[];
  tempIdToExistingRef: Record<string, ConsRef>;
  createTempIds: string[];
  unresolvedTempIds: string[];
  confirmedByHuman?: boolean;
}

export interface TrustedSummaryContextSnapshot {
  status: 'ready' | 'needs_resolution' | 'no_topic';
  topicRef: ConsRef | null;
  ambiguousTopicRefs: ConsRef[];
  allowedSourceRefs: ConsRef[];
}

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

export function materializeResultKey(stepId: string): string {
  return `${stepId}:materialize_and_connect`;
}

function refKey(ref: ConsRef): string {
  return `${ref.consId}@${String(ref.revision)}`;
}

export async function searchCore(
  store: ConsStoreApi,
  queries: CoreQuery[],
  opts?: {
    limit?: number;
    coldStartRole?: ConsRole;
    runId?: string;
    stepId?: string;
    expansionTexts?: string[];
    allowedIds?: string[];
    excludeInputProvenance?: boolean;
  },
): Promise<SearchResultItem[]> {
  const qs = queries.slice(0, MAX_QUERIES);
  const allowedSet = opts !== undefined && opts.allowedIds !== undefined ? new Set(opts.allowedIds) : null;
  const excludeInput = opts?.excludeInputProvenance === true;
  const best = new Map<string, SearchResultItem>();
  const collect = async (text: string, roles?: ConsRole[]): Promise<void> => {
    const query: { text: string; roles?: ConsRole[]; limit: number; excludeInputProvenance?: boolean } = {
      text,
      limit: PER_QUERY_LIMIT,
    };
    if (roles !== undefined) query.roles = roles;
    if (excludeInput) query.excludeInputProvenance = true;
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
        if (excludeInput) {
          const rev = await store.getRevision(l.ref.consId, l.ref.revision);
          if (rev?.provenance.source === 'input') continue;
        }
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
  scope: 'action_selection' | 'method_selection' | 'entity_resolution',
  anchors: unknown,
): Promise<ConsRef[]> {
  const roleQueries: CoreQuery[] = queries.map((q) => ({
    text: q.text,
    roles: [...(q.roles ?? []), 'tendency' as ConsRole],
  }));
  const items = await searchCore(store, roleQueries, {
    limit: TENDENCY_LIMIT,
    ...(scope === 'entity_resolution' ? { coldStartRole: 'tendency' as ConsRole } : {}),
  });
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

/**
 * Hydrate an active object/concept cons with its body, aliases, provenance,
 * and up to `maxRelated` one-hop related proposition statements.
 */
async function buildEntityCandidate(
  store: ConsStoreApi,
  ref: ConsRef,
  maxRelated: number,
): Promise<{ candidate: EntityCandidate; relatedTruncated: boolean } | null> {
  const cons = await store.getCons(ref.consId);
  if (cons === null || cons.status !== 'active') return null;
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null || rev.provenance.source === 'input') return null;
  const edges = await store.listEdges(ref.consId, 'both', true);
  const relatedStatements: RelatedStatementItem[] = [];
  const seenStmt = new Set<string>();
  let relatedTruncated = false;
  for (const edge of edges) {
    const isFrom = edge.from.consId === ref.consId;
    const otherRef = isFrom ? edge.to : edge.from;
    const key = refKey(otherRef);
    if (seenStmt.has(key)) continue;
    const otherCons = await store.getCons(otherRef.consId);
    if (otherCons === null || otherCons.status !== 'active') continue;
    const otherRev = await store.getRevision(otherRef.consId, otherRef.revision);
    if (otherRev === null || !otherRev.roles.includes('proposition')) continue;
    if (relatedStatements.length >= maxRelated) {
      relatedTruncated = true;
      break;
    }
    seenStmt.add(key);
    relatedStatements.push({
      ref: otherRef,
      relationConsId: edge.relationConsId,
      direction: isFrom ? 'from' : 'to',
      title: otherRev.title,
      body: otherRev.body,
      sourceRefs: otherRev.provenance.sourceRefs,
    });
  }
  return {
    candidate: {
      ref,
      title: rev.title,
      roles: rev.roles,
      body: rev.body,
      aliases: rev.aliases,
      searchTerms: rev.searchTerms,
      sourceRefs: rev.provenance.sourceRefs,
      relatedStatements,
    },
    relatedTruncated,
  };
}

/**
 * Hydrate an active proposition cons with its body, provenance sourceRefs,
 * and one-hop related objects/concepts.
 */
async function buildStatementCandidate(
  store: ConsStoreApi,
  ref: ConsRef,
): Promise<StatementCandidate | null> {
  const cons = await store.getCons(ref.consId);
  if (cons === null || cons.status !== 'active') return null;
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null || !rev.roles.includes('proposition')) return null;
  const edges = await store.listEdges(ref.consId, 'both', true);
  const relatedObjects: Array<{ ref: ConsRef; title: string; relationConsId: string }> = [];
  const seenObj = new Set<string>();
  for (const edge of edges) {
    const otherRef = edge.from.consId === ref.consId ? edge.to : edge.from;
    const key = refKey(otherRef);
    if (seenObj.has(key)) continue;
    const otherCons = await store.getCons(otherRef.consId);
    if (otherCons === null || otherCons.status !== 'active') continue;
    const otherRev = await store.getRevision(otherRef.consId, otherRef.revision);
    if (otherRev === null || otherRev.provenance.source === 'input') continue;
    if (!otherRev.roles.includes('object') && !otherRev.roles.includes('concept')) continue;
    seenObj.add(key);
    relatedObjects.push({
      ref: otherRef,
      title: otherRev.title,
      relationConsId: edge.relationConsId,
    });
  }
  return {
    ref,
    title: rev.title,
    roles: rev.roles,
    body: rev.body,
    sourceRefs: rev.provenance.sourceRefs,
    relatedObjects,
  };
}

/**
 * P0/P1 context retrieval mode for seed.search:
 * Searches active object+concept cons (excluding raw source=input corpus objects),
 * enriches each candidate with its body, aliases, sourceRefs, and bounded one-hop
 * related propositions, gathers related proposition statements, records a trusted
 * server-side snapshot, and returns truncation flags explicitly.
 */
async function contextSearchMode(
  ctx: StepContext,
  input: Record<string, unknown>,
  queries: CoreQuery[],
): Promise<unknown> {
  const roles = Array.isArray(input['roles']) && input['roles'].length > 0
    ? (input['roles'] as ConsRole[])
    : (['object', 'concept'] as ConsRole[]);
  const maxObjects = typeof input['maxObjects'] === 'number' && input['maxObjects'] > 0 ? input['maxObjects'] : 20;
  const maxStatements = typeof input['maxStatements'] === 'number' && input['maxStatements'] > 0 ? input['maxStatements'] : 20;
  const maxRelatedPerObject = typeof input['maxRelatedPerObject'] === 'number' && input['maxRelatedPerObject'] > 0
    ? input['maxRelatedPerObject']
    : 5;
  const excludeInput = input['excludeInputProvenance'] !== false;
  const sourceText = typeof input['sourceText'] === 'string' ? input['sourceText'] : '';

  const objQueries: CoreQuery[] = queries.map((q) => ({ text: q.text, roles }));
  if (sourceText.trim() !== '' && objQueries.length < MAX_QUERIES) {
    objQueries.push({ text: sourceText.slice(0, 80), roles });
  }
  const objectPool = new Map<string, SearchResultItem>();
  const addObjHit = (item: SearchResultItem): void => {
    const prev = objectPool.get(item.ref.consId);
    if (prev === undefined || CHANNEL_ORDER[item.channel] > CHANNEL_ORDER[prev.channel]) {
      objectPool.set(item.ref.consId, item);
    }
  };

  if (sourceText.trim() !== '') {
    const mentioned = await ctx.store.findMentionedCons(sourceText, roles, {
      excludeInputProvenance: excludeInput,
      limit: maxObjects + 5,
    });
    for (const m of mentioned) addObjHit(m);
  }
  const searchedObjs = await searchCore(ctx.store, objQueries, {
    limit: maxObjects + 5,
    excludeInputProvenance: excludeInput,
  });
  for (const s of searchedObjs) addObjHit(s);

  const sortedObjs = [...objectPool.values()].sort((a, b) => {
    const p = CHANNEL_ORDER[b.channel] - CHANNEL_ORDER[a.channel];
    if (p !== 0) return p;
    return a.ref.consId < b.ref.consId ? -1 : 1;
  });

  const objects: EntityCandidate[] = [];
  const items: SearchResultItem[] = [];
  let objectsTruncated = false;
  let anyRelatedTruncated = false;
  const stmtMap = new Map<string, StatementCandidate>();

  for (const hit of sortedObjs) {
    const hydrated = await buildEntityCandidate(ctx.store, hit.ref, maxRelatedPerObject);
    if (hydrated === null) continue;
    if (objects.length >= maxObjects) {
      objectsTruncated = true;
      break;
    }
    objects.push(hydrated.candidate);
    items.push(hit);
    if (hydrated.relatedTruncated) anyRelatedTruncated = true;
    for (const rs of hydrated.candidate.relatedStatements) {
      const k = refKey(rs.ref);
      if (!stmtMap.has(k)) {
        const sc = await buildStatementCandidate(ctx.store, rs.ref);
        if (sc !== null) stmtMap.set(k, sc);
      }
    }
  }

  // Also search active propositions directly to supply statement context.
  const propQueries: CoreQuery[] = queries.map((q) => ({ text: q.text, roles: ['proposition' as ConsRole] }));
  const searchedProps = propQueries.length > 0
    ? await searchCore(ctx.store, propQueries, {
        limit: maxStatements + 5,
        excludeInputProvenance: true,
      })
    : [];
  for (const sp of searchedProps) {
    const k = refKey(sp.ref);
    if (!stmtMap.has(k)) {
      const sc = await buildStatementCandidate(ctx.store, sp.ref);
      if (sc !== null) stmtMap.set(k, sc);
    }
  }

  const allStatements = [...stmtMap.values()].sort((a, b) => (a.ref.consId < b.ref.consId ? -1 : 1));
  const statementsTruncated = allStatements.length > maxStatements || anyRelatedTruncated;
  const statements = allStatements.slice(0, maxStatements);

  const snapshot: TrustedEntityContextSnapshot = {
    objectRefs: objects.map((o) => o.ref),
    statementRefs: statements.map((s) => s.ref),
    truncated: { objects: objectsTruncated, statements: statementsTruncated },
  };
  await ctx.store.putTrustedSnapshot(ctx.run.id, TRUSTED_SNAPSHOT_ENTITY_CONTEXT, ctx.step.id, snapshot);

  await ctx.store.appendEvent(
    'retrieval_performed',
    {
      mode: 'context',
      queries: objQueries,
      objectRefs: snapshot.objectRefs,
      statementRefs: snapshot.statementRefs,
      truncated: snapshot.truncated,
    },
    ctx.run.id,
    ctx.step.id,
  );

  return {
    items,
    objects,
    statements,
    truncated: snapshot.truncated,
    hasExistingContext: objects.length > 0 || statements.length > 0,
  };
}

/**
 * P2 topic summary context collection mode for seed.search:
 * Resolves a single target topic object (or pauses with needs_resolution if
 * multiple homonymous objects exist without confirmed equivalence), collects
 * its directly linked propositions and related-entity context propositions
 * (clearly distinguished), and persists a trusted allowedSourceRefs snapshot.
 */
async function topicSummarySearchMode(
  ctx: StepContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const maxStatements = typeof input['maxStatements'] === 'number' && input['maxStatements'] > 0 ? input['maxStatements'] : 40;
  const topicRefRaw = input['topicRef'];
  const topicQuery = typeof input['topicQuery'] === 'string' ? input['topicQuery'].trim() : '';

  let selectedTopic: EntityCandidate | null = null;
  let ambiguousTopics: EntityCandidate[] = [];

  if (isRef(topicRefRaw)) {
    const built = await buildEntityCandidate(ctx.store, topicRefRaw, 20);
    if (built !== null) {
      selectedTopic = built.candidate;
    }
  } else if (topicQuery !== '') {
    const roles: ConsRole[] = ['object', 'concept'];
    const pool = new Map<string, SearchResultItem>();
    const mentioned = await ctx.store.findMentionedCons(topicQuery, roles, {
      excludeInputProvenance: true,
      limit: 30,
    });
    for (const m of mentioned) pool.set(m.ref.consId, m);
    const searched = await searchCore(ctx.store, [{ text: topicQuery, roles }], {
      limit: 30,
      excludeInputProvenance: true,
    });
    for (const s of searched) {
      const prev = pool.get(s.ref.consId);
      if (prev === undefined || CHANNEL_ORDER[s.channel] > CHANNEL_ORDER[prev.channel]) {
        pool.set(s.ref.consId, s);
      }
    }

    const candidates: EntityCandidate[] = [];
    for (const item of pool.values()) {
      const built = await buildEntityCandidate(ctx.store, item.ref, 10);
      if (built !== null) candidates.push(built.candidate);
    }

    // Prefer exact title/alias matches against the query (or longest mentioned title inside the query).
    const qLower = topicQuery.toLowerCase();
    const exactMatches = candidates.filter(
      (c) => c.title.trim().toLowerCase() === qLower
        || c.aliases.some((a) => a.trim().toLowerCase() === qLower),
    );
    const mentionedMatches = exactMatches.length > 0
      ? exactMatches
      : candidates.filter(
          (c) => (c.title.trim().length >= 2 && qLower.includes(c.title.trim().toLowerCase()))
            || c.aliases.some((a) => a.trim().length >= 2 && qLower.includes(a.trim().toLowerCase())),
        );

    let narrowed = mentionedMatches.length > 0 ? mentionedMatches : candidates;
    if (narrowed.length > 1) {
      // Group by normalized title; if the top matched title has multiple distinct cons
      // (e.g., three separate "屠天勤" entities in a legacy DB), refuse to merge them silently.
      const maxTitleLen = Math.max(...narrowed.map((c) => c.title.trim().length));
      const longestGroup = narrowed.filter((c) => c.title.trim().length === maxTitleLen);
      const uniqueTitles = new Set(longestGroup.map((c) => c.title.trim().toLowerCase()));
      if (uniqueTitles.size === 1 && longestGroup.length > 1) {
        narrowed = longestGroup;
      }
    }

    if (narrowed.length === 1 && narrowed[0] !== undefined) {
      selectedTopic = narrowed[0];
    } else if (narrowed.length > 1) {
      ambiguousTopics = narrowed;
    }
  }

  if (ambiguousTopics.length > 0) {
    const snap: TrustedSummaryContextSnapshot = {
      status: 'needs_resolution',
      topicRef: null,
      ambiguousTopicRefs: ambiguousTopics.map((t) => t.ref),
      allowedSourceRefs: [],
    };
    await ctx.store.putTrustedSnapshot(ctx.run.id, TRUSTED_SNAPSHOT_SUMMARY_CONTEXT, ctx.step.id, snap);
    await ctx.store.appendEvent(
      'retrieval_performed',
      { mode: 'topic_summary', status: 'needs_resolution', ambiguousTopicRefs: snap.ambiguousTopicRefs },
      ctx.run.id,
      ctx.step.id,
    );
    return {
      status: 'needs_resolution',
      topic: null,
      ambiguousTopics,
      directStatements: [],
      relatedContextStatements: [],
      allowedSourceRefs: [],
      truncated: false,
    };
  }

  if (selectedTopic === null) {
    const snap: TrustedSummaryContextSnapshot = {
      status: 'no_topic',
      topicRef: null,
      ambiguousTopicRefs: [],
      allowedSourceRefs: [],
    };
    await ctx.store.putTrustedSnapshot(ctx.run.id, TRUSTED_SNAPSHOT_SUMMARY_CONTEXT, ctx.step.id, snap);
    await ctx.store.appendEvent(
      'retrieval_performed',
      { mode: 'topic_summary', status: 'no_topic', topicQuery },
      ctx.run.id,
      ctx.step.id,
    );
    return {
      status: 'no_topic',
      topic: null,
      ambiguousTopics: [],
      directStatements: [],
      relatedContextStatements: [],
      allowedSourceRefs: [],
      truncated: false,
    };
  }

  // Collect one-hop directly linked propositions and directly linked objects for the topic.
  const directStmtMap = new Map<string, StatementCandidate>();
  const directObjectRefs = new Map<string, { ref: ConsRef; title: string }>();
  const topicEdges = await ctx.store.listEdges(selectedTopic.ref.consId, 'both', true);
  for (const edge of topicEdges) {
    const otherRef = edge.from.consId === selectedTopic.ref.consId ? edge.to : edge.from;
    const otherCons = await ctx.store.getCons(otherRef.consId);
    if (otherCons === null || otherCons.status !== 'active') continue;
    const otherRev = await ctx.store.getRevision(otherRef.consId, otherRef.revision);
    if (otherRev === null || otherRev.provenance.source === 'input') continue;
    if (otherRev.roles.includes('proposition')) {
      const k = refKey(otherRef);
      if (!directStmtMap.has(k)) {
        const sc = await buildStatementCandidate(ctx.store, otherRef);
        if (sc !== null) directStmtMap.set(k, sc);
      }
    } else if (otherRev.roles.includes('object') || otherRev.roles.includes('concept')) {
      directObjectRefs.set(otherRef.consId, { ref: otherRef, title: otherRev.title });
    }
  }

  // Also collect entities co-occurring in the topic's direct statements (e.g. schools).
  const relatedEntities = new Map<string, { ref: ConsRef; title: string }>(directObjectRefs);
  for (const stmt of directStmtMap.values()) {
    for (const ro of stmt.relatedObjects) {
      if (ro.ref.consId !== selectedTopic.ref.consId) {
        relatedEntities.set(ro.ref.consId, { ref: ro.ref, title: ro.title });
      }
    }
  }

  // Gather secondary context statements attached to those related entities or their direct components (e.g., canteens part_of school).
  const secondaryEntities = new Map<string, { ref: ConsRef; title: string; parentTitle?: string }>();
  for (const ent of relatedEntities.values()) {
    secondaryEntities.set(ent.ref.consId, { ref: ent.ref, title: ent.title });
    const entEdges = await ctx.store.listEdges(ent.ref.consId, 'both', true);
    for (const e of entEdges) {
      if (e.relationConsId !== REL_PART_OF) continue;
      const partRef = e.from.consId === ent.ref.consId ? e.to : e.from;
      if (partRef.consId === selectedTopic.ref.consId || secondaryEntities.has(partRef.consId)) continue;
      const pCons = await ctx.store.getCons(partRef.consId);
      if (pCons === null || pCons.status !== 'active') continue;
      const pRev = await ctx.store.getRevision(partRef.consId, partRef.revision);
      if (pRev === null || pRev.provenance.source === 'input') continue;
      if (pRev.roles.includes('object') || pRev.roles.includes('concept')) {
        secondaryEntities.set(partRef.consId, { ref: partRef, title: pRev.title, parentTitle: ent.title });
      }
    }
  }

  const relatedStmtMap = new Map<string, StatementCandidate & { attachedTo: { ref: ConsRef; title: string }; directlyAboutTopic: false }>();
  for (const ent of secondaryEntities.values()) {
    const entEdges = await ctx.store.listEdges(ent.ref.consId, 'both', true);
    for (const e of entEdges) {
      const otherRef = e.from.consId === ent.ref.consId ? e.to : e.from;
      const k = refKey(otherRef);
      if (directStmtMap.has(k) || relatedStmtMap.has(k)) continue;
      const sc = await buildStatementCandidate(ctx.store, otherRef);
      if (sc === null) continue;
      relatedStmtMap.set(k, {
        ...sc,
        attachedTo: { ref: ent.ref, title: ent.title },
        directlyAboutTopic: false,
      });
    }
  }

  const allDirect = [...directStmtMap.values()].sort((a, b) => (a.ref.consId < b.ref.consId ? -1 : 1));
  const allRelated = [...relatedStmtMap.values()].sort((a, b) => (a.ref.consId < b.ref.consId ? -1 : 1));
  const truncated = allDirect.length + allRelated.length > maxStatements;
  const directStatements = allDirect.slice(0, maxStatements);
  const remaining = Math.max(0, maxStatements - directStatements.length);
  const relatedContextStatements = allRelated.slice(0, remaining);

  const allowedSourceMap = new Map<string, ConsRef>();
  const addAllowedSource = (ref: ConsRef): void => {
    allowedSourceMap.set(refKey(ref), ref);
  };
  for (const s of [...directStatements, ...relatedContextStatements]) {
    addAllowedSource(s.ref);
    for (const src of s.sourceRefs) {
      addAllowedSource(src);
    }
  }
  const allowedSourceRefs = [...allowedSourceMap.values()];

  const snap: TrustedSummaryContextSnapshot = {
    status: 'ready',
    topicRef: selectedTopic.ref,
    ambiguousTopicRefs: [],
    allowedSourceRefs,
  };
  await ctx.store.putTrustedSnapshot(ctx.run.id, TRUSTED_SNAPSHOT_SUMMARY_CONTEXT, ctx.step.id, snap);

  await ctx.store.appendEvent(
    'retrieval_performed',
    {
      mode: 'topic_summary',
      status: 'ready',
      topicRef: selectedTopic.ref,
      directStatementRefs: directStatements.map((s) => s.ref),
      relatedContextStatementRefs: relatedContextStatements.map((s) => s.ref),
      allowedSourceRefs,
      truncated,
    },
    ctx.run.id,
    ctx.step.id,
  );

  return {
    status: 'ready',
    topic: selectedTopic,
    ambiguousTopics: [],
    directStatements,
    relatedContextStatements,
    allowedSourceRefs,
    truncated,
  };
}

async function searchPrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const mode = typeof input['mode'] === 'string' ? input['mode'] : 'default';
  if (mode === 'topic_summary') {
    return topicSummarySearchMode(ctx, input);
  }
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
  if (mode === 'context') {
    return contextSearchMode(ctx, input, queries);
  }
  const tendencyScope = input['tendencyScope'];
  if (tendencyScope === 'action_selection' || tendencyScope === 'method_selection' || tendencyScope === 'entity_resolution') {
    return { tendencyRefs: await tendencyCandidatesCore(ctx.store, queries, tendencyScope, input['anchorIds']) };
  }
  if (typeof input['actionId'] === 'string') {
    const r = await methodCandidatesCore(ctx.store, queries, input['actionId'], {
      runId: ctx.run.id,
      stepId: ctx.step.id,
    });
    return { items: r.items, defaultMethod: r.defaultMethod };
  }
  const wantsActions = queries.some((q) => (q.roles ?? []).includes('action'))
    || (extraRoles !== undefined && extraRoles.includes('action'));
  const limit = typeof input['limit'] === 'number' ? input['limit'] : undefined;
  const anchorIds = Array.isArray(input['anchorIds']) ? input['anchorIds'].filter((v): v is string => typeof v === 'string') : [];
  const anchorQueries: CoreQuery[] = anchorIds.map((id) => ({ text: id, ...(extraRoles === undefined ? {} : { roles: extraRoles }) }));
  const searchOpts: {
    limit?: number;
    coldStartRole?: ConsRole;
    runId: string;
    stepId: string;
    expansionTexts?: string[];
    allowedIds?: string[];
    excludeInputProvenance?: boolean;
  } = {
    runId: ctx.run.id,
    stepId: ctx.step.id,
  };
  const allowedActionIds = Array.isArray(input['allowedActionIds']) ? input['allowedActionIds'].filter((v): v is string => typeof v === 'string') : [];
  if (allowedActionIds.length > 0) searchOpts.allowedIds = allowedActionIds;
  if (limit !== undefined) searchOpts.limit = limit;
  if (input['excludeInputProvenance'] === true) searchOpts.excludeInputProvenance = true;
  if (wantsActions) {
    searchOpts.coldStartRole = 'action';
    const inputState = ctx.run.state['input'];
    const inputText = isRecord(inputState) && typeof inputState['text'] === 'string' ? inputState['text'] : '';
    searchOpts.expansionTexts = [ctx.run.task, inputText.slice(0, 50)];
  }
  let items = await searchCore(ctx.store, [...anchorQueries, ...queries], searchOpts);
  if (input['contentActionsOnly'] === true) {
    const baseInput: Record<string, unknown> = {
      input: input['contextInput'] !== undefined ? input['contextInput'] : (ctx.run.state['inputCons'] ?? { text: '' }),
      task: typeof input['contextTask'] === 'string' ? input['contextTask'] : ctx.run.task,
    };
    const optionalInput: Record<string, unknown> | undefined = Array.isArray(input['contextCandidates'])
      ? { candidates: input['contextCandidates'] }
      : undefined;
    const filtered: SearchResultItem[] = [];
    for (const item of items) {
      const rev = await ctx.store.getRevision(item.ref.consId, item.ref.revision);
      if (rev !== null && isContentActionCompatible(rev.spec, baseInput, optionalInput)) filtered.push(item);
    }
    items = filtered;
  }
  return { items };
}

function isArrayType(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value === 'array';
  if (Array.isArray(value)) return value.length > 0 && value.every((t) => t === 'array');
  return false;
}

export function adaptInputForSchema(
  inputSchema: unknown,
  baseInput: Record<string, unknown>,
  optionalInput?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...baseInput };
  if (optionalInput === undefined) return result;
  const schemaObj = isRecord(inputSchema) ? inputSchema : {};
  const properties = isRecord(schemaObj['properties']) ? schemaObj['properties'] : null;
  const allowExtra = properties === null && schemaObj['additionalProperties'] !== false;
  for (const [key, value] of Object.entries(optionalInput)) {
    if (value === undefined) continue;
    if (key in result) continue;
    if (allowExtra || (properties !== null && key in properties)) {
      result[key] = value;
    }
  }
  return result;
}

export function isContentActionCompatible(
  spec: unknown,
  baseInput?: Record<string, unknown>,
  optionalInput?: Record<string, unknown>,
): boolean {
  if (!isRecord(spec) || spec['kind'] !== 'action' || spec['executor'] !== 'llm') return false;
  const allowedEffects = spec['allowedEffects'];
  if (!Array.isArray(allowedEffects) || !allowedEffects.every((e) => e === 'return_artifacts')) return false;
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
  const inputSchema = isRecord(spec['inputSchema']) ? spec['inputSchema'] : {};
  const inProps = isRecord(inputSchema['properties']) ? inputSchema['properties'] : null;
  if (inProps !== null && !('input' in inProps) && !('task' in inProps)) return false;
  const probeBase = baseInput ?? { input: {}, task: '' };
  const candidateInput = adaptInputForSchema(inputSchema, probeBase, optionalInput);
  return validateSchema(inputSchema, candidateInput).ok;
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
  concept: ['concept'],
  proposition: ['proposition'],
  relation_type: ['relation_type'],
  method: ['method'],
  tendency: ['tendency'],
  action: ['action'],
};

function mergeUniqueStrings(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...base, ...extra]) {
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

function compileMethodDraft(
  draft: unknown,
  sourceCaseRef: unknown,
): { candidates: Array<Record<string, unknown>>; pendingMethodBinding: { actionId: string; tempId: string } } {
  if (!isRecord(draft)) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: methodDraft must be an object');
  }
  const title = nonEmptyString(draft['title']);
  const actionId = nonEmptyString(draft['actionId']);
  const instructions = nonEmptyString(draft['instructions']);
  const applicabilityText = nonEmptyString(draft['applicabilityText']);
  if (title === null || actionId === null || instructions === null || applicabilityText === null) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: methodDraft requires non-empty title, actionId, instructions, and applicabilityText');
  }
  const tempId = 'method_draft_1';
  const sourceRefs = isRef(sourceCaseRef) ? [sourceCaseRef] : [];
  return {
    candidates: [
      {
        tempId,
        kind: 'method',
        content: {
          title,
          body: instructions,
          aliases: asStringArray(draft['aliases']),
          searchTerms: asStringArray(draft['searchTerms']),
          applicabilityText,
          sourceRefs,
          spec: {
            kind: 'method',
            actionId,
            instructions,
            applicabilityText,
          },
        },
      },
    ],
    pendingMethodBinding: { actionId, tempId },
  };
}

function compileTendencyDraft(
  draft: unknown,
  sourceCaseRef: unknown,
): { candidates: Array<Record<string, unknown>>; preferIds: string[]; avoidIds: string[]; tempId: string } {
  if (!isRecord(draft)) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: tendencyDraft must be an object');
  }
  const title = nonEmptyString(draft['title']);
  const scope = draft['scope'];
  const applicabilityText = nonEmptyString(draft['applicabilityText']);
  const preferenceText = nonEmptyString(draft['preferenceText']);
  if (
    title === null ||
    (scope !== 'action_selection' && scope !== 'method_selection') ||
    applicabilityText === null ||
    preferenceText === null
  ) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: tendencyDraft requires valid title, scope, applicabilityText, and preferenceText');
  }
  const preferIds = asStringArray(draft['preferIds']);
  const avoidIds = asStringArray(draft['avoidIds']);
  const tempId = 'tendency_draft_1';
  const sourceRefs = isRef(sourceCaseRef) ? [sourceCaseRef] : [];
  return {
    candidates: [
      {
        tempId,
        kind: 'tendency',
        content: {
          title,
          body: preferenceText,
          aliases: asStringArray(draft['aliases']),
          searchTerms: asStringArray(draft['searchTerms']),
          applicabilityText,
          sourceRefs,
          spec: {
            kind: 'tendency',
            scope,
            applicabilityText,
            preferenceText,
            preferIds,
            avoidIds,
          },
        },
      },
    ],
    preferIds,
    avoidIds,
    tempId,
  };
}

function compileActionDraft(
  draft: unknown,
): { candidates: Array<Record<string, unknown>>; methodBindings: Array<{ actionId: string; methodRef: string }> } {
  if (!isRecord(draft)) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: actionDraft must be an object');
  }
  const title = nonEmptyString(draft['title']);
  const body = nonEmptyString(draft['body']);
  const inputSchema = draft['inputSchema'];
  const outputSchema = draft['outputSchema'];
  const freedom = draft['freedom'];
  const defaultMethod = draft['defaultMethod'];
  if (
    title === null ||
    body === null ||
    !isRecord(inputSchema) ||
    !isRecord(outputSchema) ||
    !isRecord(freedom) ||
    !isRecord(defaultMethod)
  ) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: actionDraft missing required fields');
  }
  const methodTitle = nonEmptyString(defaultMethod['title']);
  const methodInstructions = nonEmptyString(defaultMethod['instructions']);
  const methodApplicability = nonEmptyString(defaultMethod['applicabilityText']);
  if (methodTitle === null || methodInstructions === null || methodApplicability === null) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: actionDraft.defaultMethod requires non-empty title, instructions, and applicabilityText');
  }
  const actionTempId = 'action_draft_1';
  const methodTempId = 'action_default_method_1';
  return {
    candidates: [
      {
        tempId: methodTempId,
        kind: 'method',
        content: {
          title: methodTitle,
          body: methodInstructions,
          aliases: asStringArray(defaultMethod['aliases']),
          searchTerms: asStringArray(defaultMethod['searchTerms']),
          applicabilityText: methodApplicability,
          spec: {
            kind: 'method',
            actionId: actionTempId,
            instructions: methodInstructions,
            applicabilityText: methodApplicability,
          },
        },
      },
      {
        tempId: actionTempId,
        kind: 'action',
        content: {
          title,
          body,
          aliases: asStringArray(draft['aliases']),
          searchTerms: asStringArray(draft['searchTerms']),
          spec: {
            kind: 'action',
            inputSchema,
            outputSchema,
            executor: 'llm',
            defaultMethodId: methodTempId,
            allowedEffects: ['return_artifacts'],
            freedom,
          },
        },
      },
    ],
    methodBindings: [{ actionId: actionTempId, methodRef: methodTempId }],
  };
}

async function formPrimitive(ctx: StepContext): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  const resultKey = `${ctx.step.id}:result`;
  return ctx.store.transaction(async () => {
    const savedAll = await ctx.store.getIdempotencyResult(resultKey);
    if (savedAll !== null) return savedAll;

    let candidates: unknown[] = [];
    const compiledMethodBindings: Array<{ actionId: string; methodRef: ConsRef | string }> = [];
    let pendingMethodBinding: { actionId: string; tempId: string } | null = null;
    let pendingTendencyLinks: { tempId: string; preferIds: string[]; avoidIds: string[] } | null = null;

    if (input['methodDraft'] !== undefined) {
      const compiled = compileMethodDraft(input['methodDraft'], input['sourceCaseRef']);
      candidates = compiled.candidates;
      pendingMethodBinding = compiled.pendingMethodBinding;
    } else if (input['tendencyDraft'] !== undefined) {
      const compiled = compileTendencyDraft(input['tendencyDraft'], input['sourceCaseRef']);
      candidates = compiled.candidates;
      pendingTendencyLinks = { tempId: compiled.tempId, preferIds: compiled.preferIds, avoidIds: compiled.avoidIds };
    } else if (input['actionDraft'] !== undefined) {
      const compiled = compileActionDraft(input['actionDraft']);
      candidates = compiled.candidates;
      compiledMethodBindings.push(...compiled.methodBindings);
    } else if (Array.isArray(input['candidates'])) {
      candidates = input['candidates'];
    } else {
      throw new PrimitiveError('schema_mismatch', 'schema_mismatch: form requires candidates or a structured draft');
    }

    const metadataMap = new Map<string, { aliases: string[]; searchTerms: string[]; applicabilityText?: string }>();
    if (Array.isArray(input['metadata'])) {
      for (const m of input['metadata']) {
        if (!isRecord(m) || typeof m['tempId'] !== 'string' || m['tempId'].trim() === '') continue;
        const entry: { aliases: string[]; searchTerms: string[]; applicabilityText?: string } = {
          aliases: asStringArray(m['aliases']),
          searchTerms: asStringArray(m['searchTerms']),
        };
        if (typeof m['applicabilityText'] === 'string' && m['applicabilityText'].trim() !== '') {
          entry.applicabilityText = m['applicabilityText'];
        }
        metadataMap.set(m['tempId'], entry);
      }
    }

    const formed: Array<{ tempId: string; consRef: ConsRef }> = [];
    const formedByTempId = new Map<string, ConsRef>();
    const seenTempIds = new Set<string>();
    let opIndex = 0;

    for (const c of candidates) {
      if (!isRecord(c)) continue;
      const tempId = asString(c['tempId'], '');
      if (tempId !== '') {
        if (seenTempIds.has(tempId)) {
          throw new PrimitiveError('schema_mismatch', `schema_mismatch: duplicate tempId "${tempId}" in form candidates`);
        }
        seenTempIds.add(tempId);
        await assertTempIdNamespace(ctx.store, tempId);
      }
      const kind = asString(c['kind'], 'object');
      const content = isRecord(c['content']) ? c['content'] : {};
      const key = `${ctx.step.id}:${String(opIndex)}`;
      opIndex += 1;
      const saved = await ctx.store.getIdempotencyResult(key);
      if (saved !== null && isRecord(saved) && isRef(saved['consRef'])) {
        formed.push({ tempId, consRef: saved['consRef'] });
        if (tempId !== '') formedByTempId.set(tempId, saved['consRef']);
        continue;
      }
      const title = nonEmptyString(content['title']);
      if (title === null) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: candidate "${tempId}" is missing a non-empty content.title`);
      }
      const rawBody = nonEmptyString(content['body']) ?? (kind === 'method' ? nonEmptyString(content['instructions']) : null);
      if (rawBody === null) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: candidate "${tempId}" is missing a non-empty content.body`);
      }
      const meta = tempId !== '' ? metadataMap.get(tempId) : undefined;
      const aliases = mergeUniqueStrings(asStringArray(content['aliases']), meta?.aliases ?? []);
      const searchTerms = mergeUniqueStrings(asStringArray(content['searchTerms']), meta?.searchTerms ?? []);
      const id = randomUUID();
      const revInput: Omit<ConsRevision, 'revision' | 'createdAt'> = {
        consId: id,
        title,
        roles: KIND_ROLES[kind] ?? ['object'],
        body: rawBody,
        aliases,
        searchTerms,
        provenance: {
          source: 'llm',
          runId: ctx.run.id,
          stepId: ctx.step.id,
          sourceRefs: asRefs(content['sourceRefs']),
        },
      };
      if (typeof content['applicabilityText'] === 'string' && content['applicabilityText'].trim() !== '') {
        revInput.applicabilityText = content['applicabilityText'];
      } else if (meta?.applicabilityText !== undefined) {
        revInput.applicabilityText = meta.applicabilityText;
      }
      if (content['spec'] !== undefined && isRecord(content['spec'])) {
        revInput.spec = content['spec'] as unknown as NonNullable<ConsRevision['spec']>;
      }
      await ctx.store.createCons(revInput);
      const consRef = { consId: id, revision: 1 };
      await ctx.store.putIdempotencyResult(key, { consRef });
      formed.push({ tempId, consRef });
      if (tempId !== '') formedByTempId.set(tempId, consRef);
    }

    if (pendingMethodBinding !== null) {
      const ref = formedByTempId.get(pendingMethodBinding.tempId);
      if (ref !== undefined) {
        compiledMethodBindings.push({ actionId: pendingMethodBinding.actionId, methodRef: ref });
      }
    }

    const compiledEdges: Array<{ from: ConsRef; relationConsId: string; to: ConsRef }> = [];
    if (pendingTendencyLinks !== null) {
      const fromRef = formedByTempId.get(pendingTendencyLinks.tempId);
      if (fromRef !== undefined) {
        for (const targetId of pendingTendencyLinks.preferIds) {
          const toRef = await activeRef(ctx.store, targetId);
          if (toRef !== null) {
            compiledEdges.push({ from: fromRef, relationConsId: REL_PREFERS, to: toRef });
          }
        }
        for (const targetId of pendingTendencyLinks.avoidIds) {
          const toRef = await activeRef(ctx.store, targetId);
          if (toRef !== null) {
            compiledEdges.push({ from: fromRef, relationConsId: REL_AVOIDS, to: toRef });
          }
        }
      }
    }

    const out: Record<string, unknown> = { formed };
    if (compiledMethodBindings.length > 0) {
      out['methodBindings'] = compiledMethodBindings;
    }
    if (compiledEdges.length > 0) {
      out['edges'] = compiledEdges;
    }
    await ctx.store.putIdempotencyResult(resultKey, out);
    return out;
  });
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

/**
 * Create a new active edge or reuse an existing active structural edge with the same
 * (from, relationConsId, to) triple, appending supporting evidenceRefs without losing
 * provenance from earlier inputs.
 */
async function createOrReuseEdgeInTx(
  store: ConsStoreApi,
  from: ConsRef,
  relationConsId: string,
  to: ConsRef,
  stepId: string,
  evidenceRefs: ConsRef[],
): Promise<{ edge: ConsEdge; reused: boolean }> {
  const existing = await store.findActiveEdge(from, relationConsId, to);
  if (existing !== null) {
    if (evidenceRefs.length > 0) {
      await store.addEdgeEvidence(existing.id, evidenceRefs, stepId);
    }
    return { edge: existing, reused: true };
  }
  const edge = await store.createEdge({
    from,
    relationConsId,
    to,
    createdByStepId: stepId,
    status: 'active',
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  });
  return { edge, reused: false };
}

/**
 * Verify that an existing ConsRef still refers to an active cons whose active and
 * current revision match the snapshot revision (no silent upgrade on version drift).
 */
async function assertActiveVersionMatch(
  store: ConsStoreApi,
  ref: ConsRef,
  label: string,
): Promise<ConsRevision> {
  const cons = await store.getCons(ref.consId);
  if (cons === null) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: ${label} ${ref.consId} not found`);
  }
  if (cons.status !== 'active') {
    throw new PrimitiveError('invalid_reference', `invalid_reference: ${label} ${ref.consId} is not active`);
  }
  if (activeRevisionOf(cons) !== ref.revision || cons.currentRevision !== ref.revision) {
    throw new PrimitiveError(
      'revision_conflict',
      `revision_conflict: ${label} ${ref.consId}@${String(ref.revision)} is stale (active=${String(activeRevisionOf(cons))}, current=${String(cons.currentRevision)})`,
    );
  }
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null) {
    throw new PrimitiveError('unknown_reference', `unknown_reference: ${label} revision ${refKey(ref)} not found`);
  }
  return rev;
}

/**
 * Controlled single-transaction materialize + connect primitive.
 *
 * Handles two modes:
 * 1. Topic summary mode (`summaryDraft`): validates sourceRefs against the server-trusted
 *    `summary_context` snapshot, creates a new record cons (or CAS revision when updating),
 *    activates it, and links it to the topic and source records without modifying originals.
 * 2. Content batch mode (`artifacts`): validates resolutions against server-trusted
 *    `entity_context` and `entity_resolution` snapshots, checks candidate versions for drift,
 *    creates only `create`/proposition/relation_type cons, maps reused tempIds to existing
 *    ConsRefs without mutating or re-activating reused objects, compiles local links and
 *    explicit P1 associations, activates newly created cons, deduplicates structural edges
 *    while preserving per-input evidence, and stores idempotency results atomically.
 */
async function materializeAndConnectPrimitive(ctx: StepContext, stepId: string): Promise<unknown> {
  const input = isRecord(ctx.envelope.input) ? ctx.envelope.input : {};
  if (input['summaryDraft'] !== undefined) {
    return materializeSummaryInTx(ctx, stepId, input);
  }
  return materializeContentBatchInTx(ctx, stepId, input);
}

async function materializeSummaryInTx(
  ctx: StepContext,
  stepId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const draft = input['summaryDraft'];
  if (!isRecord(draft)) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: summaryDraft must be an object');
  }
  const topicRef = input['topicRef'];
  if (!isRef(topicRef)) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: topicRef is required for summary materialization');
  }
  const title = nonEmptyString(draft['title']);
  const body = nonEmptyString(draft['body']);
  if (title === null || body === null) {
    throw new PrimitiveError('schema_mismatch', 'schema_mismatch: summaryDraft requires non-empty title and body');
  }
  const sourceRefs = asRefs(draft['sourceRefs']);
  const coverage = asStringArray(draft['coverage']);
  const openQuestions = asStringArray(draft['openQuestions']);
  const aliases = asStringArray(draft['aliases']);
  const searchTerms = asStringArray(draft['searchTerms']);
  const activate = input['activate'] !== false;
  const updateRaw = input['updateSummaryRef'];

  return ctx.store.transaction(async (): Promise<unknown> => {
    const saved = await ctx.store.getIdempotencyResult(materializeResultKey(stepId));
    if (saved !== null) return saved;

    const snap = await ctx.store.getTrustedSnapshot<TrustedSummaryContextSnapshot>(
      ctx.run.id,
      TRUSTED_SNAPSHOT_SUMMARY_CONTEXT,
    );
    if (snap === null || snap.payload.status !== 'ready' || snap.payload.topicRef === null) {
      throw new PrimitiveError('unauthorized_effect', 'unauthorized_effect: missing verified summary_context snapshot');
    }
    if (refKey(snap.payload.topicRef) !== refKey(topicRef)) {
      throw new PrimitiveError('invalid_reference', 'invalid_reference: topicRef does not match verified summary_context');
    }
    await assertActiveVersionMatch(ctx.store, topicRef, 'summary topic');

    const allowedSources = new Set(snap.payload.allowedSourceRefs.map(refKey));
    for (const sref of sourceRefs) {
      if (!allowedSources.has(refKey(sref))) {
        throw new PrimitiveError(
          'invalid_reference',
          `invalid_reference: summary sourceRef ${refKey(sref)} is outside verified summary_context`,
        );
      }
      await assertEndpointRevision(ctx.store, sref, 'summary sourceRef');
    }

    // Format summary body while preserving explicit coverage and open questions.
    const sections = [body.trim()];
    if (coverage.length > 0) {
      sections.push(`\n覆盖条目：${coverage.join('；')}`);
    }
    if (openQuestions.length > 0) {
      sections.push(`\n待补充/未明确：${openQuestions.join('；')}`);
    }
    const fullBody = sections.join('\n');

    let summaryRef: ConsRef;
    if (isRecord(updateRaw) && typeof updateRaw['consId'] === 'string' && typeof updateRaw['expectedRevision'] === 'number') {
      const targetId = updateRaw['consId'];
      const expectedRev = updateRaw['expectedRevision'];
      const existing = await ctx.store.getCons(targetId);
      if (existing === null) {
        throw new PrimitiveError('unknown_reference', `unknown_reference: summary cons ${targetId} not found`);
      }
      if (existing.currentRevision !== expectedRev) {
        throw new PrimitiveError(
          'revision_conflict',
          `revision_conflict: summary ${targetId} expected revision ${String(expectedRev)} but current is ${String(existing.currentRevision)}`,
        );
      }
      const created = await ctx.store.createRevision(targetId, {
        title,
        roles: ['record'],
        body: fullBody,
        aliases,
        searchTerms: mergeUniqueStrings(searchTerms, ['汇总', title]),
        provenance: {
          source: 'llm',
          runId: ctx.run.id,
          stepId,
          sourceRefs,
        },
      });
      summaryRef = { consId: targetId, revision: created.revision };
    } else {
      const id = randomUUID();
      await ctx.store.createCons({
        consId: id,
        title,
        roles: ['record'],
        body: fullBody,
        aliases,
        searchTerms: mergeUniqueStrings(searchTerms, ['汇总', title]),
        provenance: {
          source: 'llm',
          runId: ctx.run.id,
          stepId,
          sourceRefs,
        },
      });
      summaryRef = { consId: id, revision: 1 };
    }

    if (activate) {
      await activateConsInTx(ctx.store, summaryRef.consId, summaryRef.revision, {
        activatedBy: stepId,
        runId: ctx.run.id,
        stepId,
      });
    }

    const edgeIds: string[] = [];
    const reusedEdgeIds: string[] = [];
    const descRes = await createOrReuseEdgeInTx(ctx.store, summaryRef, REL_DESCRIBES, topicRef, stepId, sourceRefs);
    (descRes.reused ? reusedEdgeIds : edgeIds).push(descRes.edge.id);

    for (const sref of sourceRefs) {
      const srcRes = await createOrReuseEdgeInTx(ctx.store, summaryRef, REL_DERIVED_FROM, sref, stepId, [sref]);
      (srcRes.reused ? reusedEdgeIds : edgeIds).push(srcRes.edge.id);
    }

    await ctx.store.appendEvent(
      'summary_materialized',
      {
        summaryRef,
        topicRef,
        sourceRefs,
        coverage,
        openQuestions,
      },
      ctx.run.id,
      stepId,
    );

    const out = {
      connected: [summaryRef],
      created: [summaryRef],
      reused: [] as ConsRef[],
      edges: edgeIds,
      reusedEdges: reusedEdgeIds,
      tempMappings: { summary: summaryRef },
    };
    await ctx.store.putIdempotencyResult(materializeResultKey(stepId), out);
    return out;
  });
}

async function materializeContentBatchInTx(
  ctx: StepContext,
  stepId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const artifacts = Array.isArray(input['artifacts']) ? input['artifacts'] : [];
  const links = Array.isArray(input['links']) ? input['links'] : [];
  const associations = Array.isArray(input['associations']) ? input['associations'] : [];
  const metadataRaw = Array.isArray(input['metadata']) ? input['metadata'] : [];
  const inputRef = isRef(input['inputRef']) ? input['inputRef'] : null;
  const activate = input['activate'] !== false;
  const allowRelationTypeActivation = input['allowRelationTypeActivation'] === true;

  return ctx.store.transaction(async (): Promise<unknown> => {
    const saved = await ctx.store.getIdempotencyResult(materializeResultKey(stepId));
    if (saved !== null) return saved;

    // 1. Load server-trusted candidate snapshot and entity resolution authorization.
    const contextSnap = await ctx.store.getTrustedSnapshot<TrustedEntityContextSnapshot>(
      ctx.run.id,
      TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
    );
    const resolutionSnap = await ctx.store.getTrustedSnapshot<TrustedEntityResolutionSnapshot>(
      ctx.run.id,
      TRUSTED_SNAPSHOT_ENTITY_RESOLUTION,
    );
    if (resolutionSnap === null) {
      throw new PrimitiveError(
        'unauthorized_effect',
        'unauthorized_effect: missing verified entity_resolution snapshot for materialize_and_connect',
      );
    }
    if (resolutionSnap.payload.confirmedByHuman !== true) {
      const resStep = await ctx.store.getStepById(resolutionSnap.stepId);
      if (resStep === null || resStep.runId !== ctx.run.id || resStep.status !== 'succeeded') {
        throw new PrimitiveError(
          'unauthorized_effect',
          'unauthorized_effect: entity_resolution snapshot does not reference a succeeded step in this run',
        );
      }
    }
    if (resolutionSnap.payload.unresolvedTempIds.length > 0) {
      throw new PrimitiveError(
        'unauthorized_effect',
        `unauthorized_effect: unresolved entities remain (${resolutionSnap.payload.unresolvedTempIds.join(', ')})`,
      );
    }

    const allowedObjectSet = new Set((contextSnap?.payload.objectRefs ?? []).map(refKey));
    const allowedContextEndpointSet = new Set([
      ...(contextSnap?.payload.objectRefs ?? []).map(refKey),
      ...(contextSnap?.payload.statementRefs ?? []).map(refKey),
    ]);
    const allowedEvidenceSet = new Set<string>([...allowedContextEndpointSet]);
    if (inputRef !== null) {
      allowedEvidenceSet.add(refKey(inputRef));
    }

    // 2. Validate batch artifacts against resolutions and tempId namespace.
    const resolutionByTempId = new Map<string, EntityResolutionItem>();
    for (const r of resolutionSnap.payload.resolutions) {
      if (resolutionByTempId.has(r.tempId)) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: duplicate resolution for tempId "${r.tempId}"`);
      }
      resolutionByTempId.set(r.tempId, r);
    }

    const seenTempIds = new Set<string>();
    const reusedTempToRef = new Map<string, ConsRef>();
    const createArtifacts: Array<{ tempId: string; kind: string; content: Record<string, unknown> }> = [];

    for (const raw of artifacts) {
      if (!isRecord(raw)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: artifact item must be an object');
      }
      const tempId = nonEmptyString(raw['tempId']);
      if (tempId === null) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: artifact tempId must be a non-empty string');
      }
      if (seenTempIds.has(tempId)) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: duplicate tempId "${tempId}" in batch`);
      }
      seenTempIds.add(tempId);
      await assertTempIdNamespace(ctx.store, tempId);

      const kind = asString(raw['kind'], '');
      const roles = KIND_ROLES[kind];
      if (roles === undefined) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: unsupported artifact kind "${kind}"`);
      }
      const content = isRecord(raw['content']) ? raw['content'] : {};

      if (kind === 'object' || kind === 'concept') {
        const res = resolutionByTempId.get(tempId);
        if (res === undefined) {
          throw new PrimitiveError(
            'unauthorized_effect',
            `unauthorized_effect: entity artifact "${tempId}" has no verified resolution decision`,
          );
        }
        if (res.decision === 'unresolved') {
          throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: entity "${tempId}" is unresolved`);
        }
        if (res.decision === 'reuse') {
          if (!isRef(res.existingRef)) {
            throw new PrimitiveError('schema_mismatch', `schema_mismatch: reuse resolution for "${tempId}" missing existingRef`);
          }
          if (!allowedObjectSet.has(refKey(res.existingRef))) {
            throw new PrimitiveError(
              'invalid_reference',
              `invalid_reference: reused ref ${refKey(res.existingRef)} for "${tempId}" is outside the verified candidate set`,
            );
          }
          // Ensure candidate revision has not drifted since retrieval.
          await assertActiveVersionMatch(ctx.store, res.existingRef, `reused entity "${tempId}"`);
          reusedTempToRef.set(tempId, res.existingRef);
          continue;
        }
      }
      createArtifacts.push({ tempId, kind, content });
    }

    // Ensure no stray resolution references an unknown tempId.
    for (const tid of resolutionByTempId.keys()) {
      if (!seenTempIds.has(tid)) {
        throw new PrimitiveError('invalid_reference', `invalid_reference: resolution tempId "${tid}" not found in artifacts`);
      }
    }

    // 3. Validate metadata applies ONLY to create items (never mutates reused objects).
    const metadataMap = new Map<string, { aliases: string[]; searchTerms: string[]; applicabilityText?: string }>();
    for (const m of metadataRaw) {
      if (!isRecord(m) || typeof m['tempId'] !== 'string' || m['tempId'].trim() === '') continue;
      const tid = m['tempId'];
      if (reusedTempToRef.has(tid)) {
        throw new PrimitiveError(
          'unauthorized_effect',
          `unauthorized_effect: metadata must not target reused entity "${tid}"`,
        );
      }
      const entry: { aliases: string[]; searchTerms: string[]; applicabilityText?: string } = {
        aliases: asStringArray(m['aliases']),
        searchTerms: asStringArray(m['searchTerms']),
      };
      if (typeof m['applicabilityText'] === 'string' && m['applicabilityText'].trim() !== '') {
        entry.applicabilityText = m['applicabilityText'];
      }
      metadataMap.set(tid, entry);
    }

    // 4. Form only the newly created items inside this transaction.
    const tempMap = new Map<string, ConsRef>(reusedTempToRef);
    const createdItems: Array<{ tempId: string; consRef: ConsRef; roles: ConsRole[] }> = [];
    const relationTypeDrafts: Array<{ tempId: string; consRef: ConsRef }> = [];
    const createdRolesById = new Map<string, ConsRole[]>();

    for (const item of createArtifacts) {
      const title = nonEmptyString(item.content['title']);
      if (title === null) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: candidate "${item.tempId}" missing content.title`);
      }
      const rawBody = nonEmptyString(item.content['body']);
      if (rawBody === null) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: candidate "${item.tempId}" missing content.body`);
      }
      const roles = KIND_ROLES[item.kind] ?? ['object'];
      if (activate && roles.includes('relation_type') && !allowRelationTypeActivation) {
        throw new PrimitiveError(
          'unauthorized_effect',
          'unauthorized_effect: activating new relation_type drafts requires explicit flow authorization',
        );
      }
      const meta = metadataMap.get(item.tempId);
      const aliases = mergeUniqueStrings(asStringArray(item.content['aliases']), meta?.aliases ?? []);
      const searchTerms = mergeUniqueStrings(asStringArray(item.content['searchTerms']), meta?.searchTerms ?? []);
      const sourceRefs = mergeRefLists(asRefs(item.content['sourceRefs']), inputRef !== null ? [inputRef] : []);
      const id = randomUUID();
      const revInput: Omit<ConsRevision, 'revision' | 'createdAt'> = {
        consId: id,
        title,
        roles,
        body: rawBody,
        aliases,
        searchTerms,
        provenance: {
          source: 'llm',
          runId: ctx.run.id,
          stepId,
          sourceRefs,
        },
      };
      if (typeof item.content['applicabilityText'] === 'string' && item.content['applicabilityText'].trim() !== '') {
        revInput.applicabilityText = item.content['applicabilityText'];
      } else if (meta?.applicabilityText !== undefined) {
        revInput.applicabilityText = meta.applicabilityText;
      }
      await ctx.store.createCons(revInput);
      const consRef: ConsRef = { consId: id, revision: 1 };
      tempMap.set(item.tempId, consRef);
      createdItems.push({ tempId: item.tempId, consRef, roles });
      createdRolesById.set(consRef.consId, roles);
      if (roles.includes('relation_type')) {
        relationTypeDrafts.push({ tempId: item.tempId, consRef });
      }
    }

    // 5. Helper to resolve & validate relation target (separated from endpoint checks).
    const resolveRelation = async (relSpec: unknown): Promise<string> => {
      if (!isRecord(relSpec)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: edge requires relation object');
      }
      const kind = relSpec['kind'];
      if (kind === 'existing') {
        if (relSpec['tempId'] !== undefined || !isRef(relSpec['ref'])) {
          throw new PrimitiveError('schema_mismatch', 'schema_mismatch: existing relation requires ref without tempId');
        }
        const relRef = relSpec['ref'];
        const relRev = await assertActiveVersionMatch(ctx.store, relRef, 'relation_type');
        if (!relRev.roles.includes('relation_type')) {
          throw new PrimitiveError(
            'unauthorized_effect',
            `unauthorized_effect: relation ${refKey(relRef)} is not an active relation_type`,
          );
        }
        return relRef.consId;
      }
      if (kind === 'draft') {
        if (relSpec['ref'] !== undefined || typeof relSpec['tempId'] !== 'string' || relSpec['tempId'].trim() === '') {
          throw new PrimitiveError('schema_mismatch', 'schema_mismatch: draft relation requires tempId without ref');
        }
        if (!activate || !allowRelationTypeActivation) {
          throw new PrimitiveError(
            'unauthorized_effect',
            'unauthorized_effect: referencing a draft relation_type requires explicit flow authorization',
          );
        }
        const draftRef = tempMap.get(relSpec['tempId']);
        if (draftRef === undefined) {
          throw new PrimitiveError('unknown_reference', `draft relation tempId "${relSpec['tempId']}" not found in batch`);
        }
        const roles = createdRolesById.get(draftRef.consId);
        if (roles === undefined || !roles.includes('relation_type')) {
          throw new PrimitiveError(
            'unauthorized_effect',
            `unauthorized_effect: draft tempId "${relSpec['tempId']}" is not a relation_type`,
          );
        }
        return draftRef.consId;
      }
      throw new PrimitiveError('schema_mismatch', `schema_mismatch: unsupported relation kind "${String(kind)}"`);
    };

    // 6. Plan local content links (fromTempId / toTempId mapped via tempMap, including reused refs).
    const plannedEdges: Array<{ from: ConsRef; to: ConsRef; relationConsId: string; evidenceRefs: ConsRef[] }> = [];
    const defaultEvidence = inputRef !== null ? [inputRef] : [];

    for (const e of links) {
      if (!isRecord(e)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: link item must be an object');
      }
      const fromTemp = e['fromTempId'];
      const toTemp = e['toTempId'];
      if (typeof fromTemp !== 'string' || typeof toTemp !== 'string') {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: local link requires fromTempId and toTempId');
      }
      const from = tempMap.get(fromTemp) ?? null;
      const to = tempMap.get(toTemp) ?? null;
      if (from === null || to === null) {
        throw new PrimitiveError('unknown_reference', `unknown_reference: local link endpoint (${fromTemp} -> ${toTemp}) unresolved`);
      }
      const relationConsId = await resolveRelation(e['relation']);
      plannedEdges.push({ from, to, relationConsId, evidenceRefs: defaultEvidence });
    }

    // 7. Plan explicit P1 cross-input associations (explicit draft/existing union endpoints + evidenceRefs).
    const resolveExplicitEndpoint = async (ep: unknown, label: string): Promise<ConsRef> => {
      if (!isRecord(ep)) {
        throw new PrimitiveError('schema_mismatch', `schema_mismatch: association ${label} must be an object`);
      }
      const kind = ep['kind'];
      if (kind === 'draft') {
        if (ep['ref'] !== undefined || typeof ep['tempId'] !== 'string' || ep['tempId'].trim() === '') {
          throw new PrimitiveError('schema_mismatch', `schema_mismatch: draft ${label} requires tempId without ref`);
        }
        const mapped = tempMap.get(ep['tempId']);
        if (mapped === undefined) {
          throw new PrimitiveError('invalid_reference', `invalid_reference: draft ${label} tempId "${ep['tempId']}" not in batch`);
        }
        return mapped;
      }
      if (kind === 'existing') {
        if (ep['tempId'] !== undefined || !isRef(ep['ref'])) {
          throw new PrimitiveError('schema_mismatch', `schema_mismatch: existing ${label} requires ref without tempId`);
        }
        if (!allowedContextEndpointSet.has(refKey(ep['ref']))) {
          throw new PrimitiveError(
            'invalid_reference',
            `invalid_reference: existing ${label} ${refKey(ep['ref'])} is outside the verified context snapshot`,
          );
        }
        await assertActiveVersionMatch(ctx.store, ep['ref'], `association ${label}`);
        return ep['ref'];
      }
      throw new PrimitiveError('schema_mismatch', `schema_mismatch: unsupported endpoint kind "${String(kind)}"`);
    };

    for (const assoc of associations) {
      if (!isRecord(assoc)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: association item must be an object');
      }
      const from = await resolveExplicitEndpoint(assoc['from'], 'from');
      const to = await resolveExplicitEndpoint(assoc['to'], 'to');
      if (refKey(from) === refKey(to)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: association must not form a self-loop');
      }
      const relationConsId = await resolveRelation(assoc['relation']);
      const evRefs = asRefs(assoc['evidenceRefs']);
      if (evRefs.length === 0) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: association requires non-empty evidenceRefs');
      }
      for (const ev of evRefs) {
        if (!allowedEvidenceSet.has(refKey(ev))) {
          throw new PrimitiveError(
            'invalid_reference',
            `invalid_reference: association evidenceRef ${refKey(ev)} is outside the authorized evidence set`,
          );
        }
        await assertEndpointRevision(ctx.store, ev, 'association evidenceRef');
      }
      const mergedEvidence = mergeRefLists(evRefs, defaultEvidence);
      plannedEdges.push({ from, to, relationConsId, evidenceRefs: mergedEvidence });
    }

    // 8. Activate ONLY newly created relation types first, then create/reuse edges, then activate remaining new cons.
    // Reused objects are NEVER modified or re-activated.
    if (activate && allowRelationTypeActivation) {
      for (const f of relationTypeDrafts) {
        await activateConsInTx(ctx.store, f.consRef.consId, f.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
    }

    const edgeIds: string[] = [];
    const reusedEdgeIds: string[] = [];
    const createdEdgeRefs: Array<{ id: string; from: ConsRef; relationConsId: string; to: ConsRef; reused: boolean }> = [];
    for (const pe of plannedEdges) {
      const relCons = await ctx.store.getCons(pe.relationConsId);
      const relRev = relCons !== null ? await ctx.store.getRevision(relCons.id, activeRevisionOf(relCons)) : null;
      if (relCons === null || relCons.status !== 'active' || relRev === null || !relRev.roles.includes('relation_type')) {
        throw new PrimitiveError(
          'unauthorized_effect',
          `unauthorized_effect: relation cons ${pe.relationConsId} is not an active relation_type`,
        );
      }
      const res = await createOrReuseEdgeInTx(ctx.store, pe.from, pe.relationConsId, pe.to, stepId, pe.evidenceRefs);
      if (res.reused) {
        if (!reusedEdgeIds.includes(res.edge.id)) reusedEdgeIds.push(res.edge.id);
      } else {
        edgeIds.push(res.edge.id);
      }
      createdEdgeRefs.push({
        id: res.edge.id,
        from: pe.from,
        relationConsId: pe.relationConsId,
        to: pe.to,
        reused: res.reused,
      });
    }

    if (activate) {
      for (const item of createdItems) {
        if (item.roles.includes('relation_type')) continue;
        await activateConsInTx(ctx.store, item.consRef.consId, item.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
    }

    const createdRefs = createdItems.map((c) => c.consRef);
    const reusedRefs = [...reusedTempToRef.values()];
    const tempMappings: Record<string, ConsRef> = {};
    for (const [k, v] of tempMap.entries()) {
      tempMappings[k] = v;
    }

    if (createdEdgeRefs.length > 0) {
      await ctx.store.appendEvent('edges_created', { edges: createdEdgeRefs }, ctx.run.id, stepId);
    }
    await ctx.store.appendEvent(
      'entities_materialized',
      {
        createdCount: createdRefs.length,
        reusedCount: reusedRefs.length,
        createdRefs,
        reusedRefs,
        tempMappings,
        edgesCreated: edgeIds.length,
        edgesReused: reusedEdgeIds.length,
      },
      ctx.run.id,
      stepId,
    );

    const out = {
      connected: createdRefs,
      created: createdRefs,
      reused: reusedRefs,
      edges: edgeIds,
      reusedEdges: reusedEdgeIds,
      tempMappings,
    };
    await ctx.store.putIdempotencyResult(materializeResultKey(stepId), out);
    return out;
  });
}

function mergeRefLists(a: ConsRef[], b: ConsRef[]): ConsRef[] {
  const seen = new Set<string>();
  const out: ConsRef[] = [];
  for (const ref of [...a, ...b]) {
    const k = refKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ref);
  }
  return out;
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
  const allowRelationTypeActivation = input['allowRelationTypeActivation'] === true;
  const output = await ctx.store.transaction(async (): Promise<unknown> => {
    const saved = await ctx.store.getIdempotencyResult(connectResultKey(stepId));
    if (saved !== null) return saved;
    const edgeIds: string[] = [];
    const createdEdgeRefs: Array<{ id: string; from: ConsRef; relationConsId: string; to: ConsRef }> = [];
    const formedRevisions = new Map<string, ConsRevision>();
    const relationTypeDrafts: Array<{ tempId: string; consRef: ConsRef }> = [];
    for (const f of formed) {
      const rev = await ctx.store.getRevision(f.consRef.consId, f.consRef.revision);
      if (rev === null) {
        throw new PrimitiveError('unknown_reference', `draft revision ${f.consRef.consId}@${String(f.consRef.revision)} not found`);
      }
      formedRevisions.set(f.consRef.consId, rev);
      if (rev.roles.includes('relation_type')) {
        relationTypeDrafts.push(f);
      }
    }
    if (activate && relationTypeDrafts.length > 0 && !allowRelationTypeActivation) {
      throw new PrimitiveError(
        'unauthorized_effect',
        'unauthorized_effect: activating new relation_type drafts requires explicit flow authorization',
      );
    }

    const edges = Array.isArray(input['edges']) ? input['edges'] : [];
    const plannedEdges: Array<{ from: ConsRef; to: ConsRef; relationConsId: string }> = [];
    for (const e of edges) {
      if (!isRecord(e)) {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: edge item must be an object');
      }
      let from: ConsRef | null = null;
      if (typeof e['fromTempId'] === 'string') {
        from = tempMap.get(e['fromTempId']) ?? null;
      } else if (e['from'] !== undefined) {
        from = await resolveEndpoint(ctx.store, e['from'], tempMap);
      }
      let to: ConsRef | null = null;
      if (typeof e['toTempId'] === 'string') {
        to = tempMap.get(e['toTempId']) ?? null;
      } else if (e['to'] !== undefined) {
        to = await resolveEndpoint(ctx.store, e['to'], tempMap);
      }
      if (from === null || to === null) {
        throw new PrimitiveError('unknown_reference', 'edge endpoint unresolved');
      }
      await assertEndpointRevision(ctx.store, from, 'edge endpoint');
      await assertEndpointRevision(ctx.store, to, 'edge endpoint');

      let relationConsId: string;
      const relSpec = e['relation'];
      if (isRecord(relSpec)) {
        const kind = relSpec['kind'];
        if (kind === 'existing') {
          if (relSpec['tempId'] !== undefined || !isRef(relSpec['ref'])) {
            throw new PrimitiveError('schema_mismatch', 'schema_mismatch: existing relation requires ref without tempId');
          }
          const relRef = relSpec['ref'];
          const relCons = await ctx.store.getCons(relRef.consId);
          if (relCons === null) {
            throw new PrimitiveError('unknown_reference', `relation cons ${relRef.consId} not found`);
          }
          const relRev = await ctx.store.getRevision(relRef.consId, relRef.revision);
          if (relRev === null) {
            throw new PrimitiveError('unknown_reference', `relation revision ${relRef.consId}@${String(relRef.revision)} not found`);
          }
          if (
            relCons.status !== 'active' ||
            activeRevisionOf(relCons) !== relRef.revision ||
            !relRev.roles.includes('relation_type')
          ) {
            throw new PrimitiveError(
              'unauthorized_effect',
              `unauthorized_effect: relation ${relRef.consId}@${String(relRef.revision)} is not an active relation_type`,
            );
          }
          relationConsId = relRef.consId;
        } else if (kind === 'draft') {
          if (relSpec['ref'] !== undefined || typeof relSpec['tempId'] !== 'string' || relSpec['tempId'].trim() === '') {
            throw new PrimitiveError('schema_mismatch', 'schema_mismatch: draft relation requires non-empty tempId without ref');
          }
          if (!activate || !allowRelationTypeActivation) {
            throw new PrimitiveError(
              'unauthorized_effect',
              'unauthorized_effect: referencing a draft relation_type requires explicit flow authorization',
            );
          }
          const relTempId = relSpec['tempId'];
          const draftRef = tempMap.get(relTempId);
          if (draftRef === undefined) {
            throw new PrimitiveError('unknown_reference', `draft relation tempId "${relTempId}" not found in batch`);
          }
          const draftRev = formedRevisions.get(draftRef.consId);
          if (draftRev === undefined || !draftRev.roles.includes('relation_type')) {
            throw new PrimitiveError(
              'unauthorized_effect',
              `unauthorized_effect: draft tempId "${relTempId}" is not a relation_type`,
            );
          }
          relationConsId = draftRef.consId;
        } else {
          throw new PrimitiveError('schema_mismatch', `schema_mismatch: unsupported relation kind "${String(kind)}"`);
        }
      } else if (typeof e['relationConsId'] === 'string') {
        const rel = e['relationConsId'];
        const relCons = await ctx.store.getCons(rel);
        if (relCons === null) {
          throw new PrimitiveError('unknown_reference', `relation cons ${rel} not found`);
        }
        const relRev = await ctx.store.getRevision(relCons.id, activeRevisionOf(relCons));
        if (relCons.status !== 'active' || relRev === null || !relRev.roles.includes('relation_type')) {
          throw new PrimitiveError('unauthorized_effect', `unauthorized_effect: relation cons ${rel} is not an active relation_type`);
        }
        relationConsId = rel;
      } else {
        throw new PrimitiveError('schema_mismatch', 'schema_mismatch: edge requires relation or relationConsId');
      }
      plannedEdges.push({ from, to, relationConsId });
    }

    const formedIds = new Set(formed.map((f) => f.consRef.consId));
    const mainActionId = await resolveMainActionId(ctx);
    const bindings = Array.isArray(input['methodBindings']) ? input['methodBindings'] : [];
    const plannedBindings: Array<{ actionId: string; methodRef: ConsRef }> = [];
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
      plannedBindings.push({ actionId, methodRef });
    }

    if (activate && allowRelationTypeActivation) {
      for (const f of relationTypeDrafts) {
        await activateConsInTx(ctx.store, f.consRef.consId, f.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
    }

    for (const pe of plannedEdges) {
      const relCons = await ctx.store.getCons(pe.relationConsId);
      const relRev = relCons !== null ? await ctx.store.getRevision(relCons.id, activeRevisionOf(relCons)) : null;
      if (relCons === null || relCons.status !== 'active' || relRev === null || !relRev.roles.includes('relation_type')) {
        throw new PrimitiveError(
          'unauthorized_effect',
          `unauthorized_effect: relation cons ${pe.relationConsId} is not an active relation_type`,
        );
      }
      const res = await createOrReuseEdgeInTx(ctx.store, pe.from, pe.relationConsId, pe.to, stepId, []);
      if (!res.reused) {
        edgeIds.push(res.edge.id);
        createdEdgeRefs.push({ id: res.edge.id, from: pe.from, relationConsId: pe.relationConsId, to: pe.to });
      }
    }

    for (const pb of plannedBindings) {
      const createdMethodEdge = await syncMethodOwnership(ctx.store, pb.actionId, pb.methodRef.consId, pb.methodRef.revision, stepId);
      const methodCons = await ctx.store.getCons(pb.methodRef.consId);
      if (methodCons !== null && methodCons.status === 'active' && activeRevisionOf(methodCons) !== pb.methodRef.revision) {
        await ctx.store.activateRevision(pb.methodRef.consId, pb.methodRef.revision);
      }
      if (createdMethodEdge !== null) {
        edgeIds.push(createdMethodEdge.id);
        createdEdgeRefs.push({ id: createdMethodEdge.id, from: createdMethodEdge.from, relationConsId: REL_METHOD_OF, to: createdMethodEdge.to });
      }
    }

    if (activate) {
      for (const f of formed) {
        const rev = formedRevisions.get(f.consRef.consId);
        if (rev === undefined || rev.roles.includes('action') || rev.roles.includes('relation_type')) continue;
        await activateConsInTx(ctx.store, f.consRef.consId, f.consRef.revision, {
          activatedBy: stepId,
          runId: ctx.run.id,
          stepId,
        });
      }
      for (const f of formed) {
        const rev = formedRevisions.get(f.consRef.consId);
        if (rev === undefined || !rev.roles.includes('action')) continue;
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
  const connectStep = byAction('seed.materialize_and_connect') ?? byAction('seed.connect');
  const resolveStep = byAction('seed.resolve_entities');
  const associateStep = byAction('seed.associate_context');
  const contextStep = steps.find((s) => s.nodeId === 'retrieve_context');
  const receiveOut = outputOf(receiveStep);
  const inputRef = receiveOut !== null && isRef(receiveOut['consRef']) ? receiveOut['consRef'] : null;
  const connectOut = outputOf(connectStep);
  const artifactRefs = connectOut !== null && Array.isArray(connectOut['connected']) ? asRefs(connectOut['connected']) : [];
  const reusedRefs = connectOut !== null && Array.isArray(connectOut['reused']) ? asRefs(connectOut['reused']) : [];
  const resolveOut = outputOf(resolveStep);
  const resolutions = resolveOut !== null && Array.isArray(resolveOut['resolutions']) ? resolveOut['resolutions'] : [];
  const associateOut = outputOf(associateStep);
  const associations = associateOut !== null && Array.isArray(associateOut['associations']) ? associateOut['associations'] : [];
  const contextOut = outputOf(contextStep);
  const retrievedObjectRefs = contextOut !== null && Array.isArray(contextOut['objects'])
    ? contextOut['objects'].filter((o): o is { ref: ConsRef } => isRecord(o) && isRef(o['ref'])).map((o) => o.ref)
    : [];
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
    reusedRefs,
    createdCount: artifactRefs.length,
    reusedCount: reusedRefs.length,
    retrievedObjectRefs,
    resolutions,
    associationsCount: associations.length,
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
    materialize_and_connect: {
      run: (ctx: StepContext, stepId: string): Promise<unknown> => materializeAndConnectPrimitive(ctx, stepId),
    },
    record: { run: (ctx: StepContext): Promise<unknown> => recordPrimitive(ctx) },
    revise: { run: (ctx: StepContext): Promise<unknown> => revisePrimitive(ctx) },
  };
}
