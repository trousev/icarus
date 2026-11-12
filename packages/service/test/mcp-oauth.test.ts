// OAuth 2.1 для MCP: discovery, регистрация клиента, PKCE и обновление токена.
//
// Тест держит не внутренности, а контракт с authorization server: какие адреса
// сервис спрашивает, что кладёт в authorization URL и что отправляет на token
// endpoint. Ошибка здесь — это «кнопка подключить» не работает у живого сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalResource,
  clientMetadataDocument,
  completeAuthorization,
  credentialsFromCompleted,
  discoverOAuth,
  mimicCallbackUrl,
  parseAuthorizationResponse,
  peekAuthorization,
  refreshAuthorization,
  resetPendingForTests,
  startAuthorization,
  tokenIsFresh,
  type FetchLike,
} from '../src/mcp/oauth.ts';
import type { UserMcpServer } from '../src/mcp/registry.ts';

const MCP = 'https://mcp.example.com/mcp';
const ISSUER = 'https://as.example';

const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
};

function server(overrides: Partial<UserMcpServer> = {}): UserMcpServer {
  return {
    id: 'todoist',
    name: 'Todoist',
    description: 'Задачи',
    transport: 'streamable-http',
    url: MCP,
    auth: 'oauth',
    owner: 'probe',
    shared: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
type Calls = Array<{ url: string; init: RequestInit }>;

function routes(table: Record<string, Handler>): { fetchImpl: FetchLike; calls: Calls } {
  const calls: Calls = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = new URL(url).pathname + new URL(url).search;
    const handler = table[key] ?? table[url] ?? table[new URL(url).pathname];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function challenge(scope = 'tasks:read tasks:write'): Response {
  return new Response('unauthorized', {
    status: 401,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${ISSUER}/prm", scope="${scope}"`,
    },
  });
}

function discoveryRoutes(overrides: Record<string, Handler> = {}): { fetchImpl: FetchLike; calls: Calls } {
  return routes({
    '/mcp': () => challenge(),
    '/prm': () =>
      json({
        resource: MCP,
        authorization_servers: [ISSUER],
        scopes_supported: ['tasks:read', 'tasks:write'],
      }),
    '/.well-known/oauth-authorization-server': () => json(AS_METADATA),
    ...overrides,
  });
}

test('discovery идёт по подсказке 401, а не по угадыванию well-known', async () => {
  const { fetchImpl, calls } = discoveryRoutes();
  const discovery = await discoverOAuth({ serverUrl: MCP, fetchImpl });

  assert.equal(discovery.issuer, ISSUER);
  assert.equal(discovery.authorizationEndpoint, `${ISSUER}/authorize`);
  assert.equal(discovery.tokenEndpoint, `${ISSUER}/token`);
  assert.equal(discovery.registrationEndpoint, `${ISSUER}/register`);
  assert.equal(discovery.challengeScope, 'tasks:read tasks:write');
  assert.deepEqual(discovery.scopesSupported, ['tasks:read', 'tasks:write']);
  assert.equal(discovery.source, 'challenge');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/mcp',
    '/prm',
    '/.well-known/oauth-authorization-server',
  ]);
});

test('startAuthorization регистрирует клиента и строит PKCE-ссылку с resource', async () => {
  resetPendingForTests();
  const { fetchImpl } = discoveryRoutes({
    '/register': () => json({ client_id: 'client-42', client_secret: 'secret-42' }, 201),
  });
  const started = await startAuthorization({
    server: server(),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
    now: 1_000,
  });

  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, `${ISSUER}/authorize`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-42');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://icarus.example.com/panel/mcp/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), MCP, 'RFC 8707: токен выписан на этот ресурс');
  assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.ok((url.searchParams.get('state') ?? '').length >= 43);
  assert.equal(started.client.tokenEndpointAuthMethod, 'client_secret_post');
});

