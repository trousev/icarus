// OAuth 2.1 for user MCPs — on the service side, not pi's.
//
// Why not hand this to pi-mcp-extension: pi lives in a container without a browser and without
// a public address, and its interactive authorization is designed for the TUI. Here the
// browser is the panel: the service itself does discovery (RFC 9728 / RFC 8414),
// registers the client (DCR, RFC 7591), does PKCE S256, and exchanges the code for a
// token. The token then travels into mcp.json as an ordinary `Authorization: Bearer`, so
// pi-mcp-extension knows nothing about OAuth and works with any HTTP server.
//
// All the flows found in modern MCP servers are supported:
//   * a ready client_id (and secret) — when the server issues the client in advance;
//   * Dynamic Client Registration — when the server can register clients;
//   * Client ID Metadata Document — when the server supports CIMD (RFC 7591
//     is outdated but still the most common path; CIMD follows it);
//   * manual endpoints — when the server tells nothing at all.
//
// Everything network here accepts a fetchImpl: tests supply their own, the service an ordinary
// fetch. Secrets are not logged: errors say "what to do", not "which token".
import { createHash, randomBytes } from 'node:crypto';
import type { McpCredentials, McpOAuthCredentials, UserMcpServer } from './registry.ts';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

const DISCOVERY_TIMEOUT_MS = 12_000;
const TOKEN_TIMEOUT_MS = 20_000;
/** The authorization link lives for ten minutes: after that the person no longer remembers what they started. */
export const PENDING_TTL_MS = 10 * 60_000;
const PENDING_LIMIT = 200;

export class OAuthError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export type ProtectedResourceMetadata = {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_name?: string;
};

export type AuthorizationServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  resource_indicators_supported?: boolean;
};

export type OAuthDiscovery = {
  resource: string;
  resourceMetadataUrl: string | null;
  challengeScope?: string;
  protectedResource?: ProtectedResourceMetadata;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  clientIdMetadataDocumentSupported: boolean;
  source: 'challenge' | 'well-known' | 'manual' | 'stored';
};

export type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: ClientAuthMethod;
  source: 'preregistered' | 'dcr' | 'cimd';
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: number;
  raw?: Record<string, unknown>;
};

type PendingAuthorization = {
  state: string;
  userId: string;
  serverId: string;
  redirectUri: string;
  verifier: string;
  createdAt: number;
  resource: string;
  discovery: OAuthDiscovery;
  client: OAuthClient;
  scopes?: string;
};

const pending = new Map<string, PendingAuthorization>();

/** For tests only: otherwise the state of one test leaks into the next. */
export function resetPendingForTests(): void {
  pending.clear();
}

function prunePending(now: number): void {
  for (const [state, item] of pending) {
    if (now - item.createdAt > PENDING_TTL_MS) pending.delete(state);
  }
  // The map must not grow from "connect" clicks: the oldest go first.
  while (pending.size > PENDING_LIMIT) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export type PendingAuthorizationInfo = {
  userId: string;
  serverId: string;
  redirectUri: string;
  createdAt: number;
};

/**
 * Who started the login and for what. Needed for manual completion: the panel checks that
 * the pasted code belongs to its person and its server, and only then spends
 * the one-time state on the exchange.
 */
export function peekAuthorization(state: string, now = Date.now()): PendingAuthorizationInfo | null {
  const item = pending.get(state);
  if (!item) return null;
  if (now - item.createdAt > PENDING_TTL_MS) {
    pending.delete(state);
    return null;
  }
  return {
    userId: item.userId,
    serverId: item.serverId,
    redirectUri: item.redirectUri,
    createdAt: item.createdAt,
  };
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function nowOr(now: number | undefined): number {
  return now ?? Date.now();
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return list.length > 0 ? list : undefined;
}

/** Parsing `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. */
export function parseWwwAuthenticate(header: string | null | undefined): {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
} {
  if (!header) return {};
  const bearer = /^\s*Bearer\s+(.+)$/i.exec(header);
  const source = bearer?.[1] ?? header;
  const out: { resourceMetadata?: string; scope?: string; error?: string } = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    if (key === 'resource_metadata') out.resourceMetadata = value;
    else if (key === 'scope') out.scope = value;
    else if (key === 'error') out.error = value;
  }
  return out;
}

/** Canonical resource address for RFC 8707: without a trailing slash and fragment. */
export function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

export function callbackUrl(publicUrl: string): string {
  return new URL('/panel/mcp/oauth/callback', publicUrl).toString();
}

/**
 * The port of the "dead" loopback address for mimic mode (see UserMcpServer.mimic).
 * No one will listen on it intentionally: the browser will reach it, show a connection
 * error, and the address with the code will stay in the bar — the person copies it into the panel.
 * The number is rare so that a random dev server on the machine doesn't intercept the code.
 */
const MIMIC_CALLBACK_PORT = 47821;

/**
 * The address that authorization servers with a redirect_uri whitelist accept:
 * a local callback, like Claude Code and Codex CLI. It also covers login to
 * servers like Any.do, where our public callback is not registered.
 */
export function mimicCallbackUrl(): string {
  return `http://localhost:${MIMIC_CALLBACK_PORT}/callback`;
}

export type AuthorizationResponse = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  /** The whole address if the person pasted a URL: it shows where they were returned. */
  redirect?: string;
};

