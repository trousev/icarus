// HTTP-сервер icarus: три маршрута и ничего лишнего.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log, redact } from '../log.ts';
import { userPaths, type IcarusConfig } from '../config.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { errorBody } from './sse.ts';
import { handleChatCompletions, headerValue } from './openai.ts';
import { handlePanel } from '../panel/api.ts';
import { listManaged } from '../docker/manager.ts';
import { planReconciliation } from '../docker/reconcile.ts';

export const PUBLIC_MODEL_ID = 'icarus';

export function createServer(config: IcarusConfig, registry: SessionRegistry, panelSecret: string): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/panel' || url.pathname.startsWith('/panel/')) {
      try {
        if (await handlePanel(req, res, url, { config, panelSecret })) return;
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
      // Контейнеры — часть состояния сервиса, а не что-то за кадром: показываем их
      // состояние и расхождения с конфигом прямо здесь.
      let containers: Record<string, number> = { managed: 0 };
      try {
        const managed = await listManaged(config);
        const plan = planReconciliation({ config, users: config.users, containers: managed, panelSecret });
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

    // Графики Maple. Мост pi изображения не пропускает, поэтому MCP кладёт файл
    // в каталог математики человека и возвращает markdown-ссылку сюда: так картинка
    // доезжает до чата. Имя файла — 16 случайных hex, угадать путь нельзя.
    // Старый каталог в pi-agent проверяем вторым: расчёты, не пережившие переезд,
    // должны открываться, пока их не перенесли.
    if (req.method === 'GET' && url.pathname.startsWith('/maple/')) {
      const name = decodeURIComponent(url.pathname.slice('/maple/'.length));
      if (!/^[a-f0-9]{16}\.(gif|jpe?g|bmp)$/i.test(name)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorBody('нет такого графика', 'not_found')));
        return;
      }
      for (const user of config.users) {
        const paths = userPaths(config, user);
        const candidates = [
          path.join(paths.maple, name),
          path.join(paths.piAgent, 'maple-mcp', 'plots', name),
        ];
        const file = candidates.find((candidate) => fs.existsSync(candidate));
        if (!file) continue;
        const ext = path.extname(file).toLowerCase();
        const type =
          ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : ext === '.png' ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody('график не найден', 'not_found')));
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
