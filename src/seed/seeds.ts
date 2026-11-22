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

export const PRIMITIVE_KEYS = ['receive', 'search', 'form', 'connect', 'record', 'revise'] as const;

type Freedom = ActionSpec['freedom'];

const F_NONE: Freedom = { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false };
const F_FILL: Freedom = { chooseWithinCandidates: false, fillExecutionDetails: true, proposeNewDefinitions: false };
const F_CHOOSE: Freedom = { chooseWithinCandidates: true, fillExecutionDetails: false, proposeNewDefinitions: false };
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

const roleEnum: object = {
  type: 'string',
  enum: [
    'object', 'concept', 'proposition', 'relation_type',
    'action', 'method', 'tendency', 'constraint',
    'flow', 'case', 'record',
  ],
};

const selectionOutput: object = schema(
  {
    status: { type: 'string', enum: ['selected', 'no_candidate'] },
    selected: { oneOf: [refSchema, { type: 'null' }] },
    usedTendencies: { type: 'array', items: { type: 'string' } },
    basisSummary: { type: 'string' },
    usedDefaultFreedom: { type: 'boolean' },
  },
  ['status', 'selected', 'usedTendencies', 'basisSummary', 'usedDefaultFreedom'],
);

const artifactKindEnum: object = {
  type: 'string',
  enum: ['object', 'proposition', 'relation', 'method', 'tendency', 'action'],
};

const formCandidateItem: object = schema(
  { tempId: { type: 'string' }, kind: artifactKindEnum, content: {} },
  ['tempId', 'kind', 'content'],
);

const endpointSchema: object = { oneOf: [refSchema, { type: 'string' }] };

const edgeItem: object = schema(
  {
    from: endpointSchema,
    relationConsId: { type: 'string' },
    to: endpointSchema,
  },
  ['from', 'relationConsId', 'to'],
);

const methodBindingItem: object = schema(
  {
    actionId: { type: 'string' },
    methodRef: { oneOf: [refSchema, { type: 'string' }] },
  },
  ['actionId', 'methodRef'],
);

