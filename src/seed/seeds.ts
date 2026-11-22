import type {
  ActionSpec,
  ConsRole,
  EffectKind,
  FlowSpec,
  MethodSpec,
  TendencySpec,
} from '../types.js';

export type SeedSpec = ActionSpec | MethodSpec | TendencySpec | FlowSpec;

export interface SeedBinding {
  executor: 'primitive' | 'llm' | 'flow';
  primitiveKey?: string;
}

export interface SeedCons {
  id: string;
  title: string;
  roles: ConsRole[];
  body: string;
  aliases: string[];
  searchTerms: string[];
  applicabilityText?: string;
  spec?: SeedSpec;
  binding?: SeedBinding;
  methodOf?: string;
}

export const PRIMITIVE_KEYS = ['receive', 'search', 'form', 'connect', 'materialize_and_connect', 'record', 'revise'] as const;

type Freedom = ActionSpec['freedom'];

const F_NONE: Freedom = { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false };
const F_FILL: Freedom = { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false };
const F_CHOOSE: Freedom = { chooseWithinCandidates: true, fillExecutionDetails: false, proposeNewDefinitions: false };
const F_CHOOSE_FILL: Freedom = { chooseWithinCandidates: true, fillExecutionDetails: true, proposeNewDefinitions: false };
const F_PROPOSE: Freedom = { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: true };

function schema(properties: Record<string, unknown>, required: string[]): object {
  return { type: 'object', properties, required, additionalProperties: false };
}

const refSchema: object = {
  type: 'object',
  properties: { consId: { type: 'string' }, revision: { type: 'integer' } },
  required: ['consId', 'revision'],
  additionalProperties: false,
};

const nullableRefSchema: object = {
  type: ['object', 'null'],
  properties: { consId: { type: 'string' }, revision: { type: 'integer' } },
  required: ['consId', 'revision'],
  additionalProperties: false,
};

const endpointSchema: object = {
  type: ['object', 'string'],
  properties: { consId: { type: 'string' }, revision: { type: 'integer' } },
  required: ['consId', 'revision'],
  additionalProperties: false,
};

const roleEnum: object = {
  type: 'string',
  enum: [
    'object', 'concept', 'proposition', 'relation_type',
    'action', 'method', 'tendency', 'constraint',
    'flow', 'case', 'record',
  ],
};

const queryItemSchema: object = {
  type: ['string', 'object'],
  properties: { text: { type: 'string' }, roles: { type: 'array', items: roleEnum } },
  required: ['text'],
  additionalProperties: false,
};

const selectionOutput: object = schema(
  {
    status: { type: 'string', enum: ['selected', 'no_candidate'] },
    selected: nullableRefSchema,
    usedTendencies: { type: 'array', items: { type: 'string' } },
    basisSummary: { type: 'string' },
    usedDefaultFreedom: { type: 'boolean' },
  },
  ['status', 'selected', 'usedTendencies', 'basisSummary', 'usedDefaultFreedom'],
);

const artifactKindEnum: object = {
  type: 'string',
  enum: ['object', 'concept', 'proposition', 'relation_type', 'method', 'tendency', 'action'],
};

const contentArtifactKindEnum: object = {
  type: 'string',
  enum: ['object', 'concept', 'proposition', 'relation_type'],
};

const artifactContentSchema: object = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
    applicabilityText: { type: 'string' },
    spec: { type: 'object' },
    sourceRefs: { type: 'array', items: refSchema },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

const contentArtifactContentSchema: object = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
    applicabilityText: { type: 'string' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

const relationTargetSchema: object = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['existing', 'draft'] },
    ref: refSchema,
    tempId: { type: 'string' },
  },
  required: ['kind'],
  additionalProperties: false,
};

/** Explicit union endpoint schema for P1 cross-input associations (no bare string guessing). */
const explicitEndpointSchema: object = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['existing', 'draft'] },
    ref: refSchema,
    tempId: { type: 'string' },
  },
  required: ['kind'],
  additionalProperties: false,
};

const linkItemSchema: object = schema(
  {
    fromTempId: { type: 'string' },
    relation: relationTargetSchema,
    toTempId: { type: 'string' },
  },
  ['fromTempId', 'relation', 'toTempId'],
);

const associationItemSchema: object = schema(
  {
    from: explicitEndpointSchema,
    relation: relationTargetSchema,
    to: explicitEndpointSchema,
    evidenceRefs: { type: 'array', items: refSchema },
    basis: { type: 'string' },
  },
  ['from', 'relation', 'to', 'evidenceRefs', 'basis'],
);

const entityResolutionItemSchema: object = {
  type: 'object',
  properties: {
    tempId: { type: 'string' },
    decision: { type: 'string', enum: ['reuse', 'create', 'unresolved'] },
    existingRef: nullableRefSchema,
    candidateRefs: { type: 'array', items: refSchema },
    basis: { type: 'string' },
  },
  required: ['tempId', 'decision', 'basis'],
  additionalProperties: false,
};

const entityResolutionOutputSchema: object = schema(
  {
    status: { type: 'string', enum: ['resolved', 'needs_resolution'] },
    resolutions: { type: 'array', items: entityResolutionItemSchema },
  },
  ['status', 'resolutions'],
);

const associateContextOutputSchema: object = schema(
  {
    associations: { type: 'array', items: associationItemSchema },
  },
  ['associations'],
);

const summarizeTopicOutputSchema: object = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    sourceRefs: { type: 'array', items: refSchema },
    coverage: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'body', 'sourceRefs', 'coverage', 'openQuestions'],
  additionalProperties: false,
};

const formCandidateItem: object = schema(
  { tempId: { type: 'string' }, kind: artifactKindEnum, content: artifactContentSchema },
  ['tempId', 'kind', 'content'],
);

const metadataItemSchema: object = schema(
  {
    tempId: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
    applicabilityText: { type: 'string' },
  },
  ['tempId', 'aliases', 'searchTerms'],
);

const connectEdgeItem: object = {
  type: 'object',
  properties: {
    from: endpointSchema,
    to: endpointSchema,
    fromTempId: { type: 'string' },
    toTempId: { type: 'string' },
    relation: relationTargetSchema,
    relationConsId: { type: 'string' },
  },
  additionalProperties: false,
};

const methodBindingItem: object = schema(
  {
    actionId: { type: 'string' },
    methodRef: endpointSchema,
  },
  ['actionId', 'methodRef'],
);

const methodDraftSchema: object = schema(
  {
    title: { type: 'string' },
    actionId: { type: 'string' },
    instructions: { type: 'string' },
    applicabilityText: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
  },
  ['title', 'actionId', 'instructions', 'applicabilityText'],
);

const nullableMethodDraftSchema: object = {
  type: ['object', 'null'],
  properties: {
    title: { type: 'string' },
    actionId: { type: 'string' },
    instructions: { type: 'string' },
    applicabilityText: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'actionId', 'instructions', 'applicabilityText'],
  additionalProperties: false,
};

