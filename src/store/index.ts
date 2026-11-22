import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQLInputValue } from 'node:sqlite';
import type {
  Cons,
  ConsEdge,
  ConsRef,
  ConsRevision,
  ConsRole,
  ConsStatus,
  EventRecord,
  ExecutionBinding,
  MethodBinding,
  Run,
  SearchQuery,
  SearchResponse,
  Step,
} from '../types.js';
import type { ConsStoreApi } from './api.js';
import { createWriteQueue, openDb, type StoreDb, type WriteQueue } from './db.js';
import {
  countActiveByRoleImpl,
  listActiveConsByRoleImpl,
  searchByRoleImpl,
  searchCons,
} from './search.js';

type Row = Record<string, unknown>;

const txStorage = new AsyncLocalStorage<{ inside: true }>();

function nowIso(): string {
  return new Date().toISOString();
}

function rowToCons(row: Row): Cons {
  return {
    id: row.id as string,
    currentRevision: row.current_revision as number,
    activeRevision: row.active_revision as number,
    status: row.status as ConsStatus,
    createdAt: row.created_at as string,
  };
}

function rowToRevision(row: Row): ConsRevision {
  const rev: ConsRevision = {
    consId: row.cons_id as string,
    revision: row.revision as number,
    title: row.title as string,
    roles: JSON.parse(row.roles_json as string) as ConsRole[],
    body: row.body as string,
    aliases: JSON.parse(row.aliases_json as string) as string[],
    searchTerms: JSON.parse(row.search_terms_json as string) as string[],
    provenance: JSON.parse(row.provenance_json as string),
    createdAt: row.created_at as string,
  };
  if (row.applicability_text !== null && row.applicability_text !== undefined) {
    rev.applicabilityText = row.applicability_text as string;
  }
  if (row.spec_json !== null && row.spec_json !== undefined) {
    rev.spec = JSON.parse(row.spec_json as string);
  }
  return rev;
}

function rowToEdge(row: Row): ConsEdge {
  const edge: ConsEdge = {
    id: row.id as string,
    from: { consId: row.from_id as string, revision: row.from_revision as number },
    relationConsId: row.relation_cons_id as string,
    to: { consId: row.to_id as string, revision: row.to_revision as number },
    status: row.status as 'active' | 'archived',
  };
  if (row.created_by_step_id !== null && row.created_by_step_id !== undefined) {
    edge.createdByStepId = row.created_by_step_id as string;
  }
  return edge;
}

function rowToExecutionBinding(row: Row): ExecutionBinding {
  const b: ExecutionBinding = {
    consId: row.cons_id as string,
    revision: row.revision as number,
    executor: row.executor as ExecutionBinding['executor'],
    active: (row.active as number) === 1,
    activatedByStepId: row.activated_by_step_id as string,
  };
  if (row.primitive_key !== null && row.primitive_key !== undefined) {
    b.primitiveKey = row.primitive_key as string;
  }
  return b;
}

function rowToRun(row: Row): Run {
  return {
    id: row.id as string,
    entryFlowRef: JSON.parse(row.entry_flow_ref_json as string),
    task: row.task as string,
    inputRefs: JSON.parse(row.input_refs_json as string),
    status: row.status as Run['status'],
    budget: JSON.parse(row.budget_json as string),
    counters: JSON.parse(row.counters_json as string),
    state: JSON.parse(row.state_json as string),
  };
}

function rowToStep(row: Row): Step {
  const step: Step = {
    id: row.id as string,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    actionRef: JSON.parse(row.action_ref_json as string),
    tendencyRefs: JSON.parse(row.tendency_refs_json as string),
    input: row.input_json === null ? null : JSON.parse(row.input_json as string),
    status: row.status as Step['status'],
    llmAttemptCount: row.llm_attempt_count as number,
  };
  if (row.method_ref_json !== null && row.method_ref_json !== undefined) {
    step.methodRef = JSON.parse(row.method_ref_json as string);
  }
  if (row.output_json !== null && row.output_json !== undefined) {
    step.output = JSON.parse(row.output_json as string);
  }
  if (row.error_code !== null && row.error_code !== undefined) {
    step.errorCode = row.error_code as string;
  }
  return step;
}

