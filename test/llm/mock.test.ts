import { describe, expect, it } from 'vitest';
import { createMockLlm, createScriptedLlm } from '../../src/llm/mock.js';
import { createOpenAiCompatibleLlm } from '../../src/llm/openai.js';
import type { LlmRequest } from '../../src/types.js';

const req: LlmRequest = {
  systemPrompt: 'sys',
  userPrompt: 'user',
  outputSchema: { type: 'object' },
  maxOutputTokens: 100,
};

describe('createMockLlm', () => {
  it('serializes object results as JSON text and records calls', async () => {
    const mock = createMockLlm(() => ({ a: 1 }));
    const res = await mock.complete(req);
    expect(res.text).toBe('{"a":1}');
    expect(res.model).toBe('mock');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.userPrompt).toBe('user');
  });

  it('passes through string results unchanged', async () => {
    const mock = createMockLlm(() => 'raw text');
    const res = await mock.complete(req);
    expect(res.text).toBe('raw text');
  });

  it('handler can inspect the request', async () => {
    const mock = createMockLlm((r) => ({ seen: r.systemPrompt }));
    const res = await mock.complete(req);
    expect(JSON.parse(res.text)).toEqual({ seen: 'sys' });
  });
});

describe('createScriptedLlm', () => {
  it('consumes responses in order', async () => {
    const llm = createScriptedLlm([{ a: 1 }, 'plain']);
    expect(JSON.parse((await llm.complete(req)).text)).toEqual({ a: 1 });
    expect((await llm.complete(req)).text).toBe('plain');
    expect(llm.calls).toHaveLength(2);
  });

  it('throws when exhausted', async () => {
    const llm = createScriptedLlm([]);
    await expect(llm.complete(req)).rejects.toThrow();
  });

  it('rethrows scripted errors', async () => {
    const llm = createScriptedLlm([new Error('network down')]);
    await expect(llm.complete(req)).rejects.toThrow('network down');
  });
});

describe('createOpenAiCompatibleLlm', () => {
  it('sends chat completion request and parses response', async () => {
    const bodies: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const llm = createOpenAiCompatibleLlm({ baseUrl: 'http://x.test/v1/', apiKey: 'k', model: 'm1' });
      const res = await llm.complete(req);
      expect(res.text).toBe('{"ok":true}');
      expect(res.model).toBe('m1');
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      expect(typeof res.latencyMs).toBe('number');
      const body = bodies[0] as { model: string; response_format: { type: string }; max_tokens: number };
      expect(body.model).toBe('m1');
      expect(body.response_format.type).toBe('json_object');
      expect(body.max_tokens).toBe(100);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws on non-2xx', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    try {
      const llm = createOpenAiCompatibleLlm({ baseUrl: 'http://x.test/v1', apiKey: 'k', model: 'm1' });
      await expect(llm.complete(req)).rejects.toThrow('500');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws when fetch rejects', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('connect refused');
    }) as typeof fetch;
    try {
      const llm = createOpenAiCompatibleLlm({ baseUrl: 'http://x.test/v1', apiKey: 'k', model: 'm1' });
      await expect(llm.complete(req)).rejects.toThrow('connect refused');
    } finally {
      globalThis.fetch = original;
    }
  });
});
