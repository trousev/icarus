// You.com free profile: keyless search, only via MCP.
//
// With You.com "free" lives exclusively in MCP: REST /v1/search requires a key, and
// there is no free keyed profile. But MCP is just JSON-RPC over HTTP
// (streamable HTTP), so for the router it is a provider like any other:
// one POST instead of a REST request, the response is an SSE stream with the same JSON inside.
//
// What was verified against the live server on 2026-11-07:
//  - the server is stateless: initialize and Mcp-Session-Id are not needed, tools/call
//    is accepted immediately, there is no authorization;
//  - the free profile serves only you-search and you-discover (100 requests per
//    day); you-contents is not part of it, and extraction: full_page answers
//    "Free tier limit exceeded". So for web_fetch the free MCP is not
//    suitable — it can only search;
//  - an exhausted quota does not come as 429, but as a successful JSON-RPC response with
//    result.isError = true and the text "Free tier limit exceeded". Therefore a
//    tool error must be parsed separately from the HTTP status.
import { SearchFailure, type FailureKind } from './types.ts';
import { requestText, type RequestContext } from './request.ts';

/** Free profile entry point. The key and profile are in the query, there is no authorization. */
export const YOU_FREE_MCP_URL = 'https://api.you.com/mcp?profile=free';

/** Protocol version: the server understands it, but also responds without the header. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** id counter: JSON-RPC requires a unique id per request, the server echoes it. */
let lastId = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** SSE frames: `data: {...}` separated by a blank line. A frame that isn't ours — we silently skip it. */
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
      // A fragment or a comment is no reason to consider the whole response broken.
    }
  }
  return events;
}

/**
 * Response messages. The server may also reply with plain JSON — then there are no SSE frames,
 * and the body starts with a curly brace.
 */
export function parseMcpBody(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      // Looks like JSON, but isn't — below we'll try to parse it as SSE.
    }
  }
  return parseSseEvents(trimmed);
}

/**
 * Find the response to our request among the notifications. The server echoes the id, but if
 * the id didn't match (or is absent), and there is exactly one meaningful response — we take it:
 * progress notifications about the search must not break the request.
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

/** Text of the first content block: for MCP the result is an array of blocks. */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const text = asText(asRecord(block)?.text);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Signs of "free quota exhausted". You.com writes "Free tier limit
 * exceeded. Please upgrade", giving neither 429 nor Retry-After.
 */
const QUOTA_TEXT = /free tier|\bquota\b|\bcredits?\b|\bbilling\b|upgrade|\blimit exceeded\b/i;

/**
 * Failure inside an MCP response: either a JSON-RPC error, or result.isError.
 * Returns null if the response is successful.
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
 * JSON from the tool response: you-search puts it as a string into content[0].text.
 * Inside — the same shape as REST /v1/search: {results: {web, news, knowledge}}.
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
 * One search via the free profile. We ask only for you-search: you-discover searches
 * agents, not pages.
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
 * When the daily quota returns. A flat 24-hour quarantine is expensive here: the quota
 * resets by calendar, and the provider would sit idle for extra hours. A minute
 * of margin — for clock skew.
 */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return midnight + 60_000;
}
