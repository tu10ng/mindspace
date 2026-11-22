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
  scope: 'action_selection' | 'method_selection' | 'entity_resolution';
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
  contentActionsOnly?: boolean;
  allowRelationTypeProposals?: boolean;
  inputBindings: Record<string, Binding>;
  optionalInputBindings?: Record<string, Binding>;
  outputKey: string;
  next?: string;
  transitions?: {
    field: string;
    equals: string | number | boolean | null;
    next: string;
  }[];
  terminal?: boolean;
  /**
   * When terminal is true and pauseStatus is set (e.g. 'needs_resolution'),
   * the flow stops with that business status instead of 'completed' so the caller
   * can supply explicit confirmation and resume later.
   */
  pauseStatus?: 'needs_resolution';
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
  /** Supporting evidence references attached to this edge across inputs. */
  evidenceRefs?: ConsRef[];
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

export interface RunAuthorization {
  stepId: string;
  consId: string;
  revision: number;
  title: string;
  candidates: ConsRef[];
}

export interface RunBudget {
  maxSteps: number;
  maxLlmCalls: number;
  maxOutputTokensPerCall: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxSteps: 64,
  maxLlmCalls: 24,
  maxOutputTokensPerCall: 8192,
};

export type RunStatus = 'queued' | 'running' | 'completed' | 'needs_resolution' | 'failed' | 'budget_exhausted';

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

export interface ArtifactContent {
  title: string;
  body: string;
  aliases?: string[];
  searchTerms?: string[];
  applicabilityText?: string;
  spec?: ActionSpec | MethodSpec | TendencySpec | FlowSpec;
  sourceRefs?: ConsRef[];
}

export interface Artifact {
  tempId: string;
  kind: 'object' | 'concept' | 'proposition' | 'relation_type' | 'method' | 'tendency' | 'action';
  content: ArtifactContent | unknown;
}

export type RelationTarget =
  | { kind: 'existing'; ref: ConsRef }
  | { kind: 'draft'; tempId: string };

/** Explicit union endpoint for cross-input associations (P1). */
export type EndpointTarget =
  | { kind: 'existing'; ref: ConsRef }
  | { kind: 'draft'; tempId: string };

export interface ArtifactLink {
  fromTempId: string;
  relation: RelationTarget;
  toTempId: string;
}

export interface ContextAssociation {
  from: EndpointTarget;
  relation: RelationTarget;
  to: EndpointTarget;
  evidenceRefs: ConsRef[];
  basis: string;
}

export interface RelatedStatementItem {
  ref: ConsRef;
  relationConsId: string;
  direction: 'from' | 'to';
  title: string;
  body: string;
  sourceRefs: ConsRef[];
}

export interface EntityCandidate {
  ref: ConsRef;
  title: string;
  roles: ConsRole[];
  body: string;
  aliases: string[];
  searchTerms: string[];
  sourceRefs: ConsRef[];
  relatedStatements: RelatedStatementItem[];
}

export interface StatementCandidate {
  ref: ConsRef;
  title: string;
  roles: ConsRole[];
  body: string;
  sourceRefs: ConsRef[];
  relatedObjects: Array<{ ref: ConsRef; title: string; relationConsId: string }>;
}

export interface EntityResolutionItem {
  tempId: string;
  decision: 'reuse' | 'create' | 'unresolved';
  existingRef?: ConsRef | null;
  candidateRefs?: ConsRef[];
  basis: string;
}

export interface ResolutionDecisionInput {
  tempId: string;
  decision: 'reuse' | 'create';
  existingRef?: ConsRef;
  basis?: string;
}

export interface SummarizeTopicInput {
  topicRef?: ConsRef;
  topicQuery?: string;
  task?: string;
  updateSummaryRef?: { consId: string; expectedRevision: number };
}

export interface AvailableRefItem {
  consId: string;
  revision: number;
  title: string;
  description: string;
}

export interface AvailableReferences {
  availableActions?: AvailableRefItem[];
  availableMethods?: AvailableRefItem[];
  availableTendencies?: AvailableRefItem[];
  availableRelationTypes?: AvailableRefItem[];
  availableObjects?: EntityCandidate[];
  availableStatements?: StatementCandidate[];
}

export interface ExecutionEnvelope {
  runId: string;
  stepId: string;
  task: string;
  action: { ref: ConsRef; title?: string; spec: ActionSpec; body: string };
  method?: { ref: ConsRef; spec: MethodSpec; body: string };
  tendencies: Array<{ ref: ConsRef; title?: string; spec: TendencySpec }>;
  input: unknown;
  candidates: Array<{ ref: ConsRef; title: string; roles: ConsRole[]; summary: string }>;
  allowedEffects: EffectKind[];
  outputSchema: object;
  allowedRelationTypes?: string[];
  availableReferences?: AvailableReferences;
  allowRelationTypeDrafts?: boolean;
}

export interface SearchResultItem {
  ref: ConsRef;
  title: string;
  roles: ConsRole[];
  score: number;
  channel: 'id' | 'name' | 'searchTerm' | 'fts' | 'assoc';
}

export interface TrustedSnapshot<T = unknown> {
  stepId: string;
  payload: T;
}

export interface SearchQuery {
  text: string;
  roles?: ConsRole[];
  limit?: number;
  /** When true, exclude raw input corpus cons (provenance.source === 'input'). */
  excludeInputProvenance?: boolean;
}

export interface SearchResponse {
  items: SearchResultItem[];
  notes: string[];
}

export type ErrorCode =
  | 'invalid_json' | 'truncated_output' | 'schema_mismatch'
  | 'invalid_reference' | 'unknown_reference'
  | 'unauthorized_action' | 'unauthorized_effect' | 'missing_binding'
  | 'revision_conflict' | 'model_unavailable' | 'no_candidate'
  | 'budget_exhausted' | 'config_error';

export interface ValidationIssue {
  code: ErrorCode;
  path: string;
  value?: unknown;
  allowedValues?: unknown[];
  message: string;
}

export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: object;
  maxOutputTokens: number;
}

export interface LlmResponse {
  text: string;
  stopReason?: string;
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

export interface MethodDraft {
  title: string;
  actionId: string;
  instructions: string;
  applicabilityText: string;
  aliases?: string[];
  searchTerms?: string[];
}

export type MethodProposal =
  | { status: 'none'; method?: null }
  | { status: 'proposed'; method: MethodDraft };

export interface TendencyDraft {
  title: string;
  scope: 'action_selection' | 'method_selection';
  applicabilityText: string;
  preferenceText: string;
  preferIds?: string[];
  avoidIds?: string[];
  aliases?: string[];
  searchTerms?: string[];
}

export type TendencyProposal =
  | { status: 'none'; tendency?: null }
  | { status: 'proposed'; tendency: TendencyDraft };

export interface GraphNode {
  id: string;
  status: ConsStatus;
  currentRevision: number;
  activeRevision: number;
  createdAt: string;
  title: string;
  roles: ConsRole[];
  body: string;
  aliases: string[];
  searchTerms: string[];
  applicabilityText?: string;
  spec?: ActionSpec | MethodSpec | TendencySpec | FlowSpec;
  provenance: Provenance;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: ConsEdge[];
}

export interface RunSummary {
  id: string;
  entryFlowRef: ConsRef;
  task: string;
  status: RunStatus;
  counters: { steps: number; llmCalls: number };
  createdAt: string;
  finishedAt: string | null;
}
