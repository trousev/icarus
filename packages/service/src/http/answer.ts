// Buffer for the visible answer. It's needed because of how the client assembles a message:
// it creates a new part (a `content` element) on every channel switch
// content ↔ reasoning_content and renders adjacent parts as separate blocks with
// a gap. So every switch of ours to reasoning or a tool phrase
// cuts the answer — and the cut lands where the model broke off the message
// to call a tool, that is, sometimes mid-word.
//
// Therefore we hold back the unfinished tail of the answer and glue it to the continuation:
// the channel switch happens at a line or sentence boundary, not in the middle
// of a phrase. The price — text comes in sentence-sized chunks rather than letter by letter.

/** How many characters of an unfinished tail we're willing to hold: beyond that, liveliness matters more. */
export const HOLD_LIMIT = 300;

/** Characters after which a phrase is considered finished. */
const SENTENCE_END = '.!?…';

/** Word-forming character: it shows that a chunk was broken off mid-word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Up to what point the tail can be handed over whole: end of line or end of
 * sentence (a mark followed by a space — otherwise "12.10" and "i.e." would break the phrase).
 * Zero — the tail is unfinished, we hold it whole.
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
 * Separator between a held-back tail and the continuation. The model splits the answer into
 * messages (text → tools → text) and may break it mid-word
 * ("renders j" → "javascript") — we glue such a continuation tight,
 * otherwise a hole would appear in the text. We separate a finished phrase with a blank line: for
 * the model this is a new message, not a continuation of the phrase.
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
 * Accumulates the visible text and hands it to the client in finished chunks. The same
 * instance lives for the whole turn: pi sets the chunk boundaries (`text_start` — a new chunk,
 * a thought or a tool — a break), not us.
 */
export class AnswerBuffer {
  private pending = '';
  private newBlock = false;
  private inText = false;
  private sink: (text: string) => void;
  private limit: number;

  /** `limit` — a safeguard on the length of the held-back tail (smaller in tests). */
  constructor(sink: (text: string) => void, limit = HOLD_LIMIT) {
    this.sink = sink;
    this.limit = limit;
  }

  /** pi started a new text chunk: we glue the first delta to the tail. */
  startBlock(): void {
    this.newBlock = true;
    this.inText = false;
  }

  /** The turn switched to reasoning or a tool — the next text will start a new chunk. */
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

  /** The turn is over: we hand over everything we held back. */
  flush(): void {
    this.release(true);
  }

  /** What hasn't gone to the client yet — for tests and logs only. */
  get held(): string {
    return this.pending;
  }

  private release(force: boolean): void {
    if (!this.pending) return;
    let cut = force ? this.pending.length : safeCut(this.pending);
    if (!force && this.pending.length > this.limit) {
      // Safeguard: we don't hold a long paragraph with no boundaries until the end of the turn.
      // We cut at the last space so as not to split a word.
      const space = this.pending.lastIndexOf(' ') + 1;
      cut = space > 0 ? Math.max(cut, space) : this.pending.length;
    }
    if (cut <= 0) return;
    const text = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.sink(text);
  }
}
