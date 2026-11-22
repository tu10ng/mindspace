import { describe, expect, it } from 'vitest';
import { buildPrompts, SYSTEM_PROMPT } from '../../src/llm/prompt.js';
import type { ExecutionEnvelope } from '../../src/types.js';

const envelope: ExecutionEnvelope = {
  runId: 'run-1',
  stepId: 'run-1::n1',
  task: '处理这条语料',
  action: {
    ref: { consId: 'seed.select_action', revision: 1 },
    spec: {
      kind: 'action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      executor: 'llm',
      allowedEffects: ['return_artifacts'],
      freedom: { chooseWithinCandidates: true, fillExecutionDetails: true, proposeNewDefinitions: false },
    },
    body: '从候选动作中选择一个',
  },
  method: {
    ref: { consId: 'm.default', revision: 2 },
    spec: {
      kind: 'method',
      actionId: 'seed.select_action',
      instructions: '先看候选的适用范围再决定',
      applicabilityText: '所有选择步骤',
    },
    body: '默认选择方法正文',
  },
  tendencies: [
    {
      ref: { consId: 't.1', revision: 1 },
      spec: {
        kind: 'tendency',
        scope: 'action_selection',
        applicabilityText: '总是',
        preferenceText: '偏好拆解',
        preferIds: ['seed.decompose'],
        avoidIds: [],
      },
    },
  ],
  input: { query: '草原' },
  candidates: [
    { ref: { consId: 'seed.decompose', revision: 1 }, title: '拆解', roles: ['action'], summary: '拆解为对象与关系' },
  ],
  allowedEffects: ['return_artifacts'],
  outputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
};

describe('buildPrompts', () => {
  it('uses the fixed protocol system prompt verbatim', () => {
    const { systemPrompt } = buildPrompts(envelope);
    expect(systemPrompt).toBe(SYSTEM_PROMPT);
    expect(systemPrompt).toContain('只返回符合 outputSchema 的单个 JSON 对象。');
    expect(systemPrompt).toContain('可引用对象集合');
    expect(systemPrompt).not.toContain('草原');
  });

  it('includes task, action, method, tendency, candidate, input, effects and schema', () => {
    const { userPrompt } = buildPrompts(envelope);
    expect(userPrompt).toContain('处理这条语料');
    expect(userPrompt).toContain('seed.select_action');
    expect(userPrompt).toContain('从候选动作中选择一个');
    expect(userPrompt).toContain('先看候选的适用范围再决定');
    expect(userPrompt).toContain('m.default');
    expect(userPrompt).toContain('偏好拆解');
    expect(userPrompt).toContain('seed.decompose');
    expect(userPrompt).toContain('拆解为对象与关系');
    expect(userPrompt).toContain('"query": "草原"');
    expect(userPrompt).toContain('"return_artifacts"');
    expect(userPrompt).toContain('## 输出 Schema');
    expect(userPrompt).toContain('"status"');
  });

  it('omits method and tendency sections when none provided while keeping available references', () => {
    const bare: ExecutionEnvelope = { ...envelope, method: undefined, tendencies: [] };
    const { userPrompt } = buildPrompts(bare);
    expect(userPrompt).not.toContain('## 方法');
    expect(userPrompt).not.toContain('## 倾向详情');
    expect(userPrompt).toContain('## 可引用对象集合');
    expect(userPrompt).toContain('availableActions');
  });
});