test('completeAuthorization обменивает код: verifier, client_secret и resource на месте', async () => {
  resetPendingForTests();
  let tokenBody = '';
  const { fetchImpl } = discoveryRoutes({
    '/register': () => json({ client_id: 'client-42', client_secret: 'secret-42' }, 201),
    '/token': (_url, init) => {
      tokenBody = String(init.body ?? '');
      return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    },
  });
  const started = await startAuthorization({
    server: server(),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
    now: 1_000,
  });
  const completed = await completeAuthorization({ state: started.state, code: 'code-1', fetchImpl, now: 2_000 });

  const form = new URLSearchParams(tokenBody);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-1');
  assert.equal(form.get('client_id'), 'client-42');
  assert.equal(form.get('client_secret'), 'secret-42');
  assert.equal(form.get('resource'), MCP);
  assert.ok((form.get('code_verifier') ?? '').length >= 43);
  // PKCE не «на глаз»: challenge в ссылке — это S256 от verifier, который уехал
  // на token endpoint. Иначе авторизация пройдёт, а обмен кода — нет.
  const expectedChallenge = createHash('sha256')
    .update(form.get('code_verifier') ?? '')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(new URL(started.url).searchParams.get('code_challenge'), expectedChallenge);
  assert.equal(completed.tokens.accessToken, 'access-1');

  const saved = credentialsFromCompleted(completed);
  assert.equal(saved.refreshToken, 'refresh-1');
  assert.equal(saved.expiresAt, 2_000 + 3_600_000);
  assert.equal(saved.clientId, 'client-42');
  assert.equal(tokenIsFresh(saved, 2_000), true);
  assert.equal(tokenIsFresh(saved, 2_000 + 3_600_000), false);
});

test('готовый client_id и секрет не запускают динамическую регистрацию', async () => {
  resetPendingForTests();
  const { fetchImpl, calls } = discoveryRoutes();
  const started = await startAuthorization({
    server: server({ clientId: 'known-client' }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    credentials: { oauth: { clientSecret: 'known-secret', tokenEndpointAuthMethod: 'client_secret_basic' } },
    fetchImpl,
  });
  assert.equal(new URL(started.url).searchParams.get('client_id'), 'known-client');
  assert.equal(calls.filter((call) => new URL(call.url).pathname === '/register').length, 0);
});

test('секрет клиента уходит Basic-заголовком, когда сервер этого требует', async () => {
  resetPendingForTests();
  let authorization = '';
  const { fetchImpl } = discoveryRoutes({
    '/.well-known/oauth-authorization-server': () =>
      json({ ...AS_METADATA, token_endpoint_auth_methods_supported: ['client_secret_basic'] }),
    '/token': (_url, init) => {
      authorization = String((init.headers as Record<string, string> | undefined)?.authorization ?? '');
      return json({ access_token: 'access-basic', expires_in: 3600 });
    },
  });
  const started = await startAuthorization({
    server: server({ clientId: 'known-client' }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    credentials: { oauth: { clientSecret: 'known-secret' } },
    fetchImpl,
  });
  await completeAuthorization({ state: started.state, code: 'code-basic', fetchImpl });
  assert.match(authorization, /^Basic /);
  const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
  assert.equal(decoded, 'known-client:known-secret');
});

test('CIMD: если сервер его поддерживает, client_id — ссылка на наш документ', async () => {
  resetPendingForTests();
  const { fetchImpl } = discoveryRoutes({
    '/.well-known/oauth-authorization-server': () =>
      json({
        ...AS_METADATA,
        registration_endpoint: undefined,
        client_id_metadata_document_supported: true,
      }),
  });
  const started = await startAuthorization({
    server: server(),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
  });
  assert.equal(
    new URL(started.url).searchParams.get('client_id'),
    'https://icarus.example.com/panel/mcp/oauth/client-metadata.json',
  );

  const document = clientMetadataDocument('https://icarus.example.com');
  assert.equal(document.document.client_id, document.clientId);
  assert.deepEqual(document.document.redirect_uris, ['https://icarus.example.com/panel/mcp/oauth/callback']);
});

test('ручные endpoints работают без сети и без discovery', async () => {
  resetPendingForTests();
  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    return json({});
  };
  const started = await startAuthorization({
    server: server({
      clientId: 'manual-client',
      authorizationEndpoint: `${ISSUER}/auth`,
      tokenEndpoint: `${ISSUER}/token`,
    }),
    userId: 'probe',
    publicUrl: 'http://localhost:8081',
    fetchImpl,
  });
  assert.equal(new URL(started.url).pathname, '/auth');
  assert.equal(called, 0, 'ни одного запроса: всё задано руками');
});

test('чужой state не завершает авторизацию', async () => {
  resetPendingForTests();
  await assert.rejects(
    () => completeAuthorization({ state: 'чужой', code: 'code' }),
    /устарела|использована/,
  );
});

test('refresh сохраняет ротацию refresh_token и не теряет client_id', async () => {
  let body = '';
  const { fetchImpl } = routes({
    '/token': (_url, init) => {
      body = String(init.body ?? '');
      return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60 });
    },
  });
  const next = await refreshAuthorization({
    oauth: {
      accessToken: 'old',
      refreshToken: 'refresh-1',
      tokenEndpoint: `${ISSUER}/token`,
      clientId: 'client-42',
      clientSecret: 'secret-42',
      tokenEndpointAuthMethod: 'client_secret_post',
      resource: MCP,
    },
    fetchImpl,
    now: 10_000,
  });
  const form = new URLSearchParams(body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'refresh-1');
  assert.equal(form.get('resource'), MCP);
  assert.equal(next.accessToken, 'access-2');
  assert.equal(next.refreshToken, 'refresh-2');
  assert.equal(next.clientId, 'client-42');
  assert.equal(next.expiresAt, 70_000);
});

