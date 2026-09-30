// Ежедневная уборка памяти: чистая логика, которую можно проверить без pi.
//
// В контейнере нет крона: pi-процесс живёт, пока идёт разговор, и гаснет по простою.
// Поэтому уборку запускает расширение после затишья (memory-sweeper.ts), а здесь
// собрано всё остальное — сбор файлов, промпт, разбор плана и его применение.
//
// Главный принцип: уборка НЕ удаляет информацию. Строку можно перенести на другую
// полку или переформулировать/датировать, но не выбросить. Поэтому строку адресуют не
// текстом, а парой «номер строки + дословная цитата»: номер — основной ключ, цитата —
// проверка, что он не уехал. Не сошлось — пункт пропускается, а не правит соседнюю
// строку; остальной план при этом применяется, а не отменяется целиком.
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedTarget, isDuplicate, squash } from '../memory-extractor.ts';

export type SweepFile = { path: string; content: string };
/** Адрес строки: номер из промпта (с 1) и её дословный текст. */
export type SweepAnchor = { index?: number; quote: string };
export type SweepMove = { from: string; to: string; append?: string } & SweepAnchor;
export type SweepRewrite = { file: string; to: string } & SweepAnchor;
export type SweepPlan = { moves: SweepMove[]; rewrites: SweepRewrite[]; journal?: string };
export type SweepResult = { changed: string[]; skipped: string[] };
export type SweepState = { lastRunAt?: string };

/** Сколько символов файла показываем модели: память целиком ей не нужна. */
export const SWEEP_FILE_LIMIT = 4000;

/** Интервал уборки по умолчанию: сутки. */
export const DEFAULT_SWEEP_AFTER_HOURS = 24;

