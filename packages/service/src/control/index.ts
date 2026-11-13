// Icarus control panel: chat and settings — a thin JSON layer over pi sessions,
// files and git.
//
// The person is named by the SSO proxy (see identity.ts), so there is no user parameter in requests
// and it cannot be substituted: someone else's memory cannot be opened through your own session.
//
// The main screen is /panel/chat: dialogs, feed and composer. Chat goes to the same pi
// sessions as Telegram, only conversationId starts with web-. Settings
// (/panel/memory, /panel/skills, /panel/mcp) are opened by the panel over the chat.
//
// Inside memory there are two scopes: personal and shared. There are no built-in skill files here:
// their tools are ordinary MCP, and everything created lives in the working folder of the conversation.
//
// Skills are the third kind of section: a person writes them, and editing here is not line-by-line but a whole
// file (`SKILL.md`). The panel is the author of skills, pi is their reader: the person's
// skills directory is mounted into the container as `~/.pi/agent/skills`, from where pi takes them at
// session start. Therefore after saving the panel bumps the resource generation: a live
// conversation finishes on the old set, and the next turn starts pi again.
//
// Old addresses (/panel/api/*) remain working: the browser keeps an open panel
// page alive, and after a service update it must not crumble mid-word.
// The new routes are shorter and name the section explicitly — the panel itself draws them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { handleWorkspacesApi } from './workspaces.ts';
import { handleFoldersApi } from './folders.ts';
import { handleWorkspaceFilesApi } from './files.ts';
import { findUser, isAdmin, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import {
  DEFAULT_UI_LANGUAGE,
  LANGUAGE_LABELS,
  LANGUAGES,
  UI_LANGUAGES,
  isUiLanguage,
  languageOf,
  readProfile,
  uiLanguageOf,
  writeProfile,
  type Language,
  type UiLanguage,
} from '../profile.ts';
import { panelStrings, type PanelStrings } from './strings.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import {
  countFiles,
  isImageFile,
  listFiles,
  memoryExtensions,
  readImageFile,
  readMemoryFile,
  removeFile,
  removeLine,
  removeLines,
  searchMemory,
} from './memory.ts';
import { parseEntries, readEntries } from './entries.ts';
import { commitAll, ensureRepo, fileHistory, hasChanges, log, revert, show } from './git.ts';
import { identifyPanelUser } from './identity.ts';
import { parseSkillDraft, SKILL_IDEA_LIMIT } from './skill-draft.ts';
import {
  SKILLS_DISABLED_DIR,
  listSkills,
  removeSkill,
  searchSkills,
  setSkillEnabled,
  skillExtensions,
  skillLabel,
  skillScope,
  writeSkill,
} from './skills.ts';
import {
  SkillStoreError,
  isShared as isSkillShared,
  listVisible as listVisibleSkills,
  readVisible as readVisibleSkill,
  renameShare,
  setShared as setSkillShared,
  setSharedEnabled as setSkillSharedEnabled,
  countVisible as countVisibleSkills,
  syncShared as syncSharedSkills,
} from '../skills/registry.ts';
import { panelHtml, type PanelPage, type PanelSession } from './ui.ts';
import { chatPage } from './chat-ui.ts';
import { handleKeysApi } from './keys.ts';
import { keysPage } from './keys-ui.ts';
import { handleMcpApi, handleMcpPublic } from './mcp.ts';
import { mcpPage } from './mcp-ui.ts';
import { countVisible } from '../mcp/registry.ts';
import { handleChatApi } from './chat.ts';
import { handleTasksApi } from './tasks.ts';
import { tasksPage } from './tasks-ui.ts';
import { handleArtifactsApi, handleArtifactsRaw, handleArtifactsVersionRaw } from './artifacts.ts';
import { artifactsPage } from './artifacts-ui.ts';
import { countArtifacts } from '../artifacts.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { ChatRecord } from '../sessions/chats.ts';
import { log as logger } from '../log.ts';

export type PanelContext = {
  config: IcarusConfig;
  /** Live pi sessions: from them the panel sends messages and reads history. */
  registry?: SessionRegistry;
  /**
   * Mark that the person's slow resources (skills) have changed: a live pi session
   * keeps them in memory from the very start, so the next turn starts it again.
   * Not passed — the panel just writes files (that is how the storage tests run it).
   */
  bump?: (userId: string) => void;
  /**
   * Ask the model: the panel calls it to write a skill from the person's description.
   * Not passed — there is no "write it for me" button at all (that is how the local panel lives:
   * there is no container with a model next to it).
   */
  draft?: (userId: string, idea: string) => Promise<string>;
  /**
   * Move a Telegram conversation out of Telegram: archiving in the panel and in the bot is one
   * action, and the Telegram topic is deleted together with the messages (see archiveChat).
   * Not passed — the panel is without the bot: the archive remains only as a mark in the registry.
   */
  archiveTelegram?: (user: UserConfig, chat: ChatRecord) => Promise<void>;
};

/** Panel sections: the order here is the order in the sidebar. Labels — from the dictionary. */
export const SECTIONS: { id: string; adminOnly?: boolean }[] = [
  { id: 'memory' },
  { id: 'skills' },
  { id: 'mcp' },
  // Tasks are not a setting but an action: a person sets up a schedule by which the agent
  // starts itself. They stand next to MCP: this is also "what Icarus can do without a person".
  { id: 'tasks' },
  // Keys are installation settings, not a person's: only admins see and open
  // the section. It stands before "Profile": the rest is about content, this is about
  // access, and last comes the personal setting.
  { id: 'keys', adminOnly: true },
  { id: 'profile' },
];