function rowToEvent(row: Row): EventRecord {
  return {
    id: row.id as number,
    runId: (row.run_id as string | null) ?? null,
    stepId: (row.step_id as string | null) ?? null,
    eventType: row.event_type as string,
    payload: JSON.parse(row.payload_json as string),
    createdAt: row.created_at as string,
  };
}

export function openStore(path: string): ConsStoreApi {
  const ctx: StoreDb = openDb(path);
  const db = ctx.db;
  const queue: WriteQueue = createWriteQueue();

  function write<T>(fn: () => T): Promise<T> {
    if (txStorage.getStore() !== undefined) {
      return Promise.resolve().then(fn);
    }
    return queue.enqueue(() => Promise.resolve().then(fn));
  }

  function insertEventSync(eventType: string, payload: unknown, runId: string | null, stepId: string | null): void {
    db.prepare('INSERT INTO events (run_id, step_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
      runId,
      stepId,
      eventType,
      JSON.stringify(payload ?? null),
      nowIso(),
    );
  }

  function insertRevisionSync(rev: ConsRevision): void {
    db.prepare(
      `INSERT INTO cons_revisions
         (cons_id, revision, title, roles_json, body, aliases_json, search_terms_json,
          applicability_text, spec_json, provenance_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rev.consId,
      rev.revision,
      rev.title,
      JSON.stringify(rev.roles),
      rev.body,
      JSON.stringify(rev.aliases),
      JSON.stringify(rev.searchTerms),
      rev.applicabilityText ?? null,
      rev.spec === undefined ? null : JSON.stringify(rev.spec),
      JSON.stringify(rev.provenance),
      rev.createdAt,
    );
  }

  function reindexSync(consId: string): void {
    db.prepare('DELETE FROM cons_search WHERE cons_id = ?').run(consId);
    const cons = db.prepare('SELECT status, active_revision FROM cons WHERE id = ?').get(consId) as
      | Row
      | undefined;
    if (cons === undefined || cons.status !== 'active') return;
    const revisionNo = cons.active_revision as number;
    const rev = db
      .prepare(
        'SELECT title, aliases_json, search_terms_json, applicability_text, body FROM cons_revisions WHERE cons_id = ? AND revision = ?',
      )
      .get(consId, revisionNo) as Row | undefined;
    if (rev === undefined) return;
    db.prepare(
      'INSERT INTO cons_search (cons_id, title, aliases, search_terms, applicability_text, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      consId,
      rev.title as string,
      rev.aliases_json as string,
      rev.search_terms_json as string,
      (rev.applicability_text as string | null) ?? '',
      rev.body as string,
    );
  }

  function createConsSync(revision: Omit<ConsRevision, 'revision' | 'createdAt'>, opts?: { stableId?: string }): Cons {
    const id = opts?.stableId ?? revision.consId;
    const createdAt = nowIso();
    db.prepare('INSERT INTO cons (id, current_revision, active_revision, status, created_at) VALUES (?, 1, 1, ?, ?)').run(
      id,
      'draft',
      createdAt,
    );
    insertRevisionSync({ ...revision, consId: id, revision: 1, createdAt });
    insertEventSync('cons_formed', { consId: id, revision: 1 }, null, null);
    return { id, currentRevision: 1, activeRevision: 1, status: 'draft', createdAt };
  }

  function createRevisionSync(consId: string, revision: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'>): ConsRevision {
    const cons = db.prepare('SELECT current_revision, status FROM cons WHERE id = ?').get(consId) as
      | Row
      | undefined;
    if (cons === undefined) throw new Error(`unknown cons: ${consId}`);
    const next = (cons.current_revision as number) + 1;
    const createdAt = nowIso();
    const full: ConsRevision = { ...revision, consId, revision: next, createdAt };
    insertRevisionSync(full);
    if (cons.status === 'active') {
      db.prepare('UPDATE cons SET current_revision = ? WHERE id = ?').run(next, consId);
    } else {
      db.prepare('UPDATE cons SET current_revision = ?, active_revision = ? WHERE id = ?').run(next, next, consId);
    }
    insertEventSync('cons_revised', { consId, revision: next }, null, null);
    return full;
  }

  function activateRevisionSync(consId: string, revision: number): void {
    if (!Number.isInteger(revision) || revision < 1) {
      throw new Error(`invalid revision ${String(revision)} for ${consId}`);
    }
    const row = db.prepare('SELECT revision FROM cons_revisions WHERE cons_id = ? AND revision = ?').get(consId, revision) as
      | Row
      | undefined;
    if (row === undefined) throw new Error(`revision ${consId}@${String(revision)} not found`);
    db.prepare('UPDATE cons SET active_revision = ? WHERE id = ?').run(revision, consId);
    insertEventSync('cons_revision_activated', { consId, revision }, null, null);
    reindexSync(consId);
  }

  return {
    async createCons(revision, opts) {
      return write(() => createConsSync(revision, opts));
    },

    async createRevision(consId, revision) {
      return write(() => createRevisionSync(consId, revision));
    },

    async getCons(consId) {
      return write(() => db.prepare('SELECT * FROM cons WHERE id = ?').get(consId) as Row | undefined).then((row) =>
        row === undefined ? null : rowToCons(row),
      );
    },

    async getRevision(consId, revision) {
      return write(async () => {
        let rev = revision;
        if (rev === undefined) {
          const cons = db.prepare('SELECT active_revision FROM cons WHERE id = ?').get(consId) as
            | Row
            | undefined;
          if (cons === undefined) return null;
          rev = cons.active_revision as number;
        }
        const row = db
          .prepare('SELECT * FROM cons_revisions WHERE cons_id = ? AND revision = ?')
          .get(consId, rev) as Row | undefined;
        return row === undefined ? null : rowToRevision(row);
      });
    },

    async setStatus(consId, status) {
      return write(() => {
        const res = db.prepare('UPDATE cons SET status = ? WHERE id = ?').run(status, consId);
        if (res.changes === 0) throw new Error(`unknown cons: ${consId}`);
        insertEventSync(status === 'active' ? 'cons_activated' : 'cons_archived', { consId, status }, null, null);
        reindexSync(consId);
      });
    },

    async activateRevision(consId, revision) {
      return write(() => activateRevisionSync(consId, revision));
    },

    async createEdge(edge) {
      return write(() => {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO cons_edges (id, from_id, from_revision, relation_cons_id, to_id, to_revision, status, created_by_step_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          edge.from.consId,
          edge.from.revision,
          edge.relationConsId,
          edge.to.consId,
          edge.to.revision,
          edge.status,
          edge.createdByStepId ?? null,
        );
        insertEventSync('edges_created', { edgeId: id, relationConsId: edge.relationConsId }, null, null);
        return {
          id,
          from: edge.from,
          relationConsId: edge.relationConsId,
          to: edge.to,
          ...(edge.createdByStepId !== undefined ? { createdByStepId: edge.createdByStepId } : {}),
          status: edge.status,
        };
      });
    },

    async listEdges(consId, direction, onlyActive) {
      return write(() => {
        const dir = direction ?? 'both';
        const active = onlyActive ?? true;
        const clauses: string[] = [];
        const params: SQLInputValue[] = [];
        if (dir === 'from' || dir === 'both') {
          clauses.push('from_id = ?');
          params.push(consId);
        }
        if (dir === 'to' || dir === 'both') {
          clauses.push('to_id = ?');
          params.push(consId);
        }
        const where = `(${clauses.join(' OR ')})${active ? " AND status = 'active'" : ''}`;
        const rows = db.prepare(`SELECT * FROM cons_edges WHERE ${where} ORDER BY id`).all(...params) as Row[];
        return rows.map(rowToEdge);
      });
    },

    async upsertExecutionBinding(b) {
      return write(() => {
        if (b.active) {
          db.prepare('UPDATE execution_bindings SET active = 0 WHERE cons_id = ?').run(b.consId);
        }
        db.prepare(
          `INSERT INTO execution_bindings (cons_id, revision, executor, primitive_key, active, activated_by_step_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (cons_id, revision) DO UPDATE SET
             executor = excluded.executor,
             primitive_key = excluded.primitive_key,
             active = excluded.active,
             activated_by_step_id = excluded.activated_by_step_id`,
        ).run(b.consId, b.revision, b.executor, b.primitiveKey ?? null, b.active ? 1 : 0, b.activatedByStepId);
      });
    },

    async getActiveExecutionBinding(consId) {
      return write(() => db
        .prepare('SELECT * FROM execution_bindings WHERE cons_id = ? AND active = 1 ORDER BY revision DESC LIMIT 1')
        .get(consId) as Row | undefined).then((row) => (row === undefined ? null : rowToExecutionBinding(row)));
    },

    async getExecutionBinding(consId, revision) {
      return write(() => db
        .prepare('SELECT * FROM execution_bindings WHERE cons_id = ? AND revision = ?')
        .get(consId, revision) as Row | undefined).then((row) => (row === undefined ? null : rowToExecutionBinding(row)));
    },

    async insertIdempotencyKey(key) {
      return write(() => {
        db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, result_json, created_at) VALUES (?, NULL, ?)').run(key, nowIso());
      });
    },

    async hasIdempotencyKey(key) {
      return write(() => db.prepare('SELECT key FROM idempotency_keys WHERE key = ?').get(key) as Row | undefined).then(
        (row) => row !== undefined,
      );
    },

    async getIdempotencyResult(key) {
      return write(() => db.prepare('SELECT result_json FROM idempotency_keys WHERE key = ?').get(key) as Row | undefined).then(
        (row) => {
          if (row === undefined || row.result_json === null || row.result_json === undefined) return null;
          return JSON.parse(row.result_json as string) as unknown;
        },
      );
    },

    async putIdempotencyResult(key, result) {
      return write(() => {
        db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, result_json, created_at) VALUES (?, ?, ?)').run(
          key,
          JSON.stringify(result ?? null),
          nowIso(),
        );
      });
    },

    async setMethodBinding(actionId, methodId, methodRevision, active) {
      return write(() => {
        db.prepare(
          `INSERT INTO method_bindings (action_id, method_id, method_revision, active)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (action_id, method_id) DO UPDATE SET
             method_revision = excluded.method_revision,
             active = excluded.active`,
        ).run(actionId, methodId, methodRevision, active ? 1 : 0);
      });
    },

    async listActiveMethodBindings(actionId) {
      return write(() => db
        .prepare('SELECT * FROM method_bindings WHERE action_id = ? AND active = 1 ORDER BY method_id')
        .all(actionId) as Row[]).then((rows) =>
        rows.map((row) => ({
          actionId: row.action_id as string,
          methodId: row.method_id as string,
          methodRevision: row.method_revision as number,
          active: (row.active as number) === 1,
        })),
      );
    },

    async createRun(run) {
      return write(() => {
        db.prepare(
          `INSERT INTO runs (id, entry_flow_ref_json, task, input_refs_json, status, budget_json, counters_json, state_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.id,
          JSON.stringify(run.entryFlowRef),
          run.task,
          JSON.stringify(run.inputRefs),
          run.status,
          JSON.stringify(run.budget),
          JSON.stringify(run.counters),
          JSON.stringify(run.state),
          nowIso(),
        );
      });
    },

    async updateRun(runId, patch) {
      return write(() => {
        const sets: string[] = [];
        const vals: SQLInputValue[] = [];
        if (patch.status !== undefined) {
          sets.push('status = ?');
          vals.push(patch.status);
          if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'budget_exhausted') {
            sets.push('finished_at = ?');
            vals.push(nowIso());
          }
        }
        if (patch.counters !== undefined) {
          sets.push('counters_json = ?');
          vals.push(JSON.stringify(patch.counters));
        }
        if (patch.state !== undefined) {
          sets.push('state_json = ?');
          vals.push(JSON.stringify(patch.state));
        }
        if (sets.length === 0) return;
        vals.push(runId);
        db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      });
    },

    async getRun(runId) {
      return write(() => db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined).then((row) =>
        row === undefined ? null : rowToRun(row),
      );
    },

    async upsertStep(step) {
      return write(() => {
        db.prepare(
          `INSERT INTO steps (id, run_id, node_id, action_ref_json, method_ref_json, tendency_refs_json, input_json, output_json, status, error_code, llm_attempt_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             status = excluded.status,
             output_json = excluded.output_json,
             error_code = excluded.error_code,
             llm_attempt_count = excluded.llm_attempt_count`,
        ).run(
          step.id,
          step.runId,
          step.nodeId,
          JSON.stringify(step.actionRef),
          step.methodRef === undefined ? null : JSON.stringify(step.methodRef),
          JSON.stringify(step.tendencyRefs),
          JSON.stringify(step.input ?? null),
          step.output === undefined ? null : JSON.stringify(step.output),
          step.status,
          step.errorCode ?? null,
          step.llmAttemptCount,
        );
      });
    },

    async getStep(runId, nodeId) {
      return write(() => db
        .prepare('SELECT * FROM steps WHERE run_id = ? AND node_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(runId, nodeId) as Row | undefined).then((row) => (row === undefined ? null : rowToStep(row)));
    },

    async listSteps(runId) {
      return write(() => db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY rowid').all(runId) as Row[]).then((rows) =>
        rows.map(rowToStep),
      );
    },

    async appendEvent(eventType, payload, runId, stepId) {
      return write(() => {
        insertEventSync(eventType, payload, runId ?? null, stepId ?? null);
      });
    },

    async listEvents(runId, opts) {
      return write(() => {
        const afterId = opts?.afterId ?? 0;
        const limit = opts?.limit ?? 100;
        const rows = db
          .prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
          .all(runId, afterId, limit) as Row[];
        return rows.map(rowToEvent);
      });
    },

    async insertLlmAttempt(row) {
      return write(() => {
        db.prepare(
          `INSERT INTO llm_attempts (step_id, attempt_no, request_json, response_json, model, usage_json, latency_ms, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (step_id, attempt_no) DO UPDATE SET
             request_json = excluded.request_json,
             response_json = excluded.response_json,
             model = excluded.model,
             usage_json = excluded.usage_json,
             latency_ms = excluded.latency_ms,
             error_code = excluded.error_code`,
        ).run(
          row.stepId,
          row.attemptNo,
          row.request === undefined ? null : JSON.stringify(row.request),
          row.response === undefined || row.response === null ? null : JSON.stringify(row.response),
          row.model,
          row.usage === undefined || row.usage === null ? null : JSON.stringify(row.usage),
          row.latencyMs,
          row.errorCode,
        );
      });
    },

    async getLastLlmSuccess(stepId) {
      return write(() => db
        .prepare('SELECT * FROM llm_attempts WHERE step_id = ? AND error_code IS NULL ORDER BY attempt_no DESC LIMIT 1')
        .get(stepId) as Row | undefined).then((row) => {
        if (row === undefined) return null;
        return {
          stepId: row.step_id as string,
          attemptNo: row.attempt_no as number,
          request: row.request_json === null ? null : (JSON.parse(row.request_json as string) as unknown),
          response: row.response_json === null ? null : (JSON.parse(row.response_json as string) as { text?: unknown }),
          model: (row.model as string | null) ?? null,
          usage: row.usage_json === null ? null : (JSON.parse(row.usage_json as string) as { inputTokens: number; outputTokens: number }),
          latencyMs: (row.latency_ms as number | null) ?? null,
          errorCode: (row.error_code as string | null) ?? null,
        };
      });
    },

    async search(query: SearchQuery): Promise<SearchResponse> {
      return write(() => searchCons(ctx, query));
    },

    async searchByRole(query, roles) {
      return write(() => searchByRoleImpl(ctx, query, roles));
    },

    async countActiveByRole(role) {
      return write(() => countActiveByRoleImpl(ctx, role));
    },

    async listActiveConsByRole(role, limit) {
      return write(() => listActiveConsByRoleImpl(ctx, role, limit ?? 10000));
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (txStorage.getStore() !== undefined) {
        const name = `sp_${randomUUID().replaceAll('-', '')}`;
        db.exec(`SAVEPOINT ${name}`);
        let nested: T;
        try {
          nested = await txStorage.run({ inside: true }, fn);
        } catch (err) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw err;
        }
        db.exec(`RELEASE ${name}`);
        return nested;
      }
      return queue.enqueue(async () => {
        db.exec('BEGIN IMMEDIATE');
        let result: T;
        try {
          result = await txStorage.run({ inside: true }, fn);
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            throw err;
          }
          throw err;
        }
        db.exec('COMMIT');
        return result;
      });
    },

    close() {
      db.close();
    },
  };
}
