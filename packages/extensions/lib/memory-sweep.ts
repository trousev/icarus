// Daily memory sweep: pure logic that can be tested without pi.
//
// There's no cron in the container: the pi process lives as long as the conversation goes and dies on idle.
// That's why the extension starts the sweep after a lull (memory-sweeper.ts), and everything
// else is gathered here — collecting files, the prompt, parsing the plan and applying it.
//
// The main principle: the sweep does NOT delete information. A line can be moved to another
// shelf or rephrased/dated, but not thrown away; a file can only be merged with
// another, and all content moves into the target file. That's why a line is addressed
// not by text but by a pair "line number + verbatim quote": the number is the primary key,
// the quote is a check that it hasn't shifted. If it doesn't match, the item is skipped rather than editing
// the neighboring line; the rest of the plan is applied, not cancelled entirely.
//
// Two memory diseases are treated right here: twin files (puppy/dog/dory) are consolidated
// by merging, and the model splits overgrown files by topic with moves. The sweep doesn't
// touch journals and doesn't put them in the prompt: only their presence and volume, so as not to burn tokens on
// something it does nothing with anyway.
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedTarget, isDuplicate, squash } from '../memory-extractor.ts';

export type SweepFile = { path: string; content: string };
/** We don't put the journal in the prompt: only the name, volume and entry count — i.e. presence. */
export type SweepJournal = { path: string; bytes: number; entries: number };
/** Line address: the number from the prompt (1-based) and its verbatim text. */
export type SweepAnchor = { index?: number; quote: string };
export type SweepMove = { from: string; to: string; append?: string } & SweepAnchor;
export type SweepRewrite = { file: string; to: string } & SweepAnchor;
/** Merging twin files: the content of files moves entirely into into. */
export type SweepMerge = { into: string; files: string[] };
export type SweepPlan = {
  merges: SweepMerge[];
  moves: SweepMove[];
  rewrites: SweepRewrite[];
  journal?: string;
};
export type SweepResult = { changed: string[]; skipped: string[] };
export type SweepState = { lastRunAt?: string };

/**
 * The sweep prompt budget in characters. We show a file in full or not at all:
 * the model fills in a truncated tail with inventions, and a stump can't be split by meaning.
 * Files that didn't fit are listed by name — next time the sweep will start with them.
 */
export const SWEEP_PROMPT_BUDGET = 120_000;

/** Default sweep interval: one day. */
export const DEFAULT_SWEEP_AFTER_HOURS = 24;