/** Сравнение строк как в экстракторе: маркер списка и вёрстка не в счёт. */
export function normalizeLine(line: string): string {
  return line.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Модель иногда копирует строку вместе с номером из промпта («L12: - …») — номер
 * частью текста не является, иначе якорь не сойдётся с файлом.
 */
export function withoutLineNumber(text: string): string {
  return text.replace(/^\s*L\d+:\s?/i, '');
}

/** Строка-пункт: переносим и переписываем только пункты списка. */
function ensureBullet(text: string): string {
  return /^\s*[-*]\s+/.test(text) ? text : `- ${text}`;
}

function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function previousMonth(date: Date): { year: number; month: number } {
  const month = date.getMonth() - 1;
  if (month < 0) return { year: date.getFullYear() - 1, month: 11 };
  return { year: date.getFullYear(), month };
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

/** Всё, что видит уборка: полки и журнал за текущий и прошлый месяц. */
export function collectMemoryFiles(root: string, now = new Date()): SweepFile[] {
  const files: SweepFile[] = [];
  const add = (rel: string): void => {
    const content = readIfExists(path.join(root, rel));
    if (content) files.push({ path: rel, content });
  };

  add('identity.md');
  add('preferences.md');
  for (const name of markdownFiles(path.join(root, 'people'))) add(`people/${name}`);
  for (const name of markdownFiles(path.join(root, 'projects'))) add(`projects/${name}`);

  // Журнал — контекст: по нему видно, что человек уже пережил и что закрыто.
  const prev = previousMonth(now);
  const prevMonth = `${prev.year}-${String(prev.month + 1).padStart(2, '0')}`;
  add(`journal/${monthOf(now)}.md`);
  add(`journal/${prevMonth}.md`);
  return files;
}

/**
 * Промпт уборки. Правила жёсткие намеренно: модель склонна «наводить порядок»
 * удалением, а нам нужен только перенос и переформулировка. Строки пронумерованы:
 * по номеру строка находится точно, а цитата нужна, чтобы поймать уехавший номер.
 */
export function buildSweepPrompt(files: SweepFile[], today = new Date()): string {
  const date = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
  const body = files
    .map((file) => {
      const content =
        file.content.length > SWEEP_FILE_LIMIT
          ? `${file.content.slice(0, SWEEP_FILE_LIMIT).trimEnd()}\n… (файл длиннее, показано начало)`
          : file.content;
      const numbered = content
        .split('\n')
        .map((line, index) => `L${index + 1}: ${line}`)
        .join('\n');
      return `### ${file.path}\n${numbered}`;
    })
    .join('\n\n');

  return `Ты — уборщик долговременной памяти. Ниже файлы памяти, строки пронумерованы. Приведи их в порядок: уведи закрытое и длящееся из identity.md в проектные файлы, датируй изменчивое, сократи формулировки. Но не потеряй ни одного факта.

Как адресовать строку:
- line — её номер из списка (например 12), quote — сама строка дословно, целиком, ровно как в файле.
- Пункт применяется, только если quote совпадает со строкой под этим номером; если не совпало, пункт пропускается, а остальной план применяется. Поэтому копируй quote буквально, не пересказывай и не выдумывай номера.

Что можно:
- moves — перенести строку в другой файл. Поля: from — файл-источник, line и quote — адрес строки, to — целевой файл, append — новая формулировка строки в целевом файле; если текст менять не нужно, не указывай его.
- rewrites — переписать строку на месте. Поля: file, line и quote — адрес строки, to — новая формулировка.
- journal — одна строка о том, что убрано и перенесено.

Чего нельзя:
- Удалять информацию. Строку можно только перенести или переформулировать: факт обязан остаться в памяти.
- Выдумывать факты, которых нет в файлах, и дописывать то, о чём человек не говорил.
- Писать куда-либо, кроме identity.md, preferences.md, people/<имя>.md и projects/<тема>.md.

Правила уборки:
- Закрытые и длящиеся состояния (болезнь, переезд, ремонт, курс, временная работа) уводи из identity.md в projects/<тема>.md.
- Устойчивое (кто человек, где живёт, чем занимается, вкусы, близкие люди) оставляй на месте.
- Датируй то, что меняется: «По состоянию на ДД.ММ.ГГГГ: …». Сомневаешься в дате — пиши «по состоянию на ${date}».
- Не дублируй: если в целевом файле уже есть та же мысль, не переноси её.

Ответ строго одним JSON без пояснений:
{"moves":[{"from":"identity.md","line":12,"quote":"- …","to":"projects/zdorovie.md","append":"- По состоянию на ${date}: …"}],"rewrites":[{"file":"identity.md","line":7,"quote":"- …","to":"- …"}],"journal":"что убрано"}

Сегодня ${date}.

Файлы памяти:
${body}`;
}

/** Номер строки из плана: 12, "12" или "L12". Всё остальное — это цитата старого формата. */
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
 * Цитата-якорь. В новом формате это quote, в старом — сам line (у moves) или from
 * (у rewrites). Без цитаты пункт бесполезен: вслепую по одному номеру память не правим.
 */
function anchorText(quote: unknown, legacy: unknown): string {
  if (typeof quote === 'string' && quote.trim()) return squash(quote);
  if (typeof legacy === 'string' && legacy.trim()) return squash(legacy);
  return '';
}

/**
 * Разбор плана уборки. Неизвестные полки, попытки удаления и пункты без якоря
 * отбрасываются молча: лучше сделать меньше, чем тронуть память непонятно как.
 * Удаление — это перенос без цели или переформулировка в пустую строку.
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
  const source = parsed as { moves?: unknown; rewrites?: unknown; journal?: unknown };

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
  if (moves.length === 0 && rewrites.length === 0 && !journal) return null;
  return { moves, rewrites, journal: journal || undefined };
}

/** Добавляет пункт в конец, не задевая завершающий перевод строки. */
function appendBullet(lines: string[], line: string): void {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  lines.splice(end, 0, line);
}

/**
 * Применяет план. Строку ищет по номеру из промпта и сверяет с цитатой: не сошлось —
 * пункт пропускается, остальные применяются (факт остаётся на месте, терять нечего).
 * Правки идут в памяти, запись на диск — в самом конце, чтобы сбой записи не оставил
 * половину уборки.
 */
export function applySweepPlan(root: string, plan: SweepPlan, now = new Date()): SweepResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const state = new Map<string, string[]>();
  const original = new Map<string, string>();

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
      // Целевой файл может ещё не существовать — перенос создаёт его. Источник обязан быть.
      if (!create) throw new Error(`файл не читается: ${rel}`);
      original.set(rel, '');
      const lines = [''];
      state.set(rel, lines);
      return lines;
    }
  };

  /** Файл может быть неизвестен или не читаться — это повод пропустить пункт, не план. */
  const tryLines = (rel: string, create = false): string[] | null => {
    try {
      return linesOf(rel, create);
    } catch {
      return null;
    }
  };

  /**
   * Номер строки под якорь. Номер из промпта — основной ключ, но применяем его, только
   * если цитата совпала: иначе номер мог уехать (файл дописали) и правка попадёт не туда.
   * Запасной путь — поиск по цитате, и только если такая строка в файле ровно одна:
   * при дублях непонятно, какую править, а угадывать в памяти нельзя.
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

  for (const move of plan.moves) {
    const fromLines = tryLines(move.from);
    const index = fromLines ? resolveLine(fromLines, move) : -1;
    if (!fromLines || index < 0) {
      skipped.push(move.from);
      continue;
    }
    // Без append переносим строку дословно — вместе с цитатой человека, если она есть.
    const movedLine = fromLines[index];
    const targetLine = move.append ? ensureBullet(move.append) : movedLine;

    // Перенос в тот же файл — по сути переформулировка: меняем строку на месте.
    if (move.from === move.to) {
      if (normalizeLine(movedLine) === normalizeLine(targetLine)) {
        skipped.push(move.to);
        continue;
      }
      fromLines[index] = targetLine;
      continue;
    }

    // Цель проверяем ДО правки источника: похожая строка в цели — это повод пропустить
    // перенос, а не потерять факт. Сначала splice, потом проверка — и исходная строка
    // исчезла бы из источника, не появившись в цели.
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
    const next = lines.join('\n');
    if (next === original.get(rel)) continue;
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
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

/** Интервал уборки из окружения: 0 — выключено, мусор и отрицательные — дефолт. */
export function sweepAfterHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_AFTER_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SWEEP_AFTER_HOURS;
  return value;
}

/** Состояние уборки: dot-файл рядом с памятью, но вне её git-репозитория. */
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

/** Пора ли убирать: интервал вышел или отметки ещё нет. 0 часов — выключено. */
export function sweepDue(state: SweepState, now: Date, hours: number): boolean {
  if (hours <= 0) return false;
  if (!state.lastRunAt) return true;
  const last = Date.parse(state.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 3_600_000;
}
