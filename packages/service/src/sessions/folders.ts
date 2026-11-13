// Folders in the panel's left menu: the person sorts conversations onto shelves themselves.
//
// This is only the order in the list, not a working folder: a conversation keeps its own
// workspace, and moving it into a folder moves nothing on disk. There are deliberately no
// settings per folder — with them a folder turns into a second workspace, and instead of order
// you get a second management system (see idea 06).
//
// We store it in `<dataDir>/users/<id>/folders.json`, next to chats.json: a chat's membership
// is a field in the registry itself, not a second index.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log } from '../log.ts';
import { reassignChatFolder } from './chats.ts';

export type ChatFolder = {
  id: string;
  name: string;
  createdAt: string;
  /**
   * Whether the folder is collapsed in the menu. The state lives on the server, not in localStorage:
   * the conversation is the same from any device, and the menu must not diverge.
   */
  collapsed: boolean;
};

/** How many chats returned to "Inbox" after deleting a folder. */
export type DeletedFolder = { folder: ChatFolder; movedChats: number };

export class FolderError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FolderError';
    this.status = status;
  }
}

const NAME_LIMIT = 64;
const META_VERSION = 1;

function foldersFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'folders.json');
}

/** Folder name: no leading/trailing spaces and no doubles — otherwise two rows would look the same in the menu. */
export function folderName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
}

function normalize(value: unknown): ChatFolder | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const name = folderName(item.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    collapsed: item.collapsed === true,
  };
}

/** The folder list is read in full: this is a small registry, not a history. */
export function readFolders(config: IcarusConfig, user: UserConfig): ChatFolder[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(foldersFile(config, user), 'utf8')) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) return [];
    const seen = new Set<string>();
    return parsed.folders.flatMap((item) => {
      const folder = normalize(item);
      if (!folder || seen.has(folder.id)) return [];
      seen.add(folder.id);
      return [folder];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читается список папок', { user: user.id, error: String(error) });
    }
    return [];
  }
}

/** We write via a temporary file: an interrupted write must not leave the menu empty. */
export function writeFolders(config: IcarusConfig, user: UserConfig, folders: ChatFolder[]): void {
  const file = foldersFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: META_VERSION, folders }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function findFolder(config: IcarusConfig, user: UserConfig, id: string): ChatFolder | null {
  return readFolders(config, user).find((folder) => folder.id === id) ?? null;
}

/** Identical names in the menu can't be told apart by eye — so we don't allow creating them. */
function assertFreeName(folders: ChatFolder[], name: string, except?: string): void {
  const taken = folders.some(
    (folder) => folder.id !== except && folder.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'),
  );
  if (taken) throw new FolderError(`папка «${name}» уже есть`, 409);
}

export function createFolder(
  config: IcarusConfig,
  user: UserConfig,
  rawName: unknown,
  now = new Date(),
): ChatFolder {
  const name = folderName(rawName);
  if (!name) throw new FolderError('нужно название папки');
  const folders = readFolders(config, user);
  assertFreeName(folders, name);
  const folder: ChatFolder = {
    id: `f-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    name,
    createdAt: now.toISOString(),
    collapsed: false,
  };
  folders.push(folder);
  writeFolders(config, user, folders);
  return folder;
}

export function renameFolder(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  rawName: unknown,
): ChatFolder {
  const name = folderName(rawName);
  if (!name) throw new FolderError('нужно название папки');
  const folders = readFolders(config, user);
  const folder = folders.find((item) => item.id === id);
  if (!folder) throw new FolderError(`папка ${id} не найдена`, 404);
  assertFreeName(folders, name, id);
  if (folder.name !== name) {
    folder.name = name;
    writeFolders(config, user, folders);
  }
  return folder;
}

/** Collapsed state changes on a click on the header, so it's a separate operation. */
export function setFolderCollapsed(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  collapsed: boolean,
): ChatFolder {
  const folders = readFolders(config, user);
  const folder = folders.find((item) => item.id === id);
  if (!folder) throw new FolderError(`папка ${id} не найдена`, 404);
  if (folder.collapsed !== collapsed) {
    folder.collapsed = collapsed;
    writeFolders(config, user, folders);
  }
  return folder;
}

/**
 * Deleting a folder does not delete conversations: they return to "Inbox". History files
 * are not touched anyway — they live in the shared sessions folder.
 */
export function deleteFolder(config: IcarusConfig, user: UserConfig, id: string): DeletedFolder {
  const folders = readFolders(config, user);
  const folder = folders.find((item) => item.id === id);
  if (!folder) throw new FolderError(`папка ${id} не найдена`, 404);
  writeFolders(
    config,
    user,
    folders.filter((item) => item.id !== id),
  );
  const movedChats = reassignChatFolder(config, user, id, null);
  return { folder, movedChats };
}
