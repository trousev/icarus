// Shared skills: who shared them, who has them enabled and where pi reads them from.
//
// Personal skills stay where they were — in the person's `pi-agent/skills`, and still
// belong to them alone. What lives here is what a person decided to give to others:
//
//   <dataDir>/skills/registry.json — who shared with whom and each one's enabled state;
//   <dataDir>/skills/shared/       — snapshots of shared skills for containers.
//
// A snapshot, not a link to someone else's folder: a person's container sees only its own
// `pi-agent` and the shared mounts, and a neighbor's personal folder is not passed through.
// The snapshot is updated when the owner saves the skill and when the environment is built
// (syncShared): an edit in the panel reaches everyone instead of staying with the author.
//
// The main rule is the same as with MCP: once shared, the skill arrives to others DISABLED.
// Each must enable it themselves, otherwise someone else's instruction silently ends up in
// the prompt and the context. An enabled skill goes into settings.json as an extra path: we
// don't touch the `~/.pi/agent/skills` folder, so «my» and «shared» skills don't get mixed up
// and write permissions stay with the owner only.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CONTAINER_PATHS, userPaths, type IcarusConfig } from '../config.ts';
import {
  listSkills,
  readSkill,
  resolveSkillFile,
  skillLabel,
  type SkillDetail,
  type SkillSummary,
} from '../control/skills.ts';

/** Format version: without it a future migration can't tell an old file from a new one. */
export const SKILL_STORE_VERSION = 1;

/** The file name that makes a folder a skill: needed to tell a folder from a flat .md. */
const SKILL_FILE = 'SKILL.md';

export type SkillShare = {
  /** Who the owner is: only they can edit, delete and unshare it. */
  owner: string;
  /** Skill path inside the owner's folder: `pirate-mode/SKILL.md` or `notes.md`. */
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillStore = {
  version: number;
  /** `owner/id` → sharing record. */
  shares: Record<string, SkillShare>;
  /** userId → `owner/id` → whether the skill is enabled for this person. */
  prefs: Record<string, Record<string, boolean>>;
};

/** What the panel shows about access to a skill. */
export type SkillAccess = {
  /** Enabled for me: for my own — it lies in the folder root, for someone else's — prefs. */
  enabled: boolean;
  owner: string;
  ownerIsMe: boolean;
  shared: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  /** Stable key `owner/id`: the panel calls toggle and share with it. */
  key: string;
};

export type VisibleSkill = SkillSummary & SkillAccess;
export type VisibleSkillDetail = SkillDetail & SkillAccess;

export type SkillStorePaths = { dir: string; registry: string; shared: string };

export class SkillStoreError extends Error {
  /** HTTP status for the panel: 4xx — to the person, 5xx — to a broken file. */
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'SkillStoreError';
    this.status = status;
  }
}

export function storePaths(config: IcarusConfig): SkillStorePaths {
  const dir = path.join(config.dataDir, 'skills');
  return {
    dir,
    registry: path.join(dir, 'registry.json'),
    shared: path.join(dir, 'shared'),
  };
}

export function shareKey(owner: string, id: string): string {
  return `${owner}/${id}`;
}

/** Path segment without «..» and separators: id and owner come from a file, not from code. */
function safeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value) && !value.includes('\0');
}

/** Skill path inside the folder: segments with «/», without escaping outside. */
export function safeSkillId(id: string): boolean {
  return id.split('/').every(safeSegment);
}

/** Whether a specific skill of the owner is shared. */
export function isShared(config: IcarusConfig, owner: string, id: string): boolean {
  return Object.hasOwn(readStore(config).shares, shareKey(owner, id));
}

/** Snapshot path on the host: a skill folder or a flat .md file. */
function contentPath(config: IcarusConfig, owner: string, id: string): string {
  if (!safeSegment(owner) || !safeSkillId(id) || id === SKILL_FILE) {
    throw new SkillStoreError(`негодный путь скилла: «${owner}/${id}»`, 400);
  }
  const root = path.join(storePaths(config).shared, owner);
  return id.endsWith(`/${SKILL_FILE}`) ? path.join(root, id.slice(0, -(SKILL_FILE.length + 1))) : path.join(root, id);
}

/**
 * The path that goes into the container's settings.json.
 *
 * A canonical skill is a folder: pi accepts both a file and a folder, but a folder is more
 * convenient: the bundle files the skill references lie next to it.
 */
