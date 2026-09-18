// Упаковка ответов в формат OpenAI Chat Completions (JSON и SSE).
export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export function completionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

export function chunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function usageChunk(id: string, model: string, usage: Usage): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const DONE = 'data: [DONE]\n\n';

export function completion(
  id: string,
  model: string,
  content: string,
  usage: Usage,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

export function errorBody(message: string, type = 'invalid_request_error'): Record<string, unknown> {
  return { error: { message, type, code: null, param: null } };
}
