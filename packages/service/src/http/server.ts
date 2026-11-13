// icarus HTTP server: three routes and nothing extra.
import http from 'node:http';
import { log, redact } from '../log.ts';
import { findUser, type IcarusConfig, type UserConfig } from '../config.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { ChatRecord } from '../sessions/chats.ts';
import { errorBody } from './sse.ts';
import { handleChatCompletions, headerValue } from './openai.ts';
import { handlePanel } from '../control/index.ts';
import { skillDraftPrompt, SKILL_DRAFT_SYSTEM, SKILL_DRAFT_TIMEOUT_MS } from '../control/skill-draft.ts';
import { listManaged } from '../docker/manager.ts';
import { planReconciliation } from '../docker/reconcile.ts';
import { handleMcpProxy } from '../mcp/proxy.ts';
import { handlePublicArtifact } from '../control/artifacts.ts';
import { handleFetch, handleSearch, type SearchHttpOptions } from '../search/http.ts';

export const PUBLIC_MODEL_ID = 'icarus';

export type ServerOptions = {
  /**
   * Whether there is anyone to write a skill in the panel. By default — yes, if the
   * registry can do one-off questions at all: the local panel (script/panel) comes up
   * without a model container and says so directly, rather than with a decoy button.
   */
  draftSkills?: boolean;
  /**
   * Search and page extraction routers: in tests fetch and the clock are substituted
   * here, in prod — nothing: the global fetch and system time are used.
   */
  search?: SearchHttpOptions;
  /**
   * Take the conversation out of Telegram: the panel calls this when archiving a
   * Telegram conversation so the topic is deleted together with the messages (see
   * archiveChat). Not passed — the panel is up without a bot and just moves the mark
   * in the registry.
   */
  archiveTelegram?: (user: UserConfig, chat: ChatRecord) => Promise<void>;
};

export function createServer(
  config: IcarusConfig,
  registry: SessionRegistry,
  options: ServerOptions = {},
): http.Server {
  const draftSkills = options.draftSkills ?? typeof registry.oneShot === 'function';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // OAuth-MCP: pi goes here instead of the real server, and the service substitutes
    // a fresh Bearer on every request. The key is random and lives in mcp.json.
    if (url.pathname.startsWith('/mcp-proxy/')) {
      try {
        await handleMcpProxy(req, res, url, config);
      } catch (error) {
        log.error('ошибка прокси MCP', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('прокси MCP сломался', 'server_error')));
        }
      }
      return;
    }

    // Public artifacts: anyone who has the link can open it, so the route comes
    // before the panel and requires no SSO header. The secret is a random publicId in
    // the address, not a cookie: see artifacts.ts.
    if (url.pathname === '/a' || url.pathname.startsWith('/a/')) {
      try {
        if (await handlePublicArtifact(req, res, url, config)) return;
      } catch (error) {
        log.error('ошибка публичного артефакта', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('публичный артефакт сломался', 'server_error')));
        }
        return;
      }
    }

    // The control panel — the thing a person opens this port for at all: in prod the
    // whole domain points here, and the root leads into the panel, not to the service's 404.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(302, { location: '/panel' });
      res.end();
      return;
    }

    if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) {
      try {
        // The panel's registry is needed for three things. The chat sends replies into the
        // same pi sessions as Telegram. A skill saved in the panel must reach a live
        // conversation: a pi session holds the skills directory from the very start,
        // so the panel marks resources as updated — and the next turn brings pi up again
        // (see bumpResources in control/index.ts). And the “write it for me” button asks
        // the model one-off — in the same place where the keys and pi live.
        const ctx = {
          config,
          registry,
          bump: (user: string) => void registry.bumpResources(user),
          ...(options.archiveTelegram ? { archiveTelegram: options.archiveTelegram } : {}),
          ...(draftSkills
            ? {
                draft: (userId: string, idea: string) => {
                  const person = findUser(config, userId);
                  if (!person) throw new Error(`человек ${userId} не заведён`);
                  return registry.oneShot(person, skillDraftPrompt(idea), {
                    tier: 'strong',
                    systemPrompt: SKILL_DRAFT_SYSTEM,
                    timeoutMs: SKILL_DRAFT_TIMEOUT_MS,
                  });
                },
              }
            : {}),
        };
        if (await handlePanel(req, res, url, ctx)) return;
      } catch (error) {
        log.error('ошибка панели управления', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('панель сломалась', 'server_error')));
        }
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      // Containers are part of the service's state, not something off-screen: we show
      // their state and discrepancies with the config right here.
      let containers: Record<string, number> = { managed: 0 };
      try {
        const managed = await listManaged(config);
        const plan = planReconciliation({ config, users: config.users, containers: managed });
        containers = {
          managed: managed.length,
          running: managed.filter((container) => container.running).length,
          stale: plan.recreate.length,
          orphaned: plan.stop.length,
          missing: plan.create.length,
        };
      } catch (error) {
        log.warn('не удалось собрать состояние контейнеров', { error: redact(String(error)) });
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          // Code fingerprint from compose: it shows whether the same code is running in
          // the container. Without this “deploy is green, but the stand runs old code”
          // can't be told apart from normal.
          revision: process.env.ICARUS_REVISION ?? null,
          sessions: registry.list(),
          users: config.users.map((user) => user.id),
          containers,
        }),
      );
      return;
    }

    // Search router: one entry point for all providers. Keys, quarantines and choosing
    // the live one are inside; the caller only needs the service token and q.
    if (url.pathname === '/search') {
      try {
        await handleSearch(req, res, url, config, options.search ?? {});
      } catch (error) {
        log.error('маршрут поиска упал', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('поиск сломался', 'server_error')));
        } else {
          res.end();
        }
      }
      return;
    }

    // Page extraction: the same entry point, but its own “current” provider and its own
    // quarantines. Lives next to /search so the client needs just one address.
    if (url.pathname === '/fetch') {
      try {
        await handleFetch(req, res, url, config, options.search ?? {});
      } catch (error) {
        log.error('маршрут извлечения упал', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('извлечение сломалось', 'server_error')));
        } else {
          res.end();
        }
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (headerValue(req, 'authorization') !== `Bearer ${config.apiKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorBody('неверный токен', 'authentication_error')));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: PUBLIC_MODEL_ID,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'icarus',
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        await handleChatCompletions(req, res, { config, registry });
      } catch (error) {
        log.error('необработанная ошибка маршрута', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('внутренняя ошибка', 'server_error')));
        } else {
          res.end();
        }
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`неизвестный маршрут ${req.method} ${url.pathname}`)));
  });

  return server;
}
