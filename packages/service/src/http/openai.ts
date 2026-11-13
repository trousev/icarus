// The main route: the OpenAI client sends the conversation history, we turn it
// into a turn for the live pi session and back — into an OpenAI-format stream.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { log } from '../log.ts';
import { CONTAINER_INCOMING, findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { findWorkspace } from '../workspaces.ts';
import { buildPrompt } from '../prompt.ts';
import { compareHistory, normalizeContent, type IncomingMessage as ChatMessage } from '../sessions/divergence.ts';
import { recordTurn } from '../sessions/chats.ts';
import { phraseForToolEnd, phraseForToolStart } from '../reasoning.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { AnswerBuffer } from './answer.ts';
import { chunk, completion, completionId, DONE, errorBody, usageChunk, type Usage } from './sse.ts';
import {
  askModelTitle,
  conversationFromTitlePrompt,
  isTitleRequest,
  titleFromPrompt,
  TITLE_MODEL_ID,
} from './title.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** How long we wait for the cheap title model; after that we answer with a heuristic. */
const TITLE_TIMEOUT_MS = 12_000;

const ZERO_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * Conversation title: the client may call the model with a separate request, and we don't
 * let it into the live pi session — otherwise it's a needless agent run and a race with the main turn.
 *
 * We ask a cheap model for the title with a one-off question in the human's container; on any
 * failure (no user, timeout, empty answer) we silently return the heuristic — a title
 * isn't worth delaying or breaking the answer for.
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
    // The client left (they pressed "stop" in the chat) — no point holding the model call.
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      const asked = await askModelTitle({
        ask: (question) => ctx.registry.oneShot(user, question, { timeoutMs: TITLE_TIMEOUT_MS, signal: controller.signal }),
        conversation: conversationFromTitlePrompt(prompt),
        fallback,
        signal: controller.signal,
      });
      title = asked.title;
      source = asked.source === 'model' ? 'модель' : 'эвристика';
    } finally {
      res.off('close', onClose);
    }
  }

  const model = typeof body.model === 'string' ? body.model : TITLE_MODEL_ID;
  const id = completionId();

  log.info('заголовок разговора', { title, source, user: user?.id ?? 'неизвестный' });

  // The client has already left — there's nowhere to write, and that's not an error.
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

/** Who is speaking and about which conversation: client headers, otherwise fallbacks. */
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

/** Extract the text of the latest turn, unpack the attachments into incoming/ and prepare images for the model. */
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
      // We give the image to the model natively, so it can see it, not just a path to the file.
      images.push({ data: base64, mimeType: mime });
      const extension = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      try {
        fs.mkdirSync(incomingDir, { recursive: true });
        fs.writeFileSync(path.join(incomingDir, name), Buffer.from(base64, 'base64'));
        files.push(`${CONTAINER_INCOMING}/${name}`);
      } catch (error) {
        log.warn('вложение не сохранилось', { error: String(error) });
      }
    }
  }

  return { text: texts.join('\n').trim(), files, images };
}

// The turn is assembled in a shared way — Telegram uses the same (see prompt.ts).
export { buildPrompt };

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

  // We answer the conversation title before any session: it's not an Icarus turn.
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

  // The client chooses the workspace; without the header the conversation goes to "Conversation".
  const requestedWorkspace =
    typeof req.headers['x-icarus-workspace'] === 'string' ? req.headers['x-icarus-workspace'].trim() : '';
  if (requestedWorkspace && !findWorkspace(config, user, requestedWorkspace)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`workspace «${requestedWorkspace}» не найден`, 'not_found')));
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
    session = await registry.acquire(user, conversationId, requestedWorkspace || undefined);
  } catch (error) {
    log.error('не удалось поднять сессию', { userId, error: String(error) });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`сессия недоступна: ${String(error)}`, 'server_error')));
    return;
  }

  if (session.busy) {
    log.warn('ход уже идёт, отклоняю', { userId, conversation: conversationId });
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody('в этом разговоре уже идёт ответ', 'conflict_error')));
    return;
  }

  // The session file doesn't distinguish the inputs: we record the turn channel ourselves, otherwise
  // the panel can't tell who sent the latest turn — the panel, Telegram or the API.
  recordTurn(config, user, conversationId, 'api');

  // History comparison: the pi session is the truth, we only log a divergence.
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
        conversation: conversationId,
        reason: comparison.reason,
      });
    }
  } catch (error) {
    log.debug('не удалось сверить историю', { error: String(error) });
  }

  const prompt = buildPrompt(text, files);
  log.info('ход', { user: user.id, conversation: conversationId, chars: prompt.length, stream });

  if (!stream) {
    await runBuffered(res, session, id, model, prompt, images);
    return;
  }
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  await runStreaming(req, res, session, id, model, prompt, streamOptions?.include_usage === true, images);
}

