// Один HTTP-вызов провайдера: сеть, статус, тело ответа.
//
// Одинаково нужен поиску, извлечению страниц и MCP-клиенту: отличаются только
// классификация статуса (у извлечения 404 — свойство страницы, а не поломка
// ключа) и то, что делать с телом — разобрать как JSON или отдать строкой:
// MCP-сервер отвечает потоком SSE.
import { SearchFailure, classifyFailure, type FailureKind } from './types.ts';

export type RequestContext = {
  fetch: typeof fetch;
  signal?: AbortSignal;
};

/** Как понимать HTTP-статус. По умолчанию — общие правила роутера. */
export type StatusClassifier = (status: number, body: string) => FailureKind;

/**
 * Тело ответа строкой. Не-2xx — SearchFailure с куском тела: по нему роутер
 * решает, банить на пять минут или на сутки, а панель показывает причину.
 */
export async function requestText(
  url: string,
  init: RequestInit,
  ctx: RequestContext,
  classify: StatusClassifier = classifyFailure,
): Promise<string> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SearchFailure('timeout', 'провайдер не ответил вовремя');
    }
    throw new SearchFailure('network', error instanceof Error ? error.message : String(error));
  }

  let body = '';
  try {
    body = await response.text();
  } catch {
    // Тело не дочиталось — статус уже всё сказал.
  }
  if (!response.ok) {
    throw new SearchFailure(classify(response.status, body), `HTTP ${response.status}`, {
      status: response.status,
      body: body.slice(0, 400),
    });
  }
  return body;
}

/** То же, но тело обязано быть JSON: иначе это отказ, а не пустая выдача. */
export async function requestJson(
  url: string,
  init: RequestInit,
  ctx: RequestContext,
  classify: StatusClassifier = classifyFailure,
): Promise<unknown> {
  const body = await requestText(url, init, ctx, classify);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SearchFailure('http', 'ответ провайдера не разобрался как JSON');
  }
}