test('канонический ресурс не тащит хвостовой слэш и фрагмент', () => {
  assert.equal(canonicalResource('https://mcp.example.com/mcp/'), 'https://mcp.example.com/mcp');
  assert.equal(canonicalResource('https://mcp.example.com/#x'), 'https://mcp.example.com');
});

// ── мимикрия: вход через мёртвый loopback ──────────────────────────────────
// Такие authorization servers (Any.do) примут только redirect_uri из своего
// белого списка. Мы регистрируемся как локальный клиент, как Claude Code, а код
// человек вставляет руками.

test('мимикрия: регистрация и authorize идут на loopback, а не на панель', async () => {
  resetPendingForTests();
  let registerBody: Record<string, unknown> = {};
  const { fetchImpl } = discoveryRoutes({
    '/register': (_url, init) => {
      registerBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return json({ client_id: 'client-loop', token_endpoint_auth_method: 'none' }, 201);
    },
  });
  const started = await startAuthorization({
    server: server({ mimic: true }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
    now: 1_000,
  });

  assert.equal(started.mimic, true);
  assert.equal(started.redirectUri, mimicCallbackUrl());
  assert.equal(started.redirectUri, 'http://localhost:47821/callback');
  assert.deepEqual(registerBody.redirect_uris, ['http://localhost:47821/callback'], 'клиент регистрируется на loopback');
  assert.equal(new URL(started.url).searchParams.get('redirect_uri'), 'http://localhost:47821/callback');
});

test('мимикрия: сохранённый redirect_uri не даёт переиспользовать чужого клиента', async () => {
  resetPendingForTests();
  const registrations: Array<Record<string, unknown>> = [];
  const { fetchImpl } = discoveryRoutes({
    '/register': (_url, init) => {
      registrations.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
      return json({ client_id: 'client-' + registrations.length, token_endpoint_auth_method: 'none' }, 201);
    },
    '/token': () => json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
  });

  const plain = await startAuthorization({
    server: server(),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
  });
  assert.equal(new URL(plain.url).searchParams.get('client_id'), 'client-1');
  const completed = await completeAuthorization({ state: plain.state, code: 'code-1', fetchImpl });
  const saved = credentialsFromCompleted(completed);
  assert.equal(saved.redirectUri, 'https://icarus.example.com/panel/mcp/oauth/callback');

  // Включили мимикрию: адрес возврата другой, значит клиенту нужна новая
  // регистрация — старый client_id привязан к публичному callback.
  const mimic = await startAuthorization({
    server: server({ mimic: true }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    credentials: { oauth: saved },
    fetchImpl,
  });
  assert.equal(registrations.length, 2, 'клиент перерегистрирован под loopback');
  assert.equal(new URL(mimic.url).searchParams.get('client_id'), 'client-2');

  // А повторный вход в том же режиме клиента уже переиспользует.
  const repeated = await startAuthorization({
    server: server({ mimic: true }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    credentials: { oauth: { ...saved, clientId: 'client-2', redirectUri: mimicCallbackUrl() } },
    fetchImpl,
  });
  assert.equal(registrations.length, 2);
  assert.equal(new URL(repeated.url).searchParams.get('client_id'), 'client-2');
});

test('мимикрия несовместима с CIMD: наш документ объявляет публичный callback', async () => {
  resetPendingForTests();
  const { fetchImpl } = discoveryRoutes({
    '/.well-known/oauth-authorization-server': () =>
      json({ ...AS_METADATA, registration_endpoint: undefined, client_id_metadata_document_supported: true }),
  });
  await assert.rejects(
    () =>
      startAuthorization({
        server: server({ mimic: true }),
        userId: 'probe',
        publicUrl: 'https://icarus.example.com',
        fetchImpl,
      }),
    /CIMD/,
  );
});

test('вставленный адрес разбирается: полный URL, без схемы и один query', () => {
  const full = parseAuthorizationResponse(
    'http://localhost:47821/callback?code=abc&state=def&iss=https%3A%2F%2Fmcp.any.do%2F',
  );
  assert.equal(full.code, 'abc');
  assert.equal(full.state, 'def');
  assert.equal(full.redirect, 'http://localhost:47821/callback?code=abc&state=def&iss=https%3A%2F%2Fmcp.any.do%2F');

  const noScheme = parseAuthorizationResponse('localhost:47821/callback?code=abc&state=def');
  assert.equal(noScheme.code, 'abc');
  assert.equal(noScheme.state, 'def');
  assert.equal(noScheme.redirect, undefined, 'без схемы адрес не считаем URL');

  const query = parseAuthorizationResponse('?code=abc&state=def');
  assert.equal(query.code, 'abc');
  assert.equal(query.state, 'def');

  const bare = parseAuthorizationResponse('code=abc&state=def');
  assert.equal(bare.code, 'abc');
  assert.equal(bare.state, 'def');

  const denied = parseAuthorizationResponse('http://localhost:47821/callback?error=access_denied&error_description=нет');
  assert.equal(denied.error, 'access_denied');
  assert.equal(denied.errorDescription, 'нет');

  assert.throws(() => parseAuthorizationResponse('   '), /вставь адрес/);
  assert.throws(() => parseAuthorizationResponse('http://localhost:47821/callback'), /code/);
  assert.throws(() => parseAuthorizationResponse('что-то не то'), /code/);
});

test('peekAuthorization показывает, чей это вход, и исчезает после обмена', async () => {
  resetPendingForTests();
  const { fetchImpl } = discoveryRoutes({
    '/register': () => json({ client_id: 'client-42', token_endpoint_auth_method: 'none' }, 201),
    '/token': () => json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
  });
  const started = await startAuthorization({
    server: server({ mimic: true }),
    userId: 'probe',
    publicUrl: 'https://icarus.example.com',
    fetchImpl,
    now: 1_000,
  });
  const info = peekAuthorization(started.state, 2_000);
  assert.equal(info?.userId, 'probe');
  assert.equal(info?.serverId, 'todoist');
  assert.equal(info?.redirectUri, mimicCallbackUrl());

  await completeAuthorization({ state: started.state, code: 'code-1', fetchImpl, now: 3_000 });
  assert.equal(peekAuthorization(started.state, 4_000), null, 'одноразовый state больше не живёт');
  assert.equal(peekAuthorization('чужой', 4_000), null);
});
