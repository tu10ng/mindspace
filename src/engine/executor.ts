import type {
  ActionSpec, ConsRef, ConsRevision, ErrorCode, ExecutionEnvelope, LlmAdapter,
  LlmResponse, MethodSpec, Run, Step, TendencySpec,
} from '../types.js';
import type { ConsStoreApi } from '../store/api.js';
import { validateSchema } from '../schema.js';
import { resolvePath } from './path.js';
import { evaluateTransition, validateFlow } from './flow.js';
import { buildPrompts } from '../llm/prompt.js';
import { isContentActionCompatible } from '../primitives/index.js';
import type { LlmAttemptLog } from './llm_log.js';
import { PROMPT_TEMPLATE_VERSION } from './llm_log.js';

export const STATE_KEY_CANDIDATES = 'candidates';
export const STATE_KEY_TENDENCY_REFS = 'tendencyRefs';
export const STATE_KEY_METHOD_SELECTION = 'methodSelection';
export const STATE_KEY_RUN_INPUT = 'input';
export const STATE_KEY_CURRENT_NODE = '_currentNode';
const NETWORK_RETRIES = 2;
const REPAIRABLE_CODES: ErrorCode[] = ['invalid_json', 'schema_mismatch', 'unknown_reference'];
const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>([
  'invalid_json', 'schema_mismatch', 'unknown_reference',
  'unauthorized_action', 'unauthorized_effect', 'missing_binding',
  'revision_conflict', 'model_unavailable', 'no_candidate',
  'budget_exhausted', 'config_error',
]);

export interface StepContext {
  store: ConsStoreApi;
  run: Run;
  step: Step;
  envelope: ExecutionEnvelope;
}

export type PrimitiveFn = (ctx: StepContext, stepId: string) => Promise<unknown>;

export interface EngineDeps {
  store: ConsStoreApi;
  llm: LlmAdapter;
  primitives: Record<string, { run: PrimitiveFn }>;
  llmLog?: LlmAttemptLog;
}

class StepFailure extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

class BudgetSignal extends Error {
  constructor() {
    super('llm call budget exhausted');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionSpec(value: unknown): value is ActionSpec {
  return isRecord(value) && value['kind'] === 'action';
}

function isMethodSpec(value: unknown): value is MethodSpec {
  return isRecord(value) && value['kind'] === 'method';
}

function isTendencySpec(value: unknown): value is TendencySpec {
  return isRecord(value) && value['kind'] === 'tendency';
}

function isFlowSpec(value: unknown): value is import('../types.js').FlowSpec {
  return isRecord(value) && value['kind'] === 'flow';
}

function isRef(value: unknown): value is ConsRef {
  return isRecord(value) && typeof value['consId'] === 'string' && typeof value['revision'] === 'number';
}

interface AuthorizationRecord {
  stepId: string;
  consId: string;
  revision: number;
  title: string;
  candidates: ConsRef[];
}

async function authorizationFor(store: ConsStoreApi, runId: string, key: string): Promise<AuthorizationRecord | null> {
  const record = await store.getRunAuthorization(runId, key);
  if (record === null) {
    return null;
  }
  const step = await store.getStepById(record.stepId);
  if (step === null || step.runId !== runId || step.status !== 'succeeded') {
    return null;
  }
  if (!record.candidates.some((c) => c.consId === record.consId && c.revision === record.revision)) {
    return null;
  }
  return record;
}

function buildAuthorization(output: unknown, candidates: ExecutionEnvelope['candidates']): Omit<AuthorizationRecord, 'stepId'> | null {
  if (isRecord(output) && output['status'] === 'selected' && isRef(output['selected'])) {
    const selected = output['selected'];
    const hit = candidates.find((c) => c.ref.consId === selected.consId && c.ref.revision === selected.revision);
    if (hit === undefined) {
      return null;
    }
    return {
      consId: selected.consId,
      revision: selected.revision,
      title: hit.title,
      candidates: candidates.map((c) => c.ref),
    };
  }
  return null;
}

function syntheticFlowActionSpec(ref: ConsRef): ActionSpec {
  return {
    kind: 'action',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    executor: 'flow',
    flowRef: ref,
    allowedEffects: [],
    freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false },
  };
}

function stepIdFor(runId: string, nodeId: string): string {
  return `${runId}::${nodeId}`;
}

function declaredTopLevelFields(schema: object): Set<string> {
  if (isRecord(schema) && isRecord(schema['properties'])) {
    return new Set(Object.keys(schema['properties']));
  }
  return new Set<string>();
}

async function declaredFieldsForNode(
  store: ConsStoreApi,
  runId: string,
  node: { actionId?: string; actionFrom?: string },
): Promise<Set<string> | null> {
  try {
    const ref = await resolveAction(store, runId, node);
    const rev = await readRevision(store, ref);
    let spec: unknown = rev.spec;
    if (!isActionSpec(spec) && isFlowSpec(spec)) {
      spec = syntheticFlowActionSpec(ref);
    }
    if (!isActionSpec(spec)) {
      return null;
    }
    return declaredTopLevelFields(spec.outputSchema);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asCandidateArray(value: unknown): ExecutionEnvelope['candidates'] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ExecutionEnvelope['candidates'] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const ref = item['ref'];
    if (!isRecord(ref) || typeof ref['consId'] !== 'string' || typeof ref['revision'] !== 'number') {
      continue;
    }
    out.push({
      ref: { consId: ref['consId'], revision: ref['revision'] },
      title: typeof item['title'] === 'string' ? item['title'] : '',
      roles: Array.isArray(item['roles']) ? (item['roles'] as ExecutionEnvelope['candidates'][number]['roles']) : [],
      summary: typeof item['summary'] === 'string' ? item['summary'] : '',
    });
  }
  return out;
}

function asRefArray(value: unknown): ConsRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ConsRef[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item['consId'] === 'string' && typeof item['revision'] === 'number') {
      out.push({ consId: item['consId'], revision: item['revision'] });
    }
  }
  return out;
}