/**
 * Parses what the person pasted from the browser bar. The browser doesn't show the
 * scheme, so we accept both a full address, `localhost:port/callback?...`, and
 * a bare query string. We also parse an authorization server error: "access_denied"
 * must be shown in words, not as "the address has no code".
 */
export function parseAuthorizationResponse(raw: string): AuthorizationResponse {
  const text = raw.trim();
  if (text === '') throw new OAuthError('вставь адрес из строки браузера');
  let redirect: URL | null = null;
  let params: URLSearchParams;
  const query = text.indexOf('?');
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      redirect = new URL(text);
      params = redirect.searchParams;
    } else if (query >= 0) {
      params = new URLSearchParams(text.slice(query + 1));
    } else {
      params = new URLSearchParams(text.replace(/^[?#]/, ''));
    }
  } catch {
    throw new OAuthError('не разобрал адрес: скопируй его из строки браузера целиком');
  }
  const code = optionalString(params.get('code'));
  const state = optionalString(params.get('state'));
  const error = optionalString(params.get('error'));
  const errorDescription = optionalString(params.get('error_description'));
  if (code === undefined && state === undefined && error === undefined) {
    throw new OAuthError('в адресе нет ни code, ни state — скопируй адрес целиком, вместе с «?…»');
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(state === undefined ? {} : { state }),
    ...(error === undefined ? {} : { error }),
    ...(errorDescription === undefined ? {} : { errorDescription }),
    ...(redirect === null ? {} : { redirect: redirect.toString() }),
  };
}

export function clientMetadataUrl(publicUrl: string): string {
  return new URL('/panel/mcp/oauth/client-metadata.json', publicUrl).toString();
}

/** The document that the authorization server downloads from the client_id link (CIMD). */
export function clientMetadataDocument(publicUrl: string): {
  clientId: string;
  document: Record<string, unknown>;
} {
  const clientId = clientMetadataUrl(publicUrl);
  return {
    clientId,
    document: {
      client_id: clientId,
      client_name: 'Icarus',
      client_uri: new URL('/', publicUrl).toString(),
      redirect_uris: [callbackUrl(publicUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  };
}

function assertHttpUrl(value: string, where: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`${where}: «${value}» не похоже на адрес`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new OAuthError(`${where}: нужен https (или http на localhost)`);
  }
  if (url.username || url.password) throw new OAuthError(`${where}: логин и пароль в адресе недопустимы`);
  if (url.hash) throw new OAuthError(`${where}: фрагмент в адресе недопустим`);
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; allowNotFound?: boolean } = {},
): Promise<{ status: number; body: unknown; headers: Headers } | null> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
    ...(timeoutSignal(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS) === undefined
      ? {}
      : { signal: timeoutSignal(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS) }),
    redirect: 'follow',
  });
  if (options.allowNotFound && (response.status === 404 || response.status === 410)) return null;
  const text = await response.text();
  if (!response.ok) return { status: response.status, body: text, headers: response.headers };
  if (text.trim() === '') return { status: response.status, body: {}, headers: response.headers };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, headers: response.headers };
  } catch {
    throw new OAuthError(`сервер ответил не JSON в ${url}`);
  }
}

