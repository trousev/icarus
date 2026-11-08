// История версий артефактов: императивные снимки после каждого изменения.
//
// Человек не знает, что внутри папки лежит git. Для него это просто «История
// версий» в панели и кнопка «Вернуть». Здесь нет ИИ и нет решений модели:
// pi даёт событие tool_call/tool_result/turn_end, а расширение фиксирует снимок.
//
// Перед write/edit делаем снимок «как было» (на случай первого изменения старой
// папки), после успешного write/edit — коммит. turn_end добирает всё, что
// прилетело через MCP или другие инструменты. Служебные файлы (.folder-acl.json,
// .artifact.json) не версионируются: откат контента не должен менять права.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allows, canonicalTarget, readFolderAcl } from "./lib/folder-access.ts";

const ARTIFACTS = path.resolve(process.env.ICARUS_ARTIFACTS_DIR ?? "/artifacts");
const VIEWER = (process.env.ICARUS_USER_ID ?? "").trim();
const IGNORED = [".folder-acl.json", ".artifact.json"];
const WRITE_TOOLS = new Set(["write", "edit"]);

const queues = new Map<string, Promise<void>>();

function safeDir(dir: string): boolean {
  try {
    const stats = fs.lstatSync(path.join(dir, ".git"));
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureExclude(dir: string): void {
  const info = path.join(dir, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  const file = path.join(info, "exclude");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // файла ещё нет — начнём с пустого
  }
  const lines = new Set(current.split("\n").map((line) => line.trim()));
  const missing = IGNORED.filter((name) => !lines.has(name));
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  fs.writeFileSync(file, `${prefix}${missing.join("\n")}\n`);
}

/** Папка артефакта, если путь реально ведёт внутрь неё. */
export function artifactDirFor(target: string, root = ARTIFACTS): string | null {
  if (!target) return null;
  const resolved = canonicalTarget(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null;
  const relative = path.relative(root, resolved);
  const parts = relative.split(path.sep);
  const [slug] = parts;
  if (!slug || slug.startsWith(".")) return null;
  if (parts.includes(".git") || parts.some((part) => part === ".folder-acl.json" || part === ".artifact.json")) {
    return null;
  }
  const dir = path.join(root, slug);
  if (!readFolderAcl(dir)) return null;
  return dir;
}

/** Может ли текущий человек менять эту папку: история — тоже запись. */
function canWrite(dir: string): boolean {
  if (!VIEWER) return false;
  const acl = readFolderAcl(dir);
  if (!acl) return false;
  const level = VIEWER === acl.owner ? acl.acl.me : acl.acl.family;
  return allows(level, "write");
}

function git(_ctx: ExtensionContext, dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      {
        cwd: dir,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? Number((error as { code?: number }).code)
            : 1
          : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function ensureRepo(ctx: ExtensionContext, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!safeDir(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) throw new Error("в папке уже есть .git, но это не каталог");
    const init = await git(ctx, dir, ["init", "-q"]);
    if (init.code !== 0) throw new Error(init.stderr.trim() || "git init не удался");
    await git(ctx, dir, ["config", "user.name", "Icarus"]);
    await git(ctx, dir, ["config", "user.email", "icarus@localhost"]);
    await git(ctx, dir, ["config", "commit.gpgsign", "false"]);
  }
  ensureExclude(dir);
}

async function commit(ctx: ExtensionContext, dir: string, message: string): Promise<boolean> {
  await ensureRepo(ctx, dir);
  const add = await git(ctx, dir, ["add", "-A"]);
  if (add.code !== 0) throw new Error(add.stderr.trim() || "git add не удался");
  const staged = await git(ctx, dir, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return false;
  if (staged.code !== 1) throw new Error(staged.stderr.trim() || "git diff не удался");
  const commitResult = await git(ctx, dir, ["commit", "-q", "-m", message.replace(/[\r\n]+/g, " ").slice(0, 200)]);
  if (commitResult.code !== 0) throw new Error(commitResult.stderr.trim() || "git commit не удался");
  return true;
}

/** Очередь на папку: параллельные write в один артефакт не должны драться за index. */
function enqueue(dir: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(dir) ?? Promise.resolve();
  const next = previous.then(task, task).catch((error) => {
    process.stderr.write(`[artifact-git] ${String(error)}\n`);
  });
  queues.set(dir, next);
  return next;
}

function writePath(event: { input?: Record<string, unknown> }): string {
  return String(event.input?.path ?? event.input?.file ?? "");
}

function messageFor(tool: string, dir: string, target: string): string {
  let relative: string;
  try {
    relative = path.relative(dir, canonicalTarget(target)).split(path.sep).join("/");
  } catch {
    relative = path.basename(target);
  }
  return `artifact: ${tool} ${relative || "index"}`;
}

/** Снимок до изменения: нужен, если у старой папки ещё не было истории. */
async function beforeWrite(ctx: ExtensionContext, tool: string, target: string): Promise<void> {
  const dir = artifactDirFor(target);
  if (!dir || !canWrite(dir)) return;
  await enqueue(dir, async () => {
    const changed = await commit(ctx, dir, "artifact: snapshot before change");
    if (changed) process.stderr.write(`[artifact-git] snapshot ${path.basename(dir)}\n`);
  });
}

/** Коммит после успешного write/edit. */
async function afterWrite(ctx: ExtensionContext, tool: string, target: string): Promise<void> {
  const dir = artifactDirFor(target);
  if (!dir || !canWrite(dir)) return;
  await enqueue(dir, async () => {
    const changed = await commit(ctx, dir, messageFor(tool, dir, target));
    if (changed) process.stderr.write(`[artifact-git] commit ${path.basename(dir)}\n`);
  });
}

/** artifact_new создаёт папку без контента: заводим репозиторий заранее. */
async function afterArtifactNew(ctx: ExtensionContext, name: string): Promise<void> {
  if (!name) return;
  const dir = artifactDirFor(path.join(ARTIFACTS, name));
  if (!dir || !canWrite(dir)) return;
  await enqueue(dir, async () => {
    await ensureRepo(ctx, dir);
  });
}

/** Добор после хода: MCP, bash, любые инструменты, которых мы не назвали. */
async function sweep(ctx: ExtensionContext): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ARTIFACTS, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(ARTIFACTS, entry.name);
    if (!readFolderAcl(dir) || !canWrite(dir)) continue;
    await enqueue(dir, async () => {
      const changed = await commit(ctx, dir, "artifact: update");
      if (changed) process.stderr.write(`[artifact-git] sweep ${entry.name}\n`);
    });
  }
}

export default function (pi: ExtensionAPI) {
  if (!VIEWER) return;

  pi.on("tool_call", async (event, ctx) => {
    const tool = String(event.toolName ?? "");
    if (!WRITE_TOOLS.has(tool)) return;
    const target = writePath(event as { input?: Record<string, unknown> });
    if (!target) return;
    try {
      await beforeWrite(ctx, tool, target);
    } catch (error) {
      process.stderr.write(`[artifact-git] snapshot failed: ${String(error)}\n`);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const tool = String(event.toolName ?? "");
    if (event.isError) return;
    if (WRITE_TOOLS.has(tool)) {
      const target = writePath(event as { input?: Record<string, unknown> });
      if (!target) return;
      try {
        await afterWrite(ctx, tool, target);
      } catch (error) {
        process.stderr.write(`[artifact-git] commit failed: ${String(error)}\n`);
      }
      return;
    }
    if (tool.endsWith("artifact_new")) {
      const name = String((event.input as { name?: unknown } | undefined)?.name ?? "");
      try {
        await afterArtifactNew(ctx, name);
      } catch (error) {
        process.stderr.write(`[artifact-git] init failed: ${String(error)}\n`);
      }
      return;
    }
    // bash/powershell могли писать в артефакт в обход write (например, через
    // разрешённый относительный путь). Фиксируем сразу, не дожидаясь turn_end.
    if (tool === "bash" || tool === "powershell") {
      try {
        await sweep(ctx);
      } catch (error) {
        process.stderr.write(`[artifact-git] sweep failed: ${String(error)}\n`);
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      await sweep(ctx);
    } catch (error) {
      process.stderr.write(`[artifact-git] sweep failed: ${String(error)}\n`);
    }
  });

  // Последний шанс: если ход закончился нештатно, снимок всё равно должен остаться.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await sweep(ctx);
    } catch (error) {
      process.stderr.write(`[artifact-git] shutdown sweep failed: ${String(error)}\n`);
    }
  });
}
