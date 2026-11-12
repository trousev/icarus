// Общие скиллы: кто ими поделился, кому они включены и откуда их читает pi.
//
// Личные скиллы остаются там же, где были, — в `pi-agent/skills` человека, и
// по-прежнему принадлежат только ему. Здесь живёт то, что человек решил отдать
// другим:
//
//   <dataDir>/skills/registry.json — кто с кем поделился и включённость у каждого;
//   <dataDir>/skills/shared/       — снимки расшаренных скиллов для контейнеров.
//
// Снимок, а не ссылка на чужой каталог: контейнер человека видит только свой
// `pi-agent` и общие маунты, а личный каталог соседа туда не пробрасывается.
// Снимок обновляется при сохранении скилла владельцем и при сборке окружения
// (syncShared): правка в панели доезжает до всех, а не остаётся у автора.
//
// Главное правило то же, что у MCP: поделились — скилл приезжает остальным
// ВЫКЛЮЧЕННЫМ. Включить его каждый должен сам, иначе чужая инструкция молча
// оказывается в промпте и в контексте. Включённый скилл уезжает в settings.json
// дополнительным путём: каталог `~/.pi/agent/skills` не трогаем, чтобы «мои» и
// «общие» скиллы не путались и права на запись оставались только у владельца.
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

/** Версия формата: без неё будущая миграция не отличит старый файл от нового. */
export const SKILL_STORE_VERSION = 1;

/** Имя файла, который делает каталог скиллом: нужно, чтобы отличить каталог от плоского .md. */
const SKILL_FILE = 'SKILL.md';

export type SkillShare = {
  /** Кто владелец: он один может править, удалять и снимать шаринг. */
  owner: string;
  /** Путь скилла внутри каталога владельца: `pirate-mode/SKILL.md` или `notes.md`. */
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillStore = {
  version: number;
  /** `owner/id` → описание шаринга. */
  shares: Record<string, SkillShare>;
  /** userId → `owner/id` → включён ли скилл у этого человека. */
  prefs: Record<string, Record<string, boolean>>;
};

/** Что панель показывает про доступ к скиллу. */
export type SkillAccess = {
  /** Включён у меня: для своего — лежит в корне каталога, для чужого — prefs. */
  enabled: boolean;
  owner: string;
  ownerIsMe: boolean;
  shared: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  /** Устойчивый ключ `owner/id`: по нему панель зовёт toggle и share. */
  key: string;
};

export type VisibleSkill = SkillSummary & SkillAccess;
export type VisibleSkillDetail = SkillDetail & SkillAccess;

export type SkillStorePaths = { dir: string; registry: string; shared: string };

export class SkillStoreError extends Error {
  /** HTTP-статус для панели: 4xx — человеку, 5xx — сломанному файлу. */
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

/** Сегмент пути без «..» и разделителей: id и владелец приходят из файла, а не из кода. */
function safeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value) && !value.includes('\0');
}

/** Путь скилла внутри каталога: сегменты через «/», без выхода наружу. */
export function safeSkillId(id: string): boolean {
  return id.split('/').every(safeSegment);
}

/** Расшарен ли конкретный скилл владельца. */
export function isShared(config: IcarusConfig, owner: string, id: string): boolean {
  return Object.hasOwn(readStore(config).shares, shareKey(owner, id));
}

/** Адрес снимка на хосте: каталог скилла или файл плоского .md. */
function contentPath(config: IcarusConfig, owner: string, id: string): string {
  if (!safeSegment(owner) || !safeSkillId(id) || id === SKILL_FILE) {
    throw new SkillStoreError(`негодный путь скилла: «${owner}/${id}»`, 400);
  }
  const root = path.join(storePaths(config).shared, owner);
  return id.endsWith(`/${SKILL_FILE}`) ? path.join(root, id.slice(0, -(SKILL_FILE.length + 1))) : path.join(root, id);
}

