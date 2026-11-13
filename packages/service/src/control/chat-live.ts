// A live turn of a conversation that survives the viewer leaving.
//
// A pi turn does not belong to the HTTP request: the person pressed F5 or closed the tab — that
// means "left to watch", not "stop the turn". So the turn's events accumulate here,
// in process memory, and the response is just one of the subscribers. On return, the panel
// picks up what has accumulated and lives out the turn along with it.
//
// The state lives until the end of the turn and does not survive a service restart: an unfinished
// turn after a restart is lost together with the pi container that was running it.
import { log } from '../log.ts';

/** Turn event: the same as what the panel sends into the stream (`step-start`, `text`, `done`...). */
export type LiveEvent = Record<string, unknown>;

type Subscriber = (event: LiveEvent) => void;

/**
 * Summary across all of a person's conversations: the panel needs to know where a turn is running and where
 * it ended, without subscribing to the full stream of each conversation. Events are few and
 * rare — turn start and finish; text deltas don't travel here.
 */
export type BulletinEvent = {
  /** Whose turn: the panel must skip other people's events. */
  userId: string;
  chatId: string;
  /**
   * `title` — the conversation's name was refined (the model came up with it after the turn or
   * the person renamed it from the list): the panel changes the header and the sidebar row.
   * `queue` — what is waiting for a turn changed: the panel redraws "Queued: N".
   */
  type: 'busy' | 'idle' | 'title' | 'queue';
  /** id/payload of the updated conversation record — for `idle` and `title`. */
  chat?: unknown;
  /** What is queued — only for `queue`. */
  queue?: Array<{ id: string; text: string }>;
};

type Watcher = (event: BulletinEvent) => void;

/** Who listens to the summary: one writer per live panel GET response. */
const watchers = new Set<Watcher>();

/** Subscription to the summary across all conversations. Returns an unsubscribe function. */
export function watchAll(watcher: Watcher): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Summary event — to everyone who listens. A crashed writer does not drop the others. */
export function broadcast(event: BulletinEvent): void {
  for (const watcher of watchers) {
    try {
      watcher(event);
    } catch (error) {
      log.warn('чат: слушатель сводки отвалился', { error: String(error) });
    }
  }
}

/** A live turn of one conversation. */
export type Turn = {
  /** Events accumulated since the start of the turn: a new viewer catches up on the turn from them. */
  events: LiveEvent[];
  /** Who is watching right now: writers of HTTP responses. Left — simply struck off. */
  subscribers: Set<Subscriber>;
  /** The turn stopped: replay will give the tail and close the connection. */
  done: boolean;
  startedAt: number;
  /** Promise of the turn's end: the queue and "interrupt and send" wait for it. */
  finished: Promise<void>;
  finish: () => void;
};

const turns = new Map<string, Turn>();

/** One key for all: person and conversation. A second turn in the same conversation is impossible. */
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
  // We keep a finished turn that nobody came back for only briefly: it is already written
  // into the conversation, and there is nothing to remember forever. A minute — so the panel has time to reconnect.
  if (turn.done && turn.subscribers.size === 0 && Date.now() - turn.startedAt > 60_000) {
    turns.delete(key(userId, chatId));
    return undefined;
  }
  return turn;
}

/** A new turn event: into memory and to everyone watching right now. */
export function emit(turn: Turn, event: LiveEvent): void {
  turn.events.push(event);
  for (const subscriber of turn.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      // One viewer is sick — the others and the turn itself must not suffer.
      log.warn('чат: подписчик отвалился', { error: String(error) });
    }
  }
}

/** Subscription: first the accumulated tail, then live. Returns an unsubscribe function. */
export function subscribe(turn: Turn, subscriber: Subscriber, replayFrom = 0): () => void {
  const replay = turn.events.slice(replayFrom);
  // Subscribe before replay: an event that arrives in between must not be lost.
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
 * The turn really stopped. Interruption only asks pi to stop, and `busy`
 * is cleared before the turn has finished writing the response: the end must be awaited via this promise.
 */
export function whenTurnDone(turn: Turn): Promise<void> {
  return turn.finished;
}

/** The turn is running right now, not merely replayed a minute ago for a late viewer. */
export function runningTurn(userId: string, chatId: string): Turn | undefined {
  const turn = liveTurn(userId, chatId);
  return turn && !turn.done ? turn : undefined;
}

export function forgetTurn(userId: string, chatId: string): void {
  turns.delete(key(userId, chatId));
}
