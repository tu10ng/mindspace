import type {
  Cons, ConsRef, ConsRevision, ConsEdge, ExecutionBinding, MethodBinding,
  Run, RunAuthorization, Step, EventRecord, SearchQuery, SearchResponse, ConsRole, ConsStatus,
} from '../types.js';
import type { LlmAttemptRow } from '../engine/llm_log.js';

export interface ConsStoreApi {
  createCons(revision: Omit<ConsRevision, 'revision' | 'createdAt'>, opts?: { stableId?: string }): Promise<Cons>;
  createRevision(consId: string, revision: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'>): Promise<ConsRevision>;
  getCons(consId: string): Promise<Cons | null>;
  getRevision(consId: string, revision?: number): Promise<ConsRevision | null>;
  setStatus(consId: string, status: ConsStatus): Promise<void>;
  activateRevision(consId: string, revision: number): Promise<void>;

  createEdge(edge: Omit<ConsEdge, 'id'>): Promise<ConsEdge>;
  listEdges(consId: string, direction?: 'from' | 'to' | 'both', onlyActive?: boolean): Promise<ConsEdge[]>;
  archiveEdge(edgeId: string): Promise<void>;

  upsertExecutionBinding(b: Omit<ExecutionBinding, 'active'> & { active: boolean }): Promise<void>;
  getActiveExecutionBinding(consId: string): Promise<ExecutionBinding | null>;
  getExecutionBinding(consId: string, revision: number): Promise<ExecutionBinding | null>;

  insertIdempotencyKey(key: string): Promise<void>;
  hasIdempotencyKey(key: string): Promise<boolean>;
  getIdempotencyResult(key: string): Promise<unknown>;
  putIdempotencyResult(key: string, result: unknown): Promise<void>;

  setMethodBinding(actionId: string, methodId: string, methodRevision: number, active: boolean): Promise<void>;
  listActiveMethodBindings(actionId: string): Promise<MethodBinding[]>;
  deactivateMethodBindingsForMethod(methodId: string, keepActionId?: string): Promise<void>;

  createRun(run: Run): Promise<void>;
  updateRun(runId: string, patch: Partial<Pick<Run, 'status' | 'counters' | 'state'>>): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  putRunAuthorization(runId: string, key: string, record: RunAuthorization): Promise<void>;
  getRunAuthorization(runId: string, key: string): Promise<RunAuthorization | null>;

  upsertStep(step: Step): Promise<void>;
  getStep(runId: string, nodeId: string): Promise<Step | null>;
  getStepById(stepId: string): Promise<Step | null>;
  listSteps(runId: string): Promise<Step[]>;

  appendEvent(eventType: string, payload: unknown, runId?: string | null, stepId?: string | null): Promise<void>;
  listEvents(runId: string, opts?: { afterId?: number; limit?: number }): Promise<EventRecord[]>;

  insertLlmAttempt(row: LlmAttemptRow): Promise<void>;
  getLastLlmSuccess(stepId: string): Promise<LlmAttemptRow | null>;

  search(query: SearchQuery): Promise<SearchResponse>;
  searchByRole(query: SearchQuery, roles: ConsRole[]): Promise<SearchResponse>;
  countActiveByRole(role: ConsRole): Promise<number>;
  listActiveConsByRole(role: ConsRole, limit?: number): Promise<Array<{ ref: ConsRef; title: string }>>;

  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}
