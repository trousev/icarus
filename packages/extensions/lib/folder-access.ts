// Folder permissions for the agent's tools: a common layer, not just for artifacts.
//
// A folder may have `.folder-acl.json`:
//
//   { "owner": "probe", "acl": { "me": "read", "family": "write" } }
//
// Levels: none ⊂ read ⊂ write ⊂ admin. `none` — the folder doesn't exist for this
// subject: neither read nor write. For artifacts this is exactly the same matrix
// the panel shows; for future shared directories it's enough to drop in such a file.
//
// Rule: a path inside one of the protected roots looks for the nearest folder with an ACL.
// No ACL — no access: a new artifact is created via artifact_new, not a random `write`.
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

/** The roots where the guard is enabled. By default — the global artifact library. */
export function aclRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.ICARUS_ACL_ROOTS ?? env.ICARUS_ARTIFACTS_DIR ?? "/artifacts").trim();
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

/** The nearest protected root the path belongs to. */
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

/** Real path with symlinks resolved; for new files — from the nearest parent. */
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
 * Check a path: whether an operation of the required level can be done in it.
 *
 * `required=read` — reading, `write` — changing files. `admin` isn't needed here:
 * deletion and permissions are changed by the service, not by a file tool.
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
  // A symlink from the workspace into /artifacts must also be checked: otherwise permissions
  // are bypassed with a link. If the path is lexically outside the root but leads inside —
  // we protect by the real path; if lexically inside but leading outside — we don't.
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

  // We look for the nearest existing path: the new file doesn't exist yet, but its
  // folder with an ACL already does.
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
