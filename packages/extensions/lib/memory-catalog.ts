// Каталог памяти: файлы и их короткие описания.
//
// Два шага вместо поиска: сначала инструмент отдаёт список файлов с описаниями,
// потом модель сама решает, что читать. Описание живёт в frontmatter файла:
//
//   ---
//   description: проекты про Arduino и мигающие диоды
//   ---
//   - факт...
//
// Так индекс не надо вести отдельно: описание едет вместе с файлом, и модель
// обновляет его тем же инструментом, когда содержимое изменилось.
import fs from "node:fs";
import path from "node:path";

const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`;
const DESCRIPTION_LIMIT = 200;

export type MemoryFile = {
  rel: string;
  abs: string;
  description: string;
  hasDescription: boolean;
  lines: number;
};

export type UpdateResult = { ok: true; file: string } | { ok: false; error: string };

function filesIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesIn(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Значение `description` из frontmatter. Нет блока — пусто. Понимает и голую
 * строку без ключа (`---\nпро Arduino\n---`): так тоже пишут руками.
 */
export function descriptionOf(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return "";
  let bare = "";
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") break;
    const match = /^description\s*:\s*(.*)$/i.exec(line);
    if (match) return (match[1] ?? "").trim();
    if (!bare && line.trim() && !/^[A-Za-z0-9_-]+\s*:/.test(line.trim())) bare = line.trim();
  }
  return bare;
}

/** Убирает frontmatter: в ядро и в текст фактов описание не едет. */
export function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return text;
  return lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT);
}

/**
 * Обновляет или добавляет `description` в frontmatter, не трогая остальные ключи
 * и тело файла. Описание всегда одна строка: индекс не должен разъезжаться.
 */
export function withDescription(text: string, description: string): string {
  const clean = cleanDescription(description);
  if (!clean) throw new Error("описание пустое");
  const lines = text.split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end !== -1) {
      const front = lines.slice(1, end);
      const at = front.findIndex((line) => /^description\s*:/i.test(line));
      const entry = `description: ${clean}`;
      if (at === -1) front.unshift(entry);
      else front[at] = entry;
      return ["---", ...front, "---", ...lines.slice(end + 1)].join("\n");
    }
  }
  return ["---", `description: ${clean}`, "---", "", text.replace(/^\n+/, "")].join("\n");
}

/** Понятное описание, когда его ещё не написали: индекс не должен быть пустым. */
function fallbackDescription(rel: string): string {
  if (rel === "identity.md") return "кто он: имя, город, семья, работа";
  if (rel === "preferences.md") return "вкусы, привычки, табу";
  const journal = /^journal\/(\d{4})-(\d{2})\.md$/.exec(rel);
  if (journal) return `журнал за ${journal[2]}.${journal[1]}`;
  if (rel.startsWith("people/")) return `человек: ${path.basename(rel, ".md")}`;
  if (rel.startsWith("projects/")) return `тема: ${path.basename(rel, ".md")}`;
  return "(без описания)";
}

function orderOf(rel: string): number {
  if (rel === "identity.md") return 0;
  if (rel === "preferences.md") return 1;
  if (rel.startsWith("people/")) return 2;
  if (rel.startsWith("projects/")) return 3;
  if (rel.startsWith("journal/")) return 4;
  return 5;
}

/** Файлы памяти с описаниями. Пустые файлы в индекс не берём: читать там нечего. */
export function buildCatalog(root = MEMORY): MemoryFile[] {
  return filesIn(root)
    .map((file) => {
      const rel = path.relative(root, file);
      const text = readText(file);
      const own = descriptionOf(text);
      const body = stripFrontmatter(text);
      return {
        rel,
        abs: path.resolve(file),
        description: own || fallbackDescription(rel),
        hasDescription: Boolean(own),
        lines: body.split("\n").filter((line) => line.trim()).length,
      };
    })
    .filter((file) => file.lines > 0)
    .sort((left, right) => orderOf(left.rel) - orderOf(right.rel) || left.rel.localeCompare(right.rel));
}

/** Текст индекса для инструмента: абсолютные пути, чтобы `read` не гадал. */
export function formatCatalog(files: MemoryFile[]): string {
  if (files.length === 0) return "Память пуста: файлов нет.";
  const lines = files.map((file) => {
    const missing = file.hasDescription ? "" : " (описание не задано)";
    return `${file.abs} — ${file.description}${missing}`;
  });
  return [
    `Память, ${files.length} файлов:`,
    "",
    ...lines,
    "",
    "Выбери нужные файлы и прочитай их инструментом read.",
  ].join("\n");
}

/**
 * Обновляет описание файла. Путь — только внутри памяти и только `.md`:
 * инструмент не должен уметь писать куда угодно.
 */
export function updateDescription(rel: string, description: string, root = MEMORY): UpdateResult {
  const cleanRel = rel.trim();
  if (!cleanRel) return { ok: false, error: "не указан файл" };
  if (path.isAbsolute(cleanRel) || cleanRel.split(/[\\/]+/).includes("..")) {
    return { ok: false, error: "путь должен быть относительным и внутри памяти" };
  }
  if (!cleanRel.endsWith(".md")) return { ok: false, error: "описание есть только у .md файлов" };

  const base = path.resolve(root);
  const abs = path.resolve(base, cleanRel);
  if (!abs.startsWith(`${base}${path.sep}`)) return { ok: false, error: "файл вне памяти" };
  if (!fs.existsSync(abs)) return { ok: false, error: `файл не найден: ${cleanRel}` };

  let next: string;
  try {
    next = withDescription(readText(abs), description);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, abs);
  return { ok: true, file: cleanRel };
}
