// Фоновый разбор разговора в память.
//
// Логика: разговор затихает → расширение зовёт дешёвую модель отдельным одноразовым
// процессом pi (без тулов и без контекста проекта) → полученные факты раскладываются
// по полкам, журнал дописывается, всё коммитится в git.
//
// Память строится только из слов человека. Реплики Икара идут в промпт как контекст
// (чтобы понять короткие «да» и «верно»), но факт о человеке — это лишь то, что он сказал
// или подтвердил сам. Его собственные советы и рассуждения в память не попадают: без
// дословной цитаты из реплики пользователя запись отбрасывается (см. applyExtraction).
//
// В семейную память расширение не пишет никогда: туда только по явной просьбе, и это
// делает сам агент своими тулами.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { localDate, localParts, resolveZone } from "./lib/time-core.ts";

const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";
const WORKSPACE = process.env.ICARUS_WORKSPACE ?? "/workspace";
const MODEL = process.env.ICARUS_EXTRACT_MODEL ?? "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash";
const QUIET_MS = Number(process.env.ICARUS_EXTRACT_AFTER_MS ?? 90_000);
const MAX_TRANSCRIPT = 6000;

export type Fact = { file: string; append: string; evidence?: string };
export type Extraction = { journal?: string; notes: Fact[] };
export type ApplyResult = { changed: string[]; skipped: string[]; rejected: string[] };
export type TranscriptEntry = { role: 'user' | 'assistant'; text: string };

function log(message: string): void {
  process.stderr.write(`[memory-extractor] ${message}\n`);
}

/** Разрешаем писать только в известные полки и только внутрь памяти. */
export function isAllowedTarget(file: string): boolean {
  const normalized = file.replace(/^\.\//, "").trim();
  if (normalized.includes("..") || normalized.startsWith("/")) return false;
  if (/^(identity|preferences)\.md$/i.test(normalized)) return true;
  return /^(people|projects)\/[\p{L}\p{N}._-]+\.md$/u.test(normalized);
}

function normalizeLine(line: string): string {
  return line.replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Пробелы и переводы строк — в один пробел: цитату сверяем по словам, не по вёрстке. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Дословная ли цитата: свидетельство обязано встретиться в реплике пользователя. */
export function isEvidenceOf(evidence: string, entries: TranscriptEntry[]): boolean {
  const needle = squash(evidence);
  if (needle.length === 0) return false;
  return entries.some((entry) => entry.role === 'user' && squash(entry.text).includes(needle));
}

/** Дословная ли цитата: в одной реплике человека целиком или в его словах по порядку. */
export function evidenceInUserWords(
  evidence: string,
  entries: TranscriptEntry[],
  userWords = '',
): boolean {
  const needle = squash(evidence);
  if (needle.length === 0) return false;
  if (isEvidenceOf(needle, entries)) return true;
  // Иногда человек говорит одно и то же двумя репликами подряд: кусок, собранный из них,
  // дословно в одной реплике не лежит. Но только из реплик человека — слова Икара сюда
  // не подмешиваются, иначе его же совет сойдёт за свидетельство.
  return squash(userWords).includes(needle);
}

/** Достаём JSON из ответа модели: она любит обернуть его в пояснения или ```json. */
export function parseExtraction(raw: string): Extraction | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as { journal?: unknown; notes?: unknown };
  const notes: Fact[] = [];
  if (Array.isArray(source.notes)) {
    for (const note of source.notes) {
      if (!note || typeof note !== "object") continue;
      const { file, append, evidence } = note as {
        file?: unknown;
        append?: unknown;
        evidence?: unknown;
      };
      if (typeof file !== "string" || typeof append !== "string") continue;
      const text = append.trim();
      if (!text) continue;
      // У записи обязана быть цитата из слов пользователя: без неё неизвестно, чей это
      // факт, и в память легко уедет совет самого Икара.
      if (typeof evidence !== "string" || squash(evidence).length === 0) continue;
      notes.push({ file, append: text, evidence: squash(evidence) });
    }
  }
  const journal = typeof source.journal === "string" ? source.journal.trim() : undefined;
  if (notes.length === 0 && !journal) return null;
  return { notes, journal: journal || undefined };
}

/**
 * Бюджет индекса в символах. Индекс — обзор памяти для разбора, а не её второй
 * экземпляр: файлы показываем целиком, пока влезают, и хвост бюджета не раздуваем.
 */
export const INDEX_BUDGET = 4000;

/**
 * Индекс уже записанного: без него разбор плодит дубликаты и файлы-близнецы.
 *
 * Потолок строк на файл по умолчанию снят: раньше восьми строк хватало, чтобы на
 * identity.md в 20+ фактов разбор не видел поздние и заводил дубли. Теперь файл
 * показывается целиком, пока влезает в бюджет, — а бюджет и есть ограничитель.
 * Явный maxLines остаётся для вызывающих, которым нужен свой потолок.
 */
export function memoryIndex(root: string, maxFiles = 25, maxLines = Infinity): string {
  const blocks: string[] = [];
  let used = 0;

  const walk = (dir: string, prefix = ''): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.md') || entry.name === 'journal' || prefix === 'journal/') continue;
      if (blocks.length >= maxFiles) return;
      const bullets = fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+/.test(line))
        .slice(0, maxLines);
      if (bullets.length === 0) continue;

      const header = `${prefix}${entry.name}:`;
      const rendered = bullets.map((line) => `    ${line}`);
      const separator = blocks.length === 0 ? 0 : 1;
      const whole = separator + header.length + 1 + rendered.join('\n').length;
      if (used + whole <= INDEX_BUDGET) {
        blocks.push(`${header}\n${rendered.join('\n')}`);
        used += whole;
        continue;
      }

      // Файл целиком уже не влезает: добираем столько строк, сколько осталось, и прямо
      // помечаем хвост. Молчаливая обрезка — ровно то, из-за чего разбор не видел
      // поздние факты и заводил дубли.
      const fits: string[] = [];
      for (const line of rendered) {
        const hidden = bullets.length - fits.length - 1;
        const marker = hidden > 0 ? `\n    … ещё ${hidden} пункт(ов): файл целиком по пути` : '';
        const candidate = `${header}\n${[...fits, line].join('\n')}${marker}`;
        if (used + separator + candidate.length > INDEX_BUDGET) break;
        fits.push(line);
      }
      if (fits.length === 0) return;
      const hidden = bullets.length - fits.length;
      const marker = hidden > 0 ? `\n    … ещё ${hidden} пункт(ов): файл целиком по пути` : '';
      blocks.push(`${header}\n${fits.join('\n')}${marker}`);
      return; // бюджет исчерпан — остальные файлы в него уже не влезут
    }
  };

  walk(root);
  return blocks.join('\n');
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

