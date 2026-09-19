// Фоновый разбор разговора в память.
//
// Логика: разговор затихает → расширение зовёт дешёвую модель отдельным одноразовым
// процессом pi (без тулов и без контекста проекта) → полученные факты раскладываются
// по полкам, журнал дописывается, всё коммитится в git.
//
// В семейную память расширение не пишет никогда: туда только по явной просьбе, и это
// делает сам агент своими тулами.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";
const WORKSPACE = process.env.ICARUS_WORKSPACE ?? "/workspace";
const MODEL = process.env.ICARUS_EXTRACT_MODEL ?? "deepseek/deepseek-v4-flash";
const QUIET_MS = Number(process.env.ICARUS_EXTRACT_AFTER_MS ?? 90_000);
const MAX_TRANSCRIPT = 6000;

export type Fact = { file: string; append: string };
export type Extraction = { journal?: string; notes: Fact[] };
export type ApplyResult = { changed: string[]; skipped: string[]; rejected: string[] };

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
      const { file, append } = note as { file?: unknown; append?: unknown };
      if (typeof file !== "string" || typeof append !== "string") continue;
      const text = append.trim();
      if (!text) continue;
      notes.push({ file, append: text });
    }
  }
  const journal = typeof source.journal === "string" ? source.journal.trim() : undefined;
  if (notes.length === 0 && !journal) return null;
  return { notes, journal: journal || undefined };
}

/** Индекс уже записанного: без него разбор плодит дубликаты и файлы-близнецы. */
export function memoryIndex(root: string, maxFiles = 25, maxLines = 8): string {
  const lines: string[] = [];
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
      if (lines.length >= maxFiles) return;
      const bulletLines = fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+/.test(line))
        .slice(0, maxLines);
      if (bulletLines.length === 0) continue;
      lines.push(`${prefix}${entry.name}:\n${bulletLines.map((line) => `    ${line}`).join('\n')}`);
    }
  };
  walk(root);
  return lines.join('\n');
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

export function buildExtractionPrompt(transcript: string, today = new Date(), index = ''): string {
  const date = today.toISOString().slice(0, 10);
  const indexBlock = index
    ? `\nВот что уже записано. Если факт уже есть — не повторяй его. Если уточняет — пиши в тот же файл, путь бери ровно отсюда:\n${index}\n`
    : '\nПамять пока пуста.\n';
  return `Ты — подсистема памяти. Ниже кусок разговора. Вытащи из него только то, что стоит помнить надолго.

Правила:
- Личное и бытовое — да. Секреты, пароли, номера карт — нет.
- Не выдумывай: если факта в разговоре нет, не добавляй.
- Пиши короткими строками в виде пунктов списка, от третьего лица или безлично.
- Не повторяй то, что уже записано, и не заводи второй файл про то же самое.
- Если помнить нечего — верни пустые notes и journal.
${indexBlock}
Куда писать (поле file):
- identity.md — кто человек, где живёт, чем занимается
- preferences.md — вкусы, привычки, как с ним разговаривать
- people/<имя>.md — конкретный человек
- projects/<тема>.md — долгая тема или дело

Ответ строго одним JSON без пояснений:
{"journal": "одна строка о том, что было в разговоре", "notes": [{"file": "preferences.md", "append": "- Кофе пьёт без сахара"}]}

Сегодня ${date}.

Разговор:
${transcript}`;
}

/** Раскладывает факты по полкам, не плодя дубликатов. */
export function applyExtraction(root: string, extraction: Extraction, now = new Date()): ApplyResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];

  for (const note of extraction.notes) {
    if (!isAllowedTarget(note.file)) {
      rejected.push(note.file);
      continue;
    }
    const target = path.join(root, note.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const existingLines = existing.split("\n");
    const known = new Set(existingLines.map(normalizeLine));
    if (known.has(normalizeLine(note.append)) || isDuplicate(existingLines, note.append)) {
      skipped.push(note.file);
      continue;
    }
    const line = note.append.startsWith("-") ? note.append : `- ${note.append}`;
    const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(target, `${existing}${separator}${line}\n`);
    changed.push(note.file);
  }

  if (extraction.journal) {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const dir = path.join(root, "journal");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${month}.md`);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : `# ${month}\n`;
    const day = String(now.getDate()).padStart(2, "0");
    const monthNumber = String(now.getMonth() + 1).padStart(2, "0");
    const entry = `- ${day}.${monthNumber} — ${extraction.journal.replace(/\s+/g, " ").trim()}`;
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
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const runExtraction = async () => {
    if (running || pending.length === 0) return;
    running = true;
    const transcript = pending.join("\n").slice(-MAX_TRANSCRIPT);
    pending = [];
    try {
      const raw = await runOneShot(buildExtractionPrompt(transcript, new Date(), memoryIndex(MEMORY)));
      const extraction = parseExtraction(raw);
      if (!extraction) {
        log("модель не вернула разбираемый JSON — пропускаю");
        return;
      }
      const result = applyExtraction(MEMORY, extraction);
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
    const role = (event.message as { role?: string })?.role === "user" ? "Пользователь" : "Икар";
    pending.push(`${role}: ${text}`);
  });

  pi.on("agent_start", () => cancel());

  pi.on("agent_settled", () => {
    cancel();
    timer = setTimeout(() => void runExtraction(), QUIET_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => cancel());
}
