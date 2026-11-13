// Who talks to whom: the pi session id and the conversation channel.
//
// Both outputs are needed by several layers at once: pi-session brings up the process,
// chats.json keeps the conversation registry, and the panel finds the history file by id.
// We keep them separate so that the conversation registry doesn't drag PiSession along.
import { createHash } from 'node:crypto';

/** Where the conversation came from: this determines whether it can be written to from the panel. */
export type ChatChannel = 'web' | 'telegram' | 'api';

/** Deterministic UUID from the conversation key: pi expects a valid session id. */
export function sessionIdFor(userId: string, conversationId: string): string {
  const hex = createHash('sha1').update(`${userId}:${conversationId}`).digest('hex').slice(0, 32);
  const parts = [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)];
  return parts.join('-');
}

/** Channel by conversation id; anything unfamiliar is an external entry like an OpenAI client. */
export function channelForConversation(conversationId: string): ChatChannel {
  if (conversationId.startsWith('web-')) return 'web';
  if (conversationId.startsWith('telegram-')) return 'telegram';
  return 'api';
}