const tendencyDraftSchema: object = schema(
  {
    title: { type: 'string' },
    scope: { type: 'string', enum: ['action_selection', 'method_selection', 'entity_resolution'] },
    applicabilityText: { type: 'string' },
    preferenceText: { type: 'string' },
    preferIds: { type: 'array', items: { type: 'string' } },
    avoidIds: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
  },
  ['title', 'scope', 'applicabilityText', 'preferenceText'],
);

const nullableTendencyDraftSchema: object = {
  type: ['object', 'null'],
  properties: {
    title: { type: 'string' },
    scope: { type: 'string', enum: ['action_selection', 'method_selection', 'entity_resolution'] },
    applicabilityText: { type: 'string' },
    preferenceText: { type: 'string' },
    preferIds: { type: 'array', items: { type: 'string' } },
    avoidIds: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'scope', 'applicabilityText', 'preferenceText'],
  additionalProperties: false,
};

const actionDraftProperties: Record<string, unknown> = {
  title: { type: 'string' },
  body: { type: 'string' },
  aliases: { type: 'array', items: { type: 'string' } },
  searchTerms: { type: 'array', items: { type: 'string' } },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  freedom: { type: 'object' },
  defaultMethod: schema(
    {
      title: { type: 'string' },
      instructions: { type: 'string' },
      applicabilityText: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      searchTerms: { type: 'array', items: { type: 'string' } },
    },
    ['title', 'instructions', 'applicabilityText'],
  ),
};

const actionDraftRequired = ['title', 'body', 'inputSchema', 'outputSchema', 'freedom', 'defaultMethod'];

const actionDraftSchema: object = schema(actionDraftProperties, actionDraftRequired);

const nullableActionDraftSchema: object = {
  type: ['object', 'null'],
  properties: actionDraftProperties,
  required: actionDraftRequired,
  additionalProperties: false,
};

const artifactsOutput: object = schema(
  {
    artifacts: {
      type: 'array',
      items: schema(
        { tempId: { type: 'string' }, kind: contentArtifactKindEnum, content: contentArtifactContentSchema },
        ['tempId', 'kind', 'content'],
      ),
    },
    links: {
      type: 'array',
      items: linkItemSchema,
    },
    executionSummary: { type: 'string' },
  },
  ['artifacts', 'links', 'executionSummary'],
);

function defaultMethodId(actionId: string): string {
  return `${actionId}.default`;
}

function primitiveAction(
  id: string,
  title: string,
  body: string,
  primitiveKey: string,
  inputSchema: object,
  outputSchema: object,
  allowedEffects: EffectKind[],
): SeedCons {
  const spec: ActionSpec = {
    kind: 'action',
    inputSchema,
    outputSchema,
    executor: 'primitive',
    primitiveKey,
    defaultMethodId: defaultMethodId(id),
    allowedEffects,
    freedom: F_NONE,
  };
  return {
    id,
    title,
    roles: ['action'],
    body,
    aliases: [],
    searchTerms: [primitiveKey, title],
    spec,
    binding: { executor: 'primitive', primitiveKey },
  };
}

function llmAction(
  id: string,
  title: string,
  body: string,
  inputSchema: object,
  outputSchema: object,
  freedom: Freedom,
  aliases: string[] = [],
): SeedCons {
  const spec: ActionSpec = {
    kind: 'action',
    inputSchema,
    outputSchema,
    executor: 'llm',
    defaultMethodId: defaultMethodId(id),
    allowedEffects: ['return_artifacts'],
    freedom,
  };
  return {
    id,
    title,
    roles: ['action'],
    body,
    aliases,
    searchTerms: [title, ...aliases],
    spec,
    binding: { executor: 'llm' },
  };
}

export const RELATION_TYPE_SEEDS: SeedCons[] = [
  rel('rel.method_of', '方法属于', 'method_of', '表示一个方法 cons 属于哪个动作，是方法到动作的结构化绑定索引的语义来源。'),
  rel('rel.applies_to', '适用于', 'applies_to', '表示一个 cons 适用于哪个对象或情境。'),
  rel('rel.prefers', '偏好', 'prefers', '表示一个倾向在候选中偏好什么。'),
  rel('rel.avoids', '避让', 'avoids', '表示一个倾向在候选中避让什么。'),
  rel('rel.derived_from', '来源于', 'derived_from', '表示一个产物来自哪个对象、案例或执行。'),
  rel('rel.used_method', '使用了方法', 'used_method', '表示一个案例实际使用了哪个方法版本。'),
  rel('rel.used_tendency', '使用了倾向', 'used_tendency', '表示一个案例实际参考了哪个倾向。'),
  rel('rel.part_of', '组成部分', 'part_of', '表示一个 cons 是另一个 cons（如流程或整体）的组成部分。'),
  rel('rel.describes', '描述', 'describes', '表示一个记录或命题描述哪个对象。'),
];

function rel(id: string, title: string, alias: string, body: string): SeedCons {
  return {
    id,
    title,
    roles: ['relation_type'],
    body,
    aliases: [alias],
    searchTerms: [alias, title],
  };
}

