import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load-main.js';
import type { ActionSpec, ExecutionEnvelope, Run, Step } from '../../src/types.js';
import type { StepContext } from '../../src/engine/executor.js';

export async function makeStore(): Promise<{ store: ConsStoreApi; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mindspace-primitives-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore(dbPath);
  await loadSeeds(store);
  return { store, dbPath };
}

let ctxSeq = 0;

export function makeCtx(store: ConsStoreApi, input: unknown, runId = 'run-test'): StepContext {
  ctxSeq += 1;
  const run: Run = {
    id: runId,
    entryFlowRef: { consId: 'app.flow.ingest_main', revision: 1 },
    task: '处理语料',
    inputRefs: [],
    status: 'running',
    budget: { maxSteps: 64, maxLlmCalls: 20, maxOutputTokensPerCall: 4096 },
    counters: { steps: 0, llmCalls: 0 },
    state: {},
  };
  const step: Step = {
    id: `${runId}::n${ctxSeq}`,
    runId,
    nodeId: `n${ctxSeq}`,
    actionRef: { consId: 'seed.form', revision: 1 },
    tendencyRefs: [],
    input,
    status: 'running',
    llmAttemptCount: 0,
  };
  const spec: ActionSpec = {
    kind: 'action',
    inputSchema: {},
    outputSchema: {},
    executor: 'primitive',
    primitiveKey: 'form',
    allowedEffects: [],
    freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
  };
  const envelope: ExecutionEnvelope = {
    runId,
    stepId: step.id,
    task: run.task,
    action: { ref: step.actionRef, spec, body: '' },
    tendencies: [],
    input,
    candidates: [],
    allowedEffects: [],
    outputSchema: {},
  };
  return { store, run, step, envelope };
}
