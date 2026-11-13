// Queue of turns written during a turn.
//
// It is kept in the service process, not in the browser: if a person pressed F5 or went to another
// conversation, the turn will still be delivered when the current turn finishes. A service restart
// loses the queue together with the turn it was waiting for (see chat-live.ts): an unfinished
// turn cannot be restored after a restart, and pretending that the turn is "waiting somewhere" would be
// a lie.
import crypto from 'node:crypto';
import type { UploadedAttachments } from './chat.ts';

/**
 * How many turns we keep in the queue of a single conversation. Five is already "I talked a lot while
 * it was thinking"; more will not fit in memory if each has several images.
 */
export const QUEUE_LIMIT = 5;

/** How many characters of a turn are visible in the queue indicator. */
const LABEL_CHARS = 120;

export type QueuedMessage = {
  id: string;
  /** What a person sees in the queue: text or attachment names, without base64. */
  label: string;
  text: string;
  attachments: UploadedAttachments;
  at: number;
};

/** Queue view for the panel: identifier and label, nothing extra. */
export type QueueItem = { id: string; text: string };

const queues = new Map<string, QueuedMessage[]>();

/** One key for everyone: person and conversation. */
function key(userId: string, chatId: string): string {
  return `${userId}\u0000${chatId}`;
}

/**
 * Turn label for the indicator: the text, or if there is none, the file names. A too
 * long turn is truncated: the queue is a list, not a reader.
 */
export function queueLabel(text: string, names: string[]): string {
  const trimmed = text.trim();
  const full = trimmed || names.join(', ') || 'вложение';
  return full.length > LABEL_CHARS ? `${full.slice(0, LABEL_CHARS - 1).trimEnd()}…` : full;
}

/** Conversation queue: from old to new. A copy — it is not spoiled from outside. */
export function queued(userId: string, chatId: string): QueuedMessage[] {
  return [...(queues.get(key(userId, chatId)) ?? [])];
}

export function queueView(userId: string, chatId: string): QueueItem[] {
  return queued(userId, chatId).map(({ id, label }) => ({ id, text: label }));
}

/**
 * Appends a turn to the tail. `null` means the queue is full: then we honestly refuse instead of
 * accumulating endlessly. `front` is needed by the "now" command: it overtakes those already standing.
 */
export function enqueue(
  userId: string,
  chatId: string,
  message: { text: string; attachments: UploadedAttachments },
  front = false,
): { id: string; position: number } | null {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf) ?? [];
  if (list.length >= QUEUE_LIMIT) return null;
  const item: QueuedMessage = {
    id: crypto.randomUUID(),
    label: queueLabel(message.text, message.attachments.names),
    text: message.text,
    attachments: message.attachments,
    at: Date.now(),
  };
  if (front) list.unshift(item);
  else list.push(item);
  queues.set(keyOf, list);
  return { id: item.id, position: list.indexOf(item) + 1 };
}

/** Removes the head of the queue: it is what we run as the next turn. */
export function takeNext(userId: string, chatId: string): QueuedMessage | undefined {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf);
  if (!list || list.length === 0) return undefined;
  const [head, ...rest] = list;
  if (rest.length === 0) queues.delete(keyOf);
  else queues.set(keyOf, rest);
  return head;
}

/** Removes a single turn: the person changed their mind before it was sent. */
export function dropQueued(userId: string, chatId: string, id: string): boolean {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf);
  if (!list) return false;
  const rest = list.filter((item) => item.id !== id);
  if (rest.length === list.length) return false;
  if (rest.length === 0) queues.delete(keyOf);
  else queues.set(keyOf, rest);
  return true;
}

/** Removes the whole queue: `/stop` means "stop everything", not "stop only the reply". */
export function clearQueue(userId: string, chatId: string): QueuedMessage[] {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf) ?? [];
  queues.delete(keyOf);
  return list;
}
