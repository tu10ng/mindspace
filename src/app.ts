import { randomUUID } from 'node:crypto';
import type { ConsRef, EntityResolutionItem, LlmAdapter, ResolutionDecisionInput, Run, RunBudget, SummarizeTopicInput } from './types.js';
import { DEFAULT_BUDGET as BUDGET } from './types.js';
import { openStore } from './store/index.js';
import type { ConsStoreApi } from './store/api.js';
import { loadSeeds } from './seed/load-main.js';
import { buildEntityResolutionArtifacts, executeRun } from './engine/executor.js';
import type { EngineDeps } from './engine/executor.js';
import { createSeedPrimitives } from './seed/runtime.js';
import {
  isRecord,
  isRef,
  PrimitiveError,
  TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
  TRUSTED_SNAPSHOT_ENTITY_RESOLUTION,
  type TrustedEntityContextSnapshot,
  type TrustedEntityResolutionSnapshot,
} from './primitives/index.js';
import type { LlmAttemptLog } from './engine/llm_log.js';

export interface AppOptions {
  dbPath: string;
  llm: LlmAdapter;
}

export interface App {
  store: ConsStoreApi;
  deps: EngineDeps;
  runIngest(text: string): Promise<Run>;
  /**
   * Explicitly confirm unresolved entities for a run paused in `needs_resolution`,
   * then resume the flow from association/materialization to completion.
   */
  resumeResolution(runId: string, decisions: ResolutionDecisionInput[]): Promise<Run>;
  /** Run on-demand topic summarization (`flow.summarize_topic`). */
  summarizeTopic(input: SummarizeTopicInput): Promise<Run>;
  runFlow(flowId: string, task: string, input: unknown, budget?: Partial<RunBudget>): Promise<Run>;
  close(): void;
}

