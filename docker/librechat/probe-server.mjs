// Эхо-стенд: принимает запросы LibreChat, пишет их целиком в JSONL и отвечает
// как OpenAI-совместимый сервер. Модель не вызывается — проверяем стык.
//
// Режимы:
//   model = "echo-probe"  — обычный быстрый ответ
//   model = "echo-slow"   — длинный медленный стрим (для проверки отмены)
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PROBE_PORT || 4099);
const LOG = process.env.PROBE_LOG || '/home/trousev/src/icarus/docker/librechat/probe-log.jsonl';

let seq = 0;
function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }

    const id = ++seq;
    log({ type: 'request', id, method: req.method, url: req.url, headers: req.headers, body });

    // Обрыв соединения клиентом — то, что увидит icarus при отмене в LibreChat.
    res.on('close', () => {
      log({ type: 'connection_closed', id, path: req.url, writableEnded: res.writableEnded });
    });

    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'echo-probe', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'probe' }],
      }));
      return;
    }

    if (req.url.includes('/chat/completions')) {
      const slow =
        body?.model === 'echo-slow' ||
        JSON.stringify(body?.messages ?? '').includes('SLOWPROBE');
      const reply = slow
        ? 'Это медленный поток, который нужен чтобы проверить отмену. '.repeat(20)
        : 'Запрос получен. Это эхо-стенд, реальная модель не вызывалась.';
      const base = {
        id: 'chatcmpl-probe',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'echo-probe',
      };

      if (body?.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const words = reply.split(' ');
      const delay = slow ? 400 : 25;
      let i = 0;
      log({ type: 'stream_start', id, words: words.length, delayMs: delay });
      const timer = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }],
          })}\n\n`);
          i += 1;
        } else {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          log({ type: 'stream_done', id });
        }
      }, delay);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'probe: unknown route', path: req.url } }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`probe listening on 0.0.0.0:${PORT}`);
  console.log(`log: ${LOG}`);
});
