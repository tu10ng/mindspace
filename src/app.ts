import { randomUUID } from 'node:crypto';
import type { LlmAdapter, Run, RunBudget } from './types.js';
import { DEFAULT_BUDGET as BUDGET } from './types.js';
import { openStore } from './store/index.js';
import type { ConsStoreApi } from './store/api.js';
import { loadSeeds } from './seed/load-main.js';
import { executeRun } from './engine/executor.js';
import type { EngineDeps } from './engine/executor.js';
import { createSeedPrimitives } from './seed/runtime.js';
import { isRecord } from './primitives/index.js';
import type { LlmAttemptLog } from './engine/llm_log.js';

export interface AppOptions {
  dbPath: string;
  llm: LlmAdapter;
}

export interface App {
  store: ConsStoreApi;
  deps: EngineDeps;
  runIngest(text: string): Promise<Run>;
  runFlow(flowId: string, task: string, input: unknown, budget?: Partial<RunBudget>): Promise<Run>;
  close(): void;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const store = openStore(opts.dbPath);
  await loadSeeds(store);
  const primitives = createSeedPrimitives();
  const llmLog: LlmAttemptLog = {
    insert: (row) => store.insertLlmAttempt(row),
    getLastSuccess: (stepId) => store.getLastLlmSuccess(stepId),
  };
  const deps: EngineDeps = { store, llm: opts.llm, primitives, llmLog };

  async function runFlow(flowId: string, task: string, input: unknown, budget?: Partial<RunBudget>): Promise<Run> {
    const cons = await store.getCons(flowId);
    if (cons === null) {
      throw new Error(`unknown flow ${flowId}`);
    }
    const state: Record<string, unknown> = isRecord(input) ? { input } : { input: { value: input } };
    const run: Run = {
      id: randomUUID(),
      entryFlowRef: { consId: flowId, revision: cons.currentRevision },
      task,
      inputRefs: [],
      status: 'queued',
      budget: budget === undefined ? BUDGET : { ...BUDGET, ...budget },
      counters: { steps: 0, llmCalls: 0 },
      state,
    };
    await store.createRun(run);
    await executeRun(deps, run.id);
    const latest = await store.getRun(run.id);
    return latest ?? run;
  }

  return {
    store,
    deps,
    runIngest(text: string): Promise<Run> {
      return runFlow('flow.ingest', '处理输入语料并内化', { text });
    },
    runFlow,
    close(): void {
      store.close();
    },
  };
}
