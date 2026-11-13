// Free You.com MCP: transport, response parsing and refusals.
//
// The network is stubbed: we check the request shape (JSON-RPC, no key) and how the
// response is parsed — SSE with notifications, plain JSON and a tool error.
// The quota error matters more than the others here: it arrives not as 429, but as a successful response.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_PROTOCOL_VERSION,
  YOU_FREE_MCP_URL,
  mcpError,
  mcpPayload,
  nextUtcMidnight,
  parseMcpBody,
  parseSseEvents,
  pickResponse,
  youFreeSearch,
} from '../src/search/you-mcp.ts';
import { SearchFailure } from '../src/search/types.ts';

const PAYLOAD = { results: { web: [{ title: 'Раз', url: 'https://one.dev' }] }, metadata: { query: 'q' } };

function sse(...messages: unknown[]): Response {
  const body = messages
    .map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function capturing(response: () => Response): { fetch: typeof fetch; calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return response();
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

test('SSE: frames separated by an empty line, multiline data is glued together', () => {
  const events = parseSseEvents(
    'event: message\ndata: {"a":1}\n\n' +
      ': комментарий\n\n' +
      'data: {"b":\ndata: 2}\n\n' +
      'data: не json\n\n',
  );
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('plain JSON instead of SSE is understood too', () => {
  assert.deepEqual(parseMcpBody('  {"jsonrpc":"2.0","id":1,"result":{}}  '), [
    { jsonrpc: '2.0', id: 1, result: {} },
  ]);
  assert.deepEqual(parseMcpBody('event: message\ndata: {"x":1}\n\n'), [{ x: 1 }]);
});

test('the response is searched by id, and if the id did not match — the only meaningful one is taken', () => {
  const events = [
    { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'ищу' } },
    { jsonrpc: '2.0', id: 7, result: {} },
  ];
  assert.deepEqual(pickResponse(events, 7), events[1]);
  assert.deepEqual(pickResponse(events, 99), events[1], 'id не совпал, но ответ один — берём его');
  assert.equal(pickResponse([events[0]!, events[1]!, { jsonrpc: '2.0', id: 8, result: {} }], 99), null);
});

test('"Free tier limit exceeded" means credits, not a broken key', () => {
  const failure = mcpError({
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: 'Error: Free tier limit exceeded. Please upgrade.' }] },
  });
  assert.ok(failure instanceof SearchFailure);
  assert.equal(failure.kind, 'credits');
  assert.match(failure.message, /Free tier limit exceeded/);
});

test('a JSON-RPC error and an ordinary tool error — a five-minute quarantine', () => {
  const rpc = mcpError({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool you-contents not found' } });
  assert.equal(rpc?.kind, 'http');

  const tool = mcpError({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
  assert.equal(tool?.kind, 'http');

  assert.equal(mcpError({ jsonrpc: '2.0', id: 1, result: { content: [] } }), null);
});

test('the JSON of the output lies as a string in content[0].text', () => {
  const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } };
  assert.deepEqual(mcpPayload(envelope), PAYLOAD);
  assert.equal(mcpPayload({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'не json' }] } }), null);
});

test('request: tools/call you-search, without authorization, with the free profile', async () => {
  const fake = capturing(() => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } }));
  const payload = await youFreeSearch('лиссабон', 4, { fetch: fake.fetch });

  assert.deepEqual(payload, PAYLOAD);
  const call = fake.calls[0];
  assert.equal(call?.url.toString(), YOU_FREE_MCP_URL);
  assert.equal(call?.init.method, 'POST');
  const headers = call?.init.headers as Record<string, string>;
  assert.equal(headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
  assert.match(headers.accept, /text\/event-stream/);
  assert.equal(headers.authorization, undefined);

  const body = JSON.parse(String(call?.init.body));
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'you-search');
  assert.deepEqual(body.params.arguments, { query: 'лиссабон', count: 4 });
});

test('search progress notifications do not get in the way of finding the result', async () => {
  const fake = capturing(() =>
    sse(
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'Search successful' } },
      { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } },
    ),
  );
  assert.deepEqual(await youFreeSearch('q', 1, { fetch: fake.fetch }), PAYLOAD);
});

test('an exhausted quota arrives as a credits refusal, not as an empty result', async () => {
  const fake = capturing(() =>
    sse({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'Error: Free tier limit exceeded.' }] },
    }),
  );
  await assert.rejects(youFreeSearch('q', 1, { fetch: fake.fetch }), (error: unknown) => {
    assert.ok(error instanceof SearchFailure);
    assert.equal(error.kind, 'credits');
    return true;
  });
});

test('a response without a result is an honest refusal, not "nothing found"', async () => {
  const fake = capturing(() => sse({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }));
  await assert.rejects(youFreeSearch('q', 1, { fetch: fake.fetch }), /не вернул ответ/);
});

test('the daily quota waits for UTC midnight, not for an exact day', () => {
  assert.equal(nextUtcMidnight(Date.parse('2026-11-07T12:00:00Z')), Date.parse('2026-11-08T00:01:00Z'));
  assert.equal(nextUtcMidnight(Date.parse('2026-11-07T23:59:30Z')), Date.parse('2026-11-08T00:01:00Z'));
});