export const PRIMITIVE_ACTION_SEEDS: SeedCons[] = [
  primitiveAction(
    'seed.receive',
    '接收',
    '保存输入内容为 cons，创建本次处理的对象。输入文本成为后续步骤的处理对象，不在此步骤解释或拆解。',
    'receive',
    schema({ text: { type: 'string' }, task: { type: 'string' } }, ['text']),
    schema({ consRef: refSchema, text: { type: 'string' } }, ['consRef', 'text']),
    ['create_draft', 'append_event'],
  ),
  primitiveAction(
    'seed.search',
    '搜索',
    '按明确的检索请求执行文本检索：显式 ID、名称/别名精确、搜索词精确、全文排名，并做显式关联一跳扩展。支持上下文检索模式（object+concept 并排除 source=input，附带正文与一跳关联命题）与按主题汇总检索模式。role 条件只能收窄候选。',
    'search',
    schema(
      {
        mode: { type: 'string', enum: ['default', 'context', 'topic_summary'] },
        queries: {
          type: 'array',
          items: queryItemSchema,
        },
        roles: { type: 'array', items: roleEnum },
        actionId: { type: 'string' },
        limit: { type: 'integer' },
        excludeInputProvenance: { type: 'boolean' },
        sourceText: { type: 'string' },
        maxObjects: { type: 'integer' },
        maxStatements: { type: 'integer' },
        maxRelatedPerObject: { type: 'integer' },
        topicRef: refSchema,
        topicQuery: { type: 'string' },
        tendencyScope: { type: 'string', enum: ['action_selection', 'method_selection', 'entity_resolution'] },
        anchorIds: { type: 'array', items: {} },
        allowedActionIds: { type: 'array', items: { type: 'string' } },
        contentActionsOnly: { type: 'boolean' },
        contextInput: {},
        contextTask: { type: 'string' },
        contextCandidates: { type: 'array', items: {} },
      },
      [],
    ),
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ready', 'needs_resolution', 'no_topic'] },
        items: {
          type: 'array',
          items: schema(
            { ref: refSchema, title: { type: 'string' }, roles: { type: 'array', items: roleEnum }, score: { type: 'number' }, channel: { type: 'string' } },
            ['ref', 'title', 'roles', 'score', 'channel'],
          ),
        },
        objects: { type: 'array', items: {} },
        statements: { type: 'array', items: {} },
        truncated: {},
        hasExistingContext: { type: 'boolean' },
        topic: { type: ['object', 'null'] },
        ambiguousTopics: { type: 'array', items: {} },
        directStatements: { type: 'array', items: {} },
        relatedContextStatements: { type: 'array', items: {} },
        allowedSourceRefs: { type: 'array', items: refSchema },
        defaultMethod: refSchema,
        tendencyRefs: { type: 'array', items: refSchema },
      },
    },
    ['read', 'search', 'append_event'],
  ),
  primitiveAction(
    'seed.form',
    '形成',
    '将候选描述或结构化草案机械编译并保存为 draft cons，合并元数据、分配永久 ID 并保存 ID 映射。不建立关系、不激活、不写检索索引。',
    'form',
    schema(
      {
        candidates: { type: 'array', items: formCandidateItem },
        metadata: { type: 'array', items: metadataItemSchema },
        methodDraft: methodDraftSchema,
        tendencyDraft: tendencyDraftSchema,
        actionDraft: actionDraftSchema,
        sourceCaseRef: refSchema,
      },
      [],
    ),
    schema(
      {
        formed: { type: 'array', items: schema({ tempId: { type: 'string' }, consRef: refSchema }, ['tempId', 'consRef']) },
        methodBindings: { type: 'array', items: methodBindingItem },
        edges: { type: 'array', items: connectEdgeItem },
      },
      ['formed'],
    ),
    ['create_draft', 'append_event'],
  ),
  primitiveAction(
    'seed.connect',
    '接入',
    '把已形成的 draft 接入 mindSpace：验证全部引用、激活获准的新关系类型、解析边临时引用、建立关系实例、写执行绑定与方法绑定、更新检索索引、标记 active。整个接入在一个事务内完成。',
    'connect',
    schema(
      {
        formed: { type: 'array', items: schema({ tempId: { type: 'string' }, consRef: refSchema }, ['tempId', 'consRef']) },
        edges: { type: 'array', items: connectEdgeItem },
        methodBindings: { type: 'array', items: methodBindingItem },
        bindMethodRevision: refSchema,
        activate: { type: 'boolean' },
        allowRelationTypeActivation: { type: 'boolean' },
      },
      [],
    ),
    schema(
      {
        connected: { type: 'array', items: refSchema },
        edges: { type: 'array', items: { type: 'string' } },
      },
      ['connected'],
    ),
    ['link', 'activate', 'append_event'],
  ),
  primitiveAction(
    'seed.materialize_and_connect',
    '原子物化并接入',
    '在单个受控事务内完成校验、形成新建内容、映射复用对象、验证全部端点与关系类型、激活获准的新内容、建立或复用结构边并追加证据来源，以及幂等保存结果。任一步失败整个批次全部回滚，绝不修改或重激活复用对象。',
    'materialize_and_connect',
    schema(
      {
        artifacts: { type: 'array', items: formCandidateItem },
        links: { type: 'array', items: linkItemSchema },
        associations: { type: 'array', items: associationItemSchema },
        metadata: { type: 'array', items: metadataItemSchema },
        inputRef: refSchema,
        activate: { type: 'boolean' },
        allowRelationTypeActivation: { type: 'boolean' },
        summaryDraft: summarizeTopicOutputSchema,
        topicRef: refSchema,
        updateSummaryRef: schema(
          { consId: { type: 'string' }, expectedRevision: { type: 'integer' } },
          ['consId', 'expectedRevision'],
        ),
      },
      [],
    ),
    schema(
      {
        connected: { type: 'array', items: refSchema },
        created: { type: 'array', items: refSchema },
        reused: { type: 'array', items: refSchema },
        edges: { type: 'array', items: { type: 'string' } },
        reusedEdges: { type: 'array', items: { type: 'string' } },
        tempMappings: { type: 'object' },
      },
      ['connected', 'created', 'reused', 'edges'],
    ),
    ['create_draft', 'create_revision', 'link', 'activate', 'append_event'],
  ),
  primitiveAction(
    'seed.record',
    '记录执行',
    '从结构化事件日志生成案例 cons：输入引用、候选、实际使用的动作与方法版本、引用的倾向、是否使用默认自由、产物引用与执行摘要。以日志为准，不凭模型印象复述。',
    'record',
    schema(
      {
        runId: { type: 'string' },
        phase: { type: 'string', enum: ['main', 'internalize'] },
        focus: {},
        actionSelection: {},
        methodSelection: {},
        connected: { type: 'array', items: refSchema },
      },
      ['runId', 'phase'],
    ),
    schema({ caseRef: refSchema, usedDefaultFreedom: { type: 'boolean' }, caseData: { type: 'object' } }, ['caseRef', 'usedDefaultFreedom']),
    ['read', 'create_draft', 'append_event'],
  ),
  primitiveAction(
    'seed.revise',
    '形成新修订',
    '根据已有 cons ID 创建新修订草案，不覆盖旧版本。激活时使用 compare-and-swap：仅当 currentRevision 仍等于预期旧版本才提交，否则返回 revision_conflict。',
    'revise',
    schema(
      {
        consId: { type: 'string' },
        expectedRevision: { type: 'integer' },
        revision: {},
      },
      ['consId', 'expectedRevision', 'revision'],
    ),
    schema({ consRef: refSchema }, ['consRef']),
    ['create_revision', 'append_event'],
  ),
];

