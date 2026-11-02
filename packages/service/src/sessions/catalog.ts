// Каталог разговоров: какой файл сессии pi какому разговору принадлежит.
//
// pi называет файл id сессии — sha1 от `userId:conversationId`. Обратно из имени
// файла разговор не восстановить, а панели нужно знать, что это Telegram, а не
// веб-чат. Поэтому при подъёме телеграмной сессии сервис запоминает пару
// sessionId → conversationId рядом с сессиями. Файл необязательный: без записи
// старая сессия всё равно видна в панели, просто без канала и только для чтения.
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log } from '../log.ts';

/** Откуда пришёл разговор: от этого зависит, можно ли в него писать из панели. */
export type ConversationChannel = 'web' | 'telegram' | 'api';
/** Как показать разговор в панели: `external` — файл, чей канал уже не восстановить. */
export type ChatChannel = ConversationChannel | 'external';

export type SessionCatalogEntry = {
  sessionId: string;
  conversationId: string;
};

function catalogFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'session-index.json');
}

function isEntry(value: unknown): value is SessionCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === 'string' && typeof item.conversationId === 'string';
}

/** Каталог читается целиком: разговоров десятки, а не миллионы. */
export function readSessionCatalog(config: IcarusConfig, user: UserConfig): SessionCatalogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogFile(config, user), 'utf8')) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? parsed.sessions.filter(isEntry) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читается каталог разговоров', { user: user.id, error: String(error) });
    }
    return [];
  }
}

/** Пишем через временный файл: падение посреди записи не должно съесть каталог. */
function writeSessionCatalog(config: IcarusConfig, user: UserConfig, sessions: SessionCatalogEntry[]): void {
  const file = catalogFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Запоминает, что файл сессии принадлежит телеграмному разговору.
 *
 * Веб-разговоры и так лежат в chats.json, а API-разговоры панель показывает без
 * канала: их id бывают случайными на каждый запрос, и каталог рос бы без предела.
 * Телеграмных разговоров конечное число — по одному на чат и топик.
 */
export function rememberTelegramSession(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  sessionId: string,
): void {
  if (!conversationId.startsWith('telegram-')) return;
  try {
    const sessions = readSessionCatalog(config, user);
    const existing = sessions.find((entry) => entry.sessionId === sessionId);
    if (existing?.conversationId === conversationId) return;
    if (existing) existing.conversationId = conversationId;
    else sessions.push({ sessionId, conversationId });
    writeSessionCatalog(config, user, sessions);
  } catch (error) {
    // Каталог — удобство панели, а не условие разговора: его сбой не должен
    // мешать человеку получить ответ.
    log.warn('не записался каталог разговоров', { user: user.id, error: String(error) });
  }
}

/** Канал по id разговора; всё незнакомое — внешний вход вроде OpenAI-клиента. */
export function channelForConversation(conversationId: string): ConversationChannel {
  if (conversationId.startsWith('web-')) return 'web';
  if (conversationId.startsWith('telegram-')) return 'telegram';
  return 'api';
}
