export type ConsRole =
  | 'object' | 'concept' | 'proposition' | 'relation_type'
  | 'action' | 'method' | 'tendency' | 'constraint'
  | 'flow' | 'case' | 'record';

export type ConsStatus = 'draft' | 'active' | 'archived';

export type EffectKind =
  | 'read' | 'search' | 'return_artifacts'
  | 'create_draft' | 'create_revision' | 'link'
  | 'activate' | 'append_event';

export interface ConsRef {
  consId: string;
  revision: number;
}

export interface ActionSpec {
  kind: 'action';
  inputSchema: object;
  outputSchema: object;
  executor: 'primitive' | 'llm' | 'flow';
  primitiveKey?: string;
  flowRef?: ConsRef;
  defaultMethodId?: string;
  allowedEffects: EffectKind[];
  freedom: {
    chooseWithinCandidates: boolean;
    fillExecutionDetails: boolean;
    proposeNewDefinitions: boolean;
  };
}

export interface MethodSpec {
  kind: 'method';
  actionId: string;
  instructions: string;
  applicabilityText: string;
  inputHints?: string;
  outputHints?: string;
  flowRef?: ConsRef;
}

export interface TendencySpec {
  kind: 'tendency';
  scope: 'action_selection' | 'method_selection';
  applicabilityText: string;
  preferenceText: string;
  preferIds: string[];
  avoidIds: string[];
}

export interface FlowSpec {
  kind: 'flow';
  entry: string;
  nodes: Record<string, FlowNode>;
}

export interface FlowNode {
  actionId?: string;
  actionFrom?: string;
  allowedActionIds?: string[];
  inputBindings: Record<string, Binding>;
  outputKey: string;
  next?: string;
  transitions?: {
    field: string;
    equals: string | number | boolean | null;
    next: string;
  }[];
  terminal?: boolean;
}

export type Binding =
  | { source: 'literal'; value: unknown }
  | { source: 'run'; path: string }
  | { source: 'state'; path: string };

export type ProvenanceSource = 'seed' | 'human' | 'input' | 'llm' | 'execution';

export interface Provenance {
  source: ProvenanceSource;
  runId?: string;
  stepId?: string;
  sourceRefs: ConsRef[];
}

export interface Cons {
  id: string;
  currentRevision: number;
  activeRevision: number;
  status: ConsStatus;
  createdAt: string;
}

export interface ConsRevision {
  consId: string;
  revision: number;
  title: string;
  roles: ConsRole[];
  body: string;
  aliases: string[];
  searchTerms: string[];
  applicabilityText?: string;
  spec?: ActionSpec | MethodSpec | TendencySpec | FlowSpec;
  provenance: Provenance;
  createdAt: string;
}

export interface ConsEdge {
  id: string;
  from: ConsRef;
  relationConsId: string;
  to: ConsRef;
  createdByStepId?: string;
  status: 'active' | 'archived';
}

export interface ExecutionBinding {
  consId: string;
  revision: number;
  executor: 'primitive' | 'llm' | 'flow';
  primitiveKey?: string;
  active: boolean;
  activatedByStepId: string;
}

export interface MethodBinding {
  actionId: string;
  methodId: string;
  methodRevision: number;
  active: boolean;
}

export interface RunBudget {
  maxSteps: number;
  maxLlmCalls: number;
  maxOutputTokensPerCall: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxSteps: 64,
  maxLlmCalls: 20,
  maxOutputTokensPerCall: 4096,
};

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'budget_exhausted';

export interface Run {
  id: string;
  entryFlowRef: ConsRef;
  task: string;
  inputRefs: ConsRef[];
  status: RunStatus;
  budget: RunBudget;
  counters: { steps: number; llmCalls: number };
  state: Record<string, unknown>;
}

export type StepStatus = 'prepared' | 'running' | 'succeeded' | 'failed';

export interface Step {
  id: string;
  runId: string;
  nodeId: string;
  actionRef: ConsRef;
  methodRef?: ConsRef;
  tendencyRefs: ConsRef[];
  input: unknown;
  status: StepStatus;
  output?: unknown;
  errorCode?: string;
  llmAttemptCount: number;
}

export interface Artifact {
  tempId: string;
  kind: 'object' | 'proposition' | 'relation' | 'method' | 'tendency' | 'action';
  content: unknown;
}

export interface ExecutionEnvelope {
  runId: string;
  stepId: string;
  task: string;
  action: { ref: ConsRef; spec: ActionSpec; body: string };
  method?: { ref: ConsRef; spec: MethodSpec; body: string };
  tendencies: Array<{ ref: ConsRef; spec: TendencySpec }>;
  input: unknown;
  candidates: Array<{ ref: ConsRef; title: string; roles: ConsRole[]; summary: string }>;
  allowedEffects: EffectKind[];
  outputSchema: object;
  allowedRelationTypes?: string[];
}

export interface SearchResultItem {
  ref: ConsRef;
  title: string;
  roles: ConsRole[];
  score: number;
  channel: 'id' | 'name' | 'searchTerm' | 'fts' | 'assoc';
}

export interface SearchQuery {
  text: string;
  roles?: ConsRole[];
  limit?: number;
}

export interface SearchResponse {
  items: SearchResultItem[];
  notes: string[];
}

export type ErrorCode =
  | 'invalid_json' | 'schema_mismatch' | 'unknown_reference'
  | 'unauthorized_action' | 'unauthorized_effect' | 'missing_binding'
  | 'revision_conflict' | 'model_unavailable' | 'no_candidate'
  | 'budget_exhausted' | 'config_error';

export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: object;
  maxOutputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  model: string;
}

export interface LlmAdapter {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface EventRecord {
  id: number;
  runId: string | null;
  stepId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export type MethodProposal =
  | { status: 'none'; }
  | {
  status: 'proposed';
  title: string;
  actionId: string;
  applicabilityText: string;
  instructions: string;
  aliases: string[];
  searchTerms: string[];
  sourceCaseId: string;
}

export type TendencyProposal =
  | { status: 'none'; }
  | {
  status: 'proposed';
  title: string;
  scope: 'action_selection' | 'method_selection';
  applicabilityText: string;
  preferenceText: string;
  preferIds: string[];
  avoidIds: string[];
}