/** Line comparison as in the extractor: the list marker and formatting don't count. */
export function normalizeLine(line: string): string {
  return line.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A shelf is a place, not a topic: identity.md and preferences.md always remain, they can't
 * be merged with another file and they don't disappear even if lines have left them.
 */
function isShelf(rel: string): boolean {
  return /^(identity|preferences)\.md$/i.test(rel.replace(/^\.\//, '').trim());
}

/** A topic file: it can be merged with a twin, and it disappears when it's empty. */
function isTopic(rel: string): boolean {
  return isAllowedTarget(rel) && !isShelf(rel);
}

/**
 * The model sometimes copies a line together with the number from the prompt ("L12: - …") — the number
 * isn't part of the text, otherwise the anchor wouldn't match the file.
 */
export function withoutLineNumber(text: string): string {
  return text.replace(/^\s*L\d+:\s?/i, '');
}

/** A bullet line: we move and rewrite only list items. */
function ensureBullet(text: string): string {
  return /^\s*[-*]\s+/.test(text) ? text : `- ${text}`;
}

/**
 * The file body without frontmatter. On merge the description is metadata, not a fact:
 * otherwise the target file would end up with several `description` entries in a row.
 */
function contentLines(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1 ? lines : lines.slice(end + 1);
}

function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function readIfExists(file: string): string | null {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function markdownFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

/** Everything the sweep reads and edits: permanent shelves and people. Journals aren't included. */
export function collectMemoryFiles(root: string): SweepFile[] {
  const files: SweepFile[] = [];
  const add = (rel: string): void => {
    const content = readIfExists(path.join(root, rel));
    if (content) files.push({ path: rel, content });
  };

  add('identity.md');
  add('preferences.md');
  for (const name of markdownFiles(path.join(root, 'people'))) add(`people/${name}`);
  for (const name of markdownFiles(path.join(root, 'projects'))) add(`projects/${name}`);
  return files;
}

/**
 * Journals: presence only. The content doesn't make it into the prompt — a journal isn't a sweep shelf,
 * it can neither be moved nor rewritten, and it used to eat the most tokens.
 */
export function collectJournals(root: string): SweepJournal[] {
  const dir = path.join(root, 'journal');
  const journals: SweepJournal[] = [];
  for (const name of markdownFiles(dir)) {
    const file = path.join(dir, name);
    const content = readIfExists(file);
    if (!content) continue;
    let bytes = Buffer.byteLength(content, 'utf8');
    try {
      bytes = fs.statSync(file).size;
    } catch {
      // the file disappeared between read and stat — we show what we managed to read
    }
    journals.push({
      path: `journal/${name}`,
      bytes,
      entries: content.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).length,
    });
  }
  return journals;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
}

/**
 * The sweep prompt. The rules are deliberately strict: the model tends to "tidy up"
 * by deleting, while we need only moves, rephrasing and file merging. The lines
 * are numbered: by number a line is found exactly, and the quote is needed to catch
 * a shifted number. We show files in full: you can only split by meaning what you
 * see from the first line to the last, so there's no truncation here.
 */
export function buildSweepPrompt(
  files: SweepFile[],
  today = new Date(),
  journals: SweepJournal[] = [],
): string {
  const date = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;

  const shown: SweepFile[] = [];
  const hidden: SweepFile[] = [];
  let used = 0;
  for (const file of files) {
    if (used + file.content.length > SWEEP_PROMPT_BUDGET) {
      hidden.push(file);
      continue;
    }
    shown.push(file);
    used += file.content.length;
  }

  const body = shown
    .map((file) => {
      const numbered = file.content
        .split('\n')
        .map((line, index) => `L${index + 1}: ${line}`)
        .join('\n');
      return `### ${file.path}\n${numbered}`;
    })
    .join('\n\n');

  const journalsBlock =
    journals.length === 0
      ? ''
      : `

Журналы (только наличие: содержимое не показываем и не трогаем):
${journals.map((journal) => `- ${journal.path} — ${journal.entries} записей, ${kilobytes(journal.bytes)}`).join('\n')}`;

  const hiddenBlock =
    hidden.length === 0
      ? ''
      : `

Не показаны (не влезли в бюджет уборки, в этом прогоне их не трогаем):
${hidden.map((file) => `- ${file.path} — ${file.content.length} символов`).join('\n')}`;

  return `Ты — уборщик долговременной памяти. Ниже файлы памяти, строки пронумерованы. Приведи их в порядок: сведи файлы-близнецы в один, разбей разросшиеся файлы по темам, уведи закрытое и длящееся из identity.md в проектные файлы, датируй изменчивое, сократи формулировки. Но не потеряй ни одного факта.

Как адресовать строку:
- line — её номер из списка (например 12), quote — сама строка дословно, целиком, ровно как в файле.
- Пункт применяется, только если quote совпадает со строкой под этим номером; если не совпало, пункт пропускается, а остальной план применяется. Поэтому копируй quote буквально, не пересказывай и не выдумывай номера.

Что можно:
- merges — слить файлы-близнецы в один. Поля: into — файл, который остаётся, files — файлы, которые в него переезжают. Содержимое переезжает целиком, повторы выбрасываются, лишние файлы исчезают.
- moves — перенести строку в другой файл. Поля: from — файл-источник, line и quote — адрес строки, to — целевой файл, append — новая формулировка строки в целевом файле; если текст менять не нужно, не указывай его.
- rewrites — переписать строку на месте. Поля: file, line и quote — адрес строки, to — новая формулировка.
- journal — одна строка о том, что убрано, слито и перенесено.

Чего нельзя:
- Удалять информацию. Строку можно только перенести или переформулировать, файл — только слить с другим: факт обязан остаться в памяти.
- Выдумывать факты, которых нет в файлах, и дописывать то, о чём человек не говорил.
- Писать куда-либо, кроме identity.md, preferences.md, people/<имя>.md и projects/<тема>.md. Журналы не трогаем вовсе.

Правила уборки:
- Файлы про одно и то же — один файл. Близнецов вида projects/щенок.md, projects/собака.md, projects/дори.md или projects/сеть.md, projects/роутер.md, projects/интернет.md своди через merges: в into бери тот файл, где тема раскрыта полнее, и имя, по которому тему узнает человек.
- Близнецы — это одно и то же под разными именами, а не смежные темы. «Отопление» и «ремонт», «авария» и «здоровье», «финансы» и «инвестиции» — разные дела: сливай, только если оба файла рассказывают про одно и то же.
- Пустой файл-близнец (0 пунктов) — тоже в merges: переносить из него нечего, а имя в панели мозолит глаза.
- Разросшийся файл, где смешались темы, разбей: заведи под темы отдельные файлы и перенеси туда строки через moves. Дроби по смыслу, а не по половине — у каждой части своя тема и своё имя; полностью опустевший файл исчезнет сам.
- Держи файлы короткими: больше 30–40 пунктов в одном файле — сигнал, что пора дробить.
- Закрытые и длящиеся состояния (болезнь, переезд, ремонт, курс, временная работа) уводи из identity.md в projects/<тема>.md.
- Устойчивое (кто человек, где живёт, чем занимается, вкусы, близкие люди) оставляй на месте.
- Датируй то, что меняется: «По состоянию на ДД.ММ.ГГГГ: …». Сомневаешься в дате — пиши «по состоянию на ${date}».
- Не дублируй: если в целевом файле уже есть та же мысль, не переноси её.

Ответ строго одним JSON без пояснений:
{"merges":[{"into":"projects/дори.md","files":["projects/щенок.md","projects/собака.md"]}],"moves":[{"from":"identity.md","line":12,"quote":"- …","to":"projects/zdorovie.md","append":"- По состоянию на ${date}: …"}],"rewrites":[{"file":"identity.md","line":7,"quote":"- …","to":"- …"}],"journal":"что убрано и слито"}

Сегодня ${date}.${journalsBlock}

Файлы памяти:
${body}${hiddenBlock}`;
}

/** Line number from the plan: 12, "12" or "L12". Everything else is an old-format quote. */
export function lineNumberOf(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /^\s*L?(\d+)\s*$/i.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  return number >= 1 ? number : undefined;
}

/**
 * The anchor quote. In the new format it's quote, in the old one it's line itself (for moves) or from
 * (for rewrites). Without a quote the item is useless: we don't edit memory blindly by number alone.
 */
function anchorText(quote: unknown, legacy: unknown): string {
  if (typeof quote === 'string' && quote.trim()) return squash(quote);
  if (typeof legacy === 'string' && legacy.trim()) return squash(legacy);
  return '';
}

/**
 * Parsing the sweep plan. Unknown shelves, deletion attempts and items without an anchor
 * are discarded silently: better to do less than to touch memory in an unclear way.
 * Deletion is a move without a target or a rewrite into an empty line; a merge
 * isn't considered deletion because the sources' content moves into the target.
 */
export function parseSweepPlan(raw: string): SweepPlan | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const source = parsed as { merges?: unknown; moves?: unknown; rewrites?: unknown; journal?: unknown };

  const merges: SweepMerge[] = [];
  if (Array.isArray(source.merges)) {
    for (const item of source.merges) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const { into, files } = record;
      if (typeof into !== 'string' || !isTopic(into)) continue;
      if (!Array.isArray(files)) continue;
      const target = into.trim();
      const sources: string[] = [];
      for (const raw of files) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        // We don't include itself as a source and don't breed duplicates: otherwise the merge makes no sense.
        if (!isTopic(name) || name === target || sources.includes(name)) continue;
        sources.push(name);
      }
      if (sources.length === 0) continue;
      merges.push({ into: target, files: sources });
    }
  }

  const moves: SweepMove[] = [];
  if (Array.isArray(source.moves)) {
    for (const item of source.moves) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const { from, to, append } = record;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      if (!isAllowedTarget(from) || !isAllowedTarget(to)) continue;
      const index = lineNumberOf(record.line);
      const quote = anchorText(record.quote, index === undefined ? record.line : undefined);
      if (!quote) continue;
      const next = typeof append === 'string' ? squash(append) : '';
      moves.push({ from: from.trim(), index, quote, to: to.trim(), append: next || undefined });
    }
  }

  const rewrites: SweepRewrite[] = [];
  if (Array.isArray(source.rewrites)) {
    for (const item of source.rewrites) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const { file, from, to } = record;
      if (typeof file !== 'string' || typeof to !== 'string') continue;
      if (!isAllowedTarget(file)) continue;
      const index = lineNumberOf(record.line);
      const quote = anchorText(record.quote, typeof from === 'string' ? from : record.line);
      const after = squash(to);
      if (!quote || !after) continue;
      rewrites.push({ file: file.trim(), index, quote, to: after });
    }
  }

  const journal = typeof source.journal === 'string' ? squash(source.journal) : '';
  if (merges.length === 0 && moves.length === 0 && rewrites.length === 0 && !journal) return null;
  return { merges, moves, rewrites, journal: journal || undefined };
}