/**
 * Путь, который уезжает в settings.json контейнера.
 *
 * canonical-скилл — это каталог: pi принимает и файл, и каталог, но каталог
 * удобнее: рядом лежат файлы бандла, на которые скилл ссылается.
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
 * Читает хранилище. Сломанный файл — ошибка, а не «пусто»: иначе панель молча
 * показала бы, что шарингов нет, и человек решил бы, что его скиллы пропали.
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
    // Не на всех ФС права меняются; файл всё равно пишем закрытым.
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

/** Копирует бандл скилла в снимок, снося прежний: правка не должна смешиваться со старой. */
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

/** Публичный вид шаринга: сама запись плюс то, что панель может с ней делать. */
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

/** Все скиллы, видимые человеку: свои (включённые и выключенные) и чужие расшаренные. */
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
      // Свой скилл включён тогда, когда лежит в корне: у `.disabled/` это false.
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
    // Свои — первыми: с ними человек работает чаще, чем с чужими.
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

/** Читает расшаренный скилл из снимка; null — шаринг есть, а файлов уже нет. */
export function readShared(config: IcarusConfig, owner: string, id: string): SkillDetail | null {
  if (!safeSegment(owner) || !safeSkillId(id)) return null;
  const root = path.join(storePaths(config).shared, owner);
  try {
    return readSkill(root, id);
  } catch {
    return null;
  }
}

/** Один скилл глазами человека: свой редактируемый или чужой только для чтения. */
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
 * Поделиться скиллом или снять шаринг. Делать это может только владелец.
 *
 * При первом шаринге у остальных стираются прежние prefs: скилл снова приезжает
 * выключенным, как новый, даже если раньше человек его включал.
 */
export function setShared(config: IcarusConfig, owner: string, id: string, shared: boolean): SkillShare | null {
  // Корневой SKILL.md — это не скилл, а весь каталог: его бандл — все скиллы
  // человека. Делиться им значило бы отдать остальным весь личный каталог.
  // Снять с него шаринг — просто no-op: расшаренным он никогда не был.
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
 * Переименование расшаренного скилла: снимок переезжает вместе с ним.
 *
 * Возвращает true, если что-то переносили. Если скилл не был расшарен, это no-op:
 * обычное переименование не должно внезапно включать шаринг.
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
    // Скилл переименовали в никуда — шаринг снимаем вместе с ним.
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
  // Включённость переезжает вместе с ключом: переименование — не повод выключить
  // скилл у тех, кто им пользуется.
  for (const prefs of Object.values(store.prefs)) {
    if (Object.hasOwn(prefs, fromKey)) prefs[toKey] = prefs[fromKey] === true;
    delete prefs[fromKey];
  }
  writeStore(config, store);
  return true;
}

/** Включить или выключить чужой расшаренный скилл себе. */
export function setSharedEnabled(config: IcarusConfig, userId: string, owner: string, id: string, enabled: boolean): void {
  if (owner === userId) throw new SkillStoreError('свой скилл включается переездом, а не флагом', 400);
  const store = readStore(config);
  const key = shareKey(owner, id);
  if (!Object.hasOwn(store.shares, key)) throw new SkillStoreError('этот скилл не расшарен', 404);
  store.prefs[userId] = { ...(store.prefs[userId] ?? {}), [key]: enabled };
  writeStore(config, store);
}

/**
 * Приводит снимки в соответствие с файлами владельцев.
 *
 * Нужна не только после правки в панели: файлы можно положить руками или
 * откатить коммитом, и снимок обязан это догнать. Пропавший у владельца скилл
 * перестаёт быть расшаренным — иначе остальные получали бы инструкцию, которой
 * у автора уже нет.
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
    // Имя и описание могли поменяться вместе с телом: панель показывает их из
    // записи, чтобы не читать каждый снимок заново.
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
 * Пути для settings.json: только включённые чужие скиллы.
 *
 * Свои пути не добавляем: они уже лежат в `~/.pi/agent/skills`, который pi
 * читает по умолчанию. Дублировать их значило бы показать один скилл дважды.
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

/** Сколько скиллов видит человек: число рядом с разделом в панели. */
export function countVisible(config: IcarusConfig, userId: string): number {
  return listVisible(config, userId).length;
}
