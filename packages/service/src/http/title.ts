// Заголовок разговора — расширение поверх OpenAI: клиент просит его отдельным
// запросом, и этот запрос несёт ту же идентичность разговора, что и обычный ход.
// Так устроен заголовок LibreChat, которым мы пользовались раньше; контракт
// оставлен, чтобы такие запросы не попадали в живую сессию pi.
//
// Пускать его в живую сессию pi нельзя: получится либо 409 (ход уже идёт —
// клиент может отправить заголовок параллельно основному ходу), либо
// лишний полный агентский прогон с мусором в истории и в памяти. Поэтому
// такой запрос узнаётся по метке в промпте (плюс отдельная модель)
// и обслуживается здесь же, локально и без сессии.
import { log, redact } from '../log.ts';
import { normalizeContent, type IncomingMessage } from '../sessions/divergence.ts';

/** Модель, которой клиент может пометить запрос заголовка: соглашение от LibreChat. */
export const TITLE_MODEL_ID = 'icarus-title';

/** Метка в начале `titlePrompt`: по ней запрос узнаётся, даже если модель не сменилась. */
export const TITLE_SENTINEL = '[[ICARUS_TITLE]]';

const MAX_WORDS = 6;
const MAX_CHARS = 48;
const FALLBACK = 'Новый разговор';

/** Слова, которые сами по себе заголовком не являются: приветствия и обращения. */
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

/** Текст последней реплики пользователя — в запросе заголовка это и есть промпт. */
function lastUserText(messages: Array<IncomingMessage | undefined>): string {
  const lastUser = [...(messages ?? [])].reverse().find((message) => message?.role === 'user');
  return normalizeContent(lastUser?.content).trim();
}

/** Запрос на заголовок или обычный ход? */
export function isTitleRequest(model: unknown, messages: Array<IncomingMessage | undefined>): boolean {
  if (model === TITLE_MODEL_ID) return true;
  return lastUserText(messages).includes(TITLE_SENTINEL);
}

/**
 * Достаём первую реплику пользователя из промпта заголовка.
 * Клиент подставляет `{convo}` по шаблону `User: {input}\nAI: {output}`,
 * поэтому берём всё между первым `User: ` и последним `\nAI:`.
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
 * Заголовок из первой реплики: первая фраза, в которой есть о чём говорить.
 * «Привет, Икар! Помоги разобраться, как настроить память» → «Разобраться, как настроить память».
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

/** Заголовок из промпта клиента: берём разговор и сжимаем его до заголовка. */
export function titleFromPrompt(prompt: string): string {
  return titleFromText(conversationFromTitlePrompt(prompt));
}

/** Модели можно дать чуть больше свободы, чем эвристике: она умеет сжимать смысл. */
const MODEL_MAX_WORDS = 8;
const MODEL_MAX_CHARS = 64;

/**
 * Что спрашиваем у дешёвой модели. Свой промпт, а не промпт клиента: там разговор
 * обёрнут в служебную рамку и обрывается на «AI: » — модели это мешает.
 */
export function buildTitlePrompt(conversation: string): string {
  return `Придумай короткий заголовок этого разговора: 3–6 слов, на языке разговора, без кавычек и без точки в конце. Верни только заголовок.

Разговор:
${conversation}

Заголовок:`;
}

/**
 * Ответ модели как заголовок: одна строка без размышлений, кавычек, Markdown
 * и служебных подписей вроде «Заголовок:». Пустая строка — сигнал, что ответ
 * бесполезен и вызывающему стоит взять эвристику.
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

/** Кто дал разговору имя: модель по смыслу или эвристика из первой фразы. */
export type TitleSource = 'model' | 'heuristic';

export type ModelTitleOptions = {
  /** Чем спросить модель: разовый вызов дешёвой модели мимо живой сессии. */
  ask: (prompt: string) => Promise<string>;
  /** Разговор, который увидит модель. */
  conversation: string;
  /** Имя, если модель не справилась: эвристика из первой реплики. */
  fallback: string;
  /** Клиент ушёл — незачем держать вызов модели. */
  signal?: AbortSignal;
};

/**
 * Заголовок от дешёвой модели с откатом на эвристику. Заголовок — украшение:
 * таймаут, пустой ответ и мусор в ответе не повод задерживать или ломать ход,
 * поэтому любой сбой молча уходит в фолбэк. Отмену зовущего логируем отдельно:
 * «стоп» — не поломка.
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
