import type { LlmAdapter, LlmRequest, LlmResponse } from '../types.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function createOpenAiCompatibleLlm(opts: OpenAiCompatibleOptions): LlmAdapter {
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const started = Date.now();
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: req.userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens: req.maxOutputTokens,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`llm http ${String(res.status)}: ${body}`);
      }
      const data: unknown = await res.json();
      const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('llm response missing message content');
      }
      const usageRaw = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      const usage = usageRaw === undefined
        ? undefined
        : {
            inputTokens: usageRaw.prompt_tokens ?? 0,
            outputTokens: usageRaw.completion_tokens ?? 0,
          };
      const response: LlmResponse = {
        text: content,
        latencyMs: Date.now() - started,
        model: opts.model,
      };
      if (usage !== undefined) {
        response.usage = usage;
      }
      return response;
    },
  };
}