/**
 * The answer in one piece (`stream: false`). We accumulate reasoning separately and return it in
 * `message.reasoning_content` — the same channel as in the stream: `content`
 * must hold only the visible answer.
 */
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
    res.end(JSON.stringify(completion(id, model, text, usage, reasoning)));
  } catch (error) {
    log.error('ход сорвался', { error: String(error) });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody(`ход сорвался: ${String(error)}`, 'server_error')));
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

  /**
   * One chunk — exactly one channel: either reasoning or visible text, and never
   * both fields at once. A client's typical LangChain wrapper classifies a mixed `delta`
   * as text and moves the thoughts into the answer body.
   *
   * The channels are independent and don't "close". `reasoning_content` stays
   * reserved for reasoning and tool phrases at any point of the turn, `content` — only for the
   * model's words. The client merges adjacent deltas of one channel and orders the
   * blocks itself, so "a thought after the answer has started" is a normal `think` after
   * `text`, not a reason to append it to the answer. The reverse (after the first text
   * everything goes into `content`) is a regression: the agent almost always says the first phrase before tools,
   * and then the model's entire subsequent monologue ends up in the visible answer.
   *
   * The cost of switching is a break in the answer where the model broke off at a tool:
   * the client starts a new part at each switch and renders it as a separate
   * block. That's why the visible text goes through `AnswerBuffer`: an unfinished tail
   * is held back and merged with the continuation, and the switch lands on a
   * line or sentence boundary.
   */
  type ReplyDelta = { content?: string; reasoning_content?: string };

  const write = (payload: string) => {
    if (closed || res.writableEnded) return;
    res.write(payload);
  };

  const emit = (delta: ReplyDelta) => {
    if (delta.content) wroteAnything = true;
    write(chunk(id, model, delta));
  };

  /** Model thought and tool activity — one channel: a collapsed "reasoning" block. */
  const publishReasoning = (text: string) => {
    if (!text) return;
    emit({ reasoning_content: text });
  };

  /**
   * Visible answer text. It doesn't go out right away, but in finished pieces: see
   * `AnswerBuffer` — otherwise a switch to a thought or a tool phrase would cut the answer
   * where the model broke it off at a tool.
   */
  const answer = new AnswerBuffer((text) => emit({ content: text }));

  // The first chunk with the role: some clients (and parsers like LangChain) don't
  // assemble the message without it.
  write(chunk(id, model, { role: 'assistant', content: '' }));

  const unsubscribe = session.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (!delta?.type) break;
        if (delta.type === 'text_start') {
          answer.startBlock();
          break;
        }
        if (delta.type === 'text_delta' && delta.delta) {
          answer.push(delta.delta);
          break;
        }
        // `thinking_end` is deliberately not treated as a break: pi sends it already after
        // the first text of the same block (verified on a live stream), and a break
        // on it would insert a separator in the middle of a phrase.
        if (delta.type === 'thinking_start') {
          answer.breakText();
          break;
        }
        if (delta.type === 'thinking_delta' && delta.delta) {
          answer.breakText();
          publishReasoning(delta.delta);
          break;
        }
        break;
      }
      case 'tool_execution_start': {
        answer.breakText();
        const phrase = phraseForToolStart(String(event.toolName), (event.args ?? {}) as Record<string, unknown>);
        if (phrase) publishReasoning(`${phrase}\n`);
        break;
      }
      case 'tool_execution_end': {
        answer.breakText();
        publishReasoning(`${phraseForToolEnd(String(event.toolName), Boolean(event.isError))}\n`);
        break;
      }
      case 'message_start': {
        answer.breakText();
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
      conversation: session.conversationId,
    });
    void session.abort();
  });

  try {
    await session.prompt(prompt, images);
    await settle;
    if (closed) return;

    answer.flush();
    const usage = usageFromStats(await session.getStats());
    write(chunk(id, model, {}, 'stop'));
    if (includeUsage) write(usageChunk(id, model, usage));
    write(DONE);
    res.end();
    log.info('ход завершён', { user: session.user.id, wrote: wroteAnything, usage: includeUsage });
  } catch (error) {
    log.error('стрим сорвался', { error: String(error) });
    if (!closed && !res.writableEnded) {
      answer.flush();
      write(chunk(id, model, { content: `\n[ошибка: ${String(error)}]` }, 'stop'));
      write(DONE);
      res.end();
    }
  } finally {
    unsubscribe();
  }
}
