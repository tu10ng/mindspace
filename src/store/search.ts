import type { SQLInputValue } from 'node:sqlite';
import type {
  ConsRef,
  ConsRole,
  SearchQuery,
  SearchResponse,
  SearchResultItem,
} from '../types.js';
import type { StoreDb } from './db.js';

type Row = Record<string, unknown>;

interface Candidate {
  consId: string;
  title: string;
  roles: ConsRole[];
  channel: SearchResultItem['channel'];
  rank: number;
}

const CHANNEL_PRIORITY: Record<SearchResultItem['channel'], number> = {
  id: 4,
  name: 3,
  searchTerm: 2,
  fts: 1,
  assoc: 0,
};

const CHANNEL_SCORE: Record<SearchResultItem['channel'], number> = {
  id: 400,
  name: 300,
  searchTerm: 200,
  fts: 100,
  assoc: 0,
};

const CHANNEL_FETCH_LIMIT = 50;
const ASSOC_LIMIT = 20;
const DEFAULT_LIMIT = 20;

export function normalizeQueryText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '');
}

function rolesOverlap(consRoles: ConsRole[], filter: Set<ConsRole> | null): boolean {
  if (filter === null) return true;
  return consRoles.some((r) => filter.has(r));
}

function currentRevisionRow(db: StoreDb['db'], consId: string): Row | undefined {
  return db
    .prepare(
      `SELECT c.id AS cons_id, c.status, r.title, r.roles_json
       FROM cons c
       JOIN cons_revisions r ON r.cons_id = c.id AND r.revision = c.current_revision
       WHERE c.id = ?`,
    )
    .get(consId) as Row | undefined;
}

function parseRoles(rolesJson: unknown): ConsRole[] {
  return JSON.parse(rolesJson as string) as ConsRole[];
}

function toCandidate(row: Row, channel: Candidate['channel'], rank: number): Candidate | null {
  if (row.status !== 'active') return null;
  return {
    consId: row.cons_id as string,
    title: row.title as string,
    roles: parseRoles(row.roles_json),
    channel,
    rank,
  };
}

function idChannel(ctx: StoreDb, raw: string): Candidate[] {
  const row = currentRevisionRow(ctx.db, raw);
  const cand = row === undefined ? null : toCandidate(row, 'id', 0);
  return cand === null ? [] : [cand];
}

function exactChannel(ctx: StoreDb, norm: string, column: 'aliases_json' | 'search_terms_json'): Candidate[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.id AS cons_id, c.status, r.title, r.roles_json
       FROM cons c
       JOIN cons_revisions r ON r.cons_id = c.id AND r.revision = c.current_revision
       WHERE c.status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(r.${column}) e WHERE lower(e.value) = ?)
       ORDER BY c.id
       LIMIT ${CHANNEL_FETCH_LIMIT}`,
    )
    .all(norm) as Row[];
  return rows.map((r) => toCandidate(r, column === 'aliases_json' ? 'name' : 'searchTerm', 0)).filter((c): c is Candidate => c !== null);
}

function titleChannel(ctx: StoreDb, norm: string): Candidate[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.id AS cons_id, c.status, r.title, r.roles_json
       FROM cons c
       JOIN cons_revisions r ON r.cons_id = c.id AND r.revision = c.current_revision
       WHERE c.status = 'active' AND lower(r.title) = ?
       ORDER BY c.id
       LIMIT ${CHANNEL_FETCH_LIMIT}`,
    )
    .all(norm) as Row[];
  return rows.map((r) => toCandidate(r, 'name', 0)).filter((c): c is Candidate => c !== null);
}

function ftsChannel(ctx: StoreDb, norm: string): { candidates: Candidate[]; note: string | null } {
  if (!ctx.fts) return { candidates: [], note: null };
  const match = `"${norm.replace(/"/g, '""')}"`;
  let rows: Row[];
  try {
    rows = ctx.db
      .prepare(
        `SELECT s.cons_id AS cons_id, bm25(cons_search) AS rank
         FROM cons_search s
         WHERE cons_search MATCH ?
         ORDER BY rank
         LIMIT ${CHANNEL_FETCH_LIMIT}`,
      )
      .all(match) as Row[];
  } catch {
    return { candidates: [], note: 'fts_query_failed_fallback_like' };
  }
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const cur = currentRevisionRow(ctx.db, row.cons_id as string);
    const cand =
      cur === undefined ? null : toCandidate({ ...cur, cons_id: row.cons_id }, 'fts', row.rank as number);
    if (cand !== null) candidates.push(cand);
  }
  return { candidates, note: null };
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function likeChannel(ctx: StoreDb, norm: string): Candidate[] {
  const pattern = `%${likeEscape(norm)}%`;
  const rows = ctx.db
    .prepare(
      `SELECT s.cons_id AS cons_id FROM cons_search s
       WHERE s.title LIKE ? ESCAPE '\\'
          OR s.aliases LIKE ? ESCAPE '\\'
          OR s.search_terms LIKE ? ESCAPE '\\'
          OR s.applicability_text LIKE ? ESCAPE '\\'
          OR s.body LIKE ? ESCAPE '\\'
       ORDER BY s.cons_id
       LIMIT ${CHANNEL_FETCH_LIMIT}`,
    )
    .all(pattern, pattern, pattern, pattern, pattern) as Row[];
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const cur = currentRevisionRow(ctx.db, row.cons_id as string);
    if (cur === undefined || cur.status !== 'active') continue;
    candidates.push({
      consId: row.cons_id as string,
      title: cur.title as string,
      roles: parseRoles(cur.roles_json),
      channel: 'fts',
      rank: 0,
    });
  }
  return candidates;
}

