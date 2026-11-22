export interface LlmAttemptUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmAttemptRow {
  stepId: string;
  attemptNo: number;
  request: unknown;
  response: unknown;
  model: string | null;
  usage: LlmAttemptUsage | null;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface LlmAttemptLog {
  insert(row: LlmAttemptRow): Promise<void>;
  getLastSuccess(stepId: string): Promise<LlmAttemptRow | null>;
}

export const PROMPT_TEMPLATE_VERSION = 'v2';