export const LLM_ACTION_SEEDS: SeedCons[] = [
  llmAction(
    'seed.make_query',
    '生成检索表达',
    '根据输入和任务生成检索表达：查询词、需要的角色、已知锚点 ID。只生成检索请求，不执行检索。',
    schema({ input: {}, task: { type: 'string' } }, ['input', 'task']),
    schema(
      { queries: { type: 'array', items: { type: 'string' } }, roles: { type: 'array', items: roleEnum }, anchorIds: { type: 'array', items: { type: 'string' } } },
      ['queries'],
    ),
    F_FILL,
  ),
  llmAction(
    'seed.select_action',
    '选择动作',
    '从候选动作集合中选择一个动作 ID/版本，或返回 no_candidate。selected 必须属于本次候选集合。',
    schema({ candidates: { type: 'array', items: {} }, input: {}, task: { type: 'string' } }, ['candidates', 'input', 'task']),
    selectionOutput,
    F_CHOOSE,
  ),
  llmAction(
    'seed.select_method',
    '选择方法',
    '从候选方法集合中选择一个方法 ID/版本，或采用已提供的默认方法。选择结果必须引用本次候选集的具体版本。',
    schema(
      { candidates: { type: 'array', items: {} }, defaultMethod: refSchema, input: {}, task: { type: 'string' }, selectedActionTitle: { type: 'string' } },
      ['candidates', 'input', 'task'],
    ),
    selectionOutput,
    F_CHOOSE,
  ),
  llmAction(
    'seed.decompose',
    '拆解',
    '将输入拆解为临时对象、命题、必要的新关系类型草案以及关系实例。不递归展开，不为产物分配永久 ID。',
    schema({ input: {}, task: { type: 'string' } }, ['input', 'task']),
    artifactsOutput,
    F_FILL,
    ['分解'],
  ),
  llmAction(
    'seed.classify',
    '属于',
    '为输入生成对象与归属命题提案：当存在已知概念候选时关联这些概念；当概念候选为空时直接基于输入文本生成对象、概念归属或否定归属命题提案，不臆造未提供的系统概念ID。',
    schema({ input: {}, candidates: { type: 'array', items: {} }, task: { type: 'string' } }, ['input', 'task']),
    artifactsOutput,
    F_FILL,
    ['分类', '归属'],
  ),
  llmAction(
    'seed.resolve_entities',
    '辨认已有对象',
    '将当前局部提案中的 object/concept 临时项与提供的已有候选集合进行身份辨认，逐一决定 reuse（复用精确已有 ref）、create（新建对象）或 unresolved（存在歧义暂不能确定）。不自行修改已有对象，不编造候选之外的 ID。',
    schema(
      {
        input: {},
        task: { type: 'string' },
        artifacts: { type: 'array', items: {} },
        links: { type: 'array', items: {} },
        availableObjects: { type: 'array', items: {} },
        availableStatements: { type: 'array', items: {} },
        truncated: {},
      },
      ['input', 'artifacts', 'availableObjects'],
    ),
    entityResolutionOutputSchema,
    F_CHOOSE_FILL,
    ['对象辨认', '实体对齐'],
  ),
  llmAction(
    'seed.associate_context',
    '关联已有上下文',
    '在当前批次提案、已确认对象映射与提供的一跳已有上下文范围内，仅提出明确有来源的有限跨输入关系（如所属/组成/位置、人物与经历关联、命题描述已有对象）。不做开放式联想，不推测未提供事实；无明确关系返回空数组。',
    schema(
      {
        input: {},
        task: { type: 'string' },
        artifacts: { type: 'array', items: {} },
        links: { type: 'array', items: {} },
        resolutions: { type: 'array', items: {} },
        availableObjects: { type: 'array', items: {} },
        availableStatements: { type: 'array', items: {} },
        truncated: {},
      },
      ['input', 'artifacts', 'resolutions', 'availableObjects'],
    ),
    associateContextOutputSchema,
    F_FILL,
    ['跨输入关联', '上下文关联'],
  ),
  llmAction(
    'seed.summarize_topic',
    '按主题汇总记录',
    '基于指定主题对象及其已关联的命题与来源记录，按阶段或主题生成带来源引用的汇总草案。不增加未提供事实、不把缺失材料当否定、区分录取/就读/毕业、保留主观评价来源、不覆盖原始命题。',
    schema(
      {
        task: { type: 'string' },
        topic: {},
        directStatements: { type: 'array', items: {} },
        relatedContextStatements: { type: 'array', items: {} },
        allowedSourceRefs: { type: 'array', items: refSchema },
        truncated: { type: 'boolean' },
      },
      ['task', 'topic', 'directStatements', 'allowedSourceRefs'],
    ),
    summarizeTopicOutputSchema,
    F_FILL,
    ['主题汇总', '经历汇总'],
  ),
  llmAction(
    'seed.prepare_connections',
    '准备接入描述',
    '按 tempId 为已确定的候选产物补充别名（aliases）、检索词（searchTerms）及可选适用描述（applicabilityText），不重写正文与关系结构。',
    schema({ artifacts: { type: 'array', items: {} }, links: { type: 'array', items: {} } }, ['artifacts']),
    schema(
      {
        metadata: { type: 'array', items: metadataItemSchema },
      },
      ['metadata'],
    ),
    F_FILL,
  ),
  llmAction(
    'seed.extract_method',
    '从案例形成方法描述',
    '从具体执行案例形成可复用方法草案，或返回 none。只返回 status 与 method 草案对象，无需组装 candidates 或 methodBindings。',
    schema(
      {
        caseRef: refSchema,
        methodUsed: refSchema,
        executionSummary: { type: 'string' },
        selectionBasis: { type: 'string' },
        caseData: { type: 'object' },
      },
      ['caseRef', 'executionSummary'],
    ),
    schema(
      {
        status: { type: 'string', enum: ['none', 'proposed'] },
        method: nullableMethodDraftSchema,
      },
      ['status'],
    ),
    F_PROPOSE,
    ['提取方法'],
  ),
  llmAction(
    'seed.extract_tendency',
    '从选择形成倾向描述',
    '当本次选择使用了默认自由时，从选择情境形成倾向草案，或返回 none。只返回 status 与 tendency 草案对象，无需组装 candidates。',
    schema({ caseRef: refSchema, selection: {}, usedDefaultFreedom: { type: 'boolean' } }, ['caseRef', 'selection']),
    schema(
      {
        status: { type: 'string', enum: ['none', 'proposed'] },
        tendency: nullableTendencyDraftSchema,
      },
      ['status'],
    ),
    F_PROPOSE,
    ['提取倾向'],
  ),
  llmAction(
    'seed.define_action',
    '形成动作描述',
    '针对显式定义动作的任务，形成新动作及默认方法的草案，或返回 none。新动作仅允许 executor=llm 与 return_artifacts 权限，持久化与组装由后续 form/connect 完成。',
    schema({ task: { type: 'string' }, input: {} }, ['task', 'input']),
    schema(
      {
        status: { type: 'string', enum: ['none', 'proposed'] },
        action: nullableActionDraftSchema,
      },
      ['status'],
    ),
    F_PROPOSE,
  ),
  llmAction(
    'seed.reference_case',
    '参考案例',
    '基于已提供的历史案例得到局部产物。只使用已注入的案例内容，不声称查阅未提供的记录。',
    schema({ input: {}, cases: { type: 'array', items: {} }, task: { type: 'string' } }, ['input', 'cases', 'task']),
    artifactsOutput,
    F_FILL,
  ),
];

const ACTION_SEEDS: SeedCons[] = [...PRIMITIVE_ACTION_SEEDS, ...LLM_ACTION_SEEDS];

