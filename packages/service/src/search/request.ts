// A single HTTP call to a provider: network, status, response body.
//
// Equally needed by search, page extraction and the MCP client: only the status
// classification differs (for extraction, 404 is a property of the page, not a broken
// key) and what to do with the body — parse it as JSON or return it as a string:
// an MCP server replies with an SSE stream.
import { SearchFailure, classifyFailure, type FailureKind } from './types.ts';

export type RequestContext = {
  fetch: typeof fetch;
  signal?: AbortSignal;
};

/** How to interpret an HTTP status. By default, the router's general rules. */
export type StatusClassifier = (status: number, body: string) => FailureKind;

/**
 * Response body as a string. Non-2xx means a SearchFailure with a piece of the body: from it the router
 * decides whether to ban for five minutes or for a day, and the panel shows the reason.
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
    // The body was not fully read — the status has already said everything.
  }
  if (!response.ok) {
    throw new SearchFailure(classify(response.status, body), `HTTP ${response.status}`, {
      status: response.status,
      body: body.slice(0, 400),
    });
  }
  return body;
}

/** The same, but the body must be JSON: otherwise it is a refusal, not an empty result. */
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
