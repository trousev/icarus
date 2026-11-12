// Очередь реплик, написанных во время хода.
//
// Хранится в процессе сервиса, а не в браузере: человек нажал F5 или ушёл в другой
// разговор — реплика всё равно доедет, когда текущий ход встанет. Перезапуск службы
// очередь теряет вместе с ходом, который она ждала (см. chat-live.ts): незавершённый
// ход после рестарта не восстановить, и делать вид, что реплика «где-то ждёт», было бы
// враньём.
import crypto from 'node:crypto';
import type { UploadedAttachments } from './chat.ts';

/**
 * Сколько реплик держим в очереди одного разговора. Пять — уже «я наговорил, пока
 * он думал»; больше не влезет в память, если у каждой по несколько картинок.
 */
export const QUEUE_LIMIT = 5;

/** Сколько символов реплики видно в индикаторе очереди. */
const LABEL_CHARS = 120;

export type QueuedMessage = {
  id: string;
  /** Что человек видит в очереди: текст или имена вложений, без base64. */
  label: string;
  text: string;
  attachments: UploadedAttachments;
  at: number;
};

/** Вид очереди для панели: идентификатор и подпись, ничего лишнего. */
export type QueueItem = { id: string; text: string };

const queues = new Map<string, QueuedMessage[]>();

/** Ключ один на всех: человек и разговор. */
function key(userId: string, chatId: string): string {
  return `${userId}\u0000${chatId}`;
}

/**
 * Подпись реплики для индикатора: текст, а если его нет — имена файлов. Слишком
 * длинную реплику обрезаем: очередь — это список, а не читалка.
 */
export function queueLabel(text: string, names: string[]): string {
  const trimmed = text.trim();
  const full = trimmed || names.join(', ') || 'вложение';
  return full.length > LABEL_CHARS ? `${full.slice(0, LABEL_CHARS - 1).trimEnd()}…` : full;
}

/** Очередь разговора: от старых к новым. Копия — снаружи её не портят. */
export function queued(userId: string, chatId: string): QueuedMessage[] {
  return [...(queues.get(key(userId, chatId)) ?? [])];
}

export function queueView(userId: string, chatId: string): QueueItem[] {
  return queued(userId, chatId).map(({ id, label }) => ({ id, text: label }));
}

/**
 * Ставит реплику в хвост. `null` — очередь полна: тогда честно отказываем, а не
 * копим бесконечно. `front` нужен команде «сейчас»: она обгоняет уже стоящих.
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

/** Снимает голову очереди: её и запускаем следующим ходом. */
export function takeNext(userId: string, chatId: string): QueuedMessage | undefined {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf);
  if (!list || list.length === 0) return undefined;
  const [head, ...rest] = list;
  if (rest.length === 0) queues.delete(keyOf);
  else queues.set(keyOf, rest);
  return head;
}

/** Убирает одну реплику: человек передумал ещё до того, как её отправили. */
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

/** Снимает всю очередь: `/stop` — это «останови всё», а не «останови только ответ». */
export function clearQueue(userId: string, chatId: string): QueuedMessage[] {
  const keyOf = key(userId, chatId);
  const list = queues.get(keyOf) ?? [];
  queues.delete(keyOf);
  return list;
}
