// Главный маршрут: LibreChat присылает историю разговора, мы превращаем её
// в реплику для живой сессии pi и обратно — в поток формата OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { log, redact } from '../log.ts';
import { findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { compareHistory, normalizeContent, type IncomingMessage as ChatMessage } from '../sessions/divergence.ts';
import { phraseForToolEnd, phraseForToolStart } from '../reasoning.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { chunk, completion, completionId, DONE, errorBody, usageChunk, type Usage } from './sse.ts';
import {
  buildTitlePrompt,
  cleanModelTitle,
  conversationFromTitlePrompt,
  isTitleRequest,
  titleFromPrompt,
  TITLE_MODEL_ID,
} from './title.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Сколько ждём дешёвую модель на заголовок; дальше отвечаем эвристикой. */
const TITLE_TIMEOUT_MS = 12_000;

const ZERO_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * Заголовок разговора: LibreChat зовёт модель отдельным запросом, и в живую сессию
 * pi мы его не пускаем — иначе это лишний агентский прогон и гонка с основным ходом.
 *
 * Заголовок просим у дешёвой модели разовым вопросом в контейнере человека; на любом
 * сбое (нет пользователя, таймаут, пустой ответ) молча отдаём эвристику — заголовок
 * не то, ради чего стоит задерживать или ломать ответ.
 */
async function respondTitle(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  messages: ChatMessage[],
  ctx: ChatContext,
): Promise<void> {
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  const prompt = normalizeContent(lastUser?.content);
  const fallback = titleFromPrompt(prompt);
  let title = fallback;
  let source = 'эвристика';

  const user = findUser(ctx.config, resolveIdentity(req, body, messages).userId);
  if (user) {
    const controller = new AbortController();
    // Клиент ушёл (в LibreChat нажали «стоп») — незачем держать вызов модели.
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      const asked = await ctx.registry.oneShot(user, buildTitlePrompt(conversationFromTitlePrompt(prompt)), {
        timeoutMs: TITLE_TIMEOUT_MS,
        signal: controller.signal,
      });
      const cleaned = cleanModelTitle(asked);
      if (cleaned) {
        title = cleaned;
        source = 'модель';
      } else {
        log.warn('модель вернула пустой заголовок — оставляю эвристику', { user: user.id });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        log.debug('заголовок отменён вместе с ходом', { user: user.id });
      } else {
        log.warn('заголовок от модели не вышел — оставляю эвристику', {
          user: user.id,
          error: redact(String(error)),
        });
      }
    } finally {
      res.off('close', onClose);
    }
  }

  const model = typeof body.model === 'string' ? body.model : TITLE_MODEL_ID;
  const id = completionId();

  log.info('заголовок разговора', { title, source, user: user?.id ?? 'неизвестный' });

  // Клиент уже ушёл — писать некуда, и это не ошибка.
  if (res.writableEnded || res.destroyed) return;

  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(id, model, title, ZERO_USAGE)));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(chunk(id, model, { role: 'assistant', content: '' }));
  res.write(chunk(id, model, { content: title }));
  res.write(chunk(id, model, {}, 'stop'));
  res.write(DONE);
  res.end();
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('тело запроса слишком большое');
    chunks.push(part as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text && text.trim() !== '' ? text.trim() : undefined;
}

/** Кто говорит и о каком разговоре: заголовки LibreChat, иначе фолбэки. */
export function resolveIdentity(
  req: IncomingMessage,
  body: Record<string, unknown>,
  messages: ChatMessage[],
): { userId: string; conversationId: string } {
  const userId =
    headerValue(req, 'x-icarus-user-id') ??
    (typeof body.user === 'string' ? body.user : undefined) ??
    'unknown';

  const explicit = headerValue(req, 'x-icarus-conversation-id');
  const conversationId =
    explicit ??
    (typeof body.conversation_id === 'string' ? body.conversation_id : undefined) ??
    createHash('sha1')
      .update(messages.map((message) => normalizeContent(message.content)).join('\u0000'))
      .digest('hex')
      .slice(0, 32);

  return { userId, conversationId };
}

export type Attachments = { text: string; files: string[]; images: Array<{ data: string; mimeType: string }> };

