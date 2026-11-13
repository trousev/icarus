// Background extraction of a conversation into memory.
//
// Logic: the conversation goes quiet → the extension calls a cheap model as a separate one-shot
// pi process (no tools and no project context) → the extracted facts are filed onto the shelves,
// the journal is appended, everything is committed to git.
//
// Memory is built only from the person's words. Icarus's replies go into the prompt as context
// (to make sense of short "yes" and "right"), but a fact about the person is only what he said
// or confirmed himself. His own advice and reasoning do not get into memory: without a verbatim
// quote from the user's message the entry is discarded (see applyExtraction).
//
// The extension never writes to family memory: that is only on an explicit request, and the
// agent does it itself with its own tools.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { localDate, localParts, resolveZone } from "./lib/time-core.ts";

const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`;
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

/** We allow writing only to known shelves and only inside memory. */
export function isAllowedTarget(file: string): boolean {
  const normalized = file.replace(/^\.\//, "").trim();
  if (normalized.includes("..") || normalized.startsWith("/")) return false;
  if (/^(identity|preferences)\.md$/i.test(normalized)) return true;
  return /^(people|projects)\/[\p{L}\p{N}._-]+\.md$/u.test(normalized);
}

function normalizeLine(line: string): string {
  return line.replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Spaces and line breaks — into one space: we compare a quote by words, not by layout. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Is the quote verbatim: the evidence must occur in a user message. */
export function isEvidenceOf(evidence: string, entries: TranscriptEntry[]): boolean {
  const needle = squash(evidence);
  if (needle.length === 0) return false;
  return entries.some((entry) => entry.role === 'user' && squash(entry.text).includes(needle));
}

/** Is the quote verbatim: wholly in one person's message or in his words in order. */
export function evidenceInUserWords(
  evidence: string,
  entries: TranscriptEntry[],
  userWords = '',
): boolean {
  const needle = squash(evidence);
  if (needle.length === 0) return false;
  if (isEvidenceOf(needle, entries)) return true;
  // Sometimes the person says the same thing in two messages in a row: a piece assembled from
  // them is not verbatim in a single message. But only from the person's messages — Icarus's words
  // do not mix in here, otherwise his own advice would pass for evidence.
  return squash(userWords).includes(needle);
}

/** Extract JSON from the model response: it likes to wrap it in explanations or ```json. */
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
      // An entry must have a quote from the user's words: without it, it is unknown whose it is,
      // and Icarus's own advice easily gets into memory.
      if (typeof evidence !== "string" || squash(evidence).length === 0) continue;
      notes.push({ file, append: text, evidence: squash(evidence) });
    }
  }
  const journal = typeof source.journal === "string" ? source.journal.trim() : undefined;
  if (notes.length === 0 && !journal) return null;
  return { notes, journal: journal || undefined };
}

/**
 * Index budget in characters. The index is an overview of memory for extraction, not its second
 * copy: files are shown in full while they fit, and the tail of the budget is not inflated.
 */
export const INDEX_BUDGET = 4000;

/**
 * Index of what is already recorded: without it extraction breeds duplicates and twin files.
 *
 * The per-file line cap is removed by default: eight lines used to be enough that on an
 * identity.md with 20+ facts the extraction did not see the later ones and created duplicates.
 * Now the file is shown in full while it fits the budget — and the budget is the limiter.
 * An explicit maxLines remains for callers that need their own cap.
 *
 * The first line holds the names of ALL files: they are cheaper than facts, and without them the
 * extraction did not know the topic was already taken and created projects/сеть.md next to
 * projects/домашняя_сеть.md.
 */
export function memoryIndex(root: string, maxFiles = 25, maxLines = Infinity): string {
  const blocks: string[] = [];

  const names: string[] = [];
  const collectNames = (dir: string, prefix = ''): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'journal') continue; // the journal is not a shelf for extraction
        collectNames(path.join(dir, entry.name), `${rel}/`);
        continue;
      }
      if (entry.name.endsWith('.md')) names.push(rel);
    }
  };
  collectNames(root);

  const list = names.join(', ');
  // The list of names must not eat the whole index: in the worst case we show half.
  const clipped = list.length > INDEX_BUDGET / 2 ? `${list.slice(0, INDEX_BUDGET / 2).trimEnd()}…` : list;
  const header = names.length === 0 ? '' : `Файлы памяти (пиши в существующий, близнецов не заводи): ${clipped}`;
  let used = header ? header.length + 1 : 0;

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

      // The file no longer fits in full: we take as many lines as are left and explicitly mark
      // the tail. Silent truncation is exactly what made the extraction not see the later facts
      // and create duplicates.
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
      return; // the budget is exhausted — the remaining files will not fit anyway
    }
  };

  walk(root);
  return [header, ...blocks].filter((part) => part.length > 0).join('\n');
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

/** Does the new statement resemble one already recorded (protection against rephrased duplicates). */
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

/** The conversation through the eyes of extraction: the user's words are the source, Icarus's replies are only context. */
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
  // The date is by the person's zone, not UTC: otherwise an evening conversation in Dublin
  // slips into yesterday, and "recently" is dated to the wrong day.
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
- Не повторяй то, что уже записано, и не заводи второй файл про то же самое: если тема
  уже есть в списке файлов — пиши в существующий, даже если он назван иначе.
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

/** Files facts onto the shelves without breeding duplicates. */
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

  // We check the evidence only against the person's words: Icarus's replies do not enter this
  // check, otherwise his own advice would come back into memory as a fact about the interlocutor.
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
    // Next to the fact we leave its source — the person's phrase. This is not decoration:
    // it shows later where the entry came from, and it will not be put down to Icarus's invention.
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

/** Memory is a git repository: we initialize it and set up a local identity. */
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

/** One-shot call of the cheap model: no tools, no session, no extension of our own. */
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
      // The working directory is the service one: the relative paths of a one-shot run
      // must not end up in the person's free space.
      { cwd: ICARUS, stdio: ["ignore", "pipe", "pipe"] },
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
    // We keep the replies with their roles all the way to the prompt: the extraction must see
    // who said what, otherwise Icarus's advice easily gets into memory as a fact about the person.
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
