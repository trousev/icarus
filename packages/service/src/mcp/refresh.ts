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
} from './registry.ts';
import { refreshAuthorization, type FetchLike } from './oauth.ts';

const inflight = new Map<string, Promise<void>>();

export type RefreshOptions = {
  fetchImpl?: FetchLike;
  now?: number;
};

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