/** Похоже ли новое утверждение на уже записанное (защита от перефразированных дублей). */
export function isDuplicate(existing: string[], candidate: string, threshold = 0.7): boolean {
  const fresh = tokens(candidate);
  if (fresh.size === 0) return true;
  for (const line of existing) {
    const known = tokens(line);
    if (known.size === 0) continue;
    let shared = 0;
    for (const token of fresh) if (known.has(token)) shared += 1;
    if (shared / Math.min(fresh.size, known.size) >= threshold) return true;
  }
  return false;
}

/** Разговор глазами разбора: слова пользователя — источник, реплики Икара — только контекст. */
export function formatTranscript(entries: TranscriptEntry[], limit = MAX_TRANSCRIPT): string {
  const lines = entries
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => {
      const who = entry.role === 'user' ? 'ЧЕЛОВЕК' : 'ИКАР (контекст, не источник)';
      return `${who}: ${entry.text.trim()}`;
    });
  return lines.join('\n\n').slice(-limit);
}

export function buildExtractionPrompt(
  transcript: string | TranscriptEntry[],
  today = new Date(),
  index = '',
  // Дата — по поясу человека, а не по UTC: иначе вечерний разговор в Дублине
  // уезжает во вчера, и «недавно» датируется не тем днём.
  zone: string = resolveZone(),
): string {
  const date = localDate(today, zone);
  const entries: TranscriptEntry[] =
    typeof transcript === 'string' ? [{ role: 'user', text: transcript }] : transcript;
  const lines = formatTranscript(entries);
  const hasUserWords = entries.some((entry) => entry.role === 'user' && entry.text.trim());
  const indexBlock = index
    ? `\nВот что уже записано. Если факт уже есть — не повторяй его. Если уточняет — пиши в тот же файл, путь бери ровно отсюда:\n${index}\n`
    : '\nПамять пока пуста.\n';
  return `Ты — подсистема памяти. Ниже кусок разговора. Вытащи из него только то, что стоит помнить надолго.
Память строится ТОЛЬКО из слов человека. Реплики Икара — это контекст, а не факты о человеке.

Правила:
- Источник каждой записи — прямая реплика человека или его явное согласие с чем-то
  осмысленным (короткие «да», «верно», «именно так» читай вместе с вопросом Икара перед
  ними). Больше ниоткуда факты не берутся.
- Совет, рекомендация, объяснение, пример или вывод Икара — это НЕ факт о человеке.
  Советует Икар заваривать чай при 70 °C — это не значит, что человек так делает: пока он
  сам этого не сказал, в память это не идёт.
- Не додумывай по «здравому смыслу»: выбор, вкус, привычка или план человека должны быть
  сказаны или подтверждены им самим. Сомневаешься, говорил ли он это, — не пиши.
- У каждой записи должна быть дословная цитата из слов человека (поле evidence): целая его
  реплика или кусок подряд. Короткое «да», «верно», «именно так» в ответ на вопрос Икара —
  годится. Слова самого Икара цитатой быть не могут: если человек только попросил «запомни
  это» про твой совет, факта о нём здесь нет. Цитаты нет — запись отбрасывается.
- Личное и бытовое — да. Секреты, пароли, номера карт — нет.
- Пиши короткими строками в виде пунктов списка, от третьего лица или безлично.
- Не повторяй то, что уже записано, и не заводи второй файл про то же самое.
- Разовая просьба («найди», «переведи») — это не факт о человеке. Но если он сам назвал
  признак, привычку, вкус или постоянное дело — это факт.
- Устойчивое и временное — по разным полкам. Устойчивое (кто человек, где живёт, характер,
  вкусы, привычки, люди вокруг) идёт в identity.md, preferences.md, people/. Временное и
  длящееся (здоровье и восстановление, бумаги и заявки, поиск работы, переезд, ремонт, сроки)
  идёт в projects/<тема>.md датированными строками состояния, а не в identity.md: «недавно
  была операция на глазу» — это не черта характера.
- Относительное время из слов человека («недавно», «на прошлой неделе», «полгода назад»,
  «только что») переводи в абсолютную дату от сегодняшнего числа. Снимок состояния начинается
  со слов «по состоянию на 21.09.2026 — …», начавшееся — с «с 21.09.2026 …». Без даты запись
  через полгода читается как сегодняшняя.
- Если помнить нечего — верни пустые notes и journal.
${indexBlock}
Куда писать (поле file):
- identity.md — кто человек, где живёт, чем занимается; только устойчивое
- preferences.md — вкусы, привычки, как с ним разговаривать
- people/<имя>.md — конкретный человек
- projects/<тема>.md — длящееся дело или временное состояние: здоровье, бумаги и заявки,
  работа, переезд, ремонт, сроки. Строкой с датой: «- По состоянию на 21.09.2026 — подал на
  гражданство, идёт рассмотрение»

Ответ строго одним JSON без пояснений:
{"journal": "одна строка о том, что было в разговоре", "notes": [{"file": "preferences.md", "append": "- Кофе пьёт без сахара", "evidence": "я без сахара пью"}, {"file": "projects/здоровье.md", "append": "- По состоянию на 21.09.2026 — была операция на глазу", "evidence": "недавно была операция на глазу"}]}

Если человек в этом куске разговора ничего не сказал сам${hasUserWords ? '' : ' (а здесь его слов нет)'} — notes и journal пустые.

Сегодня ${date} — от этого дня и считай относительное время.

Разговор:
${lines}`;
}