async function readRevision(store: ConsStoreApi, ref: ConsRef): Promise<ConsRevision> {
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null) {
    throw new StepFailure('unknown_reference', `revision ${ref.consId}@${String(ref.revision)} not found`);
  }
  return rev;
}

async function resolveAction(
  store: ConsStoreApi,
  runId: string,
  node: { actionId?: string; actionFrom?: string },
): Promise<ConsRef> {
  let ref: ConsRef;
  if (typeof node.actionId === 'string') {
    const binding = await store.getActiveExecutionBinding(node.actionId);
    if (binding === null || !binding.active) {
      throw new StepFailure('missing_binding', `no active execution binding for ${node.actionId}`);
    }
    ref = { consId: node.actionId, revision: binding.revision };
  } else {
    const key = node.actionFrom ?? '';
    const record = await authorizationFor(store, runId, key);
    if (record === null) {
      throw new StepFailure('unauthorized_action', `actionFrom "${key}" does not reference a server-authorized selection`);
    }
    const consId = record.consId;
    const revision = record.revision;
    const binding = await store.getExecutionBinding(consId, revision);
    if (binding === null || !binding.active) {
      throw new StepFailure('missing_binding', `no active execution binding for ${consId}@${String(revision)}`);
    }
    ref = { consId, revision };
  }
  const rev = await readRevision(store, ref);
  if (!isActionSpec(rev.spec) && !isFlowSpec(rev.spec)) {
    throw new StepFailure('config_error', `${ref.consId}@${String(ref.revision)} has neither an action spec nor a flow spec`);
  }
  return ref;
}

function bindInputs(
  bindings: Record<string, { source: 'literal'; value: unknown } | { source: 'run'; path: string } | { source: 'state'; path: string }>,
  run: Run,
): Record<string, unknown> {
  const runRoot: Record<string, unknown> = {
    id: run.id,
    task: run.task,
    inputRefs: run.inputRefs,
    input: run.state[STATE_KEY_RUN_INPUT],
  };
  const input: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.source === 'literal') {
      input[key] = binding.value;
    } else if (binding.source === 'run') {
      input[key] = resolvePath(runRoot, binding.path);
    } else {
      input[key] = resolvePath(run.state, binding.path);
    }
    if (input[key] === undefined) {
      delete input[key];
    }
  }
  return input;
}