/** Достаём текст последней реплики, раскладываем вложения в incoming/ и готовим картинки для модели. */
export function extractLatestUserMessage(
  messages: ChatMessage[],
  incomingDir: string,
): Attachments {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return { text: '', files: [], images: [] };

  const content = lastUser.content;
  if (typeof content === 'string') return { text: content, files: [], images: [] };

  const texts: string[] = [];
  const files: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];

  for (const part of content ?? []) {
    if (part?.type === 'text' && part.text) {
      texts.push(part.text);
      continue;
    }
    if (part?.type === 'image_url') {
      const url = (part as { image_url?: { url?: string } }).image_url?.url ?? '';
      const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (!match) continue;
      const [, mime, base64] = match;
      // Картинку отдаём модели нативно, чтобы она её видела, а не только путь к файлу.
      images.push({ data: base64, mimeType: mime });
      const extension = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      try {
        fs.mkdirSync(incomingDir, { recursive: true });
        fs.writeFileSync(path.join(incomingDir, name), Buffer.from(base64, 'base64'));
        files.push(`/workspace/incoming/${name}`);
      } catch (error) {
        log.warn('вложение не сохранилось', { error: String(error) });
      }
    }
  }

  return { text: texts.join('\n').trim(), files, images };
}

export function buildPrompt(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((file) => `- ${file}`).join('\n');
  return `${text}\n\n[Пользователь приложил файлы, они уже лежат на диске:\n${list}]`;
}

function appendDivergence(config: IcarusConfig, userId: string, conversationId: string, body: string): void {
  const dir = path.join(config.dataDir, 'logs', 'divergence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${userId}-${conversationId.slice(0, 12)}.log`);
  fs.appendFileSync(file, `\n=== ${new Date().toISOString()} ===\n${body}\n`);
}

function usageFromStats(stats: Record<string, unknown> | null): Usage {
  const tokens = (stats?.tokens ?? {}) as Record<string, number>;
  const input = Number(tokens.input ?? 0);
  const output = Number(tokens.output ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(tokens.total ?? input + output),
  };
}

export type ChatContext = { config: IcarusConfig; registry: SessionRegistry };

export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatContext,
): Promise<void> {
  const { config, registry } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`не разобрал тело запроса: ${String(error)}`)));
    return;
  }

  const expected = `Bearer ${config.apiKey}`;
  if (headerValue(req, 'authorization') !== expected) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody('неверный токен', 'authentication_error')));
    return;
  }

  const messages = (body.messages ?? []) as ChatMessage[];

  // Заголовок разговора отвечаем до всякой сессии: это не ход Икара.
  if (isTitleRequest(body.model, messages)) {
    await respondTitle(req, res, body, messages, { config, registry });
    return;
  }

  const { userId, conversationId } = resolveIdentity(req, body, messages);
  const user: UserConfig | undefined = findUser(config, userId);
  if (!user) {
    log.warn('запрос от неизвестного пользователя', { userId });
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`пользователь ${userId} не заведён в конфиге`, 'permission_error')));
    return;
  }

  const paths = userPaths(config, user);
  const { text, files, images } = extractLatestUserMessage(messages, paths.incoming);
  if (!text && files.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody('пустая реплика')));
    return;
  }

  const model = typeof body.model === 'string' ? body.model : 'icarus';
  const stream = body.stream !== false;
  const id = completionId();

  let session: PiSession;
  try {
    session = await registry.acquire(user, conversationId);
  } catch (error) {
    log.error('не удалось поднять сессию', { userId, error: String(error) });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`сессия недоступна: ${String(error)}`, 'server_error')));
    return;
  }

  if (session.busy) {
    log.warn('ход уже идёт, отклоняю', { userId, conversation: conversationId.slice(0, 8) });
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody('в этом разговоре уже идёт ответ', 'conflict_error')));
    return;
  }

  // Сверка истории: сессия pi — истина, расхождение только логируем.
  try {
    const known = await session.getMessages();
    const comparison = compareHistory(messages, known as Array<{ role?: string; content?: unknown }>);
    if (comparison.diverged) {
      appendDivergence(
        config,
        user.id,
        conversationId,
        `причина: ${comparison.reason}\n${comparison.diff}\nпришло реплик: ${messages.length}, в сессии: ${known.length}`,
      );
      log.warn('история разошлась, продолжаю свою сессию', {
        user: user.id,
        conversation: conversationId.slice(0, 8),
        reason: comparison.reason,
      });
    }
  } catch (error) {
    log.debug('не удалось сверить историю', { error: String(error) });
  }

  const prompt = buildPrompt(text, files);
  log.info('ход', { user: user.id, conversation: conversationId.slice(0, 8), chars: prompt.length, stream });

  if (!stream) {
    await runBuffered(res, session, id, model, prompt, images);
    return;
  }
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  await runStreaming(req, res, session, id, model, prompt, streamOptions?.include_usage === true, images);
}