/** Section label in the interface language. */
function sectionLabel(id: string, ui: PanelStrings): string {
  switch (id) {
    case 'memory':
      return ui.sectionMemory;
    case 'skills':
      return ui.sectionSkills;
    case 'mcp':
      return ui.sectionMcp;
    case 'tasks':
      return ui.sectionTasks;
    case 'keys':
      return ui.sectionKeys;
    case 'profile':
      return ui.sectionProfile;
    default:
      return id;
  }
}

/** Scope labels: the panel draws them, and there is no reason to keep them in the browser. */
function scopeLabels(ui: PanelStrings): Record<string, string> {
  return { personal: ui.scopePersonal, shared: ui.scopeShared, skills: ui.sectionSkills };
}

type Scope = 'personal' | 'shared' | 'skills' | 'profile';
/** Section mode: memory is edited line by line, skills — as a whole file. */
export type ScopeMode = 'memory' | 'skills' | 'profile';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Shared skill store failure.
 *
 * A format error (broken registry.json) must be shown to the person as text, not
 * bring down the whole section: then he will understand what to fix and will not decide that the skills are gone.
 */
function skillError(res: ServerResponse, error: unknown): void {
  if (error instanceof SkillStoreError) {
    json(
      res,
      error.status,
      errorBody(error.message, error.status >= 500 ? 'server_error' : 'invalid_request_error'),
    );
    return;
  }
  logger.warn('скиллы: запрос панели не вышел', { error: String(error) });
  json(res, 500, errorBody(error instanceof Error ? error.message : String(error), 'server_error'));
}

/**
 * The "Profile" section: two independent settings — response language and interface language.
 *
 * GET returns both and the lists of available ones; POST changes the one that was sent, without touching
 * the second. The profile file lies next to the person's memory, so the settings survive
 * both a service restart and container recreation.
 *
 * Changing the response language does not tear the live session but marks the resources: pi reads AGENTS.md
 * at start, so the next reply starts it again — by the same mechanism as
 * skills. Changing the interface language does not concern pi at all: only the panel sees it, and
 * restarting the conversation because of it would mean losing context for nothing.
 */
async function handleProfileApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PanelContext,
  userId: string,
): Promise<void> {
  const { config } = ctx;
  const user = findUser(config, userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return;
  }

  if (req.method === 'GET') {
    json(res, 200, {
      user: userId,
      language: languageOf(config, user),
      languages: LANGUAGES,
      labels: LANGUAGE_LABELS,
      uiLanguage: uiLanguageOf(config, user),
      uiLanguages: UI_LANGUAGES,
      // The labels are the same: "Русский" and "English" a person reads in any language.
      uiLabels: LANGUAGE_LABELS,
    });
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, errorBody(`профиль не умеет ${req.method}`, 'invalid_request_error'));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (error) {
    json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
    return;
  }

  const language = body.language;
  const requestedUi = body.uiLanguage;
  if (language === undefined && requestedUi === undefined) {
    json(res, 400, errorBody('нужен language или uiLanguage', 'invalid_request_error'));
    return;
  }
  if (language !== undefined && (typeof language !== 'string' || !(LANGUAGES as readonly string[]).includes(language))) {
    json(res, 400, errorBody(`язык «${String(language)}» не поддерживается: ${LANGUAGES.join(', ')}`, 'invalid_request_error'));
    return;
  }
  if (requestedUi !== undefined && !isUiLanguage(requestedUi)) {
    json(
      res,
      400,
      errorBody(
        `язык интерфейса «${String(requestedUi)}» не поддерживается: ${UI_LANGUAGES.join(', ')}`,
        'invalid_request_error',
      ),
    );
    return;
  }

  // We change only the field that was sent: otherwise switching the interface would silently reset
  // the response language (and vice versa) — exactly the mixing we are moving away from.
  const previousLanguage = languageOf(config, user);
  const current = readProfile(config, user) ?? { language: previousLanguage, uiLanguage: DEFAULT_UI_LANGUAGE };
  const next = {
    language: (language as Language | undefined) ?? current.language,
    uiLanguage: (requestedUi as UiLanguage | undefined) ?? current.uiLanguage,
  };
  writeProfile(config, user, next);

  // The response language lives in AGENTS.md, and pi reads it at process start — that means
  // without this mark the language change will not catch up with the live session, and the person will hear the previous
  // language. We mark only when it really changed, and never — because of the interface.
  if (next.language !== previousLanguage) bumpResources(ctx, userId);

  json(res, 200, { user: userId, language: next.language, uiLanguage: next.uiLanguage });
}

/**
 * The person's resources have changed — pi does not know about it yet.
 *
 * pi reads resources once at process start: the skills directory and the environment map
 * (AGENTS.md, and in it — the response language). Therefore editing a file by itself will not reach the live
 * conversation. The mark "resources updated" tells the session registry to start
 * the next session again: the running turn finishes on the previous set, and the next
 * answer — already with the new skill or in the new language (see SessionRegistry.bumpResources).
 * An error here must not cancel the save: the file is already written and committed.
 */
function bumpResources(ctx: PanelContext, userId: string): void {
  try {
    ctx.bump?.(userId);
  } catch (error) {
    logger.warn('не удалось отметить обновление ресурсов', { user: userId, error: String(error) });
  }
}

/**
 * Header for download: the file name as is, not "file".
 *
 * Names in memory are Russian, and in the ASCII variant of the header there can be no Cyrillic —
 * therefore the name travels twice: cleaned for old browsers and percent-encoded
 * (RFC 5987) for all the rest. Without the second, the browser would save "здоровье.md"
 * as "______.md".
 */