function assocChannel(ctx: StoreDb, seedIds: string[], filter: Set<ConsRole> | null): Candidate[] {
  if (seedIds.length === 0) return [];
  const placeholders = seedIds.map(() => '?').join(',');
  const params: SQLInputValue[] = [...seedIds, ...seedIds];
  const rows = ctx.db
    .prepare(
      `SELECT e.from_id AS from_id, e.to_id AS to_id
       FROM cons_edges e
       WHERE e.status = 'active'
         AND (e.from_id IN (${placeholders}) OR e.to_id IN (${placeholders}))
       LIMIT 100`,
    )
    .all(...params) as Row[];
  const seen = new Set(seedIds);
  const out: Candidate[] = [];
  for (const row of rows) {
    const other = seedIds.includes(row.from_id as string) ? (row.to_id as string) : (row.from_id as string);
    if (seen.has(other)) continue;
    seen.add(other);
    const cur = currentRevisionRow(ctx.db, other);
    if (cur === undefined || cur.status !== 'active') continue;
    const cand = toCandidate({ ...cur, cons_id: other }, 'assoc', 0);
    if (cand === null || !rolesOverlap(cand.roles, filter)) continue;
    out.push(cand);
    if (out.length >= ASSOC_LIMIT) break;
  }
  return out.sort((a, b) => (a.consId < b.consId ? -1 : a.consId > b.consId ? 1 : 0));
}

export function searchCons(ctx: StoreDb, query: SearchQuery): SearchResponse {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const norm = normalizeQueryText(query.text);
  const notes: string[] = [];
  if (norm === '') return { items: [], notes };
  const filter = query.roles !== undefined && query.roles.length > 0 ? new Set(query.roles) : null;

  const collected: Candidate[] = [];
  const seen = new Set<string>();

  const push = (candidates: Candidate[]): void => {
    for (const cand of candidates) {
      if (seen.has(cand.consId)) continue;
      if (!rolesOverlap(cand.roles, filter)) continue;
      seen.add(cand.consId);
      collected.push(cand);
    }
  };

  push(idChannel(ctx, query.text.trim()));
  push(titleChannel(ctx, norm));
  push(exactChannel(ctx, norm, 'aliases_json'));
  push(exactChannel(ctx, norm, 'search_terms_json'));

  if (norm.length >= 3) {
    const { candidates, note } = ftsChannel(ctx, norm);
    if (note !== null) notes.push(note);
    if (candidates.length > 0 || ctx.fts) {
      push(candidates);
    } else {
      push(likeChannel(ctx, norm));
    }
  } else {
    push(likeChannel(ctx, norm));
    notes.push('short_query_used_exact_and_like_channels');
  }

  const direct = collected
    .slice()
    .sort((a, b) => {
      const p = CHANNEL_PRIORITY[b.channel] - CHANNEL_PRIORITY[a.channel];
      if (p !== 0) return p;
      const r = a.rank - b.rank;
      if (r !== 0) return r;
      return a.consId < b.consId ? -1 : a.consId > b.consId ? 1 : 0;
    })
    .slice(0, limit);

  const directIds = direct.map((c) => c.consId);
  const assoc = assocChannel(ctx, directIds, filter).slice(0, ASSOC_LIMIT);

  const items: SearchResultItem[] = [...direct, ...assoc].map((c) => ({
    ref: { consId: c.consId, revision: 1 },
    title: c.title,
    roles: c.roles,
    score: CHANNEL_SCORE[c.channel],
    channel: c.channel,
  }));

  const revisions = new Map<string, number>();
  for (const item of items) {
    const row = ctx.db.prepare('SELECT current_revision FROM cons WHERE id = ?').get(item.ref.consId) as
      | { current_revision: number }
      | undefined;
    if (row !== undefined) revisions.set(item.ref.consId, row.current_revision);
  }
  for (const item of items) {
    item.ref.revision = revisions.get(item.ref.consId) ?? 1;
  }

  return { items, notes };
}

export function searchByRoleImpl(ctx: StoreDb, query: SearchQuery, roles: ConsRole[]): SearchResponse {
  const merged: SearchQuery = { text: query.text };
  if (query.limit !== undefined) merged.limit = query.limit;
  const combined = [...(query.roles ?? []), ...roles];
  if (combined.length > 0) merged.roles = combined;
  return searchCons(ctx, merged);
}

export function countActiveByRoleImpl(ctx: StoreDb, role: ConsRole): number {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM cons c
       JOIN cons_revisions r ON r.cons_id = c.id AND r.revision = c.current_revision
       WHERE c.status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(r.roles_json) e WHERE e.value = ?)`,
    )
    .get(role) as { n: number };
  return row.n;
}

export function listActiveConsByRoleImpl(
  ctx: StoreDb,
  role: ConsRole,
  limit: number,
): Array<{ ref: ConsRef; title: string }> {
  const rows = ctx.db
    .prepare(
      `SELECT c.id AS cons_id, c.current_revision, r.title
       FROM cons c
       JOIN cons_revisions r ON r.cons_id = c.id AND r.revision = c.current_revision
       WHERE c.status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(r.roles_json) e WHERE e.value = ?)
       ORDER BY c.id
       LIMIT ?`,
    )
    .all(role, limit) as Row[];
  return rows.map((row) => ({
    ref: { consId: row.cons_id as string, revision: row.current_revision as number },
    title: row.title as string,
  }));
}