/** Раскладывает факты по полкам, не плодя дубликатов. */
export function applyExtraction(
  root: string,
  extraction: Extraction,
  now = new Date(),
  userEntries: TranscriptEntry[] = [],
  zone: string = resolveZone(),
): ApplyResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];

  // Свидетельство сверяем только со словами человека: реплики Икара в эту проверку не
  // попадают, иначе его же совет вернулся бы в память как факт о собеседнике.
  const userWords = userEntries
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.text)
    .join('\n');

  for (const note of extraction.notes) {
    if (!isAllowedTarget(note.file)) {
      rejected.push(note.file);
      continue;
    }
    if (
      userEntries.length > 0 &&
      (!note.evidence || !evidenceInUserWords(note.evidence, userEntries, userWords))
    ) {
      log(`отклоняю запись без слов человека в подтверждение: ${note.append}`);
      rejected.push(note.file);
      continue;
    }
    const target = path.join(root, note.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const existingLines = existing.split("\n");
    const known = new Set(existingLines.map(normalizeLine));
    const line = note.append.startsWith("-") ? note.append : `- ${note.append}`;
    if (known.has(normalizeLine(line)) || isDuplicate(existingLines, line)) {
      skipped.push(note.file);
      continue;
    }
    // Рядом с фактом оставляем его источник — фразу человека. Это не украшение:
    // по ней потом видно, откуда запись взялась, и её не спишут на выдумку Икара.
    const quote = note.evidence ? ` (его слова: «${note.evidence.replace(/[»\n\r]/g, " ")}»)` : "";
    const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(target, `${existing}${separator}${line}${quote}\n`);
    changed.push(note.file);
  }

  if (extraction.journal) {
    const { year, month: monthNumber, day: dayNumber } = localParts(now, zone);
    const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
    const dir = path.join(root, "journal");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${month}.md`);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : `# ${month}\n`;
    const day = String(dayNumber).padStart(2, "0");
    const monthNumberText = String(monthNumber).padStart(2, "0");
    const entry = `- ${day}.${monthNumberText} — ${extraction.journal.replace(/\s+/g, " ").trim()}`;
    const known = new Set(existing.split("\n").map(normalizeLine));
    if (!known.has(normalizeLine(entry))) {
      const separator = existing.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(target, `${existing}${separator}${entry}\n`);
      changed.push(`journal/${month}.md`);
    } else {
      skipped.push(`journal/${month}.md`);
    }
  }

  return { changed, skipped, rejected };
}