function validateOutputReferences(envelope: ExecutionEnvelope, output: unknown): ErrorCode | null {
  if (isRecord(output) && (output['status'] === 'selected' || output['status'] === 'no_candidate')) {
    if (output['status'] === 'selected') {
      const selected = output['selected'];
      if (!isRecord(selected) || typeof selected['consId'] !== 'string' || typeof selected['revision'] !== 'number') {
        return 'schema_mismatch';
      }
      const hit = envelope.candidates.find((c) => c.ref.consId === selected['consId'] && c.ref.revision === selected['revision']);
      if (hit === undefined) {
        return 'unauthorized_action';
      }
    }
    const used = output['usedTendencies'];
    if (used !== undefined) {
      const tendencyIds = new Set(envelope.tendencies.map((t) => t.ref.consId));
      if (!Array.isArray(used) || used.some((id) => typeof id !== 'string' || !tendencyIds.has(id))) {
        return 'unauthorized_action';
      }
    }
    return null;
  }
  if (isRecord(output) && Array.isArray(output['artifacts']) && Array.isArray(output['links'])) {
    const tempIds = new Set<string>();
    for (const art of output['artifacts']) {
      if (isRecord(art) && typeof art['tempId'] === 'string') {
        tempIds.add(art['tempId']);
      }
    }
    const allowedRelations = new Set<string>(envelope.allowedRelationTypes ?? []);
    for (const link of output['links']) {
      if (!isRecord(link)) {
        return 'schema_mismatch';
      }
      const from = link['fromTempId'];
      const to = link['toTempId'];
      const rel = link['relationConsId'];
      if (typeof from !== 'string' || !tempIds.has(from)) {
        return 'unknown_reference';
      }
      if (typeof to !== 'string' || !tempIds.has(to)) {
        return 'unknown_reference';
      }
      if (typeof rel !== 'string' || !allowedRelations.has(rel)) {
        return 'unauthorized_effect';
      }
    }
  }
  return null;
}

async function validateArtifactTempIds(store: ConsStoreApi, output: unknown): Promise<ErrorCode | null> {
  if (!isRecord(output) || !Array.isArray(output['artifacts'])) return null;
  for (const art of output['artifacts']) {
    if (isRecord(art) && typeof art['tempId'] === 'string' && art['tempId'] !== '') {
      const cons = await store.getCons(art['tempId']);
      if (cons !== null) return 'unauthorized_effect';
    }
  }
  return null;
}

function buildEnvelope(
  run: Run,
  step: Step,
  actionRev: ConsRevision,
  actionSpec: ActionSpec,
  method: { ref: ConsRef; spec: MethodSpec; body: string } | undefined,
  tendencies: Array<{ ref: ConsRef; spec: TendencySpec }>,
  input: unknown,
  candidates: ExecutionEnvelope['candidates'],
  allowedRelationTypes: string[],
): ExecutionEnvelope {
  const envelope: ExecutionEnvelope = {
    runId: run.id,
    stepId: step.id,
    task: run.task,
    action: { ref: step.actionRef, spec: actionSpec, body: actionRev.body },
    tendencies,
    input,
    candidates,
    allowedEffects: actionSpec.allowedEffects,
    outputSchema: actionSpec.outputSchema,
    allowedRelationTypes,
  };
  if (method !== undefined) {
    envelope.method = method;
  }
  return envelope;
}

