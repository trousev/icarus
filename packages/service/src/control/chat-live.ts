// Живой ход разговора, переживающий уход зрителя.
//
// Ход pi не принадлежит HTTP-запросу: человек нажал F5 или закрыл вкладку — это
// значит «ушёл смотреть», а не «останови ход». Поэтому события хода копятся здесь,
// в памяти процесса, а ответ — лишь один из подписчиков. Вернувшись, панель
// забирает накопленное и доживает ход вместе с ним.
//
// Состояние живёт до конца хода и не переживает перезапуск службы: незавершённый
// ход после рестарта теряется вместе с контейнером pi, который его вёл.
import { log } from '../log.ts';

/** Событие хода: то же, что панель шлёт в поток (`step-start`, `text`, `done`...). */
export type LiveEvent = Record<string, unknown>;

type Subscriber = (event: LiveEvent) => void;

type Turn = {
  /** Накопленные события с начала хода: по ним новый зритель догоняет ход. */
  events: LiveEvent[];
  /** Кто сейчас смотрит: писцы HTTP-ответов. Ушёл — просто вычеркнули. */
  subscribers: Set<Subscriber>;
  /** Ход встал: replay отдаст хвост и закроет соединение. */
  done: boolean;
  startedAt: number;
};

const turns = new Map<string, Turn>();

/** Ключ один на всех: человек и разговор. Второй ход в том же разговоре невозможен. */
function key(userId: string, chatId: string): string {
  return `${userId}\u0000${chatId}`;
}

export function startTurn(userId: string, chatId: string): Turn {
  const turn: Turn = { events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  turns.set(key(userId, chatId), turn);
  return turn;
}

export function liveTurn(userId: string, chatId: string): Turn | undefined {
  const turn = turns.get(key(userId, chatId));
  if (!turn) return undefined;
  // Завершённый ход, за которым никто не вернулся, держим недолго: он уже записан
  // в разговор, а помнить вечно нечего. Минута — чтобы панель успела переподключиться.
  if (turn.done && turn.subscribers.size === 0 && Date.now() - turn.startedAt > 60_000) {
    turns.delete(key(userId, chatId));
    return undefined;
  }
  return turn;
}

/** Новое событие хода: в память и всем, кто сейчас смотрит. */
export function emit(turn: Turn, event: LiveEvent): void {
  turn.events.push(event);
  for (const subscriber of turn.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      // Болен один зритель — не должны страдать остальные и сам ход.
      log.warn('чат: подписчик отвалился', { error: String(error) });
    }
  }
}

/** Подписка: сначала накопленный хвост, потом живое. Возвращает отписку. */
export function subscribe(turn: Turn, subscriber: Subscriber, replayFrom = 0): () => void {
  const replay = turn.events.slice(replayFrom);
  // Подписываемся до replay: событие, пришедшее в промежутке, не должно потеряться.
  turn.subscribers.add(subscriber);
  for (const event of replay) {
    try {
      subscriber(event);
    } catch (error) {
      log.warn('чат: подписчик отвалился на догоне', { error: String(error) });
    }
  }
  return () => {
    turn.subscribers.delete(subscriber);
  };
}

export function finishTurn(turn: Turn): void {
  turn.done = true;
}

/** Ход идёт прямо сейчас, а не только доигран минуту назад для запоздавшего зрителя. */
export function runningTurn(userId: string, chatId: string): Turn | undefined {
  const turn = liveTurn(userId, chatId);
  return turn && !turn.done ? turn : undefined;
}

export function forgetTurn(userId: string, chatId: string): void {
  turns.delete(key(userId, chatId));
}
