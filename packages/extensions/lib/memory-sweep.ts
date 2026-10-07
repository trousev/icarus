// Ежедневная уборка памяти: чистая логика, которую можно проверить без pi.
//
// В контейнере нет крона: pi-процесс живёт, пока идёт разговор, и гаснет по простою.
// Поэтому уборку запускает расширение после затишья (memory-sweeper.ts), а здесь
// собрано всё остальное — сбор файлов, промпт, разбор плана и его применение.
//
// Главный принцип: уборка НЕ удаляет информацию. Строку можно перенести на другую
// полку или переформулировать/датировать, но не выбросить; файл — только слить с
// другим, при этом всё содержимое переезжает в целевой файл. Поэтому строку адресуют
// не текстом, а парой «номер строки + дословная цитата»: номер — основной ключ,
// цитата — проверка, что он не уехал. Не сошлось — пункт пропускается, а не правит
// соседнюю строку; остальной план при этом применяется, а не отменяется целиком.
//
// Две болезни памяти лечатся здесь же: файлы-близнецы (щенок/собака/дори) сводятся
// слиянием, а разросшиеся файлы модель дробит по темам переносами. Журналы уборка не
// трогает и в промпт не кладёт: только их наличие и объём, чтобы не жечь токены на
// то, с чем всё равно ничего не делает.
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedTarget, isDuplicate, squash } from '../memory-extractor.ts';

export type SweepFile = { path: string; content: string };
/** Журнал в промпт не кладём: только имя, объём и число записей — то есть наличие. */
export type SweepJournal = { path: string; bytes: number; entries: number };
/** Адрес строки: номер из промпта (с 1) и её дословный текст. */
export type SweepAnchor = { index?: number; quote: string };
export type SweepMove = { from: string; to: string; append?: string } & SweepAnchor;
export type SweepRewrite = { file: string; to: string } & SweepAnchor;
/** Слияние файлов-близнецов: содержимое files целиком переезжает в into. */
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
 * Бюджет промпта уборки в символах. Файл показываем целиком или не показываем вовсе:
 * обрезанный хвост модель дочиняет выдумками, а разбить по смыслу огрызок невозможно.
 * Не влезшие файлы перечисляем по именам — в следующий раз уборка начнёт с них.
 */
export const SWEEP_PROMPT_BUDGET = 120_000;

/** Интервал уборки по умолчанию: сутки. */
export const DEFAULT_SWEEP_AFTER_HOURS = 24;

/** Сравнение строк как в экстракторе: маркер списка и вёрстка не в счёт. */
export function normalizeLine(line: string): string {
  return line.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Полка — это место, а не тема: identity.md и preferences.md остаются всегда, их нельзя
 * слить с другим файлом и они не исчезают, даже если строки из них разъехались.
 */
function isShelf(rel: string): boolean {
  return /^(identity|preferences)\.md$/i.test(rel.replace(/^\.\//, '').trim());
}

/** Файл-тема: его можно слить с близнецом, и он исчезает, когда опустел. */
function isTopic(rel: string): boolean {
  return isAllowedTarget(rel) && !isShelf(rel);
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

/** Всё, что уборка читает и правит: постоянные полки и люди. Журналы сюда не входят. */
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
 * Журналы: только наличие. Содержимое в промпт не попадает — журнал не полка уборки,
 * его нельзя ни перенести, ни переписать, а токенов он съедал больше всех.
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
      // файл исчез между чтением и stat — показываем то, что успели прочитать
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
 * Промпт уборки. Правила жёсткие намеренно: модель склонна «наводить порядок»
 * удалением, а нам нужны только перенос, переформулировка и слияние файлов. Строки
 * пронумерованы: по номеру строка находится точно, а цитата нужна, чтобы поймать
 * уехавший номер. Файлы показываем целиком: разбить по смыслу можно только то, что
 * видишь от первой строки до последней, поэтому обрезки здесь нет.
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
 * Удаление — это перенос без цели или переформулировка в пустую строку; слияние
 * удалением не считается, потому что содержимое источников переезжает в цель.
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
        // Себя в источники не берём, повторы не плодим: иначе слияние не имеет смысла.
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
 * половину уборки. Слияния идут первыми: они меняют файлы, но переносы и правки
 * адресуются цитатой, поэтому находят свои строки и после слияния.
 */
export function applySweepPlan(root: string, plan: SweepPlan, now = new Date()): SweepResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const state = new Map<string, string[]>();
  const original = new Map<string, string>();
  /** Файлы, которые исчезнут после успешной записи: источники слияний. */
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

  /**
   * Куда на самом деле едет содержимое: цель слияния может сама уехать в другой файл
   * (щенок → дори, а дори → «собаки»). Иначе строки осели бы в файле, который тут же
   * удаляется, и факты пропали бы. Кольцо (A ← B, B ← A) не разрешаем — слияние мимо.
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
   * Слияние файлов-близнецов: пункт применяется целиком или не применяется вовсе.
   * Сначала читаем все источники, потом переносим строки в цель. Повторы выбрасываем —
   * та же мысль в цели уже есть, — а уникальное переезжает дословно. Источники исчезают
   * в самом конце, после успешной записи цели.
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
      for (const line of lines) {
        if (!line.trim()) continue;
        if (intoLines.some((known) => normalizeLine(known) === normalizeLine(line))) continue;
        // Похожие формулировки — тот же факт: в слитом файле он не нужен дважды.
        // Заголовки так не сравниваем: «# Переезд» и «# Переезд в Порту» — разные шапки.
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
    // Опустевший файл-тему не оставляем пустышкой в панели; полки живут всегда.
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

  // Источники слияний удаляем только после записи целей: сбой записи не должен оставить
  // память без фактов, которые уже уехали из источника.
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
