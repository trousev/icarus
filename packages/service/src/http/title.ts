// Conversation title — an extension on top of OpenAI: the client requests it with a separate
// request, and this request carries the same conversation identity as a normal turn.
// This is how the title in LibreChat, which we used before, works; the contract
// is kept so that such requests don't get into a live pi session.
//
// We can't let it into a live pi session: it would produce either a 409 (a turn is already
// running — the client may send the title in parallel with the main turn), or
// an extra full agent run with garbage in the history and in memory. That's why
// such a request is recognized by a sentinel in the prompt (plus a separate model)
// and handled right here, locally and without a session.
import { log, redact } from '../log.ts';
import { normalizeContent, type IncomingMessage } from '../sessions/divergence.ts';

/** The model with which the client may tag a title request: a convention from LibreChat. */
export const TITLE_MODEL_ID = 'icarus-title';

/** The sentinel at the start of `titlePrompt`: it identifies the request even if the model didn't change. */
export const TITLE_SENTINEL = '[[ICARUS_TITLE]]';

const MAX_WORDS = 6;
const MAX_CHARS = 48;
const FALLBACK = 'Новый разговор';

/** Words that aren't a title by themselves: greetings and forms of address. */
const EMPTY_WORDS = new Set([
  'привет',
  'приветствую',
  'здравствуй',
  'здравствуйте',
  'хай',
  'хелло',
  'hello',
  'hi',
  'hey',
  'добрый',
  'доброе',
  'день',
  'вечер',
  'утро',
  'икар',
  'икарус',
  'icarus',
  'слушай',
  'смотри',
  'ну',
  'так',
  'а',
  'и',
  'эй',
]);

/** The text of the user's last message — in the title request this is the prompt. */
function lastUserText(messages: Array<IncomingMessage | undefined>): string {
  const lastUser = [...(messages ?? [])].reverse().find((message) => message?.role === 'user');
  return normalizeContent(lastUser?.content).trim();
}

/** A title request or a normal turn? */
export function isTitleRequest(model: unknown, messages: Array<IncomingMessage | undefined>): boolean {
  if (model === TITLE_MODEL_ID) return true;
  return lastUserText(messages).includes(TITLE_SENTINEL);
}

/**
 * We extract the user's first message from the title prompt.
 * The client substitutes `{convo}` using the template `User: {input}\nAI: {output}`,
 * so we take everything between the first `User: ` and the last `\nAI:`.
 */
export function conversationFromTitlePrompt(prompt: string): string {
  const start = prompt.indexOf('User: ');
  if (start === -1) return prompt.trim();
  const rest = prompt.slice(start + 'User: '.length);
  const end = rest.lastIndexOf('\nAI:');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function isBlank(phrase: string): boolean {
  const list = words(phrase.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
  return list.length === 0 || list.every((word) => EMPTY_WORDS.has(word));
}

function stripLeadWords(phrase: string): string {
  const list = words(phrase);
  while (list.length > 0) {
    const head = list[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!EMPTY_WORDS.has(head)) break;
    list.shift();
  }
  return list.join(' ');
}

function cap(phrase: string, maxWords = MAX_WORDS, maxChars = MAX_CHARS): string {
  let list = words(phrase).slice(0, maxWords);
  let text = list.join(' ');
  while (text.length > maxChars && list.length > 1) {
    list = list.slice(0, -1);
    text = list.join(' ');
  }
  return text;
}

function upFirst(text: string): string {
  const [first, ...rest] = [...text];
  return first ? first.toUpperCase() + rest.join('') : text;
}

/**
 * A title from the first message: the first phrase that has something to talk about.
 * "Hello, Icarus! Help me figure out how to set up memory" → "Figure out how to set up memory".
 */
export function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return FALLBACK;

  for (const raw of clean.split(/[.!?;\n]+/)) {
    const clause = raw.trim().replace(/^[-—–:,]+/, '').trim();
    if (!clause || isBlank(clause)) continue;
    const stripped = stripLeadWords(clause);
    if (!stripped || isBlank(stripped)) continue;
    return upFirst(cap(stripped).replace(/[,;:.\-—–]+$/, '').trim()) || FALLBACK;
  }

  return upFirst(cap(clean)) || FALLBACK;
}

/** A title from the client's prompt: take the conversation and compress it to a title. */
export function titleFromPrompt(prompt: string): string {
  return titleFromText(conversationFromTitlePrompt(prompt));
}

/** The model can be given a bit more freedom than the heuristic: it knows how to compress meaning. */
const MODEL_MAX_WORDS = 8;
const MODEL_MAX_CHARS = 64;

/**
 * What we ask the cheap model. Our own prompt, not the client's prompt: there the conversation
 * is wrapped in a service frame and cut off at "AI: " — that hinders the model.
 */
export function buildTitlePrompt(conversation: string): string {
  return `Придумай короткий заголовок этого разговора: 3–6 слов, на языке разговора, без кавычек и без точки в конце. Верни только заголовок.

Разговор:
${conversation}

Заголовок:`;
}

/**
 * The model's answer as a title: one line without reasoning, quotes, Markdown
 * and service prefixes like "Title:". An empty string is a signal that the answer
 * is useless and the caller should use the heuristic.
 */
export function cleanModelTitle(raw: string): string {
  const withoutThinking = String(raw ?? '').replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '\n');
  const line =
    withoutThinking
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? '';

  const cleaned = line
    .replace(/^(заголовок|название|title)\s*[:\-—]\s*/i, '')
    .replace(/^[#*>`"«»'“”\s]+/, '')
    .replace(/[#*`"«»'“”\s]+$/, '')
    .trim();

  if (!cleaned) return '';
  return upFirst(cap(cleaned, MODEL_MAX_WORDS, MODEL_MAX_CHARS).replace(/[.,;:!?]+$/, '').trim());
}

/** Who named the conversation: the model by meaning or the heuristic from the first phrase. */
export type TitleSource = 'model' | 'heuristic';

export type ModelTitleOptions = {
  /** What to ask the model with: a one-off call to a cheap model outside the live session. */
  ask: (prompt: string) => Promise<string>;
  /** The conversation the model will see. */
  conversation: string;
  /** The name if the model failed: the heuristic from the first message. */
  fallback: string;
  /** The client left — no point holding the model call. */
  signal?: AbortSignal;
};

/**
 * A title from the cheap model with a fallback to the heuristic. A title is decoration:
 * a timeout, an empty answer and garbage in the answer are no reason to delay or break the turn,
 * so any failure silently falls back. We log the caller's cancellation separately:
 * "stop" is not a breakdown.
 */
export async function askModelTitle(
  options: ModelTitleOptions,
): Promise<{ title: string; source: TitleSource }> {
  const { ask, conversation, fallback, signal } = options;
  try {
    const cleaned = cleanModelTitle(await ask(buildTitlePrompt(conversation)));
    if (cleaned) return { title: cleaned, source: 'model' };
    log.warn('модель вернула пустой заголовок — оставляю эвристику');
  } catch (error) {
    if (signal?.aborted) {
      log.debug('заголовок отменён вместе с ходом');
    } else {
      log.warn('заголовок от модели не вышел — оставляю эвристику', { error: redact(String(error)) });
    }
  }
  return { title: fallback, source: 'heuristic' };
}
