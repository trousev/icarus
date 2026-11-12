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

/**
 * Сводка по всем разговорам человека: панели нужно знать, где ход идёт и где он
 * кончился, не подписываясь на полный поток каждого разговора. Событий мало и они
 * редкие — старт хода и финал; дельты текста тут не ходят.
 */
export type BulletinEvent = {
  /** Чей ход: панель чужие события должна пропустить. */
  userId: string;
  chatId: string;
  /**
   * `title` — у разговора уточнилось имя (модель придумала его после хода или
   * человек переименовал из списка): панель меняет шапку и строку сайдбара.
   * `queue` — поменялось то, что ждёт хода: панель перерисовывает «В очереди: N».
   */
  type: 'busy' | 'idle' | 'title' | 'queue';
  /** id/payload обновлённой записи разговора — для `idle` и `title`. */
  chat?: unknown;
  /** Что стоит в очереди, — только для `queue`. */
  queue?: Array<{ id: string; text: string }>;
};

type Watcher = (event: BulletinEvent) => void;

/** Кто слушает сводку: по писцу на живой GET-ответ панели. */
const watchers = new Set<Watcher>();

/** Подписка на сводку по всем разговорам. Возвращает отписку. */
export function watchAll(watcher: Watcher): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Событие сводки — всем, кто слушает. Упавший писец чужих не роняет. */
export function broadcast(event: BulletinEvent): void {
  for (const watcher of watchers) {
    try {
      watcher(event);
    } catch (error) {
      log.warn('чат: слушатель сводки отвалился', { error: String(error) });
    }
  }
}

/** Живой ход одного разговора. */
export type Turn = {
  /** Накопленные события с начала хода: по ним новый зритель догоняет ход. */
  events: LiveEvent[];
  /** Кто сейчас смотрит: писцы HTTP-ответов. Ушёл — просто вычеркнули. */
  subscribers: Set<Subscriber>;
  /** Ход встал: replay отдаст хвост и закроет соединение. */
  done: boolean;
  startedAt: number;
  /** Обещание конца хода: его ждут очередь и «прервать и отправить». */
  finished: Promise<void>;
  finish: () => void;
};

const turns = new Map<string, Turn>();

/** Ключ один на всех: человек и разговор. Второй ход в том же разговоре невозможен. */
function key(userId: string, chatId: string): string {
  return `${userId}\u0000${chatId}`;
}

export function startTurn(userId: string, chatId: string): Turn {
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const turn: Turn = { events: [], subscribers: new Set(), done: false, startedAt: Date.now(), finished, finish };
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
  turn.finish();
}

/**
 * Ход действительно встал. Прерывание только просит pi остановиться, а `busy`
 * снимается раньше, чем ход дописал ответ: ждать конца нужно по этому обещанию.
 */
export function whenTurnDone(turn: Turn): Promise<void> {
  return turn.finished;
}

/** Ход идёт прямо сейчас, а не только доигран минуту назад для запоздавшего зрителя. */
export function runningTurn(userId: string, chatId: string): Turn | undefined {
  const turn = liveTurn(userId, chatId);
  return turn && !turn.done ? turn : undefined;
}

export function forgetTurn(userId: string, chatId: string): void {
  turns.delete(key(userId, chatId));
}