async function runBuffered(
  res: ServerResponse,
  session: PiSession,
  id: string,
  model: string,
  prompt: string,
  images: Array<{ data: string; mimeType: string }> = [],
): Promise<void> {
  let text = '';
  let reasoning = '';
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === 'text_delta') text += delta.delta ?? '';
        if (delta?.type === 'thinking_delta') reasoning += delta.delta ?? '';
      }
      if (event.type === 'agent_settled') {
        unsubscribe();
        resolve();
      }
    });
  });

  try {
    await session.prompt(prompt, images);
    await finished;
    const usage = usageFromStats(await session.getStats());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(id, model, text, usage)));
  } catch (error) {
    log.error('ход сорвался', { error: String(error) });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`ход сорвался: ${String(error)}`, 'server_error')));
  } finally {
    void reasoning;
  }
}

async function runStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  session: PiSession,
  id: string,
  model: string,
  prompt: string,
  includeUsage: boolean,
  images: Array<{ data: string; mimeType: string }> = [],
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  let finished = false;
  let wroteAnything = false;

  const write = (payload: string) => {
    if (closed || res.writableEnded) return;
    res.write(payload);
  };

  // Первый чанк с ролью: некоторые клиенты (и парсеры вроде LangChain) без него
  // не собирают сообщение.
  write(chunk(id, model, { role: 'assistant', content: '' }));

  const unsubscribe = session.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.delta) {
          wroteAnything = true;
          write(chunk(id, model, { content: delta.delta }));
        }
        if (delta?.type === 'thinking_delta' && delta.delta) {
          write(chunk(id, model, { reasoning_content: delta.delta }));
        }
        break;
      }
      case 'tool_execution_start': {
        const phrase = phraseForToolStart(String(event.toolName), (event.args ?? {}) as Record<string, unknown>);
        if (phrase) write(chunk(id, model, { reasoning_content: `${phrase}\n` }));
        break;
      }
      case 'tool_execution_end': {
        write(chunk(id, model, { reasoning_content: `${phraseForToolEnd(String(event.toolName), Boolean(event.isError))}\n` }));
        break;
      }
      case 'agent_settled': {
        finished = true;
        break;
      }
      case 'extension_error':
      case 'error': {
        log.error('ошибка у pi', { detail: JSON.stringify(event).slice(0, 300) });
        break;
      }
      default:
        break;
    }
  });

  const settle = (async () => {
    for (;;) {
      if (finished) return;
      if (closed) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  res.on('close', () => {
    if (res.writableEnded) return;
    closed = true;
    log.info('клиент оборвал соединение — прерываю ход', {
      user: session.user.id,
      conversation: session.conversationId.slice(0, 8),
    });
    void session.abort();
  });

  try {
    await session.prompt(prompt, images);
    await settle;
    if (closed) return;

    const usage = usageFromStats(await session.getStats());
    write(chunk(id, model, {}, 'stop'));
    if (includeUsage) write(usageChunk(id, model, usage));
    write(DONE);
    res.end();
    log.info('ход завершён', { user: session.user.id, wrote: wroteAnything, usage: includeUsage });
  } catch (error) {
    log.error('стрим сорвался', { error: String(error) });
    if (!closed && !res.writableEnded) {
      write(chunk(id, model, { content: `\n[ошибка: ${String(error)}]` }, 'stop'));
      write(DONE);
      res.end();
    }
  } finally {
    unsubscribe();
  }
}