/** Adds an item to the end without disturbing the trailing newline. */
function appendBullet(lines: string[], line: string): void {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  lines.splice(end, 0, line);
}

/**
 * Applies the plan. It looks for a line by the number from the prompt and checks it against the quote: if it doesn't
 * match, the item is skipped and the rest are applied (the fact stays in place, nothing is lost).
 * The edits happen in memory, and writing to disk happens at the very end, so a write failure doesn't leave
 * half a sweep. Merges go first: they change files, but moves and rewrites
 * are addressed by quote, so they find their lines even after a merge.
 */
export function applySweepPlan(root: string, plan: SweepPlan, now = new Date()): SweepResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const state = new Map<string, string[]>();
  const original = new Map<string, string>();
  /** Files that will disappear after a successful write: merge sources. */
  const gone = new Set<string>();

  const linesOf = (rel: string, create = false): string[] => {
    const known = state.get(rel);
    if (known) return known;
    if (!isAllowedTarget(rel)) throw new Error(`неизвестная полка: ${rel}`);
    try {
      const content = fs.readFileSync(path.join(root, rel), 'utf8');
      original.set(rel, content);
      const lines = content.split('\n');
      state.set(rel, lines);
      return lines;
    } catch {
      // The target file may not exist yet — a move creates it. The source must exist.
      if (!create) throw new Error(`файл не читается: ${rel}`);
      original.set(rel, '');
      const lines = [''];
      state.set(rel, lines);
      return lines;
    }
  };

  /** A file may be unknown or unreadable — that's a reason to skip the item, not the plan. */
  const tryLines = (rel: string, create = false): string[] | null => {
    try {
      return linesOf(rel, create);
    } catch {
      return null;
    }
  };

  /**
   * The line number for the anchor. The number from the prompt is the primary key, but we apply it only
   * if the quote matches: otherwise the number could have shifted (the file was appended to) and the edit would land in the wrong place.
   * The fallback is searching by quote, and only if such a line is exactly one in the file:
   * with duplicates it's unclear which to edit, and guessing in memory is not allowed.
   */
  const resolveLine = (lines: string[], anchor: SweepAnchor): number => {
    const needle = normalizeLine(withoutLineNumber(anchor.quote));
    if (!needle) return -1;
    if (anchor.index !== undefined) {
      const at = anchor.index - 1;
      if (at >= 0 && at < lines.length && normalizeLine(lines[at]) === needle) return at;
    }
    const found: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (normalizeLine(lines[index]) === needle) found.push(index);
    }
    return found.length === 1 ? found[0] : -1;
  };

  /**
   * Where the content actually goes: a merge target can itself move into another file
   * (puppy → dory, and dory → "dogs"). Otherwise the lines would settle in a file that's immediately
   * deleted, and the facts would be lost. We don't allow a cycle (A ← B, B ← A) — the merge is dropped.
   */
  const redirect = (rel: string): string | null => {
    const seen = new Set<string>();
    let current = rel;
    for (;;) {
      const owner = plan.merges.find((merge) => merge.files.includes(current));
      if (!owner) return current;
      if (seen.has(current)) return null;
      seen.add(current);
      current = owner.into;
    }
  };

  /**
   * Merging twin files: the item is applied entirely or not at all.
   * First we read all sources, then move the lines into the target. We drop duplicates —
   * the same thought is already in the target — and the unique moves verbatim. Sources disappear
   * at the very end, after a successful write of the target.
   */
  for (const merge of plan.merges) {
    const into = redirect(merge.into);
    const intoLines = into === null ? null : tryLines(into, true);
    const sources = new Map<string, string[]>();
    let ok = intoLines !== null;
    if (ok) {
      for (const file of merge.files) {
        const lines = tryLines(file);
        if (!lines) {
          ok = false;
          break;
        }
        sources.set(file, lines);
      }
    }
    if (!ok || !intoLines) {
      skipped.push(merge.into);
      continue;
    }
    for (const lines of sources.values()) {
      for (const line of contentLines(lines)) {
        if (!line.trim()) continue;
        if (intoLines.some((known) => normalizeLine(known) === normalizeLine(line))) continue;
        // Similar wording is the same fact: it isn't needed twice in a merged file.
        // We don't compare headings this way: "# Moving" and "# Moving to Porto" are different headings.
        if (/^\s*[-*]\s+/.test(line) && isDuplicate(intoLines, line)) continue;
        appendBullet(intoLines, line);
      }
    }
    for (const file of sources.keys()) gone.add(file);
  }

  for (const move of plan.moves) {
    if (gone.has(move.from)) {
      skipped.push(move.from);
      continue;
    }
    const fromLines = tryLines(move.from);
    const index = fromLines ? resolveLine(fromLines, move) : -1;
    if (!fromLines || index < 0) {
      skipped.push(move.from);
      continue;
    }
    // Without append we move the line verbatim — together with the person's quote, if there is one.
    const movedLine = fromLines[index];
    const targetLine = move.append ? ensureBullet(move.append) : movedLine;

    // A move into the same file is essentially a rephrase: we change the line in place.
    if (move.from === move.to) {
      if (normalizeLine(movedLine) === normalizeLine(targetLine)) {
        skipped.push(move.to);
        continue;
      }
      fromLines[index] = targetLine;
      continue;
    }

    // We check the target BEFORE editing the source: a similar line in the target is a reason to skip
    // the move, not to lose the fact. Splice first, check later — and the original line
    // would disappear from the source without appearing in the target.
    const toLines = tryLines(move.to, true);
    if (!toLines) {
      skipped.push(move.to);
      continue;
    }
    if (toLines.some((line) => normalizeLine(line) === normalizeLine(targetLine)) || isDuplicate(toLines, targetLine)) {
      skipped.push(move.to);
      continue;
    }
    fromLines.splice(index, 1);
    appendBullet(toLines, targetLine);
  }

  for (const rewrite of plan.rewrites) {
    if (gone.has(rewrite.file)) {
      skipped.push(rewrite.file);
      continue;
    }
    const lines = tryLines(rewrite.file);
    const index = lines ? resolveLine(lines, rewrite) : -1;
    if (!lines || index < 0) {
      skipped.push(rewrite.file);
      continue;
    }
    const next = ensureBullet(rewrite.to);
    if (normalizeLine(lines[index]) === normalizeLine(next)) {
      skipped.push(rewrite.file);
      continue;
    }
    lines[index] = next;
  }

  for (const [rel, lines] of state) {
    if (gone.has(rel)) continue;
    const next = lines.join('\n');
    if (next === original.get(rel)) continue;
    const file = path.join(root, rel);
    // We don't leave an emptied topic file as an empty shell in the panel; shelves always live.
    if (isTopic(rel) && lines.every((line) => line.trim() === '')) {
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        changed.push(rel);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    changed.push(rel);
  }

  // We delete merge sources only after writing the targets: a write failure must not leave
  // memory without facts that have already left the source.
  for (const rel of gone) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    changed.push(rel);
  }

  if (plan.journal) {
    const rel = `journal/${monthOf(now)}.md`;
    const file = path.join(root, rel);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${monthOf(now)}\n`;
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const entry = `- ${day}.${month} — уборка: ${plan.journal}`;
    if (existing.split('\n').some((line) => normalizeLine(line) === normalizeLine(entry))) {
      skipped.push(rel);
    } else {
      const separator = existing.endsWith('\n') ? '' : '\n';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${existing}${separator}${entry}\n`);
      changed.push(rel);
    }
  }

  return { changed, skipped };
}

/** Sweep interval from the environment: 0 — disabled, garbage and negatives — default. */
export function sweepAfterHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_AFTER_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SWEEP_AFTER_HOURS;
  return value;
}

/** Sweep state: a dot-file next to memory but outside its git repository. */
export function sweepStatePath(workspace: string): string {
  return path.join(workspace, '.sweep.json');
}

export function readSweepState(file: string): SweepState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const { lastRunAt } = parsed as { lastRunAt?: unknown };
    return typeof lastRunAt === 'string' ? { lastRunAt } : {};
  } catch {
    return {};
  }
}

export function writeSweepState(file: string, state: SweepState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether it's time to sweep: the interval has passed or there's no mark yet. 0 hours — disabled. */
export function sweepDue(state: SweepState, now: Date, hours: number): boolean {
  if (hours <= 0) return false;
  if (!state.lastRunAt) return true;
  const last = Date.parse(state.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 3_600_000;
}