function metadataUrlsForResource(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const origin = url.origin;
  return [
    ...(pathname === '' ? [] : [`${origin}/.well-known/oauth-protected-resource${pathname}`]),
    `${origin}/.well-known/oauth-protected-resource`,
  ];
}

function metadataUrlsForIssuer(issuer: string): string[] {
  const url = new URL(issuer);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const origin = url.origin;
  if (pathname === '') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server${pathname}`,
    `${origin}/.well-known/openid-configuration${pathname}`,
    `${origin}${pathname}/.well-known/openid-configuration`,
  ];
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'icarus', version: '0.1.0' },
    },
  });
}

/**
 * We try to get a 401 with a hint about where to look for the token. This is the first step
 * MCP prescribes: the server itself reports resource_metadata, and guessing well-known
 * is only the fallback path.
 */
async function challengeOf(
  serverUrl: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ resourceMetadata?: string; scope?: string }> {
  const baseHeaders = {
    ...headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  try {
    const response = await fetchImpl(serverUrl, {
      method: 'POST',
      headers: baseHeaders,
      body: initializeBody(),
      redirect: 'follow',
      ...(timeoutSignal(DISCOVERY_TIMEOUT_MS) === undefined ? {} : { signal: timeoutSignal(DISCOVERY_TIMEOUT_MS) }),
    });
    if (response.status === 401 || response.status === 403) {
      const parsed = parseWwwAuthenticate(response.headers.get('www-authenticate'));
      await response.body?.cancel().catch(() => undefined);
      return parsed;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 405) {
      const get = await fetchImpl(serverUrl, {
        method: 'GET',
        headers: { ...headers, accept: 'text/event-stream' },
        redirect: 'follow',
        ...(timeoutSignal(4000) === undefined ? {} : { signal: timeoutSignal(4000) }),
      });
      const parsed = parseWwwAuthenticate(get.headers.get('www-authenticate'));
      await get.body?.cancel().catch(() => undefined);
      return parsed;
    }
    return {};
  } catch (error) {
    throw new OAuthError(
      `не удалось достучаться до ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function discoveryFromManual(server: UserMcpServer): OAuthDiscovery | null {
  if (!server.url || !server.authorizationEndpoint || !server.tokenEndpoint) return null;
  return {
    resource: canonicalResource(server.url),
    resourceMetadataUrl: null,
    issuer: server.issuer ?? new URL(server.url).origin,
    authorizationEndpoint: assertHttpUrl(server.authorizationEndpoint, 'authorization endpoint'),
    tokenEndpoint: assertHttpUrl(server.tokenEndpoint, 'token endpoint'),
    ...(server.registrationEndpoint === undefined
      ? {}
      : { registrationEndpoint: assertHttpUrl(server.registrationEndpoint, 'registration endpoint') }),
    tokenEndpointAuthMethodsSupported: ['none', 'client_secret_post', 'client_secret_basic'],
    codeChallengeMethodsSupported: ['S256'],
    clientIdMetadataDocumentSupported: false,
    source: 'manual',
  };
}

function discoveryFromStored(server: UserMcpServer, oauth: McpOAuthCredentials): OAuthDiscovery | null {
  if (!server.url || !oauth.authorizationEndpoint || !oauth.tokenEndpoint) return null;
  return {
    resource: oauth.resource ?? canonicalResource(server.url),
    resourceMetadataUrl: null,
    issuer: oauth.issuer ?? new URL(server.url).origin,
    authorizationEndpoint: oauth.authorizationEndpoint,
    tokenEndpoint: oauth.tokenEndpoint,
    ...(oauth.registrationEndpoint === undefined ? {} : { registrationEndpoint: oauth.registrationEndpoint }),
    ...(oauth.scope === undefined ? {} : { scopesSupported: oauth.scope.split(/\s+/).filter(Boolean) }),
    tokenEndpointAuthMethodsSupported: ['none', 'client_secret_post', 'client_secret_basic'],
    codeChallengeMethodsSupported: ['S256'],
    clientIdMetadataDocumentSupported: false,
    source: 'stored',
  };
}

/** Main path: resource metadata → authorization server metadata. */
export async function discoverOAuth(options: {
  serverUrl: string;
  headers?: Record<string, string>;
  server?: UserMcpServer;
  stored?: McpOAuthCredentials;
  fetchImpl?: FetchLike;
}): Promise<OAuthDiscovery> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverUrl = assertHttpUrl(options.serverUrl, 'адрес MCP-сервера');
  const server = options.server;

  if (server) {
    const manual = discoveryFromManual(server);
    if (manual) return manual;
    if (options.stored) {
      const stored = discoveryFromStored(server, options.stored);
      if (stored) return stored;
    }
  }

  const challenge = await challengeOf(serverUrl, options.headers ?? {}, fetchImpl);
  let resourceMetadata: ProtectedResourceMetadata | null = null;
  let resourceMetadataUrl: string | null = null;
  let usedChallenge = false;

  if (challenge.resourceMetadata) {
    // The address from the header is also external input: it must be https (or
    // loopback), otherwise the service follows someone else's hint anywhere.
    const metadataUrl = assertHttpUrl(challenge.resourceMetadata, 'resource_metadata');
    const fetched = await requestJson(fetchImpl, metadataUrl, { allowNotFound: true });
    const body = asObject(fetched?.body);
    if (fetched && fetched.status === 200 && body) {
      resourceMetadata = body as ProtectedResourceMetadata;
      resourceMetadataUrl = metadataUrl;
      usedChallenge = true;
    }
  }
  if (!resourceMetadata) {
    for (const candidate of metadataUrlsForResource(serverUrl)) {
      const fetched = await requestJson(fetchImpl, candidate, { allowNotFound: true });
      const body = asObject(fetched?.body);
      if (fetched && fetched.status === 200 && body) {
        resourceMetadata = body as ProtectedResourceMetadata;
        resourceMetadataUrl = candidate;
        break;
      }
    }
  }
  if (!resourceMetadata) {
    throw new OAuthError(
      'MCP-сервер не рассказал, где искать токен (нет RFC 9728 metadata). ' +
        'Укажи authorization и token endpoints вручную в настройках сервера.',
    );
  }

  const authServers = Array.isArray(resourceMetadata.authorization_servers)
    ? resourceMetadata.authorization_servers
    : typeof resourceMetadata.authorization_servers === 'string'
      ? [resourceMetadata.authorization_servers]
      : [];
  const issuerRaw =
    optionalString(authServers[0]) ??
    (server?.issuer !== undefined ? assertHttpUrl(server.issuer, 'issuer') : undefined);
  if (!issuerRaw) throw new OAuthError('в metadata сервера нет authorization_servers — некуда идти за токеном');
  const issuerUrl = assertHttpUrl(issuerRaw, 'authorization server');
  // A trailing slash at the root is the same issuer, but it's more convenient to compare and store
  // it without the slash: RFC 8414 doesn't require it, and servers return it differently.
  const issuer = issuerUrl.endsWith('/') && new URL(issuerUrl).pathname === '/' ? issuerUrl.slice(0, -1) : issuerUrl;

  let asMetadata: AuthorizationServerMetadata | null = null;
  const source: OAuthDiscovery['source'] = usedChallenge ? 'challenge' : 'well-known';
  for (const candidate of metadataUrlsForIssuer(issuer)) {
    const fetched = await requestJson(fetchImpl, candidate, { allowNotFound: true });
    const body = asObject(fetched?.body);
    if (fetched && fetched.status === 200 && body) {
      asMetadata = body as AuthorizationServerMetadata;
      break;
    }
  }
  if (!asMetadata) {
    throw new OAuthError(
      `authorization server ${issuer} не отдал metadata (RFC 8414 / OpenID Discovery). ` +
        'Проверь адрес или задай endpoints вручную.',
    );
  }
  const authorizationEndpoint = optionalString(asMetadata.authorization_endpoint);
  const tokenEndpoint = optionalString(asMetadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OAuthError('в metadata authorization server нет authorization_endpoint или token_endpoint');
  }
  if (asMetadata.code_challenge_methods_supported && !asMetadata.code_challenge_methods_supported.includes('S256')) {
    throw new OAuthError('authorization server не поддерживает PKCE S256 — по OAuth 2.1 так нельзя');
  }

  const scopes = stringList(resourceMetadata.scopes_supported) ?? stringList(asMetadata.scopes_supported);
  return {
    resource: canonicalResource(
      typeof resourceMetadata.resource === 'string'
        ? assertHttpUrl(resourceMetadata.resource, 'resource')
        : serverUrl,
    ),
    resourceMetadataUrl,
    ...(challenge.scope === undefined ? {} : { challengeScope: challenge.scope }),
    protectedResource: resourceMetadata,
    issuer,
    authorizationEndpoint: assertHttpUrl(authorizationEndpoint, 'authorization endpoint'),
    tokenEndpoint: assertHttpUrl(tokenEndpoint, 'token endpoint'),
    ...(asMetadata.registration_endpoint === undefined
      ? {}
      : { registrationEndpoint: assertHttpUrl(asMetadata.registration_endpoint, 'registration endpoint') }),
    ...(scopes === undefined ? {} : { scopesSupported: scopes }),
    ...(asMetadata.code_challenge_methods_supported === undefined
      ? {}
      : { codeChallengeMethodsSupported: asMetadata.code_challenge_methods_supported }),
    ...(asMetadata.token_endpoint_auth_methods_supported === undefined
      ? {}
      : { tokenEndpointAuthMethodsSupported: asMetadata.token_endpoint_auth_methods_supported }),
    clientIdMetadataDocumentSupported: asMetadata.client_id_metadata_document_supported === true,
    source,
  };
}

