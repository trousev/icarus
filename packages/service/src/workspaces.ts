// Workspaces: a person's working folders. One workspace is one folder in
// `<dataDir>/users/<id>/workspaces`, and it's the only thing that determines where the
// agent works. Service directories live nearby, in `.icarus`, and are not part of the workspace.
//
// Metadata is a separate file outside the mounted tree: the agent has no reason to see,
// let alone edit, the list of its working folders.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WORKSPACE, PRIVATE_WORKSPACE, userPaths, type IcarusConfig, type UserConfig } from './config.ts';

export type WorkspaceKind = 'talk' | 'private' | 'custom';

export type Workspace = {
  slug: string;
  name: string;
  kind: WorkspaceKind;
  createdAt: string;
};

/** Workspace name in the interface: service ones have a fixed one. */
const FIXED: Record<string, { name: string; kind: WorkspaceKind }> = {
  [DEFAULT_WORKSPACE]: { name: 'Разговор', kind: 'talk' },
  [PRIVATE_WORKSPACE]: { name: 'Приватный', kind: 'private' },
};

const NAME_LIMIT = 64;
const META_VERSION = 1;

function metaFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'workspaces.json');
}

function isKind(value: unknown): value is WorkspaceKind {
  return value === 'talk' || value === 'private' || value === 'custom';
}

function readMeta(config: IcarusConfig, user: UserConfig): Workspace[] {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(config, user), 'utf8')) as unknown;
    const items = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const { slug, name, kind, createdAt } = item as Record<string, unknown>;
      if (typeof slug !== 'string' || typeof name !== 'string' || !isKind(kind)) return [];
      if (slug !== DEFAULT_WORKSPACE && slug !== PRIVATE_WORKSPACE && kind !== 'custom') return [];
      return [{ slug, name, kind, createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString() }];
    });
  } catch {
    return [];
  }
}

function writeMeta(config: IcarusConfig, user: UserConfig, items: Workspace[]): void {
  const file = metaFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Via a temporary file: an interrupted write must not leave the person without a list.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: META_VERSION, items }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Transliteration to slug: Cyrillic → Latin, everything else — hyphens. */
