// Обновление OAuth-токенов перед стартом сессии.
//
// pi читает mcp.json один раз при запуске и сам токены не обновляет: сервис
// передаёт ему уже готовый `Authorization: Bearer`. Значит, обновлять должен тот,
// кто пишет mcp.json, — и делать это до того, как pi поднялся, а не после 401.
//
// Обновление последовательное и с single-flight на пару «человек + сервер»:
// параллельные записи в credentials.json затирали бы друг друга, а два хода в
// один сервер не должны обновлять один и тот же токен дважды.
import type { IcarusConfig, UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import {
  oauthNeedsRefresh,
  readStore,
  saveOAuthCredentials,
  viewOf,
  type McpOAuthCredentials,
} from './registry.ts';
import { refreshAuthorization, type FetchLike } from './oauth.ts';

const inflight = new Map<string, Promise<unknown>>();

export type RefreshOptions = {
  fetchImpl?: FetchLike;
  now?: number;
};

export type FreshTokenOptions = RefreshOptions & {
  /** За сколько до истечения обновлять. */
  marginMs?: number;
  /** Обновить даже свежий токен — после 401 от сервера. */
  force?: boolean;
};

/**
 * Токен для одного запроса через локальный прокси.
 *
 * В отличие от refreshUserMcpTokens это происходит не «перед сессией», а на
 * каждом HTTP-запросе pi к MCP: пятиминутный токен Black Forest обновляется
 * молча, и живой разговор не упирается в invalid_token.
 */
export async function freshOAuthForServer(
  config: IcarusConfig,
  userId: string,
  serverId: string,
  options: FreshTokenOptions = {},
): Promise<McpOAuthCredentials> {
  const store = readStore(config);
  const server = store.servers[serverId];
  if (!server || server.auth !== 'oauth') throw new Error('это не OAuth-MCP');
  if (server.owner !== userId && !server.shared) throw new Error('MCP не расшарен этому человеку');
  const oauth = store.credentials[userId]?.[serverId]?.oauth;
  if (!oauth) throw new Error('OAuth-доступ не настроен');

  const now = options.now ?? Date.now();
  const margin = options.marginMs ?? 60_000;
  const fresh = Boolean(oauth.accessToken) && (oauth.expiresAt === undefined || oauth.expiresAt > now + margin);
  if (!options.force && fresh) return oauth;
  if (!oauth.refreshToken) {
    throw new Error('OAuth-токен истёк, а refresh_token нет — нужна повторная авторизация');
  }

  const key = `${userId}:${serverId}`;
  const pending = inflight.get(key);
  if (pending) {
    await pending;
    const next = readStore(config).credentials[userId]?.[serverId]?.oauth;
    if (next) return next;
    throw new Error('OAuth-токен не обновился');
  }

  const task = (async () => {
    try {
      const next = await refreshAuthorization({ oauth, fetchImpl: options.fetchImpl, now });
      saveOAuthCredentials(config, userId, serverId, next);
      log.info('MCP: токен обновлён по запросу прокси', { user: userId, server: serverId });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      saveOAuthCredentials(config, userId, serverId, { error: message });
      log.warn('MCP: не удалось обновить токен для прокси', {
        user: userId,
        server: serverId,
        error: redact(message),
      });
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return await task;
}

/**
 * Обновляет просроченные токены всех включённых серверов человека. Ошибку одного
 * сервера не выдаём наружу: остальные серверы и разговор важнее. Причина ложится
 * в credentials.json (`error`) и видна в панели.
 */
export async function refreshUserMcpTokens(
  config: IcarusConfig,
  user: UserConfig,
  options: RefreshOptions = {},
): Promise<{ refreshed: string[]; failed: string[] }> {
  let store;
  try {
    store = readStore(config);
  } catch (error) {
    // Сломанный registry не должен лишать человека разговора: prepareUser ниже
    // откатится на общие серверы config.yaml.
    log.warn('MCP: не читается хранилище, обновлять нечего', { user: user.id, error: String(error) });
    return { refreshed: [], failed: [] };
  }

  const now = options.now ?? Date.now();
  const targets = Object.values(store.servers).filter((server) => {
    if (server.owner !== user.id && !server.shared) return false;
    const view = viewOf(config, store, user.id, server.id, now);
    return Boolean(view && view.enabled && server.auth === 'oauth');
  });

  const refreshed: string[] = [];
  const failed: string[] = [];
  for (const server of targets) {
    const oauth = store.credentials[user.id]?.[server.id]?.oauth;
    if (!oauthNeedsRefresh(oauth, now) || !oauth) continue;
    const key = `${user.id}:${server.id}`;
    if (inflight.has(key)) {
      await inflight.get(key);
      continue;
    }
    const task = (async () => {
      try {
        const next = await refreshAuthorization({ oauth, fetchImpl: options.fetchImpl, now });
        saveOAuthCredentials(config, user.id, server.id, next);
        refreshed.push(server.id);
        log.info('MCP: токен обновлён', { user: user.id, server: server.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        saveOAuthCredentials(config, user.id, server.id, { error: message });
        failed.push(server.id);
        log.warn('MCP: не удалось обновить токен', { user: user.id, server: server.id, error: redact(message) });
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    await task;
  }
  return { refreshed, failed };
}