function chooseMethod(
  supported: string[] | undefined,
  hasSecret: boolean,
  preferred?: ClientAuthMethod,
): ClientAuthMethod {
  // Without a secret the server must not get client_secret_*: otherwise the request goes
  // without the secret but with a method that requires it.
  if (!hasSecret) return 'none';
  if (preferred) return preferred;
  if (supported?.includes('client_secret_post')) return 'client_secret_post';
  if (supported?.includes('client_secret_basic')) return 'client_secret_basic';
  return 'client_secret_post';
}

async function registerClient(
  discovery: OAuthDiscovery,
  redirectUri: string,
  fetchImpl: FetchLike,
  scope: string | undefined,
): Promise<OAuthClient> {
  if (!discovery.registrationEndpoint) throw new OAuthError('сервер не поддерживает динамическую регистрацию клиентов');
  const supported = discovery.tokenEndpointAuthMethodsSupported;
  const requested: ClientAuthMethod =
    supported === undefined || supported.includes('none')
      ? 'none'
      : supported.includes('client_secret_post')
        ? 'client_secret_post'
        : 'client_secret_basic';
  const payload = {
    client_name: 'Icarus',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: requested,
    ...(scope === undefined ? {} : { scope }),
  };
  const response = await fetchImpl(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    ...(timeoutSignal(DISCOVERY_TIMEOUT_MS) === undefined ? {} : { signal: timeoutSignal(DISCOVERY_TIMEOUT_MS) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null;
  try {
    body = asObject(JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  if (!response.ok || !body) {
    const detail = optionalString(body?.error_description) ?? optionalString(body?.error) ?? text.slice(0, 160);
    throw new OAuthError(`динамическая регистрация клиента не удалась: ${detail || response.status}`);
  }
  const clientId = optionalString(body.client_id);
  if (!clientId) throw new OAuthError('сервер зарегистрировал клиента, но не вернул client_id');
  const clientSecret = optionalString(body.client_secret);
  const returned = optionalString(body.token_endpoint_auth_method);
  const method: ClientAuthMethod =
    returned === 'client_secret_basic' || returned === 'client_secret_post' || returned === 'none'
      ? returned
      : requested;
  if (clientSecret) {
    return {
      clientId,
      clientSecret,
      // There is a secret, but the server returned "none" out of habit — we send the secret
      // via post, otherwise it would be silently lost.
      tokenEndpointAuthMethod: method === 'none' ? 'client_secret_post' : method,
      source: 'dcr',
    };
  }
  return { clientId, tokenEndpointAuthMethod: 'none', source: 'dcr' };
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
}

function parseTokenResponse(text: string, status: number, now: number): OAuthTokens {
  let body: Record<string, unknown> | null;
  try {
    body = asObject(JSON.parse(text) as unknown);
  } catch {
    // Some old servers respond with form-urlencoded — this is allowed for the
    // token endpoint, so we try that too.
    try {
      body = Object.fromEntries(new URLSearchParams(text));
    } catch {
      body = null;
    }
  }
  if (status >= 400 || !body) {
    const detail =
      optionalString(body?.error_description) ??
      optionalString(body?.error) ??
      text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new OAuthError(`authorization server отказал в токене: ${detail || status}`, optionalString(body?.error));
  }
  const accessToken = optionalString(body.access_token);
  if (!accessToken) throw new OAuthError('authorization server не вернул access_token');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    accessToken,
    ...(optionalString(body.refresh_token) === undefined ? {} : { refreshToken: optionalString(body.refresh_token) }),
    ...(optionalString(body.token_type) === undefined ? {} : { tokenType: optionalString(body.token_type) }),
    ...(optionalString(body.scope) === undefined ? {} : { scope: optionalString(body.scope) }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    raw: body,
  };
}

async function tokenRequest(options: {
  fetchImpl: FetchLike;
  tokenEndpoint: string;
  body: Record<string, string>;
  client: OAuthClient;
  now: number;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams(options.body);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  body.set('client_id', options.client.clientId);
  if (options.client.tokenEndpointAuthMethod === 'client_secret_basic' && options.client.clientSecret) {
    headers.authorization = basicAuth(options.client.clientId, options.client.clientSecret);
  } else if (options.client.tokenEndpointAuthMethod === 'client_secret_post' && options.client.clientSecret) {
    body.set('client_secret', options.client.clientSecret);
  }
  const response = await options.fetchImpl(options.tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
    ...(timeoutSignal(TOKEN_TIMEOUT_MS) === undefined ? {} : { signal: timeoutSignal(TOKEN_TIMEOUT_MS) }),
  });
  const text = await response.text();
  return parseTokenResponse(text, response.status, options.now);
}

export type StartedAuthorization = {
  url: string;
  state: string;
  discovery: OAuthDiscovery;
  client: OAuthClient;
  /** The redirect address that went into authorize: the panel shows it to the person. */
  redirectUri: string;
  /** The login goes through a dead loopback address and requires pasting the address manually. */
  mimic: boolean;
};

/**
 * Starts authorization and returns the address to which the browser must be taken.
 * Everything needed to exchange the code stays in the service's memory until the callback.
 */
export async function startAuthorization(options: {
  server: UserMcpServer;
  userId: string;
  publicUrl: string;
  credentials?: McpCredentials;
  fetchImpl?: FetchLike;
  now?: number;
  random?: (size: number) => Buffer;
}): Promise<StartedAuthorization> {
  if (options.server.auth !== 'oauth') throw new OAuthError('этот MCP не настроен на OAuth');
  if (!options.server.url) throw new OAuthError('у OAuth-сервера нет адреса');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = nowOr(options.now);
  const stored = options.credentials?.oauth;
  const discovery =
    discoveryFromManual(options.server) ??
    (stored ? discoveryFromStored(options.server, stored) : null) ??
    (await discoverOAuth({
      serverUrl: options.server.url,
      headers: options.credentials?.headers,
      server: options.server,
      ...(stored === undefined ? {} : { stored }),
      fetchImpl,
    }));

  const mimic = options.server.mimic === true;
  const redirectUri = mimic ? mimicCallbackUrl() : callbackUrl(options.publicUrl);
  const scopes =
    options.server.scopes?.trim() ||
    discovery.challengeScope ||
    discovery.scopesSupported?.join(' ') ||
    stored?.scope ||
    undefined;

  let client: OAuthClient;
  if (options.server.clientId) {
    client = {
      clientId: options.server.clientId,
      ...(stored?.clientSecret === undefined ? {} : { clientSecret: stored.clientSecret }),
      tokenEndpointAuthMethod: chooseMethod(
        discovery.tokenEndpointAuthMethodsSupported,
        stored?.clientSecret !== undefined,
        stored?.tokenEndpointAuthMethod,
      ),
      source: 'preregistered',
    };
  } else if (
    stored?.clientId &&
    stored.tokenEndpoint !== undefined &&
    // Registration is tied to redirect_uri: with a different address authorize will reject
    // the client_id, so when the client mode changes we register again.
    (stored.redirectUri ?? callbackUrl(options.publicUrl)) === redirectUri
  ) {
    const isCimd = stored.clientId === clientMetadataUrl(options.publicUrl);
    client = {
      clientId: stored.clientId,
      ...(stored.clientSecret === undefined ? {} : { clientSecret: stored.clientSecret }),
      tokenEndpointAuthMethod: stored.tokenEndpointAuthMethod ?? 'none',
      source: isCimd ? 'cimd' : 'dcr',
    };
  } else if (discovery.registrationEndpoint) {
    client = await registerClient(discovery, redirectUri, fetchImpl, scopes);
  } else if (discovery.clientIdMetadataDocumentSupported && options.publicUrl.startsWith('https://')) {
    client = {
      clientId: clientMetadataUrl(options.publicUrl),
      tokenEndpointAuthMethod: 'none',
      source: 'cimd',
    };
  } else {
    throw new OAuthError(
      'сервер не умеет регистрировать клиентов (нет registration_endpoint и CIMD). ' +
        'Зарегистрируй клиента вручную и укажи client_id в настройках MCP.',
    );
  }

  if (mimic && client.source === 'cimd') {
    // Our CIMD document is single and declares a public callback: the authorization server
    // won't accept loopback with it, and the person would get an unclear rejection.
    throw new OAuthError(
      'мимикрия требует динамической регистрации клиента, а этот сервер умеет только CIMD: ' +
        'документ объявляет публичный callback. Сними галочку или укажи client_id, ' +
        `зарегистрированный на ${mimicCallbackUrl()}`,
    );
  }

  const random = options.random ?? ((size: number) => randomBytes(size));
  const verifier = base64url(random(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(random(32));
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (scopes) url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // RFC 8707: the token must be issued for this exact resource. MCP requires
  // sending the parameter always, even if the server doesn't understand it yet.
  url.searchParams.set('resource', discovery.resource);

  prunePending(now);
  pending.set(state, {
    state,
    userId: options.userId,
    serverId: options.server.id,
    redirectUri,
    verifier,
    createdAt: now,
    resource: discovery.resource,
    discovery,
    client,
    ...(scopes === undefined ? {} : { scopes }),
  });

  return { url: url.toString(), state, discovery, client, redirectUri, mimic };
}

export type CompletedAuthorization = {
  userId: string;
  serverId: string;
  redirectUri: string;
  discovery: OAuthDiscovery;
  client: OAuthClient;
  tokens: OAuthTokens;
  resource: string;
  scope?: string;
};

/** Completes the flow: verifies state, exchanges the code, and returns the tokens. */
export async function completeAuthorization(options: {
  state: string;
  code: string;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<CompletedAuthorization> {
  const now = nowOr(options.now);
  const item = pending.get(options.state);
  if (!item) throw new OAuthError('ссылка авторизации устарела или уже использована — начни заново');
  pending.delete(options.state);
  if (now - item.createdAt > PENDING_TTL_MS) {
    throw new OAuthError('ссылка авторизации истекла — начни заново');
  }
  if (!options.code.trim()) throw new OAuthError('authorization server не вернул код');

  const tokens = await tokenRequest({
    fetchImpl: options.fetchImpl ?? fetch,
    tokenEndpoint: item.discovery.tokenEndpoint,
    body: {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: item.redirectUri,
      code_verifier: item.verifier,
      resource: item.resource,
    },
    client: item.client,
    now,
  });

  return {
    userId: item.userId,
    serverId: item.serverId,
    redirectUri: item.redirectUri,
    discovery: item.discovery,
    client: item.client,
    tokens,
    resource: item.resource,
    ...(tokens.scope === undefined ? (item.scopes === undefined ? {} : { scope: item.scopes }) : { scope: tokens.scope }),
  };
}

/** Token refresh. Returns the record to be merged with the previous data. */
export async function refreshAuthorization(options: {
  oauth: McpOAuthCredentials;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<McpOAuthCredentials> {
  const oauth = options.oauth;
  if (!oauth.refreshToken) throw new OAuthError('нет refresh_token — нужна повторная авторизация');
  if (!oauth.tokenEndpoint) throw new OAuthError('не знаю token endpoint — нужна повторная авторизация');
  if (!oauth.clientId) throw new OAuthError('не знаю client_id — нужна повторная авторизация');
  const now = nowOr(options.now);
  const tokens = await tokenRequest({
    fetchImpl: options.fetchImpl ?? fetch,
    tokenEndpoint: oauth.tokenEndpoint,
    body: {
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      ...(oauth.resource === undefined ? {} : { resource: oauth.resource }),
    },
    client: {
      clientId: oauth.clientId,
      ...(oauth.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }),
      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod ?? 'none',
      source: 'dcr',
    },
    now,
  });
  return {
    ...oauth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? oauth.refreshToken,
    ...(tokens.tokenType === undefined ? {} : { tokenType: tokens.tokenType }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    // We always set expiresAt: if the new token came without expires_in, the old
    // deadline from the previous token no longer applies. Otherwise a fresh token would look
    // expired and wouldn't make it into mcp.json.
    expiresAt: tokens.expiresAt,
    authorizedAt: new Date(now).toISOString(),
    error: undefined,
  };
}

/** Everything that must be put into credentials.json after the code exchange. */
export function credentialsFromCompleted(completed: CompletedAuthorization): McpOAuthCredentials {
  return {
    accessToken: completed.tokens.accessToken,
    ...(completed.tokens.refreshToken === undefined ? {} : { refreshToken: completed.tokens.refreshToken }),
    ...(completed.tokens.tokenType === undefined ? {} : { tokenType: completed.tokens.tokenType }),
    ...(completed.scope === undefined ? {} : { scope: completed.scope }),
    ...(completed.tokens.expiresAt === undefined ? {} : { expiresAt: completed.tokens.expiresAt }),
    issuer: completed.discovery.issuer,
    authorizationEndpoint: completed.discovery.authorizationEndpoint,
    tokenEndpoint: completed.discovery.tokenEndpoint,
    // An empty value here means "erase the previous one": the record is merged with the
    // already saved one, and a server without a registration_endpoint must not inherit
    // the endpoint from a previous registration.
    registrationEndpoint: completed.discovery.registrationEndpoint,
    resource: completed.resource,
    clientId: completed.client.clientId,
    // We set the secret and error explicitly: a new client_id could come without a secret, and
    // the old one must not stick to it.
    clientSecret: completed.client.clientSecret,
    tokenEndpointAuthMethod: completed.client.tokenEndpointAuthMethod,
    // The client is registered with this address: the next authorize must repeat
    // the same one, otherwise the server will reject the client_id.
    redirectUri: completed.redirectUri,
    error: undefined,
    // This key is what pi will use to reach the local proxy, and the service will substitute
    // a fresh Bearer. The token itself doesn't go into mcp.json.
    proxyKey: base64url(randomBytes(24)),
    authorizedAt: new Date().toISOString(),
  };
}

/** Whether the token is good right now: with a half-minute margin so it doesn't expire at the finish line. */
export function tokenIsFresh(oauth: McpOAuthCredentials | undefined, now = Date.now()): boolean {
  if (!oauth?.accessToken) return false;
  return oauth.expiresAt === undefined || oauth.expiresAt > now + 30_000;
}
