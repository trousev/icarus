// Заголовок разговора. LibreChat генерирует его отдельным запросом
// (`titleConvo: true` → `client.titleConvo` → `run.generateTitle`), и этот
// запрос несёт ту же идентичность разговора, что и обычный ход.
//
// Пускать его в живую сессию pi нельзя: получится либо 409 (ход уже идёт —
// при `titleTiming: immediate` запрос уходит параллельно основному), либо
// лишний полный агентский прогон с мусором в истории и в памяти. Поэтому
// такой запрос узнаётся по метке в `titlePrompt` (плюс отдельный `titleModel`)
// и обслуживается здесь же, локально и без сессии.
import { normalizeContent, type IncomingMessage } from '../sessions/divergence.ts';

/** Модель, которой LibreChat помечает запрос заголовка (`titleModel` в yaml). */
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
 * LibreChat подставляет `{convo}` по шаблону `User: {input}\nAI: {output}`,
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

function cap(phrase: string): string {
  let list = words(phrase).slice(0, MAX_WORDS);
  let text = list.join(' ');
  while (text.length > MAX_CHARS && list.length > 1) {
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

/** Заголовок из промпта LibreChat: берём разговор и сжимаем его до заголовка. */
export function titleFromPrompt(prompt: string): string {
  return titleFromText(conversationFromTitlePrompt(prompt));
}
