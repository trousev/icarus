// Кто с кем говорит: id сессии pi и канал разговора.
//
// Оба вывода нужны сразу нескольким слоям: pi-session поднимает процесс,
// chats.json ведёт реестр разговоров, а панель по id находит файл истории.
// Держим их отдельно, чтобы реестр разговоров не тянул за собой PiSession.
import { createHash } from 'node:crypto';

/** Откуда пришёл разговор: от этого зависит, можно ли в него писать из панели. */
export type ChatChannel = 'web' | 'telegram' | 'api';

/** Детерминированный UUID из ключа разговора: pi ждёт валидный id сессии. */
export function sessionIdFor(userId: string, conversationId: string): string {
  const hex = createHash('sha1').update(`${userId}:${conversationId}`).digest('hex').slice(0, 32);
  const parts = [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)];
  return parts.join('-');
}

/** Канал по id разговора; всё незнакомое — внешний вход вроде OpenAI-клиента. */
export function channelForConversation(conversationId: string): ChatChannel {
  if (conversationId.startsWith('web-')) return 'web';
  if (conversationId.startsWith('telegram-')) return 'telegram';
  return 'api';
}