function refKey(ref: ConsRef): string {
  return `${ref.consId}@${String(ref.revision)}`;
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
    const filteredInput: Record<string, unknown> = {};
    if (isRecord(input)) {
      for (const [k, v] of Object.entries(input)) {
        if (!k.startsWith('_')) {
          filteredInput[k] = v;
        }
      }
    }
    const state: Record<string, unknown> = isRecord(input) ? { input: filteredInput } : { input: { value: input } };
    const run: Run = {
      id: randomUUID(),
      entryFlowRef: { consId: flowId, revision: cons.activeRevision ?? cons.currentRevision },
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

  async function resumeResolution(runId: string, decisions: ResolutionDecisionInput[]): Promise<Run> {
    const run = await store.getRun(runId);
    if (run === null) {
      throw new PrimitiveError('unknown_reference', `run ${runId} not found`);
    }
    if (run.status !== 'needs_resolution') {
      throw new PrimitiveError('schema_mismatch', `run ${runId} is in status "${run.status}", not "needs_resolution"`);
    }
    if (!Array.isArray(decisions) || decisions.length === 0) {
      throw new PrimitiveError('schema_mismatch', 'decisions must be a non-empty array');
    }

    const ctxSnap = await store.getTrustedSnapshot<TrustedEntityContextSnapshot>(runId, TRUSTED_SNAPSHOT_ENTITY_CONTEXT);
    const resSnap = await store.getTrustedSnapshot<TrustedEntityResolutionSnapshot>(runId, TRUSTED_SNAPSHOT_ENTITY_RESOLUTION);
    const resolveStep = await store.getStep(runId, 'resolve_entities');
    if (resSnap === null || resolveStep === null) {
      throw new PrimitiveError('schema_mismatch', `run ${runId} has no pending entity_resolution step to resume`);
    }

    const allowedObjects = new Set((ctxSnap?.payload.objectRefs ?? []).map(refKey));
    const decisionByTemp = new Map<string, ResolutionDecisionInput>();
    for (const d of decisions) {
      if (typeof d.tempId !== 'string' || d.tempId.trim() === '') {
        throw new PrimitiveError('schema_mismatch', 'decision.tempId must be a non-empty string');
      }
      if (d.decision !== 'reuse' && d.decision !== 'create') {
        throw new PrimitiveError('schema_mismatch', `decision for "${d.tempId}" must be "reuse" or "create"`);
      }
      if (d.decision === 'reuse') {
        if (!isRef(d.existingRef)) {
          throw new PrimitiveError('schema_mismatch', `reuse decision for "${d.tempId}" requires existingRef`);
        }
        if (!allowedObjects.has(refKey(d.existingRef))) {
          throw new PrimitiveError(
            'invalid_reference',
            `existingRef ${refKey(d.existingRef)} for "${d.tempId}" is outside the verified candidate set`,
          );
        }
      } else if (d.existingRef !== undefined) {
        throw new PrimitiveError('schema_mismatch', `create decision for "${d.tempId}" must not include existingRef`);
      }
      decisionByTemp.set(d.tempId, d);
    }

    const mergedResolutions: EntityResolutionItem[] = resSnap.payload.resolutions.map((orig) => {
      const override = decisionByTemp.get(orig.tempId);
      if (override === undefined) return orig;
      if (override.decision === 'reuse' && override.existingRef !== undefined) {
        return {
          tempId: orig.tempId,
          decision: 'reuse',
          existingRef: override.existingRef,
          basis: override.basis ?? '由用户显式确认复用已有对象。',
        };
      }
      return {
        tempId: orig.tempId,
        decision: 'create',
        basis: override.basis ?? '由用户显式确认新建对象。',
      };
    });

    const stillUnresolved = mergedResolutions.filter((r) => r.decision === 'unresolved');
    if (stillUnresolved.length > 0) {
      throw new PrimitiveError(
        'schema_mismatch',
        `decisions still missing for unresolved tempIds: ${stillUnresolved.map((r) => r.tempId).join(', ')}`,
      );
    }

    const actionResult = isRecord(run.state['actionResult']) ? run.state['actionResult'] : {};
    const inputArtifacts = Array.isArray(actionResult['artifacts']) ? actionResult['artifacts'] : [];
    const derived = buildEntityResolutionArtifacts(
      inputArtifacts,
      mergedResolutions,
      resSnap.payload.batchStepId,
      resSnap.payload.candidateSnapshotStepId,
      true,
    );

    const updatedOutput = {
      status: 'resolved' as const,
      resolutions: mergedResolutions,
      createArtifacts: derived.createArtifacts,
      reusedTempIds: derived.reusedTempIds,
      confirmedByHuman: true,
    };

    const nextState: Record<string, unknown> = {
      ...run.state,
      entityResolution: updatedOutput,
    };
    delete nextState['pendingResolution'];

    await store.transaction(async () => {
      await store.upsertStep({ ...resolveStep, output: updatedOutput });
      await store.putTrustedSnapshot(runId, TRUSTED_SNAPSHOT_ENTITY_RESOLUTION, resolveStep.id, derived.snapshot);
      await store.updateRun(runId, { state: nextState });
      await store.appendEvent(
        'resolution_confirmed_by_human',
        { runId, decisions, mergedResolutions },
        runId,
        resolveStep.id,
      );
    });

    await executeRun(deps, runId);
    const latest = await store.getRun(runId);
    return latest ?? run;
  }

  return {
    store,
    deps,
    runIngest(text: string): Promise<Run> {
      return runFlow('flow.ingest', '处理输入语料并内化', { text });
    },
    resumeResolution,
    summarizeTopic(input: SummarizeTopicInput): Promise<Run> {
      const task = input.task ?? '按主题汇总已关联记录';
      const payload: Record<string, unknown> = {};
      if (input.topicRef !== undefined) payload['topicRef'] = input.topicRef;
      if (input.topicQuery !== undefined) payload['topicQuery'] = input.topicQuery;
      if (input.updateSummaryRef !== undefined) payload['updateSummaryRef'] = input.updateSummaryRef;
      return runFlow('flow.summarize_topic', task, payload);
    },
    runFlow,
    close(): void {
      store.close();
    },
  };
}