export function slugify(name: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  const slug = name
    .toLowerCase()
    .split('')
    .map((char) => map[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workspace';
}

/** The AGENTS.md content a new workspace gets. */
export function workspaceAgents(slug: string, name: string): string {
  if (slug === PRIVATE_WORKSPACE) {
    return `# Приватный workspace

Здесь разговор, который не должен менять память. Твой рабочий каталог —
\`/workspaces/${slug}\`, и он **только для чтения**: ничего в нём не меняется.

- Память о человеке доступна: \`/workspaces/.icarus/memory\` читай свободно.
- Писать в память отсюда нельзя — ни в память, ни в её журнал, ни в «проекты».
- Инструменты записи и оболочка отключены: не обещай «запомнить», «сохранить» или
  «положить в файл». Если человек просит запомнить — скажи, что в приватном режиме
  ничего не сохраняется, и предложи обычный workspace.
- Историю самого разговора панель показывает, но память от него не меняется —
  и это главное, что нужно помнить про этот режим.
`;
  }
  if (slug === DEFAULT_WORKSPACE) {
    return `# Workspace «${name}»

Это твой рабочий каталог по умолчанию: \`/workspaces/${slug}\`.

- Служебное Икара лежит вне него — в \`/workspaces/.icarus\`: память, вложения,
  сессии, математика. Рабочие файлы — только здесь.
- Память общая для всех workspace'ов: что узнал в одном, помнишь и в другом.
- Всё, что делаешь руками, кладёшь в этот каталог.
`;
  }
  return `# Workspace «${name}»

Это отдельная рабочая папка: \`/workspaces/${slug}\`.

- Служебное Икара лежит вне неё — в \`/workspaces/.icarus\`: память, вложения,
  сессии, математика.
- Память общая для всех workspace'ов: что узнал здесь, помнишь и в «Разговоре».
- Всё, что относится к этой задаче, живёт здесь и не смешивается с другими папками.
`;
}

function workspaceDir(config: IcarusConfig, user: UserConfig, slug: string): string {
  return path.join(userPaths(config, user).workspaces, slug);
}

/** Puts AGENTS.md into the workspace folder if it's not there yet. */
function seedAgents(config: IcarusConfig, user: UserConfig, workspace: Workspace): void {
  const dir = workspaceDir(config, user, workspace.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, workspaceAgents(workspace.slug, workspace.name));
}

/**
 * Puts things in order: «Talk» and «Private» always exist, their folders are created,
 * AGENTS.md is in place. Returns the full list in interface order.
 */
export function ensureWorkspaces(config: IcarusConfig, user: UserConfig): Workspace[] {
  const now = new Date().toISOString();
  const items = readMeta(config, user);
  const bySlug = new Map(items.map((item) => [item.slug, item]));

  for (const slug of [DEFAULT_WORKSPACE, PRIVATE_WORKSPACE]) {
    if (bySlug.has(slug)) continue;
    const fixed = FIXED[slug]!;
    bySlug.set(slug, { slug, name: fixed.name, kind: fixed.kind, createdAt: now });
  }

  // Someone else's service names must not pretend to be workspaces.
  const ordered = [
    bySlug.get(DEFAULT_WORKSPACE)!,
    bySlug.get(PRIVATE_WORKSPACE)!,
    ...[...bySlug.values()]
      .filter((item) => item.kind === 'custom')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  ];

  for (const workspace of ordered) seedAgents(config, user, workspace);

  const changed = ordered.length !== items.length || ordered.some((item, index) => items[index]?.slug !== item.slug);
  if (changed || !fs.existsSync(metaFile(config, user))) writeMeta(config, user, ordered);
  return ordered;
}

export function listWorkspaces(config: IcarusConfig, user: UserConfig): Workspace[] {
  return ensureWorkspaces(config, user);
}

export function findWorkspace(config: IcarusConfig, user: UserConfig, slug: string | undefined): Workspace | undefined {
  if (!slug) return undefined;
  return listWorkspaces(config, user).find((item) => item.slug === slug);
}

/**
 * Workspaces the person can choose for a conversation. Private is not included: it's
 * read-only, and you can't switch a conversation into it — not «hidden from the list but
 * allowed by name», but not participating at all.
 */
export function selectableWorkspaces(config: IcarusConfig, user: UserConfig): Workspace[] {
  return listWorkspaces(config, user).filter((item) => item.kind !== 'private');
}

/**
 * Workspace by what the person wrote: the folder slug (`icarus`) or its name (`Work`).
 * A separate answer for private: that's not a typo but a prohibition.
 */
export function findSelectableWorkspace(
  config: IcarusConfig,
  user: UserConfig,
  name: string,
): Workspace | 'private' | null {
  const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted) return null;
  const matches = (item: Workspace): boolean =>
    item.slug.toLowerCase() === wanted || item.name.toLowerCase() === wanted;

  const items = listWorkspaces(config, user);
  if (items.some((item) => item.kind === 'private' && matches(item))) return 'private';
  return items.find((item) => item.kind !== 'private' && matches(item)) ?? null;
}

/** Default workspace for entries without a choice (Telegram, old records). */
export function defaultWorkspace(config: IcarusConfig, user: UserConfig): Workspace {
  return findWorkspace(config, user, DEFAULT_WORKSPACE) ?? {
    slug: DEFAULT_WORKSPACE,
    name: FIXED[DEFAULT_WORKSPACE]!.name,
    kind: 'talk',
    createdAt: new Date(0).toISOString(),
  };
}

export class WorkspaceError extends Error {
  /** HTTP status the panel will answer this error with. */
  status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

/** Creates a new working folder. The folder is created at once, together with AGENTS.md. */
export function createWorkspace(config: IcarusConfig, user: UserConfig, rawName: unknown): Workspace {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new WorkspaceError('нужно название workspace', 400);
  if (name.length > NAME_LIMIT) throw new WorkspaceError(`название длиннее ${NAME_LIMIT} символов`, 400);

  const items = listWorkspaces(config, user);
  const base = slugify(name);
  if (base.startsWith('.') || base === DEFAULT_WORKSPACE || base === PRIVATE_WORKSPACE) {
    throw new WorkspaceError('это имя занято служебным workspace', 409);
  }

  let slug = base;
  for (let n = 2; items.some((item) => item.slug === slug) || fs.existsSync(workspaceDir(config, user, slug)); n += 1) {
    slug = `${base}-${n}`;
  }

  const workspace: Workspace = { slug, name, kind: 'custom', createdAt: new Date().toISOString() };
  seedAgents(config, user, workspace);
  writeMeta(config, user, [...items, workspace]);
  return workspace;
}

/**
 * Removes a workspace from the list. The folder on disk stays: it's the person's data, and
 * the panel promises that deleting a workspace doesn't touch it. Dialogues return to
 * «Talk» — the caller, who can rewrite the registry, does that.
 */
export function deleteWorkspace(config: IcarusConfig, user: UserConfig, slug: string): Workspace {
  const items = listWorkspaces(config, user);
  const workspace = items.find((item) => item.slug === slug);
  if (!workspace) throw new WorkspaceError('workspace не найден', 404);
  if (workspace.kind !== 'custom') throw new WorkspaceError('служебный workspace удалить нельзя', 409);
  writeMeta(config, user, items.filter((item) => item.slug !== slug));
  return workspace;
}

/** Random folder name: useful when a workspace is created without a name. */
export function randomSlug(): string {
  return `ws-${crypto.randomBytes(4).toString('hex')}`;
}