const CUSTOM_DEFAULT_INSTRUCTIONS: Record<string, string> = {
  'seed.select_action':
    '根据输入文本和任务语义，在 availableActions 中选择最贴合的动作（如结构/嵌套/属性关系描述侧重拆解，类别归属/定义判断侧重属于）；优先参考 availableTendencies 中的倾向。usedTendencies 只填写实际参考的倾向 consId，无则 []。',
  'seed.select_method':
    '在 availableMethods 中选择最匹配当前输入情境的方法；若无更专用的方法，则采用 defaultMethod 并标记 usedDefaultFreedom=true。usedTendencies 只填写实际参考的倾向 consId，无则 []。',
  'seed.decompose':
    '将输入拆解为精炼的对象（object/concept）、关键命题（proposition）和局部关系实例（links）。每项 content 必须包含简明的 title 与 body；局部对象使用本批次 tempId（后续由「辨认已有对象」步骤与已有实体对齐，不在本步骤直接填已有 consId）。优先复用 availableRelationTypes 中已有关系类型（kind="existing"），确需新关系且步骤允许时再以 kind="relation_type" 提出并在 links 中用 kind="draft" 引用。控制条目数量与长度，避免冗长重复。',
  'seed.classify':
    '识别输入中的对象、类别归属及否定归属，形成对象（object/concept）与归属命题（proposition）及必要关系（links）。若输入 candidates 或 availableObjects 中已有匹配概念，可基于候选说明归属；若候选为空或未提供，直接基于输入文本生成对象和归属命题提案，不得猜测系统中未提供的概念ID。',
  'seed.resolve_entities':
    '对输入 artifacts 中所有 kind 为 object 或 concept 的局部提案逐一辨认（proposition 与 relation_type 不参与对象对齐）：1) 同名只是线索，必须结合当前输入语料、局部提案内容、availableObjects 中候选的正文（body）、别名（aliases）及已有直接关联命题（relatedStatements）综合判断；2) 若 availableObjects 中存在唯一且语境一致的对应已有实体（如同一人物的连续经历、同一学校的不同信息），选择 decision="reuse" 并精确填写 existingRef={consId,revision}；3) 若 availableObjects 为空、或候选中不存在该实体、或输入明确指出了同名不同实体（有身份区分信息），选择 decision="create" 且不得填写 existingRef；4) 若 availableObjects 中存在多个同名或近似候选且无法根据已知信息唯一判定，选择 decision="unresolved"、列出歧义 candidateRefs 并将顶层 status 设为 "needs_resolution"，绝不按排名盲目选第一个，也不偷偷按 create 处理；5) 每条决定必须写明简洁依据 basis，tempId 不得遗漏或重复。全部非 unresolved 时 status 必须为 "resolved"。',
  'seed.associate_context':
    '在当前提案、已确认 resolutions 与本次提供的 availableObjects/availableStatements 范围内，仅提出明确有来源的新跨输入内容关系；本批次局部 links 经对象复用后已表达的关系无需重复输出，若无新增跨输入关系请直接简洁返回 {"associations":[]}。允许：明确的所属/组成/位置关系（如某校食堂 rel.part_of 既有学校对象）、人物与明确陈述经历的关联、当前命题明确描述已有对象（rel.describes）、对已知同一对象的阶段性描述。严禁：开放式联想、引入外部背景知识、从“学校包含初中/高中”推出“人物在那里读了初中/高中”、把“高考考上/被录取”加强为“毕业”、把推测写成事实、重复输出 links 中已表达的相同边。端点使用显式联合类型：{kind:"draft",tempId} 或 {kind:"existing",ref:{consId,revision}}；relation 使用 {kind:"existing",ref} 或 {kind:"draft",tempId}；每条关系必须提供非空 evidenceRefs（取自当前输入 input.consRef 或相关既有命题/对象 ref）与简短 basis。',
  'seed.summarize_topic':
    '根据提供的主题对象（topic）、直接关联命题（directStatements）与相关实体背景命题（relatedContextStatements），按阶段或主题形成简洁忠实的汇总草案：1) 仅组织已提供的事实，严禁补写未提供信息；2) 严格区分“就读”“录取/考上”“毕业”，区分“学校包含某学段”与“个人就读某学段”，不得混淆；3) 未提供的学段、学校或毕业状态明确留空并记入 openQuestions，不把缺失材料当否定事实；4) 保留主观评价（如食堂口味比较）的陈述来源，不改写成客观定论；5) sourceRefs 必须仅从 allowedSourceRefs 中选取并覆盖汇总依据的记录；coverage 列出本次已覆盖的阶段或条目。',
  'seed.prepare_connections':
    '仅针对输入 artifacts（已排除复用对象，仅含本次需新建项）的 tempId 补充简洁的 aliases、searchTerms（及必要的 applicabilityText），用于后续检索接入；不要重写 title、body 或生成边结构。若输入 artifacts 为空数组，返回 {"metadata":[]}。',
  'seed.extract_method':
    '从本次案例中判断是否存在值得复用的通用执行步骤：若有，返回 status="proposed" 与简洁的 method 草案（actionId 必须取自 availableActions）；若本次只是常规单次执行或无清晰复用模式，返回 status="none"。',
  'seed.extract_tendency':
    '当本次选择使用默认自由且存在清晰的选型依据时，返回 status="proposed" 与简洁的 tendency 草案（preferIds/avoidIds 只能填写可用集合中提供的 consId）；否则返回 status="none"。',
};

export const DEFAULT_METHOD_SEEDS: SeedCons[] = ACTION_SEEDS.map((action) => {
  const custom = CUSTOM_DEFAULT_INSTRUCTIONS[action.id];
  const instructions = custom !== undefined
    ? custom
    : action.binding?.executor === 'primitive'
      ? `按底座原语契约执行「${action.title}」。原语行为由底座定义，本方法只约束使用语境：${action.body}`
      : `执行动作「${action.title}」的默认方法：${action.body} 只完成当前动作本身，按输出 schema 返回，不扩展权限、不引用候选之外的对象。`;
  const spec: MethodSpec = {
    kind: 'method',
    actionId: action.id,
    instructions,
    applicabilityText: `动作「${action.title}」（${action.id}）没有专用方法时的默认执行契约。`,
  };
  return {
    id: defaultMethodId(action.id),
    title: `${action.title}默认方法`,
    roles: ['method'],
    body: spec.instructions,
    aliases: [],
    searchTerms: [action.title, '默认方法', action.id],
    spec,
    methodOf: action.id,
  };
});

