// Тонкий клиент OpenAI-совместимого эндпоинта Икара.
//
// Модель у Икара ровно одна (`icarus`), а «какой провайдер и насколько думать» —
// его внутреннее дело; измеряем мы агента целиком, а не конкретную LLM.
// Разговор задаётся заголовком: свой id разговора на задачу — значит своя
// сессия pi без истории предыдущих задач.
import type { Usage } from './types.ts';

export type ChatOptions = {
  baseUrl: string;
  apiKey: string;
  user: string;
  conversationId: string;
  model?: string;
  timeoutMs?: number;
};

export type ChatReply = { content: string; reasoning: string; usage: Usage | null };

type ChatBody = {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
  usage?: Partial<Usage>;
};

export async function ask(prompt: string, options: ChatOptions): Promise<ChatReply> {
  const url = new URL('/v1/chat/completions', options.baseUrl).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      'x-icarus-user-id': options.user,
      'x-icarus-conversation-id': options.conversationId,
    },
    body: JSON.stringify({
      model: options.model ?? 'icarus',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`эндпоинт ответил ${response.status}: ${text.slice(0, 300)}`);

  let body: ChatBody;
  try {
    body = JSON.parse(text) as ChatBody;
  } catch {
    throw new Error(`не разобрал ответ эндпоинта: ${text.slice(0, 200)}`);
  }

  const message = body.choices?.[0]?.message;
  const usage = body.usage;
  return {
    content: typeof message?.content === 'string' ? message.content : '',
    reasoning: typeof message?.reasoning_content === 'string' ? message.reasoning_content : '',
    usage:
      usage && typeof usage.total_tokens === 'number'
        ? {
            prompt_tokens: Number(usage.prompt_tokens ?? 0),
            completion_tokens: Number(usage.completion_tokens ?? 0),
            total_tokens: Number(usage.total_tokens),
          }
        : null,
  };
}

/** Живой ли стек: `/healthz` есть у сервиса и отвечает без токена. */
export async function health(baseUrl: string, timeoutMs = 5_000): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(new URL('/healthz', baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
