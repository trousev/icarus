// HTTP-сервер icarus: три маршрута и ничего лишнего.
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
   * Есть ли кому написать скилл в панели. По умолчанию — да, если реестр вообще
   * умеет разовый вопрос: локальная панель (script/panel) поднимается без
   * контейнера с моделью и говорит об этом прямо, а не кнопкой-обманкой.
   */
  draftSkills?: boolean;
  /**
   * Роутеры поиска и извлечения страниц: в тестах сюда подставляют fetch и часы,
   * в бою — ничего: возьмут глобальный fetch и системное время.
   */
  search?: SearchHttpOptions;
  /**
   * Вынести разговор из Telegram: панель зовёт при архивации Telegram-разговора,
   * чтобы топик удалился вместе с сообщениями (см. archiveChat). Не передан —
   * панель поднята без бота и просто двигает отметку в реестре.
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

    // OAuth-MCP: pi ходит сюда вместо настоящего сервера, а сервис подставляет
    // свежий Bearer на каждом запросе. Ключ случаен и лежит в mcp.json.
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

    // Публичные артефакты: ссылку открывает любой, у кого она есть, поэтому
    // маршрут стоит до панели и не требует заголовка SSO. Секрет — случайный
    // publicId в адресе, а не кука: см. artifacts.ts.
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

    // Панель управления — то, ради чего человек вообще открывает этот порт: на проде
    // весь домен смотрит сюда, и корень уводит в панель, а не в 404 сервиса.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(302, { location: '/panel' });
      res.end();
      return;
    }

    if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) {
      try {
        // Реестр панели нужен для трёх вещей. Чат отправляет реплики в те же
        // сессии pi, что и Telegram. Скилл, сохранённый в панели, должен доехать
        // до живого разговора: сессия pi держит каталог скиллов с самого старта,
        // поэтому панель отмечает обновление ресурсов — и следующий ход поднимает
        // pi заново (см. bumpResources в control/index.ts). А кнопка «напиши за
        // меня» просит модель разово — там же, где живут ключи и pi.
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
      // Контейнеры — часть состояния сервиса, а не что-то за кадром: показываем их
      // состояние и расхождения с конфигом прямо здесь.
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
          // Отпечаток кода из compose: по нему видно, тот ли код работает в контейнере.
          // Без этого «деплой зелёный, а на стенде старый код» не отличить от нормы.
          revision: process.env.ICARUS_REVISION ?? null,
          sessions: registry.list(),
          users: config.users.map((user) => user.id),
          containers,
        }),
      );
      return;
    }

    // Поисковый роутер: один вход для всех провайдеров. Ключи, карантины и выбор
    // живого — внутри; вызывающему достаточно токена сервиса и q.
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

    // Извлечение страниц: тот же вход, но свой «текущий» провайдер и свои
    // карантины. Живёт рядом с /search, чтобы клиенту хватало одного адреса.
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