export const TENDENCY_SEEDS: SeedCons[] = [
  {
    id: 'tendency.case_before_method',
    title: '方法内化前先保留案例',
    roles: ['tendency'],
    body: '方法内化时，先保留具体案例，再形成可复用方法；不以抽象描述替代原执行记录。',
    aliases: ['案例优先'],
    searchTerms: ['案例', '方法内化', '倾向'],
    applicabilityText: '方法选择与方法内化情境。',
    spec: {
      kind: 'tendency',
      scope: 'method_selection',
      applicabilityText: '正在进行方法选择或方法内化时。',
      preferenceText: '先保留具体案例，再形成可复用方法；不以抽象描述替代原执行记录。',
      preferIds: [],
      avoidIds: [],
    } satisfies TendencySpec,
  },
  {
    id: 'tendency.check_existing_objects',
    title: '优先核查已有对象',
    roles: ['tendency'],
    body: '新建实体前优先核查已检索到的对象正文与关联经历；上下文一致且唯一时复用已有对象，明确不同则新建，存在歧义时返回 unresolved，不凭同名盲目合并。',
    aliases: ['已有对象优先核查', '先查已有对象'],
    searchTerms: ['已有对象', '复用', '实体对齐', '对象辨认'],
    applicabilityText: '对象辨认与实体对齐情境。',
    spec: {
      kind: 'tendency',
      scope: 'entity_resolution',
      applicabilityText: '正在对局部对象提案执行已有对象辨认时。',
      preferenceText: '优先对照候选正文与已有直接关联命题判断是否同一实体；不因同名无条件合并，也不忽略明显同一的既有对象。',
      preferIds: [],
      avoidIds: [],
    } satisfies TendencySpec,
  },
];

const flowIngest: FlowSpec = {
  kind: 'flow',
  entry: 'receive',
  nodes: {
    receive: {
      actionId: 'seed.receive',
      inputBindings: { text: { source: 'run', path: 'input.text' }, task: { source: 'run', path: 'task' } },
      outputKey: 'inputCons',
      next: 'make_query',
    },
    make_query: {
      actionId: 'seed.make_query',
      inputBindings: { input: { source: 'state', path: 'inputCons' }, task: { source: 'run', path: 'task' } },
      outputKey: 'actionQuery',
      next: 'retrieve_context',
    },
    retrieve_context: {
      actionId: 'seed.search',
      inputBindings: {
        mode: { source: 'literal', value: 'context' },
        queries: { source: 'state', path: 'actionQuery.queries' },
        roles: { source: 'literal', value: ['object', 'concept'] },
        excludeInputProvenance: { source: 'literal', value: true },
        sourceText: { source: 'state', path: 'inputCons.text' },
        maxObjects: { source: 'literal', value: 20 },
        maxStatements: { source: 'literal', value: 20 },
        maxRelatedPerObject: { source: 'literal', value: 5 },
      },
      outputKey: 'contextBundle',
      next: 'search_actions',
    },
    search_actions: {
      actionId: 'seed.search',
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        roles: { source: 'literal', value: ['action'] },
        anchorIds: { source: 'state', path: 'actionQuery.anchorIds' },
        contentActionsOnly: { source: 'literal', value: true },
        contextInput: { source: 'state', path: 'inputCons' },
        contextTask: { source: 'run', path: 'task' },
        contextCandidates: { source: 'state', path: 'contextBundle.items' },
      },
      outputKey: 'actionCandidates',
      next: 'search_action_tendencies',
    },
    search_action_tendencies: {
      actionId: 'seed.search',
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        tendencyScope: { source: 'literal', value: 'action_selection' },
        anchorIds: { source: 'state', path: 'actionCandidates.items' },
      },
      outputKey: 'tendencyRefs',
      next: 'select_action',
    },
    select_action: {
      actionId: 'seed.select_action',
      inputBindings: {
        candidates: { source: 'state', path: 'actionCandidates.items' },
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
      },
      outputKey: 'actionSelection',
      transitions: [{ field: 'status', equals: 'no_candidate', next: 'finish' }],
      next: 'search_methods',
    },
    search_methods: {
      actionId: 'seed.search',
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        roles: { source: 'literal', value: ['method'] },
        actionId: { source: 'state', path: 'actionSelection.selected.consId' },
      },
      outputKey: 'methodCandidates',
      next: 'search_method_tendencies',
    },
    search_method_tendencies: {
      actionId: 'seed.search',
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        tendencyScope: { source: 'literal', value: 'method_selection' },
        anchorIds: { source: 'state', path: 'methodCandidates.items' },
      },
      outputKey: 'tendencyRefs',
      next: 'select_method',
    },
    select_method: {
      actionId: 'seed.select_method',
      inputBindings: {
        candidates: { source: 'state', path: 'methodCandidates.items' },
        defaultMethod: { source: 'state', path: 'methodCandidates.defaultMethod' },
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
        selectedActionTitle: { source: 'state', path: 'actionSelection.title' },
      },
      outputKey: 'methodSelection',
      next: 'execute_action',
    },
    execute_action: {
      actionFrom: 'actionSelection',
      contentActionsOnly: true,
      allowRelationTypeProposals: true,
      inputBindings: {
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
      },
      optionalInputBindings: {
        candidates: { source: 'state', path: 'contextBundle.objects' },
      },
      outputKey: 'actionResult',
      next: 'search_resolution_tendencies',
    },
    search_resolution_tendencies: {
      actionId: 'seed.search',
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        tendencyScope: { source: 'literal', value: 'entity_resolution' },
      },
      outputKey: 'tendencyRefs',
      next: 'resolve_entities',
    },
    resolve_entities: {
      actionId: 'seed.resolve_entities',
      inputBindings: {
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
        artifacts: { source: 'state', path: 'actionResult.artifacts' },
        links: { source: 'state', path: 'actionResult.links' },
        availableObjects: { source: 'state', path: 'contextBundle.objects' },
        availableStatements: { source: 'state', path: 'contextBundle.statements' },
        truncated: { source: 'state', path: 'contextBundle.truncated' },
      },
      outputKey: 'entityResolution',
      transitions: [{ field: 'status', equals: 'needs_resolution', next: 'await_resolution' }],
      next: 'associate_context',
    },
    await_resolution: {
      inputBindings: {},
      outputKey: 'pendingResolution',
      terminal: true,
      pauseStatus: 'needs_resolution',
    },
    associate_context: {
      actionId: 'seed.associate_context',
      allowRelationTypeProposals: true,
      inputBindings: {
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
        artifacts: { source: 'state', path: 'actionResult.artifacts' },
        links: { source: 'state', path: 'actionResult.links' },
        resolutions: { source: 'state', path: 'entityResolution.resolutions' },
        availableObjects: { source: 'state', path: 'contextBundle.objects' },
        availableStatements: { source: 'state', path: 'contextBundle.statements' },
        truncated: { source: 'state', path: 'contextBundle.truncated' },
      },
      outputKey: 'contextAssociations',
      next: 'prepare_connections',
    },
    prepare_connections: {
      actionId: 'seed.prepare_connections',
      inputBindings: {
        artifacts: { source: 'state', path: 'entityResolution.createArtifacts' },
      },
      outputKey: 'connectionProposals',
      next: 'materialize_and_connect',
    },
    materialize_and_connect: {
      actionId: 'seed.materialize_and_connect',
      inputBindings: {
        artifacts: { source: 'state', path: 'actionResult.artifacts' },
        links: { source: 'state', path: 'actionResult.links' },
        associations: { source: 'state', path: 'contextAssociations.associations' },
        metadata: { source: 'state', path: 'connectionProposals.metadata' },
        inputRef: { source: 'state', path: 'inputCons.consRef' },
        activate: { source: 'literal', value: true },
        allowRelationTypeActivation: { source: 'literal', value: true },
      },
      outputKey: 'connectedContent',
      next: 'record_case',
    },
    record_case: {
      actionId: 'seed.record',
      inputBindings: {
        runId: { source: 'run', path: 'id' },
        phase: { source: 'literal', value: 'main' },
        actionSelection: { source: 'state', path: 'actionSelection' },
        methodSelection: { source: 'state', path: 'methodSelection' },
        connected: { source: 'state', path: 'connectedContent.connected' },
      },
      outputKey: 'mainCase',
      next: 'internalize',
    },
    internalize: {
      actionId: 'flow.internalize',
      inputBindings: {
        caseRef: { source: 'state', path: 'mainCase.caseRef' },
        caseData: { source: 'state', path: 'mainCase.caseData' },
        actionSelection: { source: 'state', path: 'actionSelection' },
        actionCandidates: { source: 'state', path: 'actionCandidates.items' },
        methodSelection: { source: 'state', path: 'methodSelection' },
        methodCandidates: { source: 'state', path: 'methodCandidates.items' },
        connected: { source: 'state', path: 'connectedContent.connected' },
      },
      outputKey: 'internalizeResult',
      next: 'finish',
    },
    finish: {
      inputBindings: {},
      outputKey: 'done',
      terminal: true,
    },
  },
};

