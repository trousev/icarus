// Ежедневная уборка памяти: чистая логика, которую можно проверить без pi.
//
// В контейнере нет крона: pi-процесс живёт, пока идёт разговор, и гаснет по простою.
// Поэтому уборку запускает расширение после затишья (memory-sweeper.ts), а здесь
// собрано всё остальное — сбор файлов, промпт, разбор плана и его применение.
//
// Главный принцип: уборка НЕ удаляет информацию. Строку можно перенести на другую
// полку или переформулировать/датировать, но не выбросить. Любая непонятная ситуация
// (неизвестный файл, строка не найдена, мусорный JSON) оставляет память нетронутой.
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedTarget, isDuplicate, squash } from '../memory-extractor.ts';

export type SweepFile = { path: string; content: string };
export type SweepMove = { from: string; line: string; to: string; append?: string };
export type SweepRewrite = { file: string; from: string; to: string };
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
 * удалением, а нам нужен только перенос и переформулировка.
 */
export function buildSweepPrompt(files: SweepFile[], today = new Date()): string {
  const date = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
  const body = files
    .map((file) => {
      const content =
        file.content.length > SWEEP_FILE_LIMIT
          ? `${file.content.slice(0, SWEEP_FILE_LIMIT).trimEnd()}\n… (файл длиннее, показано начало)`
          : file.content;
      return `### ${file.path}\n${content}`;
    })
    .join('\n\n');

  return `Ты — уборщик долговременной памяти. Ниже файлы памяти. Приведи их в порядок: уведи закрытое и длящееся из identity.md в проектные файлы, датируй изменчивое, сократи формулировки. Но не потеряй ни одного факта.

Что можно:
- moves — перенести строку в другой файл. Поле line обязано дословно совпадать с существующей строкой, поле from — её файл. Поле append — новая формулировка строки в целевом файле; если текст менять не нужно, не указывай его.
- rewrites — переписать строку на месте. Поле from обязано дословно совпадать с существующей строкой.
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
{"moves":[{"from":"identity.md","line":"- …","to":"projects/zdorovie.md","append":"- По состоянию на ${date}: …"}],"rewrites":[{"file":"identity.md","from":"- …","to":"- …"}],"journal":"что убрано"}

Сегодня ${date}.

Файлы памяти:
${body}`;
}

/**
 * Разбор плана уборки. Неизвестные полки и попытки удаления отбрасываются молча:
 * лучше сделать меньше, чем тронуть память непонятно как. Удаление — это перенос
 * без цели или переформулировка в пустую строку.
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
      const { from, line, to, append } = record;
      if (typeof from !== 'string' || typeof line !== 'string' || typeof to !== 'string') continue;
      if (!isAllowedTarget(from) || !isAllowedTarget(to)) continue;
      const text = squash(line);
      if (!text) continue;
      const next = typeof append === 'string' ? squash(append) : '';
      moves.push({ from: from.trim(), line: text, to: to.trim(), append: next || undefined });
    }
  }

  const rewrites: SweepRewrite[] = [];
  if (Array.isArray(source.rewrites)) {
    for (const item of source.rewrites) {
      if (!item || typeof item !== 'object') continue;
      const { file, from, to } = item as Record<string, unknown>;
      if (typeof file !== 'string' || typeof from !== 'string' || typeof to !== 'string') continue;
      if (!isAllowedTarget(file)) continue;
      const before = squash(from);
      const after = squash(to);
      if (!before || !after) continue;
      rewrites.push({ file: file.trim(), from: before, to: after });
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
 * Применяет план. Сначала все проверки и правки в памяти, запись на диск — в самом
 * конце: ошибка на любом шаге означает, что не изменён ни один файл. Ровно поэтому
 * функция бросает исключение, а не возвращает половину применённого плана.
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

  const findLine = (lines: string[], needle: string): number => {
    const target = normalizeLine(needle);
    return lines.findIndex((line) => normalizeLine(line) === target);
  };

  for (const move of plan.moves) {
    const fromLines = linesOf(move.from);
    const index = findLine(fromLines, move.line);
    if (index < 0) throw new Error(`строка не найдена в ${move.from}: ${move.line}`);
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
    const toLines = linesOf(move.to, true);
    if (toLines.some((line) => normalizeLine(line) === normalizeLine(targetLine)) || isDuplicate(toLines, targetLine)) {
      skipped.push(move.to);
      continue;
    }
    fromLines.splice(index, 1);
    appendBullet(toLines, targetLine);
  }

  for (const rewrite of plan.rewrites) {
    const lines = linesOf(rewrite.file);
    const index = findLine(lines, rewrite.from);
    if (index < 0) throw new Error(`строка не найдена в ${rewrite.file}: ${rewrite.from}`);
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