function containerPath(owner: string, id: string): string {
  if (!safeSegment(owner) || !safeSkillId(id)) {
    throw new SkillStoreError(`негодный путь скилла: «${owner}/${id}»`, 400);
  }
  const relative = id.endsWith(`/${SKILL_FILE}`) ? id.slice(0, -(SKILL_FILE.length + 1)) : id;
  return `${CONTAINER_PATHS.sharedSkills}/${owner}/${relative}`;
}

function emptyStore(): SkillStore {
  return { version: SKILL_STORE_VERSION, shares: {}, prefs: {} };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillStoreError(`${where}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new SkillStoreError(
      `файл скиллов ${file} не разбирается: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reads the store. A broken file is an error, not «empty»: otherwise the panel would
 * silently show that there are no share, and the person would think their skills are gone.
 */
export function readStore(config: IcarusConfig): SkillStore {
  const paths = storePaths(config);
  const store = emptyStore();
  if (!fs.existsSync(paths.registry)) return store;

  const raw = asRecord(readJson(paths.registry), 'registry.json');
  const shares = raw.shares === undefined ? {} : asRecord(raw.shares, 'registry.json.shares');
  for (const [key, item] of Object.entries(shares)) {
    const share = asRecord(item, `registry.json.shares.${key}`) as Partial<SkillShare>;
    if (
      typeof share.owner !== 'string' ||
      typeof share.id !== 'string' ||
      !safeSegment(share.owner) ||
      !safeSkillId(share.id) ||
      share.id === SKILL_FILE ||
      shareKey(share.owner, share.id) !== key
    ) {
      throw new SkillStoreError(`registry.json: шаринг «${key}» записан не целиком`);
    }
    store.shares[key] = {
      owner: share.owner,
      id: share.id,
      name: typeof share.name === 'string' ? share.name : skillLabel(share.id),
      description: typeof share.description === 'string' ? share.description : '',
      createdAt: typeof share.createdAt === 'string' ? share.createdAt : new Date().toISOString(),
      updatedAt: typeof share.updatedAt === 'string' ? share.updatedAt : new Date().toISOString(),
    };
  }

  const prefs = raw.prefs === undefined ? {} : asRecord(raw.prefs, 'registry.json.prefs');
  for (const [userId, own] of Object.entries(prefs)) {
    const map = asRecord(own, `registry.json.prefs.${userId}`);
    store.prefs[userId] = {};
    for (const [key, enabled] of Object.entries(map)) {
      if (typeof enabled === 'boolean') store.prefs[userId][key] = enabled;
    }
  }
  return store;
}

function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Permissions don't change on all filesystems; we still write the file closed.
  }
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function writeStore(config: IcarusConfig, store: SkillStore): void {
  const paths = storePaths(config);
  fs.mkdirSync(paths.shared, { recursive: true });
  writeAtomic(
    paths.registry,
    `${JSON.stringify({ version: SKILL_STORE_VERSION, shares: store.shares, prefs: store.prefs }, null, 2)}\n`,
  );
}

/** Copies the skill bundle into the snapshot, wiping the previous one: an edit must not mix with the old. */
function copyBundle(sourceFile: string, destination: string): void {
  const isCanonical = path.basename(sourceFile) === SKILL_FILE;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (!isCanonical) {
    fs.copyFileSync(sourceFile, destination);
    return;
  }

  fs.cpSync(path.dirname(sourceFile), destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== '.git' && name !== 'node_modules' && !name.startsWith('.tmp-');
    },
  });
}

/** Public view of a share: the record itself plus what the panel can do with it. */
function accessOf(store: SkillStore, viewer: string, owner: string, id: string, shared: boolean): SkillAccess {
  const ownerIsMe = owner === viewer;
  return {
    enabled: ownerIsMe ? true : store.prefs[viewer]?.[shareKey(owner, id)] === true,
    owner,
    ownerIsMe,
    shared,
    canEdit: ownerIsMe,
    canShare: ownerIsMe,
    canDelete: ownerIsMe,
    key: shareKey(owner, id),
  };
}