function git(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Память — git-репозиторий: инициализируем и настраиваем локальную личность. */
export async function ensureRepo(root: string): Promise<void> {
  if (!fs.existsSync(path.join(root, ".git"))) {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "icarus@localhost"]);
    await git(root, ["config", "user.name", "Icarus"]);
    log(`репозиторий памяти создан: ${root}`);
  }
}

export async function commitMemory(root: string, message: string): Promise<boolean> {
  await ensureRepo(root);
  await git(root, ["add", "-A"]);
  const result = await git(root, ["commit", "-q", "-m", message]);
  if (result.code !== 0) {
    if (/nothing to commit/i.test(result.stdout + result.stderr)) return false;
    log(`коммит не удался: ${result.stderr.trim()}`);
    return false;
  }
  return true;
}

/** Одноразовый вызов дешёвой модели: без тулов, без сессии, без нашего же расширения. */
export function runOneShot(prompt: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "-p",
        prompt,
        "--model",
        MODEL,
        "--no-tools",
        "--no-session",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
      ],
      { cwd: WORKSPACE, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("таймаут разбора"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`pi завершился с кодом ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

function textOf(message: unknown): string {
  const source = (message ?? {}) as { role?: string; content?: unknown };
  if (source.role !== "user" && source.role !== "assistant") return "";
  const { content } = source;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let pending: TranscriptEntry[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const runExtraction = async () => {
    if (running || pending.length === 0) return;
    running = true;
    const entries = pending;
    pending = [];
    // Реплики храним с ролями до самого промпта: разбор должен видеть, кто что сказал,
    // иначе совет Икара легко уезжает в память как факт о человеке.
    try {
      const raw = await runOneShot(
        buildExtractionPrompt(entries, new Date(), memoryIndex(MEMORY)),
      );
      const extraction = parseExtraction(raw);
      if (!extraction) {
        log("модель не вернула разбираемый JSON — пропускаю");
        return;
      }
      const result = applyExtraction(MEMORY, extraction, new Date(), entries);
      if (result.changed.length === 0) {
        log(`новых фактов нет (пропущено ${result.skipped.length})`);
        return;
      }
      const committed = await commitMemory(
        MEMORY,
        `memory: разбор разговора (${result.changed.length} файлов)`,
      );
      log(
        `записано: ${result.changed.join(", ")}${committed ? "" : " (без коммита)"}${
          result.rejected.length > 0 ? ` | отклонено: ${result.rejected.join(", ")}` : ""
        }`,
      );
    } catch (error) {
      log(`разбор сорвался: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  pi.on("message_end", (event) => {
    const text = textOf(event.message);
    if (!text) return;
    const role = (event.message as { role?: string })?.role === "user" ? "user" : "assistant";
    pending.push({ role, text });
  });

  pi.on("agent_start", () => cancel());

  pi.on("agent_settled", () => {
    cancel();
    timer = setTimeout(() => void runExtraction(), QUIET_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => cancel());
}
