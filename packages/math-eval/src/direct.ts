// Прямой вызов провайдера — «чистая» модель без агента, инструментов и персоны.
//
// Нужен как контрольная рука: только так наши числа сопоставимы с опубликованными
// результатами бенчмарков. Икар — это агент с памятью и тулами, его цифры про
// другое; но если «чистая» модель на нашем харнессе не воспроизводит известный
// результат, значит измерениям нельзя верить вообще.
import type { Usage } from './types.ts';
import type { ChatReply } from './client.ts';

export type DirectOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** Сколько раз повторить при 429/5xx/сетевой ошибке. */
  maxRetries?: number;
  /** Пауза перед повтором, мс; растёт вдвое. */
  retryDelayMs?: number;
};

type ChatBody = {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
  usage?: Partial<Usage>;
};

/** Ответ провайдера в общий вид. Отдельно от `ask`: тут нет заголовков Икара. */
export async function askDirect(prompt: string, options: DirectOptions): Promise<ChatReply> {
  const url = new URL('chat/completions', `${options.baseUrl.replace(/\/+$/, '')}/`).toString();
  const retries = options.maxRetries ?? 3;
  let delay = options.retryDelayMs ?? 1000;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
      });
    } catch (error) {
      // Сеть и таймаут — имеет смысл повторить.
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
      continue;
    }

    const text = await response.text();
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`провайдер ответил ${response.status}: ${text.slice(0, 200)}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
      continue;
    }
    // 400 и прочие 4xx — это наш плохой запрос, повтор не поможет.
    if (!response.ok) throw new Error(`провайдер ответил ${response.status}: ${text.slice(0, 300)}`);
    return parseReply(text);
  }

  throw new Error(`провайдер не ответил за ${retries + 1} попыток: ${String(lastError)}`);
}

function parseReply(text: string): ChatReply {
  let body: ChatBody;
  try {
    body = JSON.parse(text) as ChatBody;
  } catch {
    throw new Error(`не разобрал ответ провайдера: ${text.slice(0, 200)}`);
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

/** Живой ли провайдер и как называются модели: `GET /models`. */
export async function providerModels(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<string[] | null> {
  try {
    const url = new URL('models', `${options.baseUrl.replace(/\/+$/, '')}/`).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((model) => String(model.id ?? '')).filter((id) => id.length > 0);
  } catch {
    return null;
  }
}