/** All skills visible to the person: own (enabled and disabled) and others' shared ones. */
export function listVisible(config: IcarusConfig, userId: string): VisibleSkill[] {
  const store = readStore(config);
  const paths = userPaths(config, { id: userId });
  const ownShared = new Set(
    Object.values(store.shares)
      .filter((share) => share.owner === userId)
      .map((share) => share.id),
  );

  const skills: VisibleSkill[] = [];
  for (const skill of listSkillsSafe(paths.skills)) {
    skills.push({
      ...skill,
      ...accessOf(store, userId, userId, skill.id, ownShared.has(skill.id)),
      // One's own skill is enabled when it lies in the root: for `.disabled/` this is false.
      enabled: skill.enabled,
    });
  }

  for (const share of Object.values(store.shares)) {
    if (share.owner === userId) continue;
    const detail = readShared(config, share.owner, share.id);
    if (!detail) continue;
    skills.push({
      ...stripDetail(detail),
      ...accessOf(store, userId, share.owner, share.id, true),
    });
  }

  return skills.sort((a, b) => {
    // Own ones first: a person works with them more often than with others'.
    if (a.ownerIsMe !== b.ownerIsMe) return a.ownerIsMe ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function stripDetail(detail: SkillDetail): SkillSummary {
  const { body: _body, frontmatter: _frontmatter, bundle: _bundle, ...summary } = detail;
  return summary;
}

function listSkillsSafe(root: string): SkillSummary[] {
  try {
    return listSkills(root);
  } catch {
    return [];
  }
}

/** Reads a shared skill from the snapshot; null — the share exists but the files are gone. */
export function readShared(config: IcarusConfig, owner: string, id: string): SkillDetail | null {
  if (!safeSegment(owner) || !safeSkillId(id)) return null;
  const root = path.join(storePaths(config).shared, owner);
  try {
    return readSkill(root, id);
  } catch {
    return null;
  }
}

/** A single skill through the person's eyes: own editable or someone else's read-only. */
export function readVisible(
  config: IcarusConfig,
  userId: string,
  owner: string,
  id: string,
): VisibleSkillDetail | null {
  const store = readStore(config);
  if (owner === userId) {
    const paths = userPaths(config, { id: userId });
    const detail = readSkill(paths.skills, id);
    if (!detail) return null;
    const shared = Object.hasOwn(store.shares, shareKey(userId, id));
    return { ...detail, ...accessOf(store, userId, userId, id, shared), enabled: detail.enabled };
  }

  if (!Object.hasOwn(store.shares, shareKey(owner, id))) return null;
  const detail = readShared(config, owner, id);
  if (!detail) return null;
  return { ...detail, ...accessOf(store, userId, owner, id, true) };
}

/**
 * Share a skill or unshare it. Only the owner can do this.
 *
 * On the first share, others' previous prefs are wiped: the skill arrives disabled again,
 * like a new one, even if the person had enabled it before.
 */
export function setShared(config: IcarusConfig, owner: string, id: string, shared: boolean): SkillShare | null {
  // The root SKILL.md is not a skill but the whole folder: its bundle is all of the
  // person's skills. Sharing it would mean giving everyone the entire personal folder.
  // Unsharing it is just a no-op: it was never shared.
  if (id === SKILL_FILE) {
    if (shared) throw new SkillStoreError('корневой SKILL.md не расшаривается: переименуй его в каталог', 400);
    return null;
  }

  const store = readStore(config);
  const key = shareKey(owner, id);

  if (!shared) {
    delete store.shares[key];
    fs.rmSync(contentPath(config, owner, id), { recursive: true, force: true });
    for (const prefs of Object.values(store.prefs)) delete prefs[key];
    writeStore(config, store);
    return null;
  }

  const paths = userPaths(config, { id: owner });
  const source = resolveSkillFile(paths.skills, id);
  if (!source) throw new SkillStoreError('скилла уже нет: обнови страницу', 404);
  const detail = readSkill(paths.skills, id);
  if (!detail) throw new SkillStoreError('скилл не читается: проверь файл', 400);
  if (!Object.hasOwn(store.shares, key)) {
    for (const [other, prefs] of Object.entries(store.prefs)) {
      if (other === owner) continue;
      delete prefs[key];
    }
  }

  copyBundle(source, contentPath(config, owner, id));
  const now = new Date().toISOString();
  const previous = store.shares[key];
  const share: SkillShare = {
    owner,
    id,
    name: detail.name,
    description: detail.description,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  store.shares[key] = share;
  writeStore(config, store);
  return share;
}

/**
 * Renaming a shared skill: the snapshot moves along with it.
 *
 * Returns true if something was moved. If the skill wasn't shared, this is a no-op:
 * a regular rename must not suddenly enable sharing.
 */
export function renameShare(config: IcarusConfig, owner: string, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const store = readStore(config);
  const fromKey = shareKey(owner, fromId);
  if (!Object.hasOwn(store.shares, fromKey)) return false;

  const previous = store.shares[fromKey];
  const paths = userPaths(config, { id: owner });
  const source = resolveSkillFile(paths.skills, toId);
  const detail = source ? readSkill(paths.skills, toId) : null;

  delete store.shares[fromKey];
  fs.rmSync(contentPath(config, owner, fromId), { recursive: true, force: true });

  if (!source || !detail) {
    // The skill was renamed into nowhere — we unshare it along with it.
    for (const prefs of Object.values(store.prefs)) delete prefs[fromKey];
    writeStore(config, store);
    return false;
  }

  copyBundle(source, contentPath(config, owner, toId));
  const toKey = shareKey(owner, toId);
  store.shares[toKey] = {
    owner,
    id: toId,
    name: detail.name,
    description: detail.description,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Enabled state moves along with the key: a rename is no reason to disable the
  // skill for those who use it.
  for (const prefs of Object.values(store.prefs)) {
    if (Object.hasOwn(prefs, fromKey)) prefs[toKey] = prefs[fromKey] === true;
    delete prefs[fromKey];
  }
  writeStore(config, store);
  return true;
}

/** Enable or disable someone else's shared skill for yourself. */
export function setSharedEnabled(config: IcarusConfig, userId: string, owner: string, id: string, enabled: boolean): void {
  if (owner === userId) throw new SkillStoreError('свой скилл включается переездом, а не флагом', 400);
  const store = readStore(config);
  const key = shareKey(owner, id);
  if (!Object.hasOwn(store.shares, key)) throw new SkillStoreError('этот скилл не расшарен', 404);
  store.prefs[userId] = { ...(store.prefs[userId] ?? {}), [key]: enabled };
  writeStore(config, store);
}

/**
 * Brings snapshots in line with the owners' files.
 *
 * Needed not only after a panel edit: files can be placed by hand or rolled back by a
 * commit, and the snapshot must catch up. A skill missing from the owner stops being
 * shared — otherwise others would get an instruction the author no longer has.
 */
export function syncShared(config: IcarusConfig): void {
  const store = readStore(config);
  let changed = false;
  for (const [key, share] of Object.entries(store.shares)) {
    const paths = userPaths(config, { id: share.owner });
    const source = resolveSkillFile(paths.skills, share.id);
    if (!source) {
      delete store.shares[key];
      fs.rmSync(contentPath(config, share.owner, share.id), { recursive: true, force: true });
      for (const prefs of Object.values(store.prefs)) delete prefs[key];
      changed = true;
      continue;
    }
    copyBundle(source, contentPath(config, share.owner, share.id));
    // The name and description could have changed along with the body: the panel shows
    // them from the record so it doesn't re-read every snapshot.
    const detail = readSkill(paths.skills, share.id);
    if (detail && (detail.name !== share.name || detail.description !== share.description)) {
      store.shares[key] = {
        ...share,
        name: detail.name,
        description: detail.description,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
  }
  if (changed) writeStore(config, store);
}

/**
 * Paths for settings.json: only enabled someone else's skills.
 *
 * We don't add own paths: they already lie in `~/.pi/agent/skills`, which pi reads by
 * default. Duplicating them would mean showing one skill twice.
 */
export function enabledSharedPaths(config: IcarusConfig, userId: string): string[] {
  const store = readStore(config);
  const paths: string[] = [];
  for (const share of Object.values(store.shares)) {
    if (share.owner === userId) continue;
    if (store.prefs[userId]?.[shareKey(share.owner, share.id)] !== true) continue;
    if (!fs.existsSync(contentPath(config, share.owner, share.id))) continue;
    paths.push(containerPath(share.owner, share.id));
  }
  return paths.sort();
}

/** How many skills the person sees: the number next to the section in the panel. */
export function countVisible(config: IcarusConfig, userId: string): number {
  return listVisible(config, userId).length;
}
