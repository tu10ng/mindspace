import type {
  ActionSpec, AvailableRefItem, AvailableReferences, Binding, ConsRef, ConsRevision,
  EntityCandidate, EntityResolutionItem, ErrorCode, ExecutionEnvelope, FlowNode, FlowSpec, LlmAdapter,
  LlmResponse, MethodSpec, Run, StatementCandidate, Step, TendencySpec, ValidationIssue,
} from '../types.js';
import type { ConsStoreApi } from '../store/api.js';
import { validateSchema, validateSchemaDetailed, validateSchemaStructure } from '../schema.js';
import { resolvePath } from './path.js';
import { evaluateTransition, validateFlow } from './flow.js';
import { buildPrompts } from '../llm/prompt.js';
import {
  adaptInputForSchema,
  isContentActionCompatible,
  TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
  TRUSTED_SNAPSHOT_ENTITY_RESOLUTION,
  TRUSTED_SNAPSHOT_SUMMARY_CONTEXT,
  type TrustedEntityContextSnapshot,
  type TrustedEntityResolutionSnapshot,
  type TrustedSummaryContextSnapshot,
} from '../primitives/index.js';
import type { LlmAttemptLog } from './llm_log.js';
import { PROMPT_TEMPLATE_VERSION } from './llm_log.js';