async function callLlmOnce(
  deps: EngineDeps,
  run: Run,
  step: Step,
  systemPrompt: string,
  userPrompt: string,
  outputSchema: object,
  attemptNo: number,
): Promise<LlmResponse> {
  let lastError: unknown = null;
  const request = {
    systemPrompt,
    userPrompt,
    outputSchema,
    maxOutputTokens: run.budget.maxOutputTokensPerCall,
  };
  for (let netTry = 0; netTry <= NETWORK_RETRIES; netTry++) {
    if (run.counters.llmCalls >= run.budget.maxLlmCalls) {
      throw new BudgetSignal();
    }
    run.counters = { steps: run.counters.steps, llmCalls: run.counters.llmCalls + 1 };
    await deps.store.updateRun(run.id, { counters: run.counters });
    try {
      const res = await deps.llm.complete(request);
      step.llmAttemptCount += 1;
      await deps.store.upsertStep(step);
      if (deps.llmLog !== undefined) {
        await deps.llmLog.insert({
          stepId: step.id,
          attemptNo,
          request,
          response: { text: res.text },
          model: res.model,
          usage: res.usage ?? null,
          latencyMs: res.latencyMs,
          errorCode: null,
        });
      }
      await deps.store.appendEvent('llm_called', {
        stepId: step.id,
        attemptNo,
        model: res.model,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        maxOutputTokens: request.maxOutputTokens,
        latencyMs: res.latencyMs,
        usage: res.usage ?? null,
      }, run.id, step.id);
      return res;
    } catch (err) {
      lastError = err;
      step.llmAttemptCount += 1;
      await deps.store.upsertStep(step);
      if (deps.llmLog !== undefined) {
        await deps.llmLog.insert({
          stepId: step.id,
          attemptNo,
          request,
          response: null,
          model: null,
          usage: null,
          latencyMs: null,
          errorCode: 'model_unavailable',
        });
      }
      await deps.store.appendEvent('llm_called', {
        stepId: step.id,
        attemptNo,
        model: null,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        maxOutputTokens: request.maxOutputTokens,
        latencyMs: null,
        usage: null,
        errorCode: 'model_unavailable',
        error: err instanceof Error ? err.message : String(err),
      }, run.id, step.id);
      if (netTry < NETWORK_RETRIES) {
        await sleep(25 * (netTry + 1));
      }
    }
  }
  throw new StepFailure('model_unavailable', `llm call failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function repairPrompt(userPrompt: string, code: ErrorCode, detail: string[]): string {
  return `${userPrompt}\n\n上一次输出未通过校验。\n错误代码：${code}\n错误详情：\n${detail.map((d) => `- ${d}`).join('\n')}\n请在相同的授权范围内修正问题，只返回符合 outputSchema 的 JSON。`;
}

type ParsedCheck = { ok: true; value: unknown } | { ok: false; code: ErrorCode; errors: string[] };

function checkParsed(envelope: ExecutionEnvelope, text: string): ParsedCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_json', errors: ['响应不是合法 JSON'] };
  }
  const schemaResult = validateSchema(envelope.outputSchema, parsed);
  if (!schemaResult.ok) {
    return { ok: false, code: 'schema_mismatch', errors: schemaResult.errors };
  }
  const refCode = validateOutputReferences(envelope, parsed);
  if (refCode !== null) {
    return { ok: false, code: refCode, errors: [`输出引用校验失败：${refCode}`] };
  }
  return { ok: true, value: parsed };
}

async function recoverPersistedResponse(
  deps: EngineDeps,
  step: Step,
  envelope: ExecutionEnvelope,
): Promise<{ recovered: boolean; value?: unknown }> {
  if (deps.llmLog === undefined) {
    return { recovered: false };
  }
  const rec = await deps.llmLog.getLastSuccess(step.id);
  if (rec === null) {
    return { recovered: false };
  }
  const text = isRecord(rec.response) && typeof rec.response['text'] === 'string' ? rec.response['text'] : undefined;
  if (text === undefined) {
    return { recovered: false };
  }
  const check = checkParsed(envelope, text);
  if (!check.ok) {
    return { recovered: false };
  }
  await deps.store.appendEvent('llm_response_recovered', {
    stepId: step.id,
    attemptNo: rec.attemptNo,
  }, envelope.runId, step.id);
  return { recovered: true, value: check.value };
}

async function callAndValidateLocalModel(
  deps: EngineDeps,
  run: Run,
  step: Step,
  envelope: ExecutionEnvelope,
): Promise<unknown> {
  const recovered = await recoverPersistedResponse(deps, step, envelope);
  if (recovered.recovered) {
    return recovered.value;
  }
  const prompts = buildPrompts(envelope);
  let userPrompt = prompts.userPrompt;
  let repaired = false;
  let attemptNo = 0;
  for (;;) {
    attemptNo += 1;
    const res = await callLlmOnce(deps, run, step, prompts.systemPrompt, userPrompt, envelope.outputSchema, attemptNo);
    const check = checkParsed(envelope, res.text);
    if (check.ok) {
      return check.value;
    }
    if (!repaired && (check.code === 'invalid_json' || check.code === 'schema_mismatch' || check.code === 'unknown_reference')) {
      repaired = true;
      userPrompt = repairPrompt(prompts.userPrompt, check.code, check.errors);
      continue;
    }
    throw new StepFailure(check.code, check.errors.join('; '));
  }
}

async function executePinnedSubflow(
  deps: EngineDeps,
  run: Run,
  step: Step,
  envelope: ExecutionEnvelope,
  flowRef: ConsRef,
): Promise<unknown> {
  const childRunId = `${run.id}::sub::${step.nodeId}`;
  let child = await deps.store.getRun(childRunId);
  if (child === null) {
    const flowRev = await readRevision(deps.store, flowRef);
    if (!isFlowSpec(flowRev.spec)) {
      throw new StepFailure('config_error', `${flowRef.consId}@${String(flowRef.revision)} has no flow spec`);
    }
    const childState: Record<string, unknown> = {};
    if (isRecord(envelope.input)) {
      for (const [k, v] of Object.entries(envelope.input)) {
        if (!k.startsWith('_')) {
          childState[k] = v;
        }
      }
    } else {
      childState['value'] = envelope.input;
    }
    child = {
      id: childRunId,
      entryFlowRef: flowRef,
      task: run.task,
      inputRefs: [],
      status: 'queued',
      budget: run.budget,
      counters: { steps: run.counters.steps, llmCalls: run.counters.llmCalls },
      state: { ...childState },
    };
    await deps.store.createRun(child);
    await deps.store.appendEvent('subflow_started', {
      parentRunId: run.id,
      childRunId,
      nodeId: step.nodeId,
      flowRef,
    }, run.id, step.id);
  }
  const finished = await executeRun(deps, childRunId);
  run.counters = { steps: finished.counters.steps, llmCalls: finished.counters.llmCalls };
  await deps.store.updateRun(run.id, { counters: run.counters });
  if (finished.status === 'budget_exhausted') {
    throw new BudgetSignal();
  }
  if (finished.status !== 'completed') {
    const childSteps = await deps.store.listSteps(childRunId);
    const failed = childSteps.find((s) => s.status === 'failed');
    const code = failed !== undefined && failed.errorCode !== undefined && ERROR_CODE_SET.has(failed.errorCode)
      ? failed.errorCode as ErrorCode
      : 'config_error';
    throw new StepFailure(code, `subflow ${flowRef.consId} ended with status ${finished.status}`);
  }
  await deps.store.appendEvent('subflow_finished', {
    parentRunId: run.id,
    childRunId,
    nodeId: step.nodeId,
    flowRef,
  }, run.id, step.id);
  return finished.state;
}

async function executeStep(deps: EngineDeps, run: Run, step: Step, envelope: ExecutionEnvelope): Promise<unknown> {
  const spec = envelope.action.spec;
  if (spec.executor === 'primitive') {
    const key = spec.primitiveKey ?? '';
    const primitive = deps.primitives[key];
    if (primitive === undefined) {
      throw new StepFailure('missing_binding', `primitive "${key}" is not registered`);
    }
    const ctx: StepContext = { store: deps.store, run, step, envelope };
    return primitive.run(ctx, step.id);
  }
  if (spec.executor === 'llm') {
    return callAndValidateLocalModel(deps, run, step, envelope);
  }
  if (spec.executor === 'flow') {
    if (spec.flowRef === undefined) {
      throw new StepFailure('config_error', 'flow executor action has no flowRef');
    }
    return executePinnedSubflow(deps, run, step, envelope, spec.flowRef);
  }
  throw new StepFailure('config_error', `unknown executor "${spec.executor}"`);
}

function authorizeSelection(output: unknown, authorization: Omit<AuthorizationRecord, 'stepId'> | null): unknown {
  if (authorization !== null && isRecord(output)) {
    return {
      ...output,
      consId: authorization.consId,
      revision: authorization.revision,
      title: authorization.title,
      authorized: true,
    };
  }
  return output;
}

export async function executeRun(deps: EngineDeps, runId: string): Promise<Run> {
  const run = await deps.store.getRun(runId);
  if (run === null) {
    throw new Error(`run ${runId} not found`);
  }
  const events = await deps.store.listEvents(runId, { limit: 1 });
  if (events.length === 0) {
    await deps.store.appendEvent('run_started', {
      runId: run.id,
      entryFlowRef: run.entryFlowRef,
      task: run.task,
    }, run.id, null);
  }
  if (run.status === 'queued') {
    run.status = 'running';
    await deps.store.updateRun(run.id, { status: 'running' });
  }
  let flowRev: ConsRevision;
  try {
    flowRev = await readRevision(deps.store, run.entryFlowRef);
  } catch (err) {
    return failRun(deps, run, null, codeOf(err), messageOf(err));
  }
  const flowSpec = flowRev.spec;
  if (!isRecord(flowSpec) || flowSpec['kind'] !== 'flow') {
    return failRun(deps, run, null, 'config_error', 'entry flow revision has no flow spec');
  }
  const flowErrors = validateFlow(flowSpec as { kind: 'flow'; entry: string; nodes: Record<string, import('../types.js').FlowNode> });
  if (flowErrors.length > 0) {
    return failRun(deps, run, null, 'config_error', flowErrors.join('; '));
  }
  const flow = flowSpec as import('../types.js').FlowSpec;
  let nodeId: string | null = flow.entry;
  while (nodeId !== null) {
    const node = flow.nodes[nodeId];
    if (node === undefined) {
      return failRun(deps, run, null, 'config_error', `node "${nodeId}" not found`);
    }
    if (node.terminal === true) {
      return finishRun(deps, run);
    }
    const existing = await deps.store.getStep(run.id, nodeId);
    if (existing !== null && existing.status === 'succeeded') {
      const declaredFields = await declaredFieldsForNode(deps.store, run.id, node);
      const transition = evaluateTransition(node, existing.output, declaredFields ?? undefined);
      if (transition.error !== undefined) {
        return failRun(deps, run, existing, 'schema_mismatch', transition.error);
      }
      nodeId = transition.next;
      continue;
    }
    if (run.counters.steps >= run.budget.maxSteps) {
      return exhaustBudget(deps, run, { reason: 'maxSteps', nodeId });
    }
    let actionRef: ConsRef;
    try {
      actionRef = await resolveAction(deps.store, run.id, node);
    } catch (err) {
      return failRun(deps, run, null, codeOf(err), messageOf(err));
    }
    if (node.actionFrom !== undefined) {
      if (node.allowedActionIds !== undefined && !node.allowedActionIds.includes(actionRef.consId)) {
        return failRun(deps, run, null, 'unauthorized_action', `action ${actionRef.consId} is outside the allowed action set of node "${nodeId}"`);
      }
      if (node.allowedActionIds === undefined && node.contentActionsOnly === true) {
        const chosen = await readRevision(deps.store, actionRef);
        let chosenSpec: unknown = chosen.spec;
        if (!isActionSpec(chosenSpec) && isFlowSpec(chosenSpec)) {
          chosenSpec = syntheticFlowActionSpec(actionRef);
        }
        if (!isContentActionCompatible(chosenSpec)) {
          return failRun(deps, run, null, 'unauthorized_action', `action ${actionRef.consId} does not satisfy the content action contract of node "${nodeId}"`);
        }
      }
    }
    const actionRev = await readRevision(deps.store, actionRef);
    let actionSpec = actionRev.spec;
    if (!isActionSpec(actionSpec)) {
      if (isFlowSpec(actionSpec)) {
        actionSpec = syntheticFlowActionSpec(actionRef);
      } else {
        return failRun(deps, run, null, 'config_error', `${actionRef.consId} has no action spec`);
      }
    }
    let input: Record<string, unknown>;
    try {
      input = bindInputs(node.inputBindings, run);
    } catch (err) {
      return failRun(deps, run, null, codeOf(err), messageOf(err));
    }
    const inputResult = validateSchema(actionSpec.inputSchema, input);
    if (!inputResult.ok) {
      return failRun(deps, run, null, 'schema_mismatch', inputResult.errors.join('; '));
    }
    let method: { ref: ConsRef; spec: MethodSpec; body: string } | undefined;
    const methodAuth = await authorizationFor(deps.store, run.id, STATE_KEY_METHOD_SELECTION);
    if (methodAuth !== null) {
      const methodRev = await deps.store.getRevision(methodAuth.consId, methodAuth.revision);
      if (methodRev !== null && isMethodSpec(methodRev.spec) && methodRev.spec.actionId === actionRef.consId) {
        method = { ref: { consId: methodAuth.consId, revision: methodAuth.revision }, spec: methodRev.spec, body: methodRev.body };
      }
    }
    if (method === undefined && typeof actionSpec.defaultMethodId === 'string') {
      const defaultCons = await deps.store.getCons(actionSpec.defaultMethodId);
      if (defaultCons !== null && defaultCons.status === 'active') {
        const methodRef: ConsRef = {
          consId: actionSpec.defaultMethodId,
          revision: defaultCons.activeRevision ?? defaultCons.currentRevision,
        };
        const methodRev = await deps.store.getRevision(methodRef.consId, methodRef.revision);
        if (
          methodRev !== null &&
          methodRev.roles.includes('method') &&
          isMethodSpec(methodRev.spec) &&
          methodRev.spec.actionId === actionRef.consId
        ) {
          method = { ref: methodRef, spec: methodRev.spec, body: methodRev.body };
        }
      }
    }
    if (method === undefined && actionSpec.executor === 'llm') {
      return failRun(deps, run, null, 'missing_binding', `action ${actionRef.consId} declares no default method and no verified method selection is present`);
    }
    const tendencyStateRaw = run.state[STATE_KEY_TENDENCY_REFS];
    const tendencyRefsInput = isRecord(tendencyStateRaw) && Array.isArray(tendencyStateRaw['tendencyRefs'])
      ? tendencyStateRaw['tendencyRefs']
      : tendencyStateRaw;
    const tendencyRefs = asRefArray(tendencyRefsInput);
    const tendencies: Array<{ ref: ConsRef; spec: TendencySpec }> = [];
    for (const ref of tendencyRefs) {
      const rev = await readRevision(deps.store, ref);
      if (isTendencySpec(rev.spec)) {
        tendencies.push({ ref, spec: rev.spec });
      }
    }
    const inputCandidates = isRecord(input) && Array.isArray(input['candidates']) ? input['candidates'] : run.state[STATE_KEY_CANDIDATES];
    const candidates = asCandidateArray(inputCandidates);
    const relationTypeCons = await deps.store.listActiveConsByRole('relation_type');
    const allowedRelationTypes = relationTypeCons.map((c) => c.ref.consId);
    const stepId = stepIdFor(run.id, nodeId);
    const step: Step = {
      id: stepId,
      runId: run.id,
      nodeId,
      actionRef,
      tendencyRefs,
      input,
      status: 'running',
      llmAttemptCount: existing !== null && existing !== undefined ? existing.llmAttemptCount : 0,
    };
    if (method !== undefined) {
      step.methodRef = method.ref;
    }
    run.counters = { steps: run.counters.steps + 1, llmCalls: run.counters.llmCalls };
    await deps.store.updateRun(run.id, { counters: run.counters });
    await deps.store.upsertStep(step);
    await deps.store.appendEvent('step_started', {
      stepId: step.id,
      nodeId,
      actionRef,
      methodRef: method !== undefined ? method.ref : null,
      tendencyRefs,
    }, run.id, step.id);
    const envelope = buildEnvelope(run, step, actionRev, actionSpec, method, tendencies, input, candidates, allowedRelationTypes);
    let output: unknown;
    try {
      output = await executeStep(deps, run, step, envelope);
    } catch (err) {
      if (err instanceof BudgetSignal) {
        return exhaustBudget(deps, run, { reason: 'maxLlmCalls', nodeId, step });
      }
      return failRun(deps, run, step, codeOf(err), messageOf(err));
    }
    const outputResult = validateSchema(actionSpec.outputSchema, output);
    if (!outputResult.ok) {
      return failRun(deps, run, step, 'schema_mismatch', outputResult.errors.join('; '));
    }
    const refCode = validateOutputReferences(envelope, output);
    if (refCode !== null) {
      return failRun(deps, run, step, refCode, `output reference validation failed: ${refCode}`);
    }
    const tempIdCode = await validateArtifactTempIds(deps.store, output);
    if (tempIdCode !== null) {
      return failRun(deps, run, step, tempIdCode, `output artifact validation failed: ${tempIdCode}`);
    }
    const transition = evaluateTransition(node, output, declaredTopLevelFields(actionSpec.outputSchema));
    if (transition.error !== undefined) {
      return failRun(deps, run, step, 'schema_mismatch', transition.error);
    }
    const committed: Step = { ...step, status: 'succeeded', output };
    const authorization = buildAuthorization(output, candidates);
    const committedOutput = authorizeSelection(output, authorization);
    const committedStep: Step = { ...committed, output: committedOutput };
    const nextState: Record<string, unknown> = { ...run.state, [node.outputKey]: committedOutput, [STATE_KEY_CURRENT_NODE]: transition.next };
    const selectionLike = isRecord(output) && (output['status'] === 'selected' || output['status'] === 'no_candidate');
    const selectionBasis = isRecord(output) && typeof output['basisSummary'] === 'string' ? output['basisSummary'] : null;
    const rawUsedTendencies = isRecord(output) && Array.isArray(output['usedTendencies'])
      ? output['usedTendencies'].filter((id): id is string => typeof id === 'string')
      : [];
    const usedTendencyRefs: ConsRef[] = [];
    for (const id of rawUsedTendencies) {
      const cons = await deps.store.getCons(id);
      if (cons !== null) {
        usedTendencyRefs.push({ consId: id, revision: cons.currentRevision });
      }
    }
    await deps.store.transaction(async () => {
      await deps.store.upsertStep(committedStep);
      await deps.store.updateRun(run.id, { state: nextState, counters: run.counters });
      if (authorization !== null) {
        await deps.store.putRunAuthorization(run.id, node.outputKey, { stepId: step.id, ...authorization });
      }
      if (selectionLike) {
        const committedRecord = isRecord(committedOutput) ? committedOutput : {};
        await deps.store.appendEvent('selection_made', {
          stepId: step.id,
          nodeId,
          candidates: candidates.map((c) => c.ref),
          selected: isRecord(committedRecord['selected']) ? committedRecord['selected'] : null,
          basisSummary: selectionBasis,
          usedTendencies: rawUsedTendencies,
          usedTendencyRefs,
        }, run.id, step.id);
      }
      await deps.store.appendEvent('step_succeeded', {
        stepId: step.id,
        nodeId,
        outputKey: node.outputKey,
        llmAttemptCount: committed.llmAttemptCount,
      }, run.id, step.id);
    });
    run.state = nextState;
    nodeId = transition.next;
  }
  return finishRun(deps, run);
}

function codeOf(err: unknown): ErrorCode {
  if (err instanceof StepFailure) {
    return err.code;
  }
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE_SET.has(code)) {
      return code as ErrorCode;
    }
  }
  return 'config_error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function failRun(
  deps: EngineDeps,
  run: Run,
  step: Step | null,
  errorCode: ErrorCode,
  message: string,
): Promise<Run> {
  run.status = 'failed';
  await deps.store.transaction(async () => {
    if (step !== null) {
      const failed: Step = { ...step, status: 'failed', errorCode };
      await deps.store.upsertStep(failed);
    }
    await deps.store.updateRun(run.id, { status: 'failed', state: { ...run.state, [STATE_KEY_CURRENT_NODE]: null } });
    await deps.store.appendEvent('step_failed', {
      nodeId: step !== null ? step.nodeId : null,
      stepId: step !== null ? step.id : null,
      errorCode,
      message,
    }, run.id, step !== null ? step.id : null);
  });
  await deps.store.appendEvent('run_finished', { runId: run.id, status: 'failed' }, run.id, null);
  return run;
}

async function exhaustBudget(
  deps: EngineDeps,
  run: Run,
  info: { reason: string; nodeId: string; step?: Step },
): Promise<Run> {
  run.status = 'budget_exhausted';
  await deps.store.transaction(async () => {
    if (info.step !== undefined) {
      const failed: Step = { ...info.step, status: 'failed', errorCode: 'budget_exhausted' };
      await deps.store.upsertStep(failed);
    }
    await deps.store.updateRun(run.id, { status: 'budget_exhausted', counters: run.counters, state: { ...run.state, [STATE_KEY_CURRENT_NODE]: null } });
    await deps.store.appendEvent('budget_exhausted', {
      reason: info.reason,
      nodeId: info.nodeId,
      counters: run.counters,
      budget: run.budget,
    }, run.id, info.step !== undefined ? info.step.id : null);
  });
  return run;
}

async function finishRun(deps: EngineDeps, run: Run): Promise<Run> {
  run.status = 'completed';
  await deps.store.updateRun(run.id, { status: 'completed', state: { ...run.state, [STATE_KEY_CURRENT_NODE]: null } });
  await deps.store.appendEvent('run_finished', {
    runId: run.id,
    status: 'completed',
    counters: run.counters,
  }, run.id, null);
  return run;
}
