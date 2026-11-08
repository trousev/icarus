// Права на папки для инструментов агента: общий слой, не только для артефактов.
//
// У папки может лежать `.folder-acl.json`:
//
//   { "owner": "probe", "acl": { "me": "read", "family": "write" } }
//
// Уровни: none ⊂ read ⊂ write ⊂ admin. `none` — папки не существует для этого
// субъекта: ни чтения, ни записи. Для артефактов это ровно та же матрица, что
// показывает панель; для будущих общих каталогов достаточно положить такой файл.
//
// Правило: путь внутри одного из защищённых корней ищет ближайшую папку с ACL.
// Нет ACL — доступа нет: новый артефакт создаётся через artifact_new, а не
// случайным `write`.
import fs from "node:fs";
import path from "node:path";

export type AccessLevel = "none" | "read" | "write" | "admin";
export type FolderAcl = { me: AccessLevel; family: AccessLevel };
export type FolderAclFile = {
  owner: string;
  acl: FolderAcl;
};

export const FOLDER_ACL_FILE = ".folder-acl.json";
const LEVELS: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
const LEVEL_LABELS: Record<AccessLevel, string> = { none: "нет доступа", read: "чтение", write: "запись", admin: "администрирование" };

export function allows(level: AccessLevel, required: AccessLevel): boolean {
  return LEVELS[level] >= LEVELS[required];
}

export function levelLabel(level: AccessLevel): string {
  return LEVEL_LABELS[level];
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return value === "none" || value === "read" || value === "write" || value === "admin";
}

/** Корни, где включён страж. По умолчанию — глобальная библиотека артефактов. */
export function aclRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.ICARUS_ACL_ROOTS ?? env.ICARUS_ARTIFACTS_DIR ?? "/artifacts").trim();
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

/** Ближайший защищённый корень, которому принадлежит путь. */
export function rootOf(target: string, roots: string[]): string | null {
  const resolved = path.resolve(target);
  let best: string | null = null;
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

export function readFolderAcl(dir: string): FolderAclFile | null {
  let text: string;
  try {
    const file = path.join(dir, FOLDER_ACL_FILE);
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as { owner?: unknown; acl?: unknown };
    if (typeof raw.owner !== "string" || raw.owner.trim() === "") return null;
    if (!raw.acl || typeof raw.acl !== "object" || Array.isArray(raw.acl)) return null;
    const acl = raw.acl as { me?: unknown; family?: unknown };
    if (!isAccessLevel(acl.me) || !isAccessLevel(acl.family)) return null;
    return { owner: raw.owner, acl: { me: acl.me, family: acl.family } };
  } catch {
    return null;
  }
}

/** Реальный путь с раскрытием симлинков; новых файлов — от ближайшего родителя. */
export function canonicalTarget(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(current);
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export type FolderVerdict =
  | { protected: false }
  | { protected: true; rootOnly: true; root: string }
  | {
      protected: true;
      rootOnly: false;
      root: string;
      folder: string;
      owner: string;
      level: AccessLevel;
      allowed: boolean;
      reason?: string;
    };

/**
 * Проверить путь: можно ли в нём делать операцию нужного уровня.
 *
 * `required=read` — чтение, `write` — изменение файлов. `admin` здесь не нужен:
 * удаление и права меняет сервис, а не файловый тул.
 */
export function folderVerdict(
  target: string,
  viewer: string,
  required: AccessLevel,
  roots: string[],
): FolderVerdict {
  const lexicalRoot = rootOf(target, roots);
  const resolved = canonicalTarget(target);
  const canonicalRoot = rootOf(resolved, roots);
  // Симлинк из workspace в /artifacts тоже должен проверяться: иначе права
  // обходятся ссылкой. Если путь лексически вне корня, но ведёт внутрь —
  // защищаем по реальному пути; если лексически внутри, а ведёт наружу — нет.
  if (!lexicalRoot && !canonicalRoot) return { protected: false };
  if (!canonicalRoot) {
    return {
      protected: true,
      rootOnly: false,
      root: lexicalRoot!,
      folder: resolved,
      owner: "",
      level: "read",
      allowed: false,
      reason: "Симлинк выводит за пределы защищённой папки — так нельзя.",
    };
  }
  const root = canonicalRoot;
  if (resolved === root) return { protected: true, rootOnly: true, root };

  // Ищем ближайший существующий путь: новый файл ещё не существует, но его
  // папка с ACL — уже да.
  let current = resolved;
  for (;;) {
    try {
      const stats = fs.lstatSync(current);
      if (stats.isFile()) current = path.dirname(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  while (current !== root && current.startsWith(root + path.sep)) {
    const acl = readFolderAcl(current);
    if (acl) {
      if (!viewer) {
        return { protected: true, rootOnly: false, root, folder: current, owner: acl.owner, level: "read", allowed: false, reason: "Не известен пользователь: права на папку проверить нечем." };
      }
      const level = viewer === acl.owner ? acl.acl.me : acl.acl.family;
      const allowed = allows(level, required);
      return {
        protected: true,
        rootOnly: false,
        root,
        folder: current,
        owner: acl.owner,
        level,
        allowed,
        ...(allowed ? {} : { reason: `Нет права ${required === "read" ? "читать" : "писать"} в этой папке: владелец ${acl.owner}, твой уровень ${levelLabel(level)}.` }),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return {
    protected: true,
    rootOnly: false,
    root,
    folder: resolved,
    owner: "",
    level: "read",
    allowed: false,
    reason: "В папке нет прав (.folder-acl.json). Создай артефакт через artifact_new.",
  };
}
