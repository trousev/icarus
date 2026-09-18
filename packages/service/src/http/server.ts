// HTTP-сервер icarus: три маршрута и ничего лишнего.
import http from 'node:http';
import { log, redact } from '../log.ts';
import type { IcarusConfig } from '../config.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { errorBody } from './sse.ts';
import { handleChatCompletions, headerValue } from './openai.ts';
import { handlePanel } from '../panel/api.ts';

export const PUBLIC_MODEL_ID = 'icarus';

export function createServer(config: IcarusConfig, registry: SessionRegistry): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) {
      try {
        if (await handlePanel(req, res, url, { config })) return;
      } catch (error) {
        log.error('ошибка панели памяти', { error: redact(String(error)) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('панель сломалась', 'server_error')));
        }
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          sessions: registry.list(),
          users: config.users.map((user) => user.id),
        }),
      );
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
