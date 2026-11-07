// Бесплатный MCP You.com: транспорт, разбор ответа и отказы.
//
// Сеть подменяется: проверяем форму запроса (JSON-RPC, без ключа) и то, как
// разбирается ответ — SSE с уведомлениями, обычный JSON и ошибка инструмента.
// Ошибка квоты тут важнее прочих: она приходит не 429, а успешным ответом.
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

test('SSE: кадры через пустую строку, многострочный data склеивается', () => {
  const events = parseSseEvents(
    'event: message\ndata: {"a":1}\n\n' +
      ': комментарий\n\n' +
      'data: {"b":\ndata: 2}\n\n' +
      'data: не json\n\n',
  );
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('обычный JSON вместо SSE тоже понимается', () => {
  assert.deepEqual(parseMcpBody('  {"jsonrpc":"2.0","id":1,"result":{}}  '), [
    { jsonrpc: '2.0', id: 1, result: {} },
  ]);
  assert.deepEqual(parseMcpBody('event: message\ndata: {"x":1}\n\n'), [{ x: 1 }]);
});

test('ответ ищется по id, а если id не совпал — берётся единственный осмысленный', () => {
  const events = [
    { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'ищу' } },
    { jsonrpc: '2.0', id: 7, result: {} },
  ];
  assert.deepEqual(pickResponse(events, 7), events[1]);
  assert.deepEqual(pickResponse(events, 99), events[1], 'id не совпал, но ответ один — берём его');
  assert.equal(pickResponse([events[0]!, events[1]!, { jsonrpc: '2.0', id: 8, result: {} }], 99), null);
});

test('«Free tier limit exceeded» — это кредиты, а не поломка ключа', () => {
  const failure = mcpError({
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: 'Error: Free tier limit exceeded. Please upgrade.' }] },
  });
  assert.ok(failure instanceof SearchFailure);
  assert.equal(failure.kind, 'credits');
  assert.match(failure.message, /Free tier limit exceeded/);
});

test('JSON-RPC error и обычная ошибка инструмента — пятиминутный карантин', () => {
  const rpc = mcpError({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool you-contents not found' } });
  assert.equal(rpc?.kind, 'http');

  const tool = mcpError({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
  assert.equal(tool?.kind, 'http');

  assert.equal(mcpError({ jsonrpc: '2.0', id: 1, result: { content: [] } }), null);
});

test('JSON выдачи лежит строкой в content[0].text', () => {
  const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } };
  assert.deepEqual(mcpPayload(envelope), PAYLOAD);
  assert.equal(mcpPayload({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'не json' }] } }), null);
});

test('запрос: tools/call you-search, без авторизации, с профилем free', async () => {
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

test('уведомления о ходе поиска не мешают найти результат', async () => {
  const fake = capturing(() =>
    sse(
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'Search successful' } },
      { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } },
    ),
  );
  assert.deepEqual(await youFreeSearch('q', 1, { fetch: fake.fetch }), PAYLOAD);
});

test('исчерпанная квота доезжает как отказ credits, а не как пустая выдача', async () => {
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

test('ответ без результата — честный отказ, а не «ничего не нашлось»', async () => {
  const fake = capturing(() => sse({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }));
  await assert.rejects(youFreeSearch('q', 1, { fetch: fake.fetch }), /не вернул ответ/);
});

test('суточная квота ждёт полуночи UTC, а не ровных суток', () => {
  assert.equal(nextUtcMidnight(Date.parse('2026-11-07T12:00:00Z')), Date.parse('2026-11-08T00:01:00Z'));
  assert.equal(nextUtcMidnight(Date.parse('2026-11-07T23:59:30Z')), Date.parse('2026-11-08T00:01:00Z'));
});