export const STATE_KEY_CANDIDATES = 'candidates';
export const STATE_KEY_TENDENCY_REFS = 'tendencyRefs';
export const STATE_KEY_METHOD_SELECTION = 'methodSelection';
export const STATE_KEY_RUN_INPUT = 'input';
export const STATE_KEY_CURRENT_NODE = '_currentNode';
const NETWORK_RETRIES = 2;
const REPAIRABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'invalid_json',
  'truncated_output',
  'schema_mismatch',
  'invalid_reference',
  'unknown_reference',
]);
const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>([
  'invalid_json', 'truncated_output', 'schema_mismatch',
  'invalid_reference', 'unknown_reference',
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
  issues: ValidationIssue[];
  constructor(code: ErrorCode, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
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

function isFlowSpec(value: unknown): value is FlowSpec {
  return isRecord(value) && value['kind'] === 'flow';
}

function isRef(value: unknown): value is ConsRef {
  return isRecord(value) && typeof value['consId'] === 'string' && typeof value['revision'] === 'number';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTruncatedStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
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

function hasArtifactsAndLinksSchema(schema: object): boolean {
  const fields = declaredTopLevelFields(schema);
  return fields.has('artifacts') && fields.has('links');
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

async function enrichCandidates(
  store: ConsStoreApi,
  candidates: ExecutionEnvelope['candidates'],
): Promise<ExecutionEnvelope['candidates']> {
  const out: ExecutionEnvelope['candidates'] = [];
  for (const c of candidates) {
    if (c.summary.trim() !== '' && c.title.trim() !== '') {
      out.push(c);
      continue;
    }
    const rev = await store.getRevision(c.ref.consId, c.ref.revision);
    if (rev === null) {
      out.push(c);
      continue;
    }
    const desc = rev.applicabilityText !== undefined && rev.applicabilityText.trim() !== ''
      ? rev.applicabilityText
      : rev.body;
    out.push({
      ref: c.ref,
      title: c.title.trim() !== '' ? c.title : rev.title,
      roles: c.roles.length > 0 ? c.roles : rev.roles,
      summary: c.summary.trim() !== '' ? c.summary : desc,
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

async function refToAvailableItem(store: ConsStoreApi, ref: ConsRef): Promise<AvailableRefItem | null> {
  const rev = await store.getRevision(ref.consId, ref.revision);
  if (rev === null) return null;
  const description = rev.applicabilityText !== undefined && rev.applicabilityText.trim() !== ''
    ? rev.applicabilityText
    : rev.body;
  return {
    consId: ref.consId,
    revision: ref.revision,
    title: rev.title,
    description,
  };
}

async function refsFromCandidateList(store: ConsStoreApi, raw: unknown): Promise<AvailableRefItem[]> {
  const items: AvailableRefItem[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return items;
  for (const entry of raw) {
    let ref: ConsRef | null = null;
    if (isRef(entry)) {
      ref = entry;
    } else if (isRecord(entry) && isRef(entry['ref'])) {
      ref = entry['ref'];
    }
    if (ref === null) continue;
    const key = `${ref.consId}@${String(ref.revision)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = await refToAvailableItem(store, ref);
    if (item !== null) items.push(item);
  }
  return items;
}

function refKey(ref: ConsRef): string {
  return `${ref.consId}@${String(ref.revision)}`;
}

function asEntityCandidateArray(value: unknown, allowedKeys: Set<string> | null): EntityCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: EntityCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRef(item['ref'])) continue;
    if (allowedKeys !== null && !allowedKeys.has(refKey(item['ref']))) continue;
    out.push(item as unknown as EntityCandidate);
  }
  return out;
}

function asStatementCandidateArray(value: unknown, allowedKeys: Set<string> | null): StatementCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: StatementCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRef(item['ref'])) continue;
    if (allowedKeys !== null && !allowedKeys.has(refKey(item['ref']))) continue;
    out.push(item as unknown as StatementCandidate);
  }
  return out;
}

async function resolveContextRefsForRun(
  store: ConsStoreApi,
  run: Run,
  input: Record<string, unknown>,
): Promise<{ objects: EntityCandidate[]; statements: StatementCandidate[] }> {
  // Always intersect with server-trusted entity_context snapshot when present so
  // tampered run.state entries cannot inject unauthorized references.
  const snap = await store.getTrustedSnapshot<TrustedEntityContextSnapshot>(run.id, TRUSTED_SNAPSHOT_ENTITY_CONTEXT);
  const allowedObjKeys = snap !== null ? new Set(snap.payload.objectRefs.map(refKey)) : null;
  const allowedStmtKeys = snap !== null ? new Set(snap.payload.statementRefs.map(refKey)) : null;
  const bundle = isRecord(run.state['contextBundle']) ? run.state['contextBundle'] : null;
  const rawObjects = Array.isArray(input['availableObjects'])
    ? input['availableObjects']
    : (bundle !== null && Array.isArray(bundle['objects']) ? bundle['objects'] : []);
  const rawStatements = Array.isArray(input['availableStatements'])
    ? input['availableStatements']
    : (bundle !== null && Array.isArray(bundle['statements']) ? bundle['statements'] : []);
  return {
    objects: asEntityCandidateArray(rawObjects, allowedObjKeys),
    statements: asStatementCandidateArray(rawStatements, allowedStmtKeys),
  };
}

async function buildAvailableReferences(
  store: ConsStoreApi,
  run: Run,
  actionRef: ConsRef,
  actionSpec: ActionSpec,
  input: Record<string, unknown>,
  candidates: ExecutionEnvelope['candidates'],
  tendencies: Array<{ ref: ConsRef; title?: string; spec: TendencySpec }>,
  relationTypeItems: AvailableRefItem[],
): Promise<AvailableReferences> {
  const refs: AvailableReferences = {};
  const actionId = actionRef.consId;
  const tendencyItems: AvailableRefItem[] = tendencies.map((t) => ({
    consId: t.ref.consId,
    revision: t.ref.revision,
    title: t.title ?? t.ref.consId,
    description: t.spec.preferenceText || t.spec.applicabilityText,
  }));

  const isSelectAction = actionId === 'seed.select_action'
    || (actionSpec.freedom.chooseWithinCandidates && actionId !== 'seed.select_method' && actionId !== 'seed.resolve_entities' && !candidates.some((c) => c.roles.includes('method')));
  const isSelectMethod = actionId === 'seed.select_method'
    || (actionSpec.freedom.chooseWithinCandidates && actionId !== 'seed.resolve_entities' && candidates.some((c) => c.roles.includes('method')));

  if (isSelectAction) {
    refs.availableActions = candidates.map((c) => ({
      consId: c.ref.consId,
      revision: c.ref.revision,
      title: c.title,
      description: c.summary,
    }));
    refs.availableTendencies = tendencyItems;
  } else if (isSelectMethod) {
    refs.availableMethods = candidates.map((c) => ({
      consId: c.ref.consId,
      revision: c.ref.revision,
      title: c.title,
      description: c.summary,
    }));
    refs.availableTendencies = tendencyItems;
  }

  if (hasArtifactsAndLinksSchema(actionSpec.outputSchema)) {
    refs.availableRelationTypes = relationTypeItems;
    const ctxRefs = await resolveContextRefsForRun(store, run, input);
    refs.availableObjects = ctxRefs.objects;
    refs.availableStatements = ctxRefs.statements;
  }

  if (actionId === 'seed.resolve_entities') {
    const ctxRefs = await resolveContextRefsForRun(store, run, input);
    refs.availableObjects = ctxRefs.objects;
    refs.availableStatements = ctxRefs.statements;
    refs.availableTendencies = tendencyItems;
  }

  if (actionId === 'seed.associate_context') {
    const ctxRefs = await resolveContextRefsForRun(store, run, input);
    refs.availableObjects = ctxRefs.objects;
    refs.availableStatements = ctxRefs.statements;
    refs.availableRelationTypes = relationTypeItems;
  }

  if (actionId === 'seed.summarize_topic') {
    const topic = isRecord(input['topic']) && isRef(input['topic']['ref'])
      ? [input['topic'] as unknown as EntityCandidate]
      : [];
    const direct = asStatementCandidateArray(input['directStatements'], null);
    const related = asStatementCandidateArray(input['relatedContextStatements'], null);
    refs.availableObjects = topic;
    refs.availableStatements = [...direct, ...related];
  }

  if (actionId === 'seed.extract_method') {
    const actions: AvailableRefItem[] = [];
    const caseData = isRecord(input['caseData']) ? input['caseData'] : null;
    const actionSelection = isRecord(run.state['actionSelection']) ? run.state['actionSelection'] : null;
    const targetRef = (caseData !== null && isRef(caseData['selectedAction']) ? caseData['selectedAction'] : null)
      ?? (actionSelection !== null && isRef(actionSelection['selected']) ? actionSelection['selected'] : null);
    if (targetRef !== null) {
      const item = await refToAvailableItem(store, targetRef);
      if (item !== null) actions.push(item);
    }
    refs.availableActions = actions;
  }

  if (actionId === 'seed.extract_tendency') {
    const caseData = isRecord(run.state['caseData']) ? run.state['caseData'] : null;
    const selection = isRecord(input['selection']) ? input['selection'] : null;
    const rawActions = run.state['actionCandidates'] !== undefined
      ? (isRecord(run.state['actionCandidates']) && Array.isArray(run.state['actionCandidates']['items'])
          ? run.state['actionCandidates']['items']
          : run.state['actionCandidates'])
      : (caseData !== null && Array.isArray(caseData['candidateActions']) ? caseData['candidateActions'] : []);
    const actionItems = await refsFromCandidateList(store, rawActions);
    if (actionItems.length === 0 && selection !== null && isRef(selection['selected'])) {
      const selItem = await refToAvailableItem(store, selection['selected']);
      if (selItem !== null) actionItems.push(selItem);
    }
    const rawMethods = run.state['methodCandidates'] !== undefined
      ? (isRecord(run.state['methodCandidates']) && Array.isArray(run.state['methodCandidates']['items'])
          ? run.state['methodCandidates']['items']
          : run.state['methodCandidates'])
      : [];
    const methodItems = await refsFromCandidateList(store, rawMethods);
    refs.availableActions = actionItems;
    refs.availableMethods = methodItems;
  }

  if (refs.availableTendencies === undefined && tendencies.length > 0) {
    refs.availableTendencies = tendencyItems;
  }

  return refs;
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
  bindings: Record<string, Binding>,
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

function primaryErrorCode(issues: ValidationIssue[]): ErrorCode {
  const unauthAction = issues.find((i) => i.code === 'unauthorized_action');
  if (unauthAction !== undefined) return unauthAction.code;
  const unauthEffect = issues.find((i) => i.code === 'unauthorized_effect');
  if (unauthEffect !== undefined) return unauthEffect.code;
  return issues[0]?.code ?? 'schema_mismatch';
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}

async function validateOutputIssues(
  store: ConsStoreApi,
  envelope: ExecutionEnvelope,
  output: unknown,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(output)) return issues;

  if (output['status'] === 'selected' || output['status'] === 'no_candidate') {
    if (output['status'] === 'selected') {
      const selected = output['selected'];
      if (!isRecord(selected) || typeof selected['consId'] !== 'string' || typeof selected['revision'] !== 'number') {
        issues.push({
          code: 'schema_mismatch',
          path: '$.selected',
          value: selected,
          message: 'status 为 selected 时，selected 必须是包含 consId 和 revision 的对象。',
        });
      } else {
        const hit = envelope.candidates.find((c) => c.ref.consId === selected['consId'] && c.ref.revision === selected['revision']);
        if (hit === undefined) {
          issues.push({
            code: 'unauthorized_action',
            path: '$.selected',
            value: selected,
            allowedValues: envelope.candidates.map((c) => c.ref),
            message: 'selected 只能引用本次候选集合中的 consId 与 revision。',
          });
        }
      }
    } else if (output['selected'] !== null) {
      issues.push({
        code: 'schema_mismatch',
        path: '$.selected',
        value: output['selected'],
        allowedValues: [null],
        message: 'status 为 no_candidate 时，selected 必须为 null。',
      });
    }
    const used = output['usedTendencies'];
    if (used !== undefined) {
      const allowedTendencyIds = envelope.tendencies.map((t) => t.ref.consId);
      const tendencySet = new Set(allowedTendencyIds);
      if (!Array.isArray(used)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.usedTendencies',
          value: used,
          allowedValues: allowedTendencyIds,
          message: 'usedTendencies 必须是字符串数组。',
        });
      } else {
        for (let i = 0; i < used.length; i++) {
          const item = used[i];
          if (typeof item !== 'string' || !tendencySet.has(item)) {
            issues.push({
              code: 'invalid_reference',
              path: `$.usedTendencies[${String(i)}]`,
              value: item,
              allowedValues: allowedTendencyIds,
              message: allowedTendencyIds.length === 0
                ? '此字段只能填写已提供的倾向ID；当前无可用倾向，应为[]。'
                : '此字段只能填写本次 availableTendencies 中提供的倾向ID。',
            });
          }
        }
      }
    }
    return issues;
  }

  if (Array.isArray(output['artifacts']) && Array.isArray(output['links'])) {
    const tempIds = new Set<string>();
    const draftRelationTempIds = new Set<string>();
    const artifacts = output['artifacts'];
    for (let i = 0; i < artifacts.length; i++) {
      const art = artifacts[i];
      if (!isRecord(art)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.artifacts[${String(i)}]`,
          message: 'artifact 必须是对象。',
        });
        continue;
      }
      const tempId = art['tempId'];
      if (!isNonEmptyString(tempId)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.artifacts[${String(i)}].tempId`,
          value: tempId,
          message: 'tempId 必须是非空字符串。',
        });
      } else {
        if (tempIds.has(tempId)) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.artifacts[${String(i)}].tempId`,
            value: tempId,
            message: `tempId "${tempId}" 在当前批次中重复。`,
          });
        } else {
          tempIds.add(tempId);
        }
        const existingCons = await store.getCons(tempId);
        if (existingCons !== null) {
          issues.push({
            code: 'unauthorized_effect',
            path: `$.artifacts[${String(i)}].tempId`,
            value: tempId,
            message: `tempId "${tempId}" 与已有 cons ID 冲突，请使用局部临时标识。`,
          });
        }
      }

      const kind = art['kind'];
      if (kind === 'relation_type') {
        if (envelope.allowRelationTypeDrafts !== true) {
          issues.push({
            code: 'unauthorized_effect',
            path: `$.artifacts[${String(i)}].kind`,
            value: kind,
            allowedValues: ['object', 'proposition'],
            message: '当前步骤未授权提出新关系类型草案；不支持的关系请保存为 proposition。',
          });
        } else if (isNonEmptyString(tempId)) {
          draftRelationTempIds.add(tempId);
        }
      }

      const content = art['content'];
      if (!isRecord(content)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.artifacts[${String(i)}].content`,
          message: 'content 必须是包含 title 和 body 的对象。',
        });
      } else {
        if (!isNonEmptyString(content['title'])) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.artifacts[${String(i)}].content.title`,
            value: content['title'],
            message: 'content.title 必须是非空字符串。',
          });
        }
        if (!isNonEmptyString(content['body'])) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.artifacts[${String(i)}].content.body`,
            value: content['body'],
            message: 'content.body 必须是非空字符串。',
          });
        }
        if (content['spec'] !== undefined) {
          if (kind === 'object' || kind === 'concept' || kind === 'proposition' || kind === 'relation_type') {
            issues.push({
              code: 'schema_mismatch',
              path: `$.artifacts[${String(i)}].content.spec`,
              value: content['spec'],
              message: `kind 为 ${String(kind)} 的内容产物不应填写 spec。`,
            });
          } else if (!isRecord(content['spec']) || content['spec']['kind'] !== kind) {
            issues.push({
              code: 'schema_mismatch',
              path: `$.artifacts[${String(i)}].content.spec`,
              value: content['spec'],
              message: `content.spec.kind 必须与产物 kind "${String(kind)}" 一致。`,
            });
          }
        }
      }
    }

    const availableRelTypes = envelope.availableReferences?.availableRelationTypes ?? [];
    const allowedRelRefs = availableRelTypes.map((r) => ({ consId: r.consId, revision: r.revision }));
    const allowedRelKeySet = new Set(availableRelTypes.map((r) => `${r.consId}@${String(r.revision)}`));
    const allowedTempList = [...tempIds];
    const allowedDraftRelList = [...draftRelationTempIds];

    const links = output['links'];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (!isRecord(link)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.links[${String(i)}]`,
          message: 'link 必须是对象。',
        });
        continue;
      }
      const from = link['fromTempId'];
      const to = link['toTempId'];
      if (typeof from !== 'string' || !tempIds.has(from)) {
        issues.push({
          code: 'invalid_reference',
          path: `$.links[${String(i)}].fromTempId`,
          value: from,
          allowedValues: allowedTempList,
          message: 'fromTempId 必须引用本批次 artifacts 中的 tempId。',
        });
      }
      if (typeof to !== 'string' || !tempIds.has(to)) {
        issues.push({
          code: 'invalid_reference',
          path: `$.links[${String(i)}].toTempId`,
          value: to,
          allowedValues: allowedTempList,
          message: 'toTempId 必须引用本批次 artifacts 中的 tempId。',
        });
      }
      const rel = link['relation'];
      if (isRecord(rel)) {
        const relKind = rel['kind'];
        if (relKind === 'existing') {
          if (rel['tempId'] !== undefined) {
            issues.push({
              code: 'schema_mismatch',
              path: `$.links[${String(i)}].relation.tempId`,
              value: rel['tempId'],
              message: 'relation.kind 为 existing 时不得提供 tempId。',
            });
          }
          const ref = rel['ref'];
          if (!isRef(ref)) {
            issues.push({
              code: 'schema_mismatch',
              path: `$.links[${String(i)}].relation.ref`,
              value: ref,
              allowedValues: allowedRelRefs,
              message: 'relation.kind 为 existing 时必须提供有效的 ref ({ consId, revision })。',
            });
          } else if (!allowedRelKeySet.has(`${ref.consId}@${String(ref.revision)}`)) {
            issues.push({
              code: 'invalid_reference',
              path: `$.links[${String(i)}].relation.ref`,
              value: ref,
              allowedValues: allowedRelRefs,
              message: '已有关系类型只能引用本次 availableRelationTypes 中提供的 consId 与 revision。',
            });
          }
        } else if (relKind === 'draft') {
          if (envelope.allowRelationTypeDrafts !== true) {
            issues.push({
              code: 'unauthorized_effect',
              path: `$.links[${String(i)}].relation.kind`,
              value: relKind,
              allowedValues: ['existing'],
              message: '当前步骤未授权引用新关系类型草案。',
            });
          } else {
            if (rel['ref'] !== undefined) {
              issues.push({
                code: 'schema_mismatch',
                path: `$.links[${String(i)}].relation.ref`,
                value: rel['ref'],
                message: 'relation.kind 为 draft 时不得提供 ref。',
              });
            }
            const relTempId = rel['tempId'];
            if (typeof relTempId !== 'string' || !draftRelationTempIds.has(relTempId)) {
              issues.push({
                code: 'invalid_reference',
                path: `$.links[${String(i)}].relation.tempId`,
                value: relTempId,
                allowedValues: allowedDraftRelList,
                message: 'relation.tempId 必须引用本批次 artifacts 中 kind 为 relation_type 的 tempId。',
              });
            }
          }
        } else {
          issues.push({
            code: 'schema_mismatch',
            path: `$.links[${String(i)}].relation.kind`,
            value: relKind,
            allowedValues: envelope.allowRelationTypeDrafts === true ? ['existing', 'draft'] : ['existing'],
            message: 'relation.kind 必须是 existing 或 draft。',
          });
        }
      } else {
        issues.push({
          code: 'schema_mismatch',
          path: `$.links[${String(i)}].relation`,
          message: '每条边必须提供结构化的 relation 对象（禁止使用裸 relationConsId 字符串）。',
        });
      }
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.resolve_entities') {
    const inputObj = isRecord(envelope.input) ? envelope.input : {};
    const inputArtifacts = Array.isArray(inputObj['artifacts']) ? inputObj['artifacts'] : [];
    // Only object and concept proposals participate in entity alignment; propositions & relation_types do not.
    const expectedTempIds = new Set<string>();
    for (const art of inputArtifacts) {
      if (!isRecord(art) || !isNonEmptyString(art['tempId'])) continue;
      const kind = art['kind'];
      if (kind === 'object' || kind === 'concept') {
        expectedTempIds.add(art['tempId']);
      }
    }
    const allowedObjects = envelope.availableReferences?.availableObjects ?? [];
    const allowedObjectRefs = allowedObjects.map((o) => o.ref);
    const allowedObjectKeys = new Set(allowedObjects.map((o) => refKey(o.ref)));

    const resolutions = Array.isArray(output['resolutions']) ? output['resolutions'] : [];
    const seen = new Set<string>();
    let hasUnresolved = false;

    for (let i = 0; i < resolutions.length; i++) {
      const item = resolutions[i];
      if (!isRecord(item)) continue;
      const tid = item['tempId'];
      if (typeof tid !== 'string' || !expectedTempIds.has(tid)) {
        issues.push({
          code: 'invalid_reference',
          path: `$.resolutions[${String(i)}].tempId`,
          value: tid,
          allowedValues: [...expectedTempIds],
          message: 'tempId 必须是本批次中 kind 为 object 或 concept 的局部提案标识。',
        });
      } else if (seen.has(tid)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.resolutions[${String(i)}].tempId`,
          value: tid,
          message: `tempId "${tid}" 在 resolutions 中重复出现。`,
        });
      } else {
        seen.add(tid);
      }

      if (!isNonEmptyString(item['basis'])) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.resolutions[${String(i)}].basis`,
          value: item['basis'],
          message: 'basis 必须是非空审计说明字符串。',
        });
      }

      const decision = item['decision'];
      const existingRef = item['existingRef'];
      const candRefs = item['candidateRefs'];

      if (decision === 'reuse') {
        if (!isRef(existingRef)) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.resolutions[${String(i)}].existingRef`,
            value: existingRef,
            allowedValues: allowedObjectRefs,
            message: 'decision 为 reuse 时必须提供有效的 existingRef ({ consId, revision })。',
          });
        } else if (!allowedObjectKeys.has(refKey(existingRef))) {
          issues.push({
            code: 'invalid_reference',
            path: `$.resolutions[${String(i)}].existingRef`,
            value: existingRef,
            allowedValues: allowedObjectRefs,
            message: allowedObjectRefs.length === 0
              ? 'availableObjects 为空集 []，不允许复用任何已有对象ID。'
              : 'existingRef 必须精确引用本次 availableObjects 中提供的 consId 与 revision。',
          });
        }
      } else if (decision === 'create') {
        if (existingRef !== undefined && existingRef !== null) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.resolutions[${String(i)}].existingRef`,
            value: existingRef,
            allowedValues: [null],
            message: 'decision 为 create 时不得携带 existingRef。',
          });
        }
      } else if (decision === 'unresolved') {
        hasUnresolved = true;
        if (existingRef !== undefined && existingRef !== null) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.resolutions[${String(i)}].existingRef`,
            value: existingRef,
            allowedValues: [null],
            message: 'decision 为 unresolved 时不得猜测或填写 existingRef。',
          });
        }
        if (Array.isArray(candRefs)) {
          for (let j = 0; j < candRefs.length; j++) {
            const cr = candRefs[j];
            if (!isRef(cr) || !allowedObjectKeys.has(refKey(cr))) {
              issues.push({
                code: 'invalid_reference',
                path: `$.resolutions[${String(i)}].candidateRefs[${String(j)}]`,
                value: cr,
                allowedValues: allowedObjectRefs,
                message: 'candidateRefs 只能引用本次 availableObjects 中提供的候选对象。',
              });
            }
          }
        }
      }
    }

    for (const expected of expectedTempIds) {
      if (!seen.has(expected)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.resolutions',
          value: expected,
          allowedValues: [...expectedTempIds],
          message: `缺少局部对象 tempId "${expected}" 的辨认结果。`,
        });
      }
    }

    const status = output['status'];
    if (hasUnresolved && status !== 'needs_resolution') {
      issues.push({
        code: 'schema_mismatch',
        path: '$.status',
        value: status,
        allowedValues: ['needs_resolution'],
        message: '存在 unresolved 决定时，顶层 status 必须为 "needs_resolution"。',
      });
    } else if (!hasUnresolved && status !== 'resolved') {
      issues.push({
        code: 'schema_mismatch',
        path: '$.status',
        value: status,
        allowedValues: ['resolved'],
        message: '全部对象均已决定为 reuse 或 create 时，顶层 status 必须为 "resolved"。',
      });
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.associate_context') {
    const inputObj = isRecord(envelope.input) ? envelope.input : {};
    const inputArtifacts = Array.isArray(inputObj['artifacts']) ? inputObj['artifacts'] : [];
    const batchTempIds = new Set<string>();
    const draftRelTempIds = new Set<string>();
    for (const art of inputArtifacts) {
      if (!isRecord(art) || !isNonEmptyString(art['tempId'])) continue;
      batchTempIds.add(art['tempId']);
      if (art['kind'] === 'relation_type') {
        draftRelTempIds.add(art['tempId']);
      }
    }

    const availableObjects = envelope.availableReferences?.availableObjects ?? [];
    const availableStatements = envelope.availableReferences?.availableStatements ?? [];
    const availableRelTypes = envelope.availableReferences?.availableRelationTypes ?? [];
    const allowedEndpointRefs = [...availableObjects.map((o) => o.ref), ...availableStatements.map((s) => s.ref)];
    const allowedEndpointKeys = new Set(allowedEndpointRefs.map(refKey));
    const allowedRelRefs = availableRelTypes.map((r) => ({ consId: r.consId, revision: r.revision }));
    const allowedRelKeySet = new Set(availableRelTypes.map((r) => `${r.consId}@${String(r.revision)}`));

    const allowedEvidenceRefs: ConsRef[] = [...allowedEndpointRefs];
    const inputCons = isRecord(inputObj['input']) ? inputObj['input'] : null;
    if (inputCons !== null && isRef(inputCons['consRef'])) {
      allowedEvidenceRefs.unshift(inputCons['consRef']);
    }
    const allowedEvidenceKeys = new Set(allowedEvidenceRefs.map(refKey));

    const checkEndpoint = (ep: unknown, path: string): void => {
      if (!isRecord(ep)) {
        issues.push({ code: 'schema_mismatch', path, value: ep, message: '端点必须是显式联合对象（kind 为 existing 或 draft）。' });
        return;
      }
      const kind = ep['kind'];
      if (kind === 'draft') {
        if (ep['ref'] !== undefined) {
          issues.push({ code: 'schema_mismatch', path: `${path}.ref`, value: ep['ref'], message: 'kind 为 draft 时不得提供 ref。' });
        }
        const tid = ep['tempId'];
        if (typeof tid !== 'string' || !batchTempIds.has(tid)) {
          issues.push({
            code: 'invalid_reference',
            path: `${path}.tempId`,
            value: tid,
            allowedValues: [...batchTempIds],
            message: 'draft 端点 tempId 必须属于当前批次 artifacts。',
          });
        }
      } else if (kind === 'existing') {
        if (ep['tempId'] !== undefined) {
          issues.push({ code: 'schema_mismatch', path: `${path}.tempId`, value: ep['tempId'], message: 'kind 为 existing 时不得提供 tempId。' });
        }
        const ref = ep['ref'];
        if (!isRef(ref)) {
          issues.push({
            code: 'schema_mismatch',
            path: `${path}.ref`,
            value: ref,
            allowedValues: allowedEndpointRefs,
            message: 'existing 端点必须提供有效的 ref ({ consId, revision })。',
          });
        } else if (!allowedEndpointKeys.has(refKey(ref))) {
          issues.push({
            code: 'invalid_reference',
            path: `${path}.ref`,
            value: ref,
            allowedValues: allowedEndpointRefs,
            message: allowedEndpointRefs.length === 0
              ? '当前无可用已有对象/命题上下文，不得引用任何已有端点。'
              : 'existing 端点必须来自本次授权的 availableObjects 或 availableStatements。',
          });
        }
      } else {
        issues.push({
          code: 'schema_mismatch',
          path: `${path}.kind`,
          value: kind,
          allowedValues: ['existing', 'draft'],
          message: '端点 kind 必须是 existing 或 draft。',
        });
      }
    };

    const associations = Array.isArray(output['associations']) ? output['associations'] : [];
    for (let i = 0; i < associations.length; i++) {
      const assoc = associations[i];
      if (!isRecord(assoc)) continue;
      checkEndpoint(assoc['from'], `$.associations[${String(i)}].from`);
      checkEndpoint(assoc['to'], `$.associations[${String(i)}].to`);

      const rel = assoc['relation'];
      if (!isRecord(rel)) {
        issues.push({ code: 'schema_mismatch', path: `$.associations[${String(i)}].relation`, message: '缺少 relation 对象。' });
      } else if (rel['kind'] === 'existing') {
        if (rel['tempId'] !== undefined) {
          issues.push({ code: 'schema_mismatch', path: `$.associations[${String(i)}].relation.tempId`, message: 'existing 关系不得提供 tempId。' });
        }
        if (!isRef(rel['ref']) || !allowedRelKeySet.has(refKey(rel['ref']))) {
          issues.push({
            code: 'invalid_reference',
            path: `$.associations[${String(i)}].relation.ref`,
            value: rel['ref'],
            allowedValues: allowedRelRefs,
            message: '已有关系类型必须精确引用本次 availableRelationTypes 中的 consId 与 revision。',
          });
        }
      } else if (rel['kind'] === 'draft') {
        if (envelope.allowRelationTypeDrafts !== true) {
          issues.push({
            code: 'unauthorized_effect',
            path: `$.associations[${String(i)}].relation.kind`,
            value: rel['kind'],
            allowedValues: ['existing'],
            message: '当前步骤未授权引用新关系类型草案。',
          });
        } else if (typeof rel['tempId'] !== 'string' || !draftRelTempIds.has(rel['tempId'])) {
          issues.push({
            code: 'invalid_reference',
            path: `$.associations[${String(i)}].relation.tempId`,
            value: rel['tempId'],
            allowedValues: [...draftRelTempIds],
            message: 'draft 关系必须引用本批次 kind 为 relation_type 的 tempId。',
          });
        }
      }

      const evRefs = assoc['evidenceRefs'];
      if (!Array.isArray(evRefs) || evRefs.length === 0) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.associations[${String(i)}].evidenceRefs`,
          value: evRefs,
          allowedValues: allowedEvidenceRefs,
          message: '每条关联必须提供至少一条来源引用 evidenceRefs。',
        });
      } else {
        for (let j = 0; j < evRefs.length; j++) {
          const ev = evRefs[j];
          if (!isRef(ev) || !allowedEvidenceKeys.has(refKey(ev))) {
            issues.push({
              code: 'invalid_reference',
              path: `$.associations[${String(i)}].evidenceRefs[${String(j)}]`,
              value: ev,
              allowedValues: allowedEvidenceRefs,
              message: 'evidenceRefs 必须精确引用本次输入或已提供上下文中的 consId 与 revision。',
            });
          }
        }
      }

      if (!isNonEmptyString(assoc['basis'])) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.associations[${String(i)}].basis`,
          value: assoc['basis'],
          message: 'association.basis 必须是非空字符串。',
        });
      }
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.summarize_topic') {
    if (!isNonEmptyString(output['title'])) {
      issues.push({ code: 'schema_mismatch', path: '$.title', value: output['title'], message: '汇总 title 必须是非空字符串。' });
    }
    if (!isNonEmptyString(output['body'])) {
      issues.push({ code: 'schema_mismatch', path: '$.body', value: output['body'], message: '汇总 body 必须是非空字符串。' });
    }
    const snap = await store.getTrustedSnapshot<TrustedSummaryContextSnapshot>(
      envelope.runId,
      TRUSTED_SNAPSHOT_SUMMARY_CONTEXT,
    );
    const inputObj = isRecord(envelope.input) ? envelope.input : {};
    const allowedRefs = snap !== null
      ? snap.payload.allowedSourceRefs
      : asRefArray(inputObj['allowedSourceRefs']);
    const allowedKeys = new Set(allowedRefs.map(refKey));
    const sourceRefs = Array.isArray(output['sourceRefs']) ? output['sourceRefs'] : [];
    for (let i = 0; i < sourceRefs.length; i++) {
      const sref = sourceRefs[i];
      if (!isRef(sref) || !allowedKeys.has(refKey(sref))) {
        issues.push({
          code: 'invalid_reference',
          path: `$.sourceRefs[${String(i)}]`,
          value: sref,
          allowedValues: allowedRefs,
          message: allowedRefs.length === 0
            ? 'allowedSourceRefs 为空集 []，不得引用任何来源ID。'
            : 'sourceRefs 只能引用本次上下文提供的 allowedSourceRefs。',
        });
      }
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.prepare_connections' && Array.isArray(output['metadata'])) {
    const inputObj = isRecord(envelope.input) ? envelope.input : {};
    const inputArtifacts = Array.isArray(inputObj['artifacts']) ? inputObj['artifacts'] : [];
    const allowedTempIds = new Set<string>();
    for (const a of inputArtifacts) {
      if (isRecord(a) && isNonEmptyString(a['tempId'])) {
        allowedTempIds.add(a['tempId']);
      }
    }
    const allowedList = [...allowedTempIds];
    const seen = new Set<string>();
    const metadata = output['metadata'];
    for (let i = 0; i < metadata.length; i++) {
      const m = metadata[i];
      if (!isRecord(m)) continue;
      const tid = m['tempId'];
      if (typeof tid !== 'string' || !allowedTempIds.has(tid)) {
        issues.push({
          code: 'invalid_reference',
          path: `$.metadata[${String(i)}].tempId`,
          value: tid,
          allowedValues: allowedList,
          message: 'metadata 中的 tempId 必须属于输入 artifacts 的 tempId 集合。',
        });
      } else if (seen.has(tid)) {
        issues.push({
          code: 'schema_mismatch',
          path: `$.metadata[${String(i)}].tempId`,
          value: tid,
          message: `metadata 中存在重复的 tempId "${tid}"。`,
        });
      } else {
        seen.add(tid);
      }
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.extract_method') {
    const status = output['status'];
    const method = output['method'];
    if (status === 'proposed') {
      if (!isRecord(method)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.method',
          value: method,
          message: 'status 为 proposed 时必须提供非空的 method 草案对象。',
        });
        return issues;
      }
      for (const field of ['title', 'instructions', 'applicabilityText'] as const) {
        if (!isNonEmptyString(method[field])) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.method.${field}`,
            value: method[field],
            message: `method.${field} 必须是非空字符串。`,
          });
        }
      }
      const allowedActionIds = (envelope.availableReferences?.availableActions ?? []).map((a) => a.consId);
      const actionId = method['actionId'];
      if (!isNonEmptyString(actionId)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.method.actionId',
          value: actionId,
          allowedValues: allowedActionIds,
          message: 'method.actionId 必须是非空字符串。',
        });
      } else if (!allowedActionIds.includes(actionId)) {
        issues.push({
          code: 'invalid_reference',
          path: '$.method.actionId',
          value: actionId,
          allowedValues: allowedActionIds,
          message: allowedActionIds.length === 0
            ? 'availableActions 为空集 []，不允许填写任何 actionId。'
            : 'method.actionId 必须是本次实际执行并在 availableActions 中提供的动作ID。',
        });
      }
    } else if (status === 'none' && method !== undefined && method !== null) {
      issues.push({
        code: 'schema_mismatch',
        path: '$.method',
        value: method,
        message: 'status 为 none 时不应提供 method 对象。',
      });
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.extract_tendency') {
    const status = output['status'];
    const tendency = output['tendency'];
    if (status === 'proposed') {
      if (!isRecord(tendency)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.tendency',
          value: tendency,
          message: 'status 为 proposed 时必须提供非空的 tendency 草案对象。',
        });
        return issues;
      }
      for (const field of ['title', 'applicabilityText', 'preferenceText'] as const) {
        if (!isNonEmptyString(tendency[field])) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.tendency.${field}`,
            value: tendency[field],
            message: `tendency.${field} 必须是非空字符串。`,
          });
        }
      }
      const scope = tendency['scope'];
      const allowedIds = scope === 'method_selection'
        ? (envelope.availableReferences?.availableMethods ?? []).map((m) => m.consId)
        : (envelope.availableReferences?.availableActions ?? []).map((a) => a.consId);
      const allowedSet = new Set(allowedIds);
      for (const listKey of ['preferIds', 'avoidIds'] as const) {
        const list = tendency[listKey];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          if (typeof id !== 'string' || !allowedSet.has(id)) {
            issues.push({
              code: 'invalid_reference',
              path: `$.tendency.${listKey}[${String(i)}]`,
              value: id,
              allowedValues: allowedIds,
              message: `tendency.${listKey} 只能引用本次提供的合法对象ID。`,
            });
          }
        }
      }
    } else if (status === 'none' && tendency !== undefined && tendency !== null) {
      issues.push({
        code: 'schema_mismatch',
        path: '$.tendency',
        value: tendency,
        message: 'status 为 none 时不应提供 tendency 对象。',
      });
    }
    return issues;
  }

  if (envelope.action.ref.consId === 'seed.define_action') {
    const status = output['status'];
    const action = output['action'];
    if (status === 'proposed') {
      if (!isRecord(action)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.action',
          value: action,
          message: 'status 为 proposed 时必须提供非空的 action 草案对象。',
        });
        return issues;
      }
      for (const field of ['title', 'body'] as const) {
        if (!isNonEmptyString(action[field])) {
          issues.push({
            code: 'schema_mismatch',
            path: `$.action.${field}`,
            value: action[field],
            message: `action.${field} 必须是非空字符串。`,
          });
        }
      }
      if (isRecord(action['inputSchema'])) {
        const errs = validateSchemaStructure(action['inputSchema']);
        if (errs.length > 0) {
          issues.push({
            code: 'schema_mismatch',
            path: '$.action.inputSchema',
            message: errs.join('; '),
          });
        }
      }
      if (isRecord(action['outputSchema'])) {
        const errs = validateSchemaStructure(action['outputSchema']);
        if (errs.length > 0) {
          issues.push({
            code: 'schema_mismatch',
            path: '$.action.outputSchema',
            message: errs.join('; '),
          });
        }
      }
      const dm = action['defaultMethod'];
      if (!isRecord(dm)) {
        issues.push({
          code: 'schema_mismatch',
          path: '$.action.defaultMethod',
          message: 'action.defaultMethod 必须是对象。',
        });
      } else {
        for (const field of ['title', 'instructions', 'applicabilityText'] as const) {
          if (!isNonEmptyString(dm[field])) {
            issues.push({
              code: 'schema_mismatch',
              path: `$.action.defaultMethod.${field}`,
              value: dm[field],
              message: `action.defaultMethod.${field} 必须是非空字符串。`,
            });
          }
        }
      }
    } else if (status === 'none' && action !== undefined && action !== null) {
      issues.push({
        code: 'schema_mismatch',
        path: '$.action',
        value: action,
        message: 'status 为 none 时不应提供 action 对象。',
      });
    }
    return issues;
  }

  return issues;
}

function buildEnvelope(
  run: Run,
  step: Step,
  actionRev: ConsRevision,
  actionSpec: ActionSpec,
  method: { ref: ConsRef; spec: MethodSpec; body: string } | undefined,
  tendencies: Array<{ ref: ConsRef; title?: string; spec: TendencySpec }>,
  input: unknown,
  candidates: ExecutionEnvelope['candidates'],
  allowedRelationTypes: string[],
  availableReferences: AvailableReferences,
  allowRelationTypeDrafts: boolean,
): ExecutionEnvelope {
  const envelope: ExecutionEnvelope = {
    runId: run.id,
    stepId: step.id,
    task: run.task,
    action: { ref: step.actionRef, title: actionRev.title, spec: actionSpec, body: actionRev.body },
    tendencies,
    input,
    candidates,
    allowedEffects: actionSpec.allowedEffects,
    outputSchema: actionSpec.outputSchema,
    allowedRelationTypes,
    availableReferences,
    allowRelationTypeDrafts,
  };
  if (method !== undefined) {
    envelope.method = method;
  }
  return envelope;
}

type ParsedCheck =
  | { ok: true; value: unknown }
  | { ok: false; code: ErrorCode; issues: ValidationIssue[] };

/**
 * Strip a single wrapping Markdown code fence (```json ... ``` or ``` ... ```)
 * if and only if the entire trimmed response is a single fenced block.
 * Does not attempt heuristic extraction from prose.
 */
function stripSingleJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match !== null && match[1] !== undefined ? match[1].trim() : trimmed;
}

async function checkParsed(
  store: ConsStoreApi,
  envelope: ExecutionEnvelope,
  text: string,
  stopReason?: string,
): Promise<ParsedCheck> {
  const truncated = isTruncatedStopReason(stopReason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripSingleJsonFence(text));
  } catch {
    if (truncated) {
      return {
        ok: false,
        code: 'truncated_output',
        issues: [{
          code: 'truncated_output',
          path: '$',
          message: '模型输出因达到 max_tokens 上限被截断，未得到完整 JSON。请精简产物数量和每项描述长度后重新输出完整 JSON。',
        }],
      };
    }
    return {
      ok: false,
      code: 'invalid_json',
      issues: [{
        code: 'invalid_json',
        path: '$',
        message: '响应不是合法 JSON，请只返回符合 outputSchema 的单个 JSON 对象。',
      }],
    };
  }
  const schemaResult = validateSchemaDetailed(envelope.outputSchema, parsed);
  if (!schemaResult.ok) {
    const code: ErrorCode = truncated ? 'truncated_output' : 'schema_mismatch';
    const issues: ValidationIssue[] = schemaResult.errors.map((e) => {
      const issue: ValidationIssue = { code, path: e.path, message: e.message };
      if (e.value !== undefined) issue.value = e.value;
      if (e.allowedValues !== undefined) issue.allowedValues = e.allowedValues;
      return issue;
    });
    return { ok: false, code, issues };
  }
  const refIssues = await validateOutputIssues(store, envelope, parsed);
  if (refIssues.length > 0) {
    return { ok: false, code: primaryErrorCode(refIssues), issues: refIssues };
  }
  return { ok: true, value: parsed };
}

async function callLlmOnce(
  deps: EngineDeps,
  run: Run,
  step: Step,
  systemPrompt: string,
  userPrompt: string,
  outputSchema: object,
  attemptNo: number,
): Promise<{ request: { systemPrompt: string; userPrompt: string; outputSchema: object; maxOutputTokens: number }; response: LlmResponse }> {
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
      return { request, response: res };
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
        stopReason: null,
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

function repairPrompt(userPrompt: string, issues: ValidationIssue[], previousText: string): string {
  const snippet = previousText.length > 2000 ? `${previousText.slice(0, 2000)}...(truncated)` : previousText;
  const hasTruncation = issues.some((i) => i.code === 'truncated_output');
  const truncationHint = hasTruncation
    ? '\n本次输出达到 token 上限被截断，请减少产物数量并大幅精简每项正文，确保完整输出闭合 JSON。'
    : '';
  return [
    userPrompt,
    '',
    '## 上一次输出未通过协议校验（受限修复，最多一次）',
    '### 结构化错误',
    '```json',
    JSON.stringify(issues, null, 2),
    '```',
    '### 上一次原输出片段',
    '```',
    snippet,
    '```',
    `请在完全相同的动作、方法、候选与授权范围内修正上述错误，不得扩大权限或编造未提供的ID。${truncationHint}`,
    '只返回修正后的完整 JSON 对象。',
  ].join('\n');
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
  const stopReason = isRecord(rec.response) && typeof rec.response['stopReason'] === 'string' ? rec.response['stopReason'] : undefined;
  const check = await checkParsed(deps.store, envelope, text, stopReason);
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
    const { request, response: res } = await callLlmOnce(
      deps,
      run,
      step,
      prompts.systemPrompt,
      userPrompt,
      envelope.outputSchema,
      attemptNo,
    );
    const check = await checkParsed(deps.store, envelope, res.text, res.stopReason);
    const attemptErrorCode = check.ok ? null : check.code;
    const attemptIssues = check.ok ? [] : check.issues;
    if (deps.llmLog !== undefined) {
      await deps.llmLog.insert({
        stepId: step.id,
        attemptNo,
        request,
        response: {
          text: res.text,
          stopReason: res.stopReason ?? null,
          issues: attemptIssues,
        },
        model: res.model,
        usage: res.usage ?? null,
        latencyMs: res.latencyMs,
        errorCode: attemptErrorCode,
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
      stopReason: res.stopReason ?? null,
      errorCode: attemptErrorCode,
      issues: attemptIssues,
    }, run.id, step.id);

    if (check.ok) {
      return check.value;
    }
    if (!repaired && REPAIRABLE_CODES.has(check.code)) {
      repaired = true;
      await deps.store.appendEvent('llm_repair_requested', {
        stepId: step.id,
        attemptNo,
        errorCode: check.code,
        stopReason: res.stopReason ?? null,
        issues: check.issues,
      }, run.id, step.id);
      userPrompt = repairPrompt(prompts.userPrompt, check.issues, res.text);
      continue;
    }
    throw new StepFailure(check.code, formatIssues(check.issues), check.issues);
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

/**
 * Build the server-trusted entity resolution snapshot and derived create-only
 * artifact list (so prepare_connections never touches reused existing objects).
 */
export function buildEntityResolutionArtifacts(
  inputArtifacts: unknown[],
  resolutions: EntityResolutionItem[],
  batchStepId: string,
  candidateSnapshotStepId: string | null,
  confirmedByHuman = false,
): {
  snapshot: TrustedEntityResolutionSnapshot;
  createArtifacts: unknown[];
  reusedTempIds: string[];
} {
  const tempIdToExistingRef: Record<string, ConsRef> = {};
  const createTempIds: string[] = [];
  const unresolvedTempIds: string[] = [];
  const reusedSet = new Set<string>();

  for (const r of resolutions) {
    if (r.decision === 'reuse' && isRef(r.existingRef)) {
      tempIdToExistingRef[r.tempId] = r.existingRef;
      reusedSet.add(r.tempId);
    } else if (r.decision === 'create') {
      createTempIds.push(r.tempId);
    } else if (r.decision === 'unresolved') {
      unresolvedTempIds.push(r.tempId);
    }
  }

  const createArtifacts = inputArtifacts.filter((art) => {
    if (!isRecord(art) || typeof art['tempId'] !== 'string') return true;
    return !reusedSet.has(art['tempId']);
  });

  const snapshot: TrustedEntityResolutionSnapshot = {
    batchStepId,
    candidateSnapshotStepId,
    resolutions,
    tempIdToExistingRef,
    createTempIds,
    unresolvedTempIds,
    ...(confirmedByHuman ? { confirmedByHuman: true } : {}),
  };

  return { snapshot, createArtifacts, reusedTempIds: [...reusedSet] };
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
  if (run.status === 'queued' || run.status === 'needs_resolution') {
    run.status = 'running';
    await deps.store.updateRun(run.id, { status: 'running' });
  }
  let flowRev: ConsRevision;
  try {
    flowRev = await readRevision(deps.store, run.entryFlowRef);
  } catch (err) {
    return failRun(deps, run, null, codeOf(err), messageOf(err), issuesOf(err));
  }
  const flowSpec = flowRev.spec;
  if (!isRecord(flowSpec) || flowSpec['kind'] !== 'flow') {
    return failRun(deps, run, null, 'config_error', 'entry flow revision has no flow spec');
  }
  const flowErrors = validateFlow(flowSpec as { kind: 'flow'; entry: string; nodes: Record<string, FlowNode> });
  if (flowErrors.length > 0) {
    return failRun(deps, run, null, 'config_error', flowErrors.join('; '));
  }
  const flow = flowSpec as FlowSpec;
  let nodeId: string | null = flow.entry;
  while (nodeId !== null) {
    const node = flow.nodes[nodeId];
    if (node === undefined) {
      return failRun(deps, run, null, 'config_error', `node "${nodeId}" not found`);
    }
    if (node.terminal === true) {
      if (node.pauseStatus === 'needs_resolution') {
        return pauseRunForResolution(deps, run, nodeId);
      }
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
      return failRun(deps, run, null, codeOf(err), messageOf(err), issuesOf(err));
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
    let baseInput: Record<string, unknown>;
    let optionalRaw: Record<string, unknown> | undefined;
    try {
      baseInput = bindInputs(node.inputBindings, run);
      optionalRaw = node.optionalInputBindings !== undefined ? bindInputs(node.optionalInputBindings, run) : undefined;
    } catch (err) {
      return failRun(deps, run, null, codeOf(err), messageOf(err), issuesOf(err));
    }
    if (node.actionFrom !== undefined) {
      if (node.allowedActionIds !== undefined && !node.allowedActionIds.includes(actionRef.consId)) {
        return failRun(deps, run, null, 'unauthorized_action', `action ${actionRef.consId} is outside the allowed action set of node "${nodeId}"`);
      }
      if (node.allowedActionIds === undefined && node.contentActionsOnly === true) {
        if (!isContentActionCompatible(actionSpec, baseInput, optionalRaw)) {
          return failRun(deps, run, null, 'unauthorized_action', `action ${actionRef.consId} does not satisfy the content action contract of node "${nodeId}"`);
        }
      }
    }
    const input = adaptInputForSchema(actionSpec.inputSchema, baseInput, optionalRaw);
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
    const tendencies: Array<{ ref: ConsRef; title?: string; spec: TendencySpec }> = [];
    for (const ref of tendencyRefs) {
      const rev = await readRevision(deps.store, ref);
      if (isTendencySpec(rev.spec)) {
        tendencies.push({ ref, title: rev.title, spec: rev.spec });
      }
    }
    const inputCandidates = isRecord(input) && Array.isArray(input['candidates']) ? input['candidates'] : run.state[STATE_KEY_CANDIDATES];
    const candidates = await enrichCandidates(deps.store, asCandidateArray(inputCandidates));
    const relationTypeCons = await deps.store.listActiveConsByRole('relation_type');
    const relationTypeItems: AvailableRefItem[] = [];
    for (const c of relationTypeCons) {
      const item = await refToAvailableItem(deps.store, c.ref);
      if (item !== null) relationTypeItems.push(item);
    }
    const allowedRelationTypes = relationTypeItems.map((c) => c.consId);
    const availableReferences = await buildAvailableReferences(
      deps.store,
      run,
      actionRef,
      actionSpec,
      input,
      candidates,
      tendencies,
      relationTypeItems,
    );
    const allowRelationTypeDrafts = node.allowRelationTypeProposals === true;
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
    const envelope = buildEnvelope(
      run,
      step,
      actionRev,
      actionSpec,
      method,
      tendencies,
      input,
      candidates,
      allowedRelationTypes,
      availableReferences,
      allowRelationTypeDrafts,
    );
    let output: unknown;
    try {
      output = await executeStep(deps, run, step, envelope);
    } catch (err) {
      if (err instanceof BudgetSignal) {
        return exhaustBudget(deps, run, { reason: 'maxLlmCalls', nodeId, step });
      }
      return failRun(deps, run, step, codeOf(err), messageOf(err), issuesOf(err));
    }
    const outputResult = validateSchemaDetailed(actionSpec.outputSchema, output);
    if (!outputResult.ok) {
      const issues: ValidationIssue[] = outputResult.errors.map((e) => {
        const issue: ValidationIssue = { code: 'schema_mismatch', path: e.path, message: e.message };
        if (e.value !== undefined) issue.value = e.value;
        if (e.allowedValues !== undefined) issue.allowedValues = e.allowedValues;
        return issue;
      });
      return failRun(deps, run, step, 'schema_mismatch', formatIssues(issues), issues);
    }
    const refIssues = await validateOutputIssues(deps.store, envelope, output);
    if (refIssues.length > 0) {
      return failRun(deps, run, step, primaryErrorCode(refIssues), formatIssues(refIssues), refIssues);
    }
    const transition = evaluateTransition(node, output, declaredTopLevelFields(actionSpec.outputSchema));
    if (transition.error !== undefined) {
      return failRun(deps, run, step, 'schema_mismatch', transition.error);
    }
    const committed: Step = { ...step, status: 'succeeded', output };
    const authorization = buildAuthorization(output, candidates);
    let committedOutput = authorizeSelection(output, authorization);
    let resolutionSnapshotToStore: TrustedEntityResolutionSnapshot | null = null;
    if (actionRef.consId === 'seed.resolve_entities' && isRecord(output) && Array.isArray(output['resolutions'])) {
      const inputArtifacts = isRecord(input) && Array.isArray(input['artifacts']) ? input['artifacts'] : [];
      const ctxSnap = await deps.store.getTrustedSnapshot<TrustedEntityContextSnapshot>(
        run.id,
        TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
      );
      const execSteps = await deps.store.listSteps(run.id);
      const execActionStep = execSteps.find((s) => s.nodeId === 'execute_action');
      const derived = buildEntityResolutionArtifacts(
        inputArtifacts,
        output['resolutions'] as EntityResolutionItem[],
        execActionStep?.id ?? step.id,
        ctxSnap?.stepId ?? null,
      );
      resolutionSnapshotToStore = derived.snapshot;
      committedOutput = {
        ...output,
        createArtifacts: derived.createArtifacts,
        reusedTempIds: derived.reusedTempIds,
      };
    }
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
      if (resolutionSnapshotToStore !== null) {
        await deps.store.putTrustedSnapshot(run.id, TRUSTED_SNAPSHOT_ENTITY_RESOLUTION, step.id, resolutionSnapshotToStore);
        await deps.store.appendEvent('entity_resolution_made', {
          stepId: step.id,
          nodeId,
          candidateCount: envelope.availableReferences?.availableObjects?.length ?? 0,
          resolutions: resolutionSnapshotToStore.resolutions,
          reusedCount: Object.keys(resolutionSnapshotToStore.tempIdToExistingRef).length,
          createdCount: resolutionSnapshotToStore.createTempIds.length,
          unresolvedCount: resolutionSnapshotToStore.unresolvedTempIds.length,
        }, run.id, step.id);
      }
      if (actionRef.consId === 'seed.associate_context' && isRecord(output) && Array.isArray(output['associations'])) {
        await deps.store.appendEvent('associations_proposed', {
          stepId: step.id,
          nodeId,
          count: output['associations'].length,
          associations: output['associations'],
        }, run.id, step.id);
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

function issuesOf(err: unknown): ValidationIssue[] {
  if (err instanceof StepFailure) {
    return err.issues;
  }
  return [];
}

async function failRun(
  deps: EngineDeps,
  run: Run,
  step: Step | null,
  errorCode: ErrorCode,
  message: string,
  issues: ValidationIssue[] = [],
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
      issues,
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

async function pauseRunForResolution(deps: EngineDeps, run: Run, nodeId: string): Promise<Run> {
  run.status = 'needs_resolution';
  const entityResolution = isRecord(run.state['entityResolution']) ? run.state['entityResolution'] : null;
  const topicContext = isRecord(run.state['topicContext']) ? run.state['topicContext'] : null;
  const pendingPayload = entityResolution !== null
    ? {
        kind: 'entity_resolution',
        resolutions: Array.isArray(entityResolution['resolutions']) ? entityResolution['resolutions'] : [],
        availableObjects: isRecord(run.state['contextBundle']) && Array.isArray(run.state['contextBundle']['objects'])
          ? run.state['contextBundle']['objects']
          : [],
      }
    : {
        kind: 'topic_disambiguation',
        ambiguousTopics: topicContext !== null && Array.isArray(topicContext['ambiguousTopics'])
          ? topicContext['ambiguousTopics']
          : [],
      };
  const nextState: Record<string, unknown> = {
    ...run.state,
    pendingResolution: pendingPayload,
    [STATE_KEY_CURRENT_NODE]: nodeId,
  };
  await deps.store.updateRun(run.id, { status: 'needs_resolution', state: nextState });
  await deps.store.appendEvent('run_paused_for_resolution', {
    runId: run.id,
    nodeId,
    status: 'needs_resolution',
    pending: pendingPayload,
  }, run.id, null);
  run.state = nextState;
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
