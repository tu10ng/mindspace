import type { LlmAdapter, LlmRequest, LlmResponse } from '../types.js';

export interface MockLlm extends LlmAdapter {
  calls: LlmRequest[];
}

function toResponse(result: unknown): LlmResponse {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { text, latencyMs: 0, model: 'mock' };
}

export function createMockLlm(handler: (req: LlmRequest) => unknown): MockLlm {
  const calls: LlmRequest[] = [];
  const adapter: MockLlm = {
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return toResponse(handler(req));
    },
  };
  return adapter;
}

export function createScriptedLlm(responses: unknown[]): MockLlm {
  let index = 0;
  const calls: LlmRequest[] = [];
  const adapter: MockLlm = {
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      const result = responses[index];
      index += 1;
      if (result === undefined) {
        throw new Error('scripted llm exhausted');
      }
      if (result instanceof Error) {
        throw result;
      }
      return toResponse(result);
    },
  };
  return adapter;
}