export function disposition(relative: string): string {
  const name = relative.split('/').pop() ?? 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Serve text as a file: the browser will save it under the same name instead of showing
 * it as a page. The path checks are the same as for ordinary reading: they are done by the one who
 * has already read the content.
 */
function sendAttachment(res: ServerResponse, relative: string, content: string): void {
  const body = Buffer.from(content, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'content-disposition': disposition(relative),
  });
  res.end(body);
}

/**
 * Memory scope from the request: everything unfamiliar is personal, as before.
 */
function parseScope(raw: unknown): 'personal' | 'shared' {
  return raw === 'shared' ? raw : 'personal';
}

function modeFor(scope: Scope): ScopeMode {
  if (scope === 'skills') return 'skills';
  // Profile is not files but a settings form: it has its own render and its own routes,
  // and it does not enter the common "memory files" parsing.
  if (scope === 'profile') return 'profile';
  return 'memory';
}

/**
 * Which scope the request reads.
 *
 * In the new routes the section is in the address (`/panel/skills/files`) and decides everything:
 * the scope from the query would only confuse there. In the old ones (`/panel/api/*`) there is no section in
 * the address — they already named the scope with a parameter, and an open panel
 * tab in the browser must keep working after a service update.
 */
function scopeFor(section: string | undefined, raw: unknown): Scope {
  if (section === 'skills') return 'skills';
  if (section === 'profile') return 'profile';
  if (section === 'memory') return parseScope(raw);
  return raw === 'shared' ? raw : 'personal';
}

/** The section root and the set of extensions that are allowed in it at all. */
function resolveScope(config: IcarusConfig, userId: string, scope: Scope) {
  const user = findUser(config, userId);
  if (!user) return null;
  const paths = userPaths(config, user);
  if (scope === 'shared') return { root: paths.sharedMemory, allowed: memoryExtensions };
  if (scope === 'skills') return { root: paths.skills, allowed: skillExtensions };
  // Profile is a single file, and it lives one level above memory. As the root we give the person's
  // directory: nobody walks it as a file list, and "is there a file" is a question to it too.
  if (scope === 'profile') return { root: paths.icarus, allowed: NO_FILES };
  return { root: paths.memory, allowed: memoryExtensions };
}

/**
 * Sections that have no files at all: there is nothing to ask them for a file list.
 * An empty set instead of `[]` — because below it is compared as a set.
 */
const NO_FILES: ReadonlySet<string> = new Set();

/** Which scopes a person has and what can be done in them. */
function scopesFor(): Record<string, ScopeMode> {
  // There are exactly two scopes, and both are memory. Skills and math do not belong here: they are
  // sections with their own root, and in the scope list they would appear as a second entrance
  // to the same place — exactly the confusion because of which math was removed from here.
  return { personal: 'memory', shared: 'memory' };
}

/** Repositories and directories without which the section cannot be opened: the panel creates them. */
async function prepare(config: IcarusConfig, userId: string): Promise<void> {
  const user = findUser(config, userId);
  if (!user) return;
  const paths = userPaths(config, user);
  await ensureRepo(paths.memory);
  await ensureRepo(paths.sharedMemory);
  // Skills have their own repository inside the directory that pi reads as `~/.pi/agent/skills`.
  // Separate from pi-agent: in pi-agent itself lie auth.json and mcp.json with keys, and
  // creating a repository over them would mean committing keys.
  await ensureRepo(paths.skills);
}

/** How many files in each scope: the panel shows this as a number next to the section. */
function countsFor(config: IcarusConfig, userId: string): Record<string, number> {
  const user = findUser(config, userId);
  if (!user) return {};
  const paths = userPaths(config, user);
  const counts: Record<string, number> = {
    personal: countFiles(paths.memory, memoryExtensions),
    shared: countFiles(paths.sharedMemory, memoryExtensions),
    // For skills we count not files but the skills themselves: a bundle of a dozen files is
    // one skill, and the number next to the section must mean exactly that.
    // Shared ones are also included in the count: the panel shows them in the same list.
    skills: listSkills(paths.skills).length,
  };
  try {
    counts.skills = countVisibleSkills(config, userId);
  } catch (error) {
    logger.warn('скиллы: счётчик не собрался', { user: userId, error: String(error) });
  }
  try {
    counts.mcp = countVisible(config, userId);
  } catch (error) {
    // A broken MCP store must not bring down the counters of the whole panel.
    logger.warn('MCP: счётчик не собрался', { user: userId, error: String(error) });
  }
  try {
    // We count artifacts across all workspaces: the section is one, but they lie in different ones.
    counts.artifacts = countArtifacts(config, userId);
  } catch (error) {
    logger.warn('артефакты: счётчик не собрался', { user: userId, error: String(error) });
  }
  return counts;
}

