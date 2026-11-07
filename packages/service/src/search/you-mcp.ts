// Бесплатный профиль You.com: поиск без ключа, только по MCP.
//
// У You.com «free» живёт исключительно в MCP: REST /v1/search требует ключ, а
// бесплатного ключевого профиля нет. Но MCP — это обычный JSON-RPC поверх HTTP
// (streamable HTTP), так что из роутера это такой же провайдер, как остальные:
// один POST вместо REST-запроса, ответ — поток SSE с тем же JSON внутри.
//
// Что проверено на живом сервере 2026-11-07:
//  - сервер stateless: initialize и Mcp-Session-Id не нужны, tools/call
//    принимается сразу, авторизации нет;
//  - free-профиль отдаёт только you-search и you-discover (100 запросов в
//    сутки); you-contents в него не входит, а extraction: full_page отвечает
//    «Free tier limit exceeded». Значит, для web_fetch бесплатный MCP не
//    годится — им можно только искать;
//  - исчерпанная квота приходит не 429, а успешным JSON-RPC-ответом с
//    result.isError = true и текстом «Free tier limit exceeded». Поэтому
//    ошибку инструмента надо разбирать отдельно от HTTP-статуса.
import { SearchFailure, type FailureKind } from './types.ts';
import { requestText, type RequestContext } from './request.ts';

/** Точка входа free-профиля. Ключ и профиль — в query, авторизации нет. */
export const YOU_FREE_MCP_URL = 'https://api.you.com/mcp?profile=free';

/** Версия протокола: сервер её понимает, но и без заголовка отвечает. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Счётчик id: JSON-RPC требует уникальный id на запрос, сервер его эхом. */
let lastId = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Кадры SSE: `data: {...}` через пустую строку. Не наш кадр — молча пропускаем. */
export function parseSseEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n');
    if (data.trim() === '') continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      // Обрывок или комментарий — не повод считать весь ответ битым.
    }
  }
  return events;
}

/**
 * Сообщения ответа. Сервер вправе ответить и обычным JSON — тогда SSE-кадров
 * нет, а тело начинается с фигурной скобки.
 */
export function parseMcpBody(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      // Похоже на JSON, но не он — ниже попробуем разобрать как SSE.
    }
  }
  return parseSseEvents(trimmed);
}

/**
 * Найти ответ на свой запрос среди уведомлений. Сервер эхом отдаёт id, но если
 * id не совпал (или его нет), а осмысленный ответ ровно один — берём его:
 * уведомления о ходе поиска не должны ронять запрос.
 */
export function pickResponse(events: unknown[], id: number): unknown | null {
  const answers = events.filter((event) => {
    const root = asRecord(event);
    return root !== null && ('result' in root || 'error' in root);
  });
  const sameId = answers.find((event) => {
    const value = asRecord(event)?.id;
    return value === id || value === String(id);
  });
  if (sameId !== undefined) return sameId;
  return answers.length === 1 ? answers[0] : null;
}

/** Текст первого content-блока: у MCP результат — массив блоков. */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const text = asText(asRecord(block)?.text);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Признаки «кончилась бесплатная квота». You.com пишет «Free tier limit
 * exceeded. Please upgrade», не давая ни 429, ни Retry-After.
 */
const QUOTA_TEXT = /free tier|\bquota\b|\bcredits?\b|\bbilling\b|upgrade|\blimit exceeded\b/i;

/**
 * Отказ внутри ответа MCP: либо JSON-RPC error, либо result.isError.
 * Возвращает null, если ответ успешный.
 */
export function mcpError(envelope: unknown): SearchFailure | null {
  const root = asRecord(envelope);
  if (root === null) return null;

  const error = asRecord(root.error);
  if (error !== null) {
    const message = asText(error.message) ?? 'MCP-сервер вернул ошибку';
    const kind: FailureKind = QUOTA_TEXT.test(message) ? 'credits' : 'http';
    return new SearchFailure(kind, message, { body: JSON.stringify(error).slice(0, 400) });
  }

  const result = asRecord(root.result);
  if (result?.isError === true) {
    const message = contentText(result.content) ?? 'инструмент вернул ошибку';
    const kind: FailureKind = QUOTA_TEXT.test(message) ? 'credits' : 'http';
    return new SearchFailure(kind, message, { body: message.slice(0, 400) });
  }
  return null;
}

/**
 * JSON из ответа инструмента: you-search кладёт его строкой в content[0].text.
 * Внутри — та же форма, что у REST /v1/search: {results: {web, news, knowledge}}.
 */
export function mcpPayload(envelope: unknown): unknown | null {
  const text = contentText(asRecord(asRecord(envelope)?.result)?.content);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Один поиск через free-профиль. Просим только you-search: you-discover ищет
 * агентов, а не страницы.
 */
export async function youFreeSearch(query: string, limit: number, ctx: RequestContext): Promise<unknown> {
  lastId += 1;
  const id = lastId;
  const body = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'you-search', arguments: { query, count: limit } },
  };

  const text = await requestText(
    YOU_FREE_MCP_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify(body),
    },
    ctx,
  );

  const envelope = pickResponse(parseMcpBody(text), id);
  if (envelope === null) {
    throw new SearchFailure('http', 'MCP-сервер не вернул ответ на запрос');
  }
  const failure = mcpError(envelope);
  if (failure !== null) throw failure;

  const payload = mcpPayload(envelope);
  if (payload === null) {
    throw new SearchFailure('http', 'MCP-сервер вернул ответ без JSON внутри');
  }
  return payload;
}

/**
 * Когда вернётся суточная квота. Ровные сутки карантина тут дороги: квота
 * сбрасывается по календарю, и провайдер простоял бы лишние часы. Минута
 * запаса — на расхождение часов.
 */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return midnight + 60_000;
}
