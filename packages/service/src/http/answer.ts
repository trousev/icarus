// Буфер видимого ответа. Нужен из-за того, как LibreChat собирает сообщение:
// он заводит новую часть (`content`-элемент) на каждом переключении канала
// content ↔ reasoning_content и рисует соседние части отдельными блоками с
// отступом. Значит, каждое наше переключение на размышления или фразу тула
// разрезает ответ — и разрез попадает туда, где модель оборвала сообщение,
// чтобы позвать тул, то есть иногда посреди слова.
//
// Поэтому незаконченный хвост ответа мы придерживаем и склеиваем с продолжением:
// переключение канала случается на границе строки или предложения, а не посреди
// фразы. Плата — текст идёт кусками по предложению, а не по буквам.

/** Сколько знаков незаконченного хвоста готовы держать: дальше важнее живость. */
export const HOLD_LIMIT = 300;

/** Знаки, после которых фраза считается законченной. */
const SENTENCE_END = '.!?…';

/** Словообразующий символ: по нему видно, что кусок оборван посреди слова. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * До какого места хвост можно отдать целиком: конец строки или конец
 * предложения (знак, а за ним пробел — иначе «12.10» и «т.е.» рвали бы фразу).
 * Ноль — хвост не закончен, держим его целиком.
 */
export function safeCut(text: string): number {
  let cut = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\n') {
      cut = i + 1;
      continue;
    }
    if (!SENTENCE_END.includes(char)) continue;
    let next = i + 1;
    while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next += 1;
    if (next > i + 1) cut = next;
  }
  return cut;
}

/**
 * Разделитель между придержанным хвостом и продолжением. Модель дробит ответ на
 * сообщения (текст → тулы → текст) и может оборвать его посреди слова
 * («рендерится д» → «жаваскриптом») — такое продолжение приклеиваем вплотную,
 * иначе в тексте появится дырка. Законченную фразу отделяем пустой строкой: для
 * модели это новое сообщение, а не продолжение фразы.
 */
export function joinChunks(tail: string, next: string): string {
  if (!tail || !next) return '';
  const last = tail[tail.length - 1];
  if (/\s/.test(last) || /^\s/.test(next)) return '';
  if (SENTENCE_END.includes(last) || last === ':' || last === ';') return '\n\n';
  if (WORD_CHAR.test(last) && WORD_CHAR.test(next[0])) return '';
  return ' ';
}

/**
 * Копит видимый текст и отдаёт его в клиент законченными кусками. Один и тот же
 * экземпляр живёт весь ход: границы кусков задаёт pi (`text_start` — новый кусок,
 * мысль или тул — разрыв), а не мы.
 */
export class AnswerBuffer {
  private pending = '';
  private newBlock = false;
  private inText = false;
  private sink: (text: string) => void;
  private limit: number;

  /** `limit` — предохранитель по длине придержанного хвоста (в тестах меньше). */
  constructor(sink: (text: string) => void, limit = HOLD_LIMIT) {
    this.sink = sink;
    this.limit = limit;
  }

  /** pi начал новый кусок текста: первый delta склеиваем с хвостом. */
  startBlock(): void {
    this.newBlock = true;
    this.inText = false;
  }

  /** Ход переключился на размышления или тул — следующий текст начнёт новый кусок. */
  breakText(): void {
    this.inText = false;
  }

  push(delta: string): void {
    if (this.newBlock || !this.inText) this.pending += joinChunks(this.pending, delta);
    this.newBlock = false;
    this.inText = true;
    this.pending += delta;
    this.release(false);
  }

  /** Ход кончился: отдаём всё, что придержали. */
  flush(): void {
    this.release(true);
  }

  /** Что ещё не ушло клиенту — только для тестов и логов. */
  get held(): string {
    return this.pending;
  }

  private release(force: boolean): void {
    if (!this.pending) return;
    let cut = force ? this.pending.length : safeCut(this.pending);
    if (!force && this.pending.length > this.limit) {
      // Предохранитель: длинный абзац без границ не держим до конца хода.
      // Режем по последнему пробелу, чтобы не разорвать слово.
      const space = this.pending.lastIndexOf(' ') + 1;
      cut = space > 0 ? Math.max(cut, space) : this.pending.length;
    }
    if (cut <= 0) return;
    const text = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.sink(text);
  }
}