const flowInternalize: FlowSpec = {
  kind: 'flow',
  entry: 'record_case',
  nodes: {
    record_case: {
      actionId: 'seed.record',
      inputBindings: {
        runId: { source: 'run', path: 'id' },
        phase: { source: 'literal', value: 'internalize' },
        focus: { source: 'state', path: 'caseRef' },
        methodSelection: { source: 'state', path: 'methodSelection' },
      },
      outputKey: 'internalCase',
      transitions: [
        { field: 'usedDefaultFreedom', equals: true, next: 'extract_method' },
        { field: 'usedDefaultFreedom', equals: false, next: 'extract_method_alt' },
      ],
    },
    extract_method: {
      actionId: 'seed.extract_method',
      inputBindings: {
        caseRef: { source: 'state', path: 'internalCase.caseRef' },
        methodUsed: { source: 'state', path: 'methodSelection.selected' },
        executionSummary: { source: 'state', path: 'caseData.executionSummary' },
        selectionBasis: { source: 'state', path: 'methodSelection.basisSummary' },
        caseData: { source: 'state', path: 'caseData' },
      },
      outputKey: 'methodProposal',
      transitions: [{ field: 'status', equals: 'none', next: 'finish' }],
      next: 'form_method',
    },
    form_method: {
      actionId: 'seed.form',
      inputBindings: {
        methodDraft: { source: 'state', path: 'methodProposal.method' },
        sourceCaseRef: { source: 'state', path: 'internalCase.caseRef' },
      },
      outputKey: 'formedMethod',
      next: 'connect_method',
    },
    connect_method: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedMethod.formed' },
        methodBindings: { source: 'state', path: 'formedMethod.methodBindings' },
        activate: { source: 'literal', value: true },
      },
      outputKey: 'connectedMethod',
      next: 'extract_tendency',
    },
    extract_tendency: {
      actionId: 'seed.extract_tendency',
      inputBindings: {
        caseRef: { source: 'state', path: 'internalCase.caseRef' },
        selection: { source: 'state', path: 'actionSelection' },
        usedDefaultFreedom: { source: 'state', path: 'methodSelection.usedDefaultFreedom' },
      },
      outputKey: 'tendencyProposal',
      transitions: [{ field: 'status', equals: 'none', next: 'finish' }],
      next: 'form_tendency',
    },
    form_tendency: {
      actionId: 'seed.form',
      inputBindings: {
        tendencyDraft: { source: 'state', path: 'tendencyProposal.tendency' },
        sourceCaseRef: { source: 'state', path: 'internalCase.caseRef' },
      },
      outputKey: 'formedTendency',
      next: 'connect_tendency',
    },
    connect_tendency: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedTendency.formed' },
        edges: { source: 'state', path: 'formedTendency.edges' },
        activate: { source: 'literal', value: true },
      },
      outputKey: 'connectedTendency',
      next: 'finish',
    },
    extract_method_alt: {
      actionId: 'seed.extract_method',
      inputBindings: {
        caseRef: { source: 'state', path: 'internalCase.caseRef' },
        methodUsed: { source: 'state', path: 'methodSelection.selected' },
        executionSummary: { source: 'state', path: 'caseData.executionSummary' },
        selectionBasis: { source: 'state', path: 'methodSelection.basisSummary' },
        caseData: { source: 'state', path: 'caseData' },
      },
      outputKey: 'methodProposalAlt',
      transitions: [{ field: 'status', equals: 'none', next: 'finish' }],
      next: 'form_method_alt',
    },
    form_method_alt: {
      actionId: 'seed.form',
      inputBindings: {
        methodDraft: { source: 'state', path: 'methodProposalAlt.method' },
        sourceCaseRef: { source: 'state', path: 'internalCase.caseRef' },
      },
      outputKey: 'formedMethodAlt',
      next: 'connect_method_alt',
    },
    connect_method_alt: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedMethodAlt.formed' },
        methodBindings: { source: 'state', path: 'formedMethodAlt.methodBindings' },
        activate: { source: 'literal', value: true },
      },
      outputKey: 'connectedMethodAlt',
      next: 'finish',
    },
    finish: {
      inputBindings: {},
      outputKey: 'done',
      terminal: true,
    },
  },
};

const flowDefineAction: FlowSpec = {
  kind: 'flow',
  entry: 'define_action',
  nodes: {
    define_action: {
      actionId: 'seed.define_action',
      inputBindings: { task: { source: 'run', path: 'task' }, input: { source: 'run', path: 'input' } },
      outputKey: 'actionProposal',
      transitions: [{ field: 'status', equals: 'none', next: 'finish' }],
      next: 'form_action',
    },
    form_action: {
      actionId: 'seed.form',
      inputBindings: { actionDraft: { source: 'state', path: 'actionProposal.action' } },
      outputKey: 'formedAction',
      next: 'connect_action',
    },
    connect_action: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedAction.formed' },
        methodBindings: { source: 'state', path: 'formedAction.methodBindings' },
        activate: { source: 'literal', value: true },
      },
      outputKey: 'connectedAction',
      next: 'finish',
    },
    finish: {
      inputBindings: {},
      outputKey: 'done',
      terminal: true,
    },
  },
};