const artifactsOutput: object = schema(
  {
    artifacts: {
      type: 'array',
      items: schema(
        { tempId: { type: 'string' }, kind: artifactKindEnum, content: {} },
        ['tempId', 'kind', 'content'],
      ),
    },
    links: {
      type: 'array',
      items: schema(
        {
          fromTempId: { type: 'string' },
          relationConsId: { type: 'string' },
          toTempId: { type: 'string' },
        },
        ['fromTempId', 'relationConsId', 'toTempId'],
      ),
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
  rel('rel.part_of', '组成部分', 'part_of', '表示一个 cons 是另一个 cons（如流程）的组成部分。'),
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
    '按明确的检索请求执行文本检索：显式 ID、名称/别名精确、搜索词精确、全文排名，并做显式关联一跳扩展。role 条件只能收窄候选。',
    'search',
    schema(
      {
        queries: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              schema({ text: { type: 'string' }, roles: { type: 'array', items: roleEnum } }, ['text']),
            ],
          },
        },
        roles: { type: 'array', items: roleEnum },
        actionId: { type: 'string' },
        limit: { type: 'integer' },
        tendencyScope: { type: 'string', enum: ['action_selection', 'method_selection'] },
        anchorIds: { type: 'array', items: {} },
        allowedActionIds: { type: 'array', items: { type: 'string' } },
        contentActionsOnly: { type: 'boolean' },
      },
      ['queries'],
    ),
    {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: schema(
            { ref: refSchema, title: { type: 'string' }, roles: { type: 'array', items: roleEnum }, score: { type: 'number' }, channel: { type: 'string' } },
            ['ref', 'title', 'roles', 'score', 'channel'],
          ),
        },
        defaultMethod: refSchema,
        tendencyRefs: { type: 'array', items: refSchema },
      },
    },
    ['read', 'search', 'append_event'],
  ),
  primitiveAction(
    'seed.form',
    '形成',
    '将候选描述保存为 draft cons，为临时产物分配永久 ID 并保存 ID 映射。不建立关系、不激活、不写检索索引。',
    'form',
    schema(
      {
        candidates: {
          type: 'array',
          items: schema(
            { tempId: { type: 'string' }, kind: artifactKindEnum, content: {} },
            ['tempId', 'kind', 'content'],
          ),
        },
      },
      ['candidates'],
    ),
    schema(
      { formed: { type: 'array', items: schema({ tempId: { type: 'string' }, consRef: refSchema }, ['tempId', 'consRef']) } },
      ['formed'],
    ),
    ['create_draft', 'append_event'],
  ),
  primitiveAction(
    'seed.connect',
    '接入',
    '把已形成的 draft 接入 mindSpace：解析临时引用、建立边、写执行绑定与方法绑定、更新检索索引、标记 active。整个接入在一个事务内完成。',
    'connect',
    schema(
      {
        formed: { type: 'array', items: schema({ tempId: { type: 'string' }, consRef: refSchema }, ['tempId', 'consRef']) },
        edges: { type: 'array', items: edgeItem },
        methodBindings: { type: 'array', items: methodBindingItem },
        bindMethodRevision: refSchema,
        activate: { type: 'boolean' },
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
    '将输入拆解为临时对象与关系描述。不递归展开，不为产物分配永久 ID。',
    schema({ input: {}, task: { type: 'string' } }, ['input', 'task']),
    artifactsOutput,
    F_FILL,
    ['分解'],
  ),
  llmAction(
    'seed.classify',
    '属于',
    '为输入生成候选归属命题：判断输入内容属于哪些已知概念或类别，以命题形式返回。',
    schema({ input: {}, candidates: { type: 'array', items: {} }, task: { type: 'string' } }, ['input', 'task']),
    artifactsOutput,
    F_FILL,
    ['分类'],
  ),
  llmAction(
    'seed.prepare_connections',
    '准备接入描述',
    '为候选产物准备接入所需的描述并整理接入输入：形成候选（标题、别名、检索词、适用描述、规格）、边提案和方法绑定提案。只生成提案，不执行接入。',
    schema({ artifacts: { type: 'array', items: {} }, links: { type: 'array', items: {} } }, ['artifacts']),
    schema(
      {
        candidates: { type: 'array', items: formCandidateItem },
        edges: { type: 'array', items: edgeItem },
        methodBindings: { type: 'array', items: methodBindingItem },
      },
      ['candidates'],
    ),
    F_FILL,
  ),
  llmAction(
    'seed.extract_method',
    '从案例形成方法描述',
    '从具体执行案例形成可复用方法的草案，或返回 none。actionId 必须是本次实际执行的动作；从具体执行中形成参数化做法，不以抽象描述替代案例。',
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
        title: { type: 'string' },
        actionId: { type: 'string' },
        applicabilityText: { type: 'string' },
        instructions: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        searchTerms: { type: 'array', items: { type: 'string' } },
        sourceCaseId: { type: 'string' },
        candidates: { type: 'array', items: formCandidateItem },
        methodBindings: { type: 'array', items: methodBindingItem },
      },
      ['status'],
    ),
    F_PROPOSE,
    ['提取方法'],
  ),
  llmAction(
    'seed.extract_tendency',
    '从选择形成倾向描述',
    '当本次选择使用了默认自由时，从选择情境形成倾向草案，或返回 none。倾向是偏好描述，不能写成系统禁令。',
    schema({ caseRef: refSchema, selection: {}, usedDefaultFreedom: { type: 'boolean' } }, ['caseRef', 'selection']),
    schema(
      {
        status: { type: 'string', enum: ['none', 'proposed'] },
        title: { type: 'string' },
        scope: { type: 'string', enum: ['action_selection', 'method_selection'] },
        applicabilityText: { type: 'string' },
        preferenceText: { type: 'string' },
        preferIds: { type: 'array', items: { type: 'string' } },
        avoidIds: { type: 'array', items: { type: 'string' } },
        candidates: { type: 'array', items: formCandidateItem },
      },
      ['status'],
    ),
    F_PROPOSE,
    ['提取倾向'],
  ),
  llmAction(
    'seed.define_action',
    '形成动作描述',
    '针对显式定义动作的任务，形成新动作的草案，或返回 none。新动作必须是 executor=llm、权限仅 return_artifacts，并包含默认方法描述。同时给出形成候选（动作与默认方法两个 cons 草案）与方法绑定提案。本动作只形成描述，持久化与激活由后续 form/connect 步骤完成。',
    schema({ task: { type: 'string' }, input: {} }, ['task', 'input']),
    schema(
      {
        status: { type: 'string', enum: ['none', 'proposed'] },
        title: { type: 'string' },
        description: { type: 'string' },
        inputSchema: {},
        outputSchema: {},
        freedom: {},
        defaultMethod: schema(
          { title: { type: 'string' }, instructions: { type: 'string' }, applicabilityText: { type: 'string' } },
          ['title', 'instructions'],
        ),
        artifacts: { type: 'array', items: formCandidateItem },
        methodBindings: { type: 'array', items: methodBindingItem },
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

export const DEFAULT_METHOD_SEEDS: SeedCons[] = ACTION_SEEDS.map((action) => {
  const spec: MethodSpec = {
    kind: 'method',
    actionId: action.id,
    instructions:
      action.binding?.executor === 'primitive'
        ? `按底座原语契约执行「${action.title}」。原语行为由底座定义，本方法只约束使用语境：${action.body}`
        : `执行动作「${action.title}」的默认方法：${action.body} 只完成当前动作本身，按输出 schema 返回，不扩展权限、不引用候选之外的对象。`,
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
      next: 'search_actions',
    },
    search_actions: {
      actionId: 'seed.search',
      allowedActionIds: ['seed.decompose', 'seed.classify', 'seed.reference_case'],
      inputBindings: {
        queries: { source: 'state', path: 'actionQuery.queries' },
        roles: { source: 'literal', value: ['action'] },
        anchorIds: { source: 'state', path: 'actionQuery.anchorIds' },
        allowedActionIds: { source: 'literal', value: ['seed.decompose', 'seed.classify', 'seed.reference_case'] },
        contentActionsOnly: { source: 'literal', value: true },
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
      inputBindings: {
        input: { source: 'state', path: 'inputCons' },
        task: { source: 'run', path: 'task' },
      },
      outputKey: 'actionResult',
      next: 'prepare_connections',
    },
    prepare_connections: {
      actionId: 'seed.prepare_connections',
      inputBindings: {
        artifacts: { source: 'state', path: 'actionResult.artifacts' },
        links: { source: 'state', path: 'actionResult.links' },
      },
      outputKey: 'connectionProposals',
      next: 'form_content',
    },
    form_content: {
      actionId: 'seed.form',
      inputBindings: { candidates: { source: 'state', path: 'connectionProposals.candidates' } },
      outputKey: 'formedContent',
      next: 'connect_content',
    },
    connect_content: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedContent.formed' },
        edges: { source: 'state', path: 'connectionProposals.edges' },
        activate: { source: 'literal', value: true },
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
        methodSelection: { source: 'state', path: 'methodSelection' },
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
      inputBindings: { candidates: { source: 'state', path: 'methodProposal.candidates' } },
      outputKey: 'formedMethod',
      next: 'connect_method',
    },
    connect_method: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedMethod.formed' },
        methodBindings: { source: 'state', path: 'methodProposal.methodBindings' },
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
      inputBindings: { candidates: { source: 'state', path: 'tendencyProposal.candidates' } },
      outputKey: 'formedTendency',
      next: 'connect_tendency',
    },
    connect_tendency: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedTendency.formed' },
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
      inputBindings: { candidates: { source: 'state', path: 'methodProposalAlt.candidates' } },
      outputKey: 'formedMethodAlt',
      next: 'connect_method_alt',
    },
    connect_method_alt: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedMethodAlt.formed' },
        methodBindings: { source: 'state', path: 'methodProposalAlt.methodBindings' },
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
      next: 'prepare_connections',
    },
    prepare_connections: {
      actionId: 'seed.prepare_connections',
      inputBindings: {
        artifacts: { source: 'state', path: 'actionProposal.artifacts' },
        links: { source: 'literal', value: [] },
      },
      outputKey: 'connectionProposals',
      next: 'form_action',
    },
    form_action: {
      actionId: 'seed.form',
      inputBindings: { candidates: { source: 'state', path: 'connectionProposals.candidates' } },
      outputKey: 'formedAction',
      next: 'connect_action',
    },
    connect_action: {
      actionId: 'seed.connect',
      inputBindings: {
        formed: { source: 'state', path: 'formedAction.formed' },
        edges: { source: 'state', path: 'connectionProposals.edges' },
        methodBindings: { source: 'state', path: 'actionProposal.methodBindings' },
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

export const FLOW_SEEDS: SeedCons[] = [
  {
    id: 'flow.ingest',
    title: '语料接收与处理流程',
    roles: ['flow'],
    body: '接收并处理语料：接收、生成检索表达、检索并选择动作及其 action_selection 倾向（无候选时直接结束）、检索并选择方法及其 method_selection 倾向、执行所选动作、准备并接入内容产物、记录主阶段案例，随后执行一次内化流程。',
    aliases: ['ingest'],
    searchTerms: ['ingest', '接收', '语料处理'],
    applicabilityText: '默认语料处理入口。',
    spec: flowIngest,
    binding: { executor: 'flow' },
  },
  {
    id: 'flow.internalize',
    title: '内化流程',
    roles: ['flow'],
    body: '记录 internalize 阶段案例、无条件提取方法草案（none 则跳过形成与接入）、形成并接入方法；仅当本次方法选择使用默认自由时才提取倾向草案（none 则结束）、形成并接入倾向。不对此阶段再次生成学习任务。',
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
    body: '针对显式定义动作任务：形成动作描述（none 则结束）、准备接入描述、形成、接入并激活。新动作仅允许 executor=llm 与 return_artifacts 权限。',
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