export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
): Promise<boolean> {
  const { config } = ctx;

  // Public MCP routes: they are called by the authorization server and the browser after a
  // redirect, not by the panel with the SSO header. In the callback the person is bound by state.
  if (url.pathname.startsWith('/panel/mcp/oauth/')) {
    if (await handleMcpPublic(req, res, url, ctx)) return true;
  }

  const access = identifyPanelUser(req, config);

  // Artifact file: a path, not a query, so that relative links inside the HTML
  // (styles, images) resolve by themselves. SSO is mandatory here: this is the panel.
  if (url.pathname.startsWith('/panel/artifacts/raw/')) {
    if (!access.ok) {
      json(
        res,
        access.denial.status,
        errorBody(
          `${access.denial.message}. ${access.denial.hint}`,
          access.denial.status === 401 ? 'authentication_error' : 'permission_error',
        ),
      );
      return true;
    }
    handleArtifactsRaw(req, res, url, config, access.identity.userId);
    return true;
  }

  // The file of a specific version — for previewing history. The same SSO as the panel.
  if (url.pathname.startsWith('/panel/artifacts/version/')) {
    if (!access.ok) {
      json(
        res,
        access.denial.status,
        errorBody(
          `${access.denial.message}. ${access.denial.hint}`,
          access.denial.status === 401 ? 'authentication_error' : 'permission_error',
        ),
      );
      return true;
    }
    await handleArtifactsVersionRaw(req, res, url, config, access.identity.userId);
    return true;
  }

  // The panel root is chat: this is now the main screen, and memory and skills live
  // as settings. Old links to a memory file still lead to memory.
  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    if (!access.ok) {
      res.writeHead(access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(panelHtml(access.denial));
      return true;
    }
    const legacy = url.searchParams.has('scope') || url.searchParams.has('file') || url.searchParams.has('tab');
    if (!legacy) {
      res.writeHead(302, { location: '/panel/chat' });
      res.end();
      return true;
    }
    const scope = parseScope(url.searchParams.get('scope'));
    const query = new URLSearchParams({ scope });
    const file = url.searchParams.get('file');
    if (file) query.set('file', file);
    if (url.searchParams.get('tab') === 'history') query.set('tab', 'history');
    res.writeHead(302, { location: `/panel/memory?${query}` });
    res.end();
    return true;
  }

  const page = routePage(url.pathname);
  if (page) {
    // Old links opened settings over the chat (?settings=memory). Now the
    // settings have their own page with a menu in the left panel — we lead there without losing the section.
    const legacySettings = page.section === 'chat' ? url.searchParams.get('settings') : null;
    if (legacySettings && /^(artifacts|memory|skills|mcp|tasks|keys|profile)$/.test(legacySettings)) {
      res.writeHead(302, { location: `/panel/${legacySettings}` });
      res.end();
      return true;
    }
    let html: string;
    let status: number;
    if (!access.ok) {
      html = panelHtml(access.denial);
      status = access.denial.status;
    } else if (page.section === 'keys' && !isAdmin(findUser(config, access.identity.userId))) {
      // We do not hide the section behind a 404: the person came by a link from a bookmark and must
      // understand that it is about permissions, not a broken panel.
      html = panelHtml({
        status: 403,
        message: 'Ключи правит только админ',
        hint: 'Флаг admin: true выдаётся человеку в users: config.yaml (на проде — правкой конфига на хосте).',
      });
      status = 403;
    } else {
      html = await sectionPage(
        config,
        access.identity.userId,
        page,
        url,
        typeof ctx.draft === 'function',
        Boolean(ctx.registry),
      );
      status = 200;
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  // Artifacts have their own prefix, like MCP and keys: the page and API live together.
  if (url.pathname === '/panel/artifacts/api' || url.pathname.startsWith('/panel/artifacts/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  if (url.pathname === '/panel/mcp' || url.pathname.startsWith('/panel/mcp/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  // Keys have their own prefix, like MCP: the page and API live under one section.
  if (url.pathname === '/panel/keys/api' || url.pathname.startsWith('/panel/keys/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  // Profile is the same story as MCP: the page and its API live under one section,
  // so the API goes by its own prefix instead of sharing an address with the page.
  if (url.pathname === '/panel/profile/api' || url.pathname.startsWith('/panel/profile/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  // Tasks have their own prefix, like MCP: the page and its API live under one section.
  if (url.pathname === '/panel/tasks/api' || url.pathname.startsWith('/panel/tasks/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  if (url.pathname.startsWith('/panel/api/') || routeApi(url.pathname)) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  return false;
}

/** Section from the address: /panel/chat, /panel/artifacts, /panel/memory and the rest. */
function routePage(pathname: string): PanelPage | null {
  if (pathname === '/panel/chat' || pathname === '/panel/chat/') return { section: 'chat' };
  const match = /^\/panel\/(artifacts|memory|skills|mcp|tasks|keys|profile)\/?$/.exec(pathname);
  return match ? { section: match[1] } : null;
}

/** API route from the address: /panel/<section>/<name>. */
function routeApi(pathname: string): { section: string; name: string } | null {
  const match = /^\/panel\/(memory|skills)\/([\w-]+)$/.exec(pathname);
  return match ? { section: match[1], name: match[2] } : null;
}

/**
 * Panel sections for this person: keys — only for an admin. We do not hide the other sections:
 * they are his own memory, skills and settings.
 */
function sectionsFor(
  config: IcarusConfig,
  user: UserConfig | undefined,
  ui: PanelStrings,
): { id: string; label: string }[] {
  return SECTIONS.filter((section) => section.adminOnly !== true || isAdmin(user)).map(({ id }) => ({
    id,
    label: sectionLabel(id, ui),
  }));
}

async function sectionPage(
  config: IcarusConfig,
  userId: string,
  page: PanelPage,
  url: URL,
  draftSkills: boolean,
  chatEnabled: boolean,
): Promise<string> {
  await prepare(config, userId);
  const user = findUser(config, userId);
  // The interface language is set before building the session: from it come the labels of sections, scopes
  // and all page strings. Without a person (panel without config) Russian remains.
  const uiLanguage: UiLanguage = user ? uiLanguageOf(config, user) : DEFAULT_UI_LANGUAGE;
  const ui = panelStrings(uiLanguage);
  const session: PanelSession = {
    user: userId,
    sections: sectionsFor(config, user, ui),
    scopes: scopesFor(),
    scopeLabels: scopeLabels(ui),
    model: config.models[0]?.id ?? '—',
    storage: 'git · local',
    draftSkills,
    admin: isAdmin(user),
    uiLanguage,
    // Response language: the panel shows it in the "Profile" section and highlights
    // the selected one. It also goes into the person's AGENTS.md (see workspace.ts).
    ...(user ? { language: languageOf(config, user) } : {}),
  };
  if (page.section === 'chat') {
    return chatPage(session, {
      chatId: url.searchParams.get('chat') ?? undefined,
      enabled: chatEnabled,
    });
  }
  if (page.section === 'mcp') {
    return mcpPage(session);
  }
  if (page.section === 'tasks') {
    return tasksPage(session, config);
  }
  if (page.section === 'keys') {
    return keysPage(session);
  }
  if (page.section === 'artifacts') {
    return artifactsPage(session, {
      ...(url.searchParams.get('artifact') ? { artifact: url.searchParams.get('artifact')! } : {}),
      counts: countsFor(config, userId),
    });
  }
  return panelHtml(session, {
    ...page,
    // Scope — only for memory: skills and math have none, and dragging the personal one there
    // would mean showing the section in a form that does not exist.
    scope: scopeFor(page.section, url.searchParams.get('scope')),
    file: url.searchParams.get('file') ?? undefined,
    // Owner of the open skill: for your own it matches the person, for a shared one
    // it comes in the address. Without it two skills with the same id cannot be told apart.
    owner: url.searchParams.get('owner') ?? undefined,
    // An empty editor of a new skill is also state, and it lives in the address: the link
    // "create a skill" can be forwarded, and "back" returns to the list.
    fresh: url.searchParams.get('new') === '1',
    tab: url.searchParams.get('tab') === 'history' ? 'history' : 'notes',
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
  access: ReturnType<typeof identifyPanelUser>,
): Promise<void> {
  const { config } = ctx;
  if (!access.ok) {
    json(
      res,
      access.denial.status,
      errorBody(
        `${access.denial.message}. ${access.denial.hint}`,
        access.denial.status === 401 ? 'authentication_error' : 'permission_error',
      ),
    );
    return;
  }

  const userId = access.identity.userId;

  // Artifacts are their own section: list, read, links and delete. Its routes must not
  // fall into the common memory parsing, otherwise "artifact file" would be searched
  // among memory records.
  if (url.pathname === '/panel/artifacts/api' || url.pathname.startsWith('/panel/artifacts/api/')) {
    await handleArtifactsApi(req, res, url, config, userId);
    return;
  }

  // Tasks are a separate branch: they have their own schedule storage, not memory files.
  // The branch stands before the common scope parsing, otherwise "tasks" would be searched among records.
  if (url.pathname === '/panel/tasks/api' || url.pathname.startsWith('/panel/tasks/api/')) {
    await handleTasksApi(req, res, url, { config, userId });
    return;
  }

  // Keys — admin only: the check lives in the handler, next to the file writing,
  // so that no new route of the section can bypass it.
  if (url.pathname === '/panel/keys/api' || url.pathname.startsWith('/panel/keys/api/')) {
    await handleKeysApi(req, res, url, { config, userId, bump: ctx.bump });
    return;
  }

  // MCP is a separate section with its own routes; it does not enter the common scope
  // parsing, otherwise memory "files" would try to open an MCP server.
  if (url.pathname.startsWith('/panel/mcp/')) {
    await handleMcpApi(req, res, url, ctx, userId);
    return;
  }

  // Chat is a separate branch: it has its own entities (dialogs and pi sessions), and the common
  // memory parsing would only get in the way here. It reads the POST body itself, so we leave
  // before the common readJsonBody below.
  if (url.pathname === '/panel/api/chats' || url.pathname.startsWith('/panel/api/chat/')) {
    await handleChatApi(req, res, url, {
      config,
      userId,
      registry: ctx.registry,
      ...(ctx.archiveTelegram ? { archiveTelegram: ctx.archiveTelegram } : {}),
    });
    return;
  }

  // Workspaces are folders, not containers: a separate branch, the same person from the proxy.
  if (url.pathname === '/panel/api/workspaces' || url.pathname.startsWith('/panel/api/workspaces/')) {
    await handleWorkspacesApi(req, res, url, { config, userId });
    return;
  }

  // Folders in the left menu are shelves for conversations, not working directories: their own branch,
  // so that they do not fall into the memory scope parsing.
  if (url.pathname === '/panel/api/folders' || url.pathname.startsWith('/panel/api/folders/')) {
    await handleFoldersApi(req, res, url, { config, userId });
    return;
  }

  // Working folder files for the chat's right panel: tree and preview. A separate
  // branch before the common scope parsing — otherwise "files" would be searched in memory.
  if (url.pathname === '/panel/api/workspace-files' || url.pathname.startsWith('/panel/api/workspace-files/')) {
    await handleWorkspaceFilesApi(req, res, url, { config, userId });
    return;
  }

  // "Profile" is a setting, not files: the route lives before the common scope parsing,
  // otherwise a request to save the language would fall into "memory" and look there for a file
  // `profile`. The setting name stands right after `api`, not after the section name.
  if (url.pathname === '/panel/profile/api' || url.pathname.startsWith('/panel/profile/api/')) {
    await prepare(config, userId);
    await handleProfileApi(req, res, ctx, userId);
    return;
  }

  const route = routeApi(url.pathname);
  const name = route?.name ?? url.pathname.slice('/panel/api/'.length);

  if (req.method === 'GET' && name === 'state') {
    const user = findUser(config, userId);
    if (!user) {
      json(res, 404, errorBody(`пользователь ${userId} не заведён`));
      return;
    }
    await prepare(config, userId);
    const scopes = scopesFor();
    const uiLanguage = uiLanguageOf(config, user);
    const ui = panelStrings(uiLanguage);
    json(res, 200, {
      user: userId,
      sections: sectionsFor(config, user, ui),
      scopes: Object.keys(scopes),
      modes: scopes,
      labels: scopeLabels(ui),
      counts: countsFor(config, userId),
      language: languageOf(config, user),
      languages: LANGUAGES,
      languageLabels: LANGUAGE_LABELS,
      uiLanguage,
      uiLanguages: UI_LANGUAGES,
      uiLanguageLabels: LANGUAGE_LABELS,
    });
    return;
  }

  // For GET the scope comes in the query, for POST — in the body. There is no person in the request:
  // the proxy has already named him, and he cannot be substituted.
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (error) {
      // A broken body is a refusal in the request, not a panel crash: there is nothing to fix it with.
      json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
      return;
    }
  }
  // The section in the address is older than the scope: /panel/skills/… is skills, whatever the
  // scope in the request, and /panel/memory/… is only memory.
  const scope = scopeFor(route?.section, url.searchParams.get('scope') ?? body.scope);
  const mode = modeFor(scope);
  const resolved = resolveScope(config, userId, scope);
  if (!resolved) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return;
  }
  const { root, allowed } = resolved;

  if (req.method === 'GET' && name === 'files') {
    // Memory and skills are under git: their edits in the panel are reverted by commits.
    await ensureRepo(root);
    // For skills "files" are the skills themselves: a directory with SKILL.md inside and its bundle.
    // The panel shows them as a list, not a scattering of the files they are made of.
    if (mode === 'skills') {
      try {
        // Own and shared — in one list: a person does not care where the skill is from,
        // he cares whether it is enabled and whether he can edit it.
        json(res, 200, { user: userId, scope, mode, root, skills: listVisibleSkills(config, userId) });
      } catch (error) {
        skillError(res, error);
      }
      return;
    }
    json(res, 200, { user: userId, scope, mode, root, files: listFiles(root, '', allowed) });
    return;
  }

  // ── skills ──────────────────────────────────────────────────────────────────
  // The section is entirely its own: the panel here does not "look at files" but writes skills, so
  // its routes are its own too. Everything below this branch does not reach skills — otherwise
  // "forget a line" and "delete a file" would crawl into SKILL.md.
  if (mode === 'skills') {
    if (req.method === 'GET' && name === 'skill') {
      const owner = url.searchParams.get('owner') ?? userId;
      try {
        const skill = readVisibleSkill(config, userId, owner, url.searchParams.get('id') ?? '');
        if (!skill) {
          json(res, 404, errorBody('скилл не найден или недоступен'));
          return;
        }
        json(res, 200, skill);
      } catch (error) {
        skillError(res, error);
      }
      return;
    }

    // "Write it for me": the person describes an idea — the model assembles a skill draft.
    // The draft only fills the editor: the file and commit appear after "Save".
    if (req.method === 'POST' && name === 'draft') {
      if (!ctx.draft) {
        json(res, 501, errorBody('в этой панели писать некому: рядом нет контейнера с моделью'));
        return;
      }
      const idea = String(body.idea ?? '').trim();
      if (!idea) {
        json(res, 400, errorBody('опиши словами, что скилл должен делать', 'invalid_request_error'));
        return;
      }
      if (idea.length > SKILL_IDEA_LIMIT) {
        json(res, 400, errorBody(`идея длиннее ${SKILL_IDEA_LIMIT} символов — столько модели не нужно`, 'invalid_request_error'));
        return;
      }

      let answer: string;
      try {
        answer = await ctx.draft(userId, idea);
      } catch (error) {
        logger.warn('панель: модель не написала скилл', { user: userId, error: String(error) });
        json(res, 502, errorBody(`модель не ответила: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      // Only the disk knows the taken names: the model knows nothing about them and quite
      // possibly may suggest the name of an existing skill.
      let taken: Set<string>;
      try {
        // The names of shared skills are taken too: pi must not receive two skills
        // with one name — it will silently keep only the first.
        taken = new Set(listVisibleSkills(config, userId).map((skill) => skill.name));
      } catch {
        taken = new Set(listSkills(root).map((skill) => skillLabel(skill.id)));
      }
      const parsed = parseSkillDraft(answer, taken);
      if (!parsed.ok) {
        logger.warn('панель: черновик скилла не разобрался', { user: userId, message: parsed.message });
        json(res, 502, errorBody(parsed.message));
        return;
      }
      logger.info('панель: скилл написан моделью', { user: userId, name: parsed.draft.name || '(имя не вышло)' });
      json(res, 200, parsed.draft);
      return;
    }

    // The whole skill file: the panel opens the skill in an editor, and download is
    // the same SKILL.md served as a file (and the bundle files along with it).
    if (req.method === 'GET' && name === 'file') {
      const relative = url.searchParams.get('path') ?? '';
      const content = readMemoryFile(root, relative, skillExtensions);
      if (content === null) {
        json(res, 404, errorBody('файл не найден или недоступен'));
        return;
      }
      if (url.searchParams.get('download') === '1') {
        sendAttachment(res, relative, content);
        return;
      }
      json(res, 200, { path: relative, content });
      return;
    }

    if (req.method === 'POST' && name === 'save') {
      // Someone else's skill is only read and enabled. Editing it on your side would mean
      // quietly diverging from the author, so the panel refuses instead of copying.
      const owner = typeof body.owner === 'string' && body.owner ? body.owner : userId;
      if (owner !== userId) {
        json(res, 403, errorBody('чужой скилл правит только его владелец', 'permission_error'));
        return;
      }
      const previousId = typeof body.id === 'string' && body.id ? body.id : '';
      let wasShared: boolean;
      try {
        wasShared = previousId !== '' && isSkillShared(config, userId, previousId);
      } catch (error) {
        skillError(res, error);
        return;
      }
      const result = writeSkill(root, {
        ...(previousId ? { id: previousId } : {}),
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        body: String(body.body ?? ''),
        hidden: body.hidden === true,
      });
      if (!result.ok) {
        json(res, 400, errorBody(result.message, 'invalid_request_error'));
        return;
      }
      // The skill was shared — the snapshot at the others must catch up with the edit. First
      // the move (the name could have changed), then the snapshot of the new file.
      try {
        if (wasShared) {
          if (previousId !== result.id) renameShare(config, userId, previousId, result.id);
          setSkillShared(config, userId, result.id, true);
        }
      } catch (error) {
        skillError(res, error);
        return;
      }
      // The commit is part of the save: skills have the same history and the same revert as memory.
      const committed = await commitAll(root, `skills: скилл «${skillLabel(result.id)}»`);
      bumpResources(ctx, userId);
      logger.info('панель: скилл сохранён', { user: userId, id: result.id, committed });
      // The commit hash goes to the panel: the person sees that the skill is not just written but
      // has landed in history, from where it can be returned.
      const [head] = await log(root, 1);
      json(res, 200, { ...result, committed, commit: head?.hash ?? '' });
      return;
    }

    if (req.method === 'POST' && name === 'delete') {
      const owner = typeof body.owner === 'string' && body.owner ? body.owner : userId;
      if (owner !== userId) {
        json(res, 403, errorBody('чужой скилл удаляет только его владелец', 'permission_error'));
        return;
      }
      const id = String(body.id ?? '');
      const label = skillLabel(id);
      // The bundle files could have been placed by hand and not committed: they must not be
      // deleted irrevocably, so first we record what is not in history yet,
      // — then reverting the deletion will return the whole skill, not just one SKILL.md.
      const skillPath = skillScope(id);
      // A disabled skill lies in `.disabled/`, and an uncommitted bundle there must also be
      // recorded: otherwise reverting the deletion will return one SKILL.md.
      if ((await hasChanges(root, skillPath)) || (await hasChanges(root, `${SKILLS_DISABLED_DIR}/${skillPath}`))) {
        await commitAll(root, `skills: ${label} перед удалением`);
      }
      try {
        // We remove sharing before deletion: the snapshot at the others must not outlive the skill.
        setSkillShared(config, userId, id, false);
      } catch (error) {
        skillError(res, error);
        return;
      }
      const result = removeSkill(root, id);
      if (result.ok) await commitAll(root, `skills: удалить «${label}»`);
      if (result.ok) bumpResources(ctx, userId);
      logger.info('панель: скилл удалён', { user: userId, id, ok: result.ok });
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    // Enable/disable. Your own skill moves between the root and `.disabled/`,
    // someone else's — just a flag on my side: the file itself lies in the shared snapshot and is only read.
    if (req.method === 'POST' && name === 'toggle') {
      const id = String(body.id ?? '');
      const owner = typeof body.owner === 'string' && body.owner ? body.owner : userId;
      if (typeof body.enabled !== 'boolean') {
        json(res, 400, errorBody('enabled: ожидалось true или false', 'invalid_request_error'));
        return;
      }
      try {
        if (owner !== userId) {
          setSkillSharedEnabled(config, userId, owner, id, body.enabled);
        } else {
          const shared = isSkillShared(config, userId, id);
          const result = setSkillEnabled(root, id, body.enabled);
          if (!result.ok) {
            json(res, 400, errorBody(result.message, 'invalid_request_error'));
            return;
          }
          // At the owner the skill may be shared: the snapshot must know that the file
          // has moved to `.disabled/`, otherwise at the others it will remain old.
          if (shared) setSkillShared(config, userId, result.id, true);
          await commitAll(root, `skills: ${body.enabled ? 'включить' : 'выключить'} «${skillLabel(id)}»`);
        }
      } catch (error) {
        skillError(res, error);
        return;
      }
      bumpResources(ctx, userId);
      logger.info('панель: скилл переключён', { user: userId, owner, id, enabled: body.enabled });
      json(res, 200, { ok: true, id, owner, enabled: body.enabled });
      return;
    }

    // Share or hide. Owner only: someone else's skill is not his property.
    if (req.method === 'POST' && name === 'share') {
      const id = String(body.id ?? '');
      if (typeof body.shared !== 'boolean') {
        json(res, 400, errorBody('shared: ожидалось true или false', 'invalid_request_error'));
        return;
      }
      try {
        setSkillShared(config, userId, id, body.shared);
      } catch (error) {
        skillError(res, error);
        return;
      }
      bumpResources(ctx, userId);
      logger.info('панель: скилл расшарен', { user: userId, id, shared: body.shared });
      let detail: ReturnType<typeof readVisibleSkill> = null;
      try {
        detail = readVisibleSkill(config, userId, userId, id);
      } catch {
        // The sharing has already happened; a response without the detail is no reason to return an error.
      }
      json(res, 200, detail ?? { ok: true });
      return;
    }

    if (req.method === 'GET' && name === 'history') {
      // Without a path: for skills the history is common across the directory, but with the same numbers per
      // commit line as a memory file — they are drawn by the same layout.
      json(res, 200, { commits: await fileHistory(root, '') });
      return;
    }

    if (req.method === 'GET' && name === 'show') {
      json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
      return;
    }

    if (req.method === 'POST' && name === 'revert') {
      const result = await revert(root, String(body.commit ?? ''));
      if (result.ok) {
        // The revert could have returned a deleted skill or removed an existing one: the snapshots at the
        // others must catch up with this, otherwise they will get an instruction that
        // the author no longer has.
        try {
          syncSharedSkills(config);
        } catch (error) {
          logger.warn('скиллы: снимки не обновились после отката', { user: userId, error: String(error) });
        }
        bumpResources(ctx, userId);
      }
      logger.info('панель: откат скиллов', { user: userId, ok: result.ok });
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'GET' && name === 'search') {
      const query = url.searchParams.get('q') ?? '';
      json(res, 200, { query, hits: searchSkills(root, query, 50) });
      return;
    }

    json(res, 404, errorBody(`неизвестный маршрут раздела скиллов: ${name}`));
    return;
  }

  // File entries: lines with numbers and dates from history — what the panel uses to draw
  // the list with checkboxes. The whole file remains a separate route: it is read by
  // image highlighting and old panel tabs.
  if (req.method === 'GET' && name === 'entries') {
    const relative = url.searchParams.get('path') ?? '';
    const content = readMemoryFile(root, relative, allowed);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return;
    }
    json(res, 200, mode === 'memory' ? await readEntries(root, relative, content) : { ...parseEntries(content), path: relative, capped: false });
    return;
  }

  if (req.method === 'GET' && (name === 'file' || name === 'file-raw')) {
    const relative = url.searchParams.get('path') ?? '';
    const asFile = url.searchParams.get('download') === '1';
    // We always serve an image as bytes, however it is asked for: a chart will not go
    // as a string in JSON, and reading .gif as utf8 means corrupting it in front of the person.
    const raw = name === 'file-raw' || url.searchParams.get('raw') === '1' || isImageFile(relative);
    if (raw && isImageFile(relative)) {
      const image = readImageFile(root, relative, allowed);
      if (!image) {
        json(res, 404, errorBody('картинка не найдена или недоступна'));
        return;
      }
      res.writeHead(200, {
        'content-type': image.type,
        'cache-control': 'private, max-age=300',
        ...(asFile ? { 'content-disposition': disposition(relative) } : {}),
      });
      fs.createReadStream(image.file).pipe(res);
      return;
    }
    const content = readMemoryFile(root, relative, allowed);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return;
    }
    // download=1 — serve the file as a file: the browser will save it under the same name
    // instead of showing it as text. The path checks here are the same as for ordinary reading.
    if (asFile) {
      sendAttachment(res, relative, content);
      return;
    }
    json(res, 200, { path: relative, content });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'file-history') {
    json(res, 200, { commits: await fileHistory(root, url.searchParams.get('path') ?? '') });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'history') {
    json(res, 200, { commits: await log(root) });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'show') {
    json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
    return;
  }

  if (req.method === 'GET' && name === 'search') {
    const query = url.searchParams.get('q') ?? '';
    json(res, 200, { query, hits: searchMemory(root, query, 50, allowed) });
    return;
  }

  if (mode === 'memory' && req.method === 'POST' && name === 'revert') {
    const result = await revert(root, String(body.commit ?? ''));
    logger.info('панель: откат коммита', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (mode === 'memory' && req.method === 'POST' && name === 'forget') {
    const result = removeLine(root, String(body.path ?? ''), String(body.line ?? ''), allowed);
    if (result.ok) {
      await commitAll(root, `memory: забыть «${String(body.line ?? '').slice(0, 60)}»`);
    }
    logger.info('панель: забывание', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // A batch of entries marked with checkboxes: we delete them in one commit so that in history
  // it is one meaningful action, not a dozen "forget a line".
  if (mode === 'memory' && req.method === 'POST' && name === 'forget-many') {
    const relative = String(body.path ?? '');
    const lines = Array.isArray(body.lines) ? body.lines.map(Number) : [];
    const refused = guardEntries(root, relative, lines, allowed);
    if (refused) {
      json(res, 400, errorBody(refused, 'invalid_request_error'));
      return;
    }
    const result = removeLines(root, relative, lines, allowed);
    if (result.ok) {
      await commitAll(root, `memory: убрать записей из «${relative.slice(0, 60)}»: ${lines.length}`);
    }
    logger.info('панель: забывание пачки', { user: userId, scope, count: lines.length, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // Deleting a whole file is also a commit: the loss is visible in history, and it can be
  // returned by a reverse commit, like any other memory edit.
  if (mode === 'memory' && req.method === 'POST' && name === 'delete') {
    const relative = String(body.path ?? '');
    const result = removeFile(root, relative, allowed);
    if (result.ok) {
      await commitAll(root, `memory: удалить файл «${relative.slice(0, 80)}»`);
    }
    logger.info('панель: удаление файла', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  json(res, 404, errorBody(`неизвестный маршрут панели: ${name}`));
}

/**
 * Checks that exactly entries are about to be deleted: a section heading is not an entry,
 * and "removing" it means tearing down the section together with everything written under it.
 * At the same time we catch the case when the file has already changed: then the numbers are no longer the right ones.
 */
function guardEntries(
  root: string,
  relative: string,
  lines: number[],
  allowed: ReadonlySet<string>,
): string | null {
  const content = readMemoryFile(root, relative, allowed);
  if (content === null) return 'файл не найден или недоступен';
  // Dates are not needed here: the parsing goes by the file lines, and the history will come to the panel.
  const entries = new Map(parseEntries(content).entries.map((entry) => [entry.line, entry.kind]));
  for (const line of lines) {
    const kind = entries.get(line);
    if (kind === undefined) return `строки ${line} в файле уже нет`;
    if (kind !== 'note') return `строка ${line} — не запись: заголовки и текст не удаляем`;
  }
  return null;
}