const flowReviseMethod: FlowSpec = {
  kind: 'flow',
  entry: 'revise_method',
  nodes: {
    revise_method: {
      actionId: 'seed.revise',
      inputBindings: {
        consId: { source: 'run', path: 'input.methodId' },
        expectedRevision: { source: 'run', path: 'input.expectedRevision' },
        revision: { source: 'run', path: 'input.revision' },
      },
      outputKey: 'revisedMethod',
      next: 'connect_revision',
    },
    connect_revision: {
      actionId: 'seed.connect',
      inputBindings: {
        bindMethodRevision: { source: 'state', path: 'revisedMethod.consRef' },
        activate: { source: 'literal', value: true },
      },
      outputKey: 'connectedRevision',
      next: 'finish',
    },
    finish: {
      inputBindings: {},
      outputKey: 'done',
      terminal: true,
    },
  },
};

const flowSummarizeTopic: FlowSpec = {
  kind: 'flow',
  entry: 'collect_topic_context',
  nodes: {
    collect_topic_context: {
      actionId: 'seed.search',
      inputBindings: {
        mode: { source: 'literal', value: 'topic_summary' },
        maxStatements: { source: 'literal', value: 40 },
      },
      optionalInputBindings: {
        topicRef: { source: 'run', path: 'input.topicRef' },
        topicQuery: { source: 'run', path: 'input.topicQuery' },
      },
      outputKey: 'topicContext',
      transitions: [
        { field: 'status', equals: 'needs_resolution', next: 'await_resolution' },
        { field: 'status', equals: 'no_topic', next: 'finish' },
      ],
      next: 'summarize_topic',
    },
    await_resolution: {
      inputBindings: {},
      outputKey: 'pendingResolution',
      terminal: true,
      pauseStatus: 'needs_resolution',
    },
    summarize_topic: {
      actionId: 'seed.summarize_topic',
      inputBindings: {
        task: { source: 'run', path: 'task' },
        topic: { source: 'state', path: 'topicContext.topic' },
        directStatements: { source: 'state', path: 'topicContext.directStatements' },
        relatedContextStatements: { source: 'state', path: 'topicContext.relatedContextStatements' },
        allowedSourceRefs: { source: 'state', path: 'topicContext.allowedSourceRefs' },
        truncated: { source: 'state', path: 'topicContext.truncated' },
      },
      outputKey: 'summaryDraft',
      next: 'materialize_summary',
    },
    materialize_summary: {
      actionId: 'seed.materialize_and_connect',
      inputBindings: {
        summaryDraft: { source: 'state', path: 'summaryDraft' },
        topicRef: { source: 'state', path: 'topicContext.topic.ref' },
        activate: { source: 'literal', value: true },
      },
      optionalInputBindings: {
        updateSummaryRef: { source: 'run', path: 'input.updateSummaryRef' },
      },
      outputKey: 'connectedSummary',
      next: 'finish',
    },
    finish: {
      inputBindings: {},
      outputKey: 'done',
      terminal: true,
    },
  },
};

export const FLOW_SEEDS: SeedCons[] = [
  {
    id: 'flow.ingest',
    title: '语料接收与处理流程',
    roles: ['flow'],
    body: '接收并处理语料：接收、生成检索表达、检索已有对象/概念及相关命题上下文（排除输入语料对象）、选择动作与方法、执行内容动作产生局部提案、执行已有对象辨认（存在歧义则暂停返回 needs_resolution）、执行有限跨输入关联、仅对新建项补充元数据、在单事务内原子形成并接入（复用对象不覆写不重激活、结构边去重并追加证据）、记录主阶段案例，随后执行一次内化流程。',
    aliases: ['ingest'],
    searchTerms: ['ingest', '接收', '语料处理'],
    applicabilityText: '默认语料处理入口。',
    spec: flowIngest,
    binding: { executor: 'flow' },
  },
  {
    id: 'flow.summarize_topic',
    title: '按主题汇总记录流程',
    roles: ['flow'],
    body: '按用户请求针对指定主题对象检索关联命题及来源（多同名未消歧对象时暂停返回 needs_resolution 而不混合），生成带来源引用、覆盖范围与未知问题的汇总草案，校验全部 sourceRefs 后形成新汇总记录或新增修订，保留原始记录。',
    aliases: ['summarize_topic', '主题汇总'],
    searchTerms: ['summarize_topic', '主题汇总', '经历汇总', '汇总'],
    applicabilityText: '用户显式请求按主题汇总已关联记录时。',
    spec: flowSummarizeTopic,
    binding: { executor: 'flow' },
  },
  {
    id: 'flow.internalize',
    title: '内化流程',
    roles: ['flow'],
    body: '记录 internalize 阶段案例、无条件提取方法草案（none 则跳过形成与接入）、由底座机械编译形成并接入方法；仅当本次方法选择使用默认自由时才提取倾向草案（none 则结束）、由底座机械编译形成并接入倾向。不对此阶段再次生成学习任务。',
    aliases: ['internalize'],
    searchTerms: ['internalize', '内化', '方法提取'],
    applicabilityText: '主处理完成后的单次内化。',
    spec: flowInternalize,
    binding: { executor: 'flow' },
  },
  {
    id: 'flow.define_action',
    title: '定义新动作流程',
    roles: ['flow'],
    body: '针对显式定义动作任务：形成动作与默认方法草案（none 则结束）、由底座机械编译并形成、接入并激活。新动作仅允许 executor=llm 与 return_artifacts 权限。',
    aliases: ['define_action'],
    searchTerms: ['define_action', '定义动作', '新动作'],
    applicabilityText: '用户显式要求形成新动作时。',
    spec: flowDefineAction,
    binding: { executor: 'flow' },
  },
  {
    id: 'flow.revise_method',
    title: '方法修订流程',
    roles: ['flow'],
    body: '针对指定方法形成新修订并接入：以固定旧版本为输入，使用 compare-and-swap 激活，冲突时返回 revision_conflict，不自动合并。',
    aliases: ['revise_method'],
    searchTerms: ['revise_method', '修订', '方法修订'],
    applicabilityText: '用户显式要求修改某方法时。',
    spec: flowReviseMethod,
    binding: { executor: 'flow' },
  },
];

export const ALL_SEEDS: SeedCons[] = [
  ...RELATION_TYPE_SEEDS,
  ...PRIMITIVE_ACTION_SEEDS,
  ...LLM_ACTION_SEEDS,
  ...DEFAULT_METHOD_SEEDS,
  ...TENDENCY_SEEDS,
  ...FLOW_SEEDS,
];

export const SEED_METHOD_OF_RELATION = 'rel.method_of';
