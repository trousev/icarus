// Панель управления Icarus: чат и настройки — тонкий JSON-слой над сессиями pi,
// файлами и git.
//
// Человека называет SSO-прокси (см. identity.ts), поэтому параметра user в запросах нет
// и подменить его нельзя: чужую память через свою сессию не открыть.
//
// Главный экран — /panel/chat: диалоги, лента и композер. Чат ходит в те же сессии
// pi, что Telegram, только conversationId начинается с web-. Настройки
// (/panel/memory, /panel/skills, /panel/mcp) открываются панелью поверх чата.
//
// Внутри памяти две области: личная и семейная. Файлов встроенных умений здесь нет:
// их инструменты — обычный MCP, а всё созданное живёт в рабочей папке разговора.
//
// Скиллы — третий вид раздела: их пишет человек, и правка тут не построчная, а целым
// файлом (`SKILL.md`). Панель — автор скиллов, pi — их читатель: каталог скиллов
// человека монтируется в контейнер как `~/.pi/agent/skills`, откуда pi берёт их при
// старте сессии. Поэтому после сохранения панель поднимает поколение ресурсов: живой
// разговор доигрывает на старом наборе, а следующий ход поднимает pi заново.
//
// Старые адреса (/panel/api/*) остаются рабочими: браузер держит открытую страницу
// панели живой, и после обновления сервиса она не должна осыпаться на полуслове.
// Новые маршруты короче и называют раздел явно — их и рисует сама панель.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { handleWorkspacesApi } from './workspaces.ts';
import { DEFAULT_WORKSPACE, findUser, isAdmin, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { LANGUAGE_LABELS, LANGUAGES, languageOf, writeProfile, type Language } from '../profile.ts';
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
  listSkills,
  readSkill,
  removeSkill,
  searchSkills,
  skillExtensions,
  skillLabel,
  skillScope,
  writeSkill,
} from './skills.ts';
import { panelHtml, type PanelPage, type PanelSession } from './ui.ts';
import { chatPage } from './chat-ui.ts';
import { handleKeysApi } from './keys.ts';
import { keysPage } from './keys-ui.ts';
import { handleMcpApi, handleMcpPublic } from './mcp.ts';
import { mcpPage } from './mcp-ui.ts';
import { countVisible } from '../mcp/registry.ts';
import { handleChatApi } from './chat.ts';
import { handleArtifactsApi, handleArtifactsRaw } from './artifacts.ts';
import { artifactsPage } from './artifacts-ui.ts';
import { artifactWorkspaces, countArtifacts } from '../artifacts.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { log as logger } from '../log.ts';

export type PanelContext = {
  config: IcarusConfig;
  /** Живые сессии pi: из них панель отправляет сообщения и читает историю. */
  registry?: SessionRegistry;
  /**
   * Отметить, что медленные ресурсы человека (скиллы) поменялись: живая сессия pi
   * держит их в памяти с самого старта, поэтому следующий ход поднимает её заново.
   * Не передан — панель просто пишет файлы (так её гоняют тесты хранилища).
   */
  bump?: (userId: string) => void;
  /**
   * Спросить модель: панель зовёт её, чтобы написать скилл по описанию человека.
   * Не передан — кнопки «напиши за меня» нет вовсе (так живёт локальная панель:
   * контейнера с моделью рядом с ней нет).
   */
  draft?: (userId: string, idea: string) => Promise<string>;
};

/** Разделы панели: порядок здесь — порядок в сайдбаре. */
export const SECTIONS: { id: string; label: string; adminOnly?: boolean }[] = [
  { id: 'memory', label: 'Память' },
  { id: 'skills', label: 'Скиллы' },
  { id: 'mcp', label: 'MCP' },
  // Ключи — настройка инсталляции, а не человека: раздел видят и открывают только
  // админы. Стоит он перед «Пользователем»: остальное — про содержимое, это — про
  // доступы, а последним идёт личная настройка.
  { id: 'keys', label: 'Ключи', adminOnly: true },
  { id: 'profile', label: 'Пользователь' },
];

type Scope = 'personal' | 'shared' | 'skills' | 'profile';
/** Режим раздела: memory правится построчно, skills — целым файлом. */
export type ScopeMode = 'memory' | 'skills' | 'profile';

/** Заголовки областей: их рисует панель, и держать их в браузере незачем. */
const SCOPE_LABELS: Record<string, string> = {
  personal: 'Личная',
  shared: 'Семейная',
  skills: 'Скиллы',
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Раздел «Пользователь»: сейчас в нём одна настройка — язык ответов.
 *
 * GET отдаёт текущий язык и список доступных, POST его меняет. Файл профиля лежит
 * рядом с памятью человека, поэтому язык переживает и перезапуск сервиса, и
 * пересоздание контейнера. Живую сессию он не рвёт: pi читает AGENTS.md при старте,
 * поэтому следующая реплика поднимает её заново — тем же механизмом, что и скиллы.
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
  if (typeof language !== 'string' || !(LANGUAGES as readonly string[]).includes(language)) {
    json(res, 400, errorBody(`язык «${String(language)}» не поддерживается: ${LANGUAGES.join(', ')}`, 'invalid_request_error'));
    return;
  }

  const previous = languageOf(config, user);
  writeProfile(config, user, { language: language as Language });

  // Язык живёт в AGENTS.md, а его pi читает при старте процесса — значит, живую
  // сессию без этой пометки смена языка не догонит, и человек услышит прежний язык.
  // Помечаем только когда язык правда поменялся: лишний перезапуск сессии — это
  // потеря контекста разговора ни за что.
  if (language !== previous) bumpResources(ctx, userId);

  json(res, 200, { user: userId, language });
}

/**
 * Ресурсы человека поменялись — pi об этом ещё не знает.
 *
 * Ресурсы pi читает один раз при старте процесса: каталог скиллов и карту окружения
 * (AGENTS.md, а в ней — язык ответов). Поэтому правка файла сама по себе до живого
 * разговора не доедет. Пометка «ресурсы обновились» говорит реестру сессий поднять
 * следующую сессию заново: идущий ход доигрывает на прежнем наборе, а следующий
 * ответ — уже с новым скиллом или на новом языке (см. SessionRegistry.bumpResources).
 * Ошибка тут не должна отменять сохранение: файл уже записан и закоммичен.
 */
function bumpResources(ctx: PanelContext, userId: string): void {
  try {
    ctx.bump?.(userId);
  } catch (error) {
    logger.warn('не удалось отметить обновление ресурсов', { user: userId, error: String(error) });
  }
}

/**
 * Заголовок для скачивания: имя файла как есть, а не «file».
 *
 * Имена в памяти русские, а в ASCII-варианте заголовка кириллицы быть не может —
 * поэтому имя едет дважды: подчищенное для старых браузеров и percent-encoded
 * (RFC 5987) для всех остальных. Без второго браузер сохранил бы «здоровье.md»
 * как «______.md».
 */
export function disposition(relative: string): string {
  const name = relative.split('/').pop() ?? 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Отдать текст файлом: браузер сохранит его под тем же именем, а не покажет
 * страницей. Проверки пути — те же, что у обычного чтения: их делает тот, кто
 * уже прочитал содержимое.
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
 * Область памяти из запроса: всё незнакомое — личная, как и раньше.
 */
function parseScope(raw: unknown): 'personal' | 'shared' {
  return raw === 'shared' ? raw : 'personal';
}

function modeFor(scope: Scope): ScopeMode {
  if (scope === 'skills') return 'skills';
  // Профиль — не файлы, а форма настроек: у него свой рендер и свои маршруты,
  // и в общий разбор «файлов памяти» он не заходит.
  if (scope === 'profile') return 'profile';
  return 'memory';
}

/**
 * Какую область читает запрос.
 *
 * У новых маршрутов раздел стоит в адресе (`/panel/skills/files`) и решает всё:
 * область из query там только путала бы. У старых (`/panel/api/*`) раздела в
 * адресе нет — они и раньше называли область параметром, и открытая в браузере
 * вкладка панели должна продолжать работать после обновления сервиса.
 */
function scopeFor(section: string | undefined, raw: unknown): Scope {
  if (section === 'skills') return 'skills';
  if (section === 'profile') return 'profile';
  if (section === 'memory') return parseScope(raw);
  return raw === 'shared' ? raw : 'personal';
}

/** Корень раздела и набор расширений, которые в нём вообще допустимы. */
function resolveScope(config: IcarusConfig, userId: string, scope: Scope) {
  const user = findUser(config, userId);
  if (!user) return null;
  const paths = userPaths(config, user);
  if (scope === 'shared') return { root: paths.sharedMemory, allowed: memoryExtensions };
  if (scope === 'skills') return { root: paths.skills, allowed: skillExtensions };
  // Профиль — один файл, и живёт он на уровень выше памяти. Корнем отдаём каталог
  // человека: списком файлов его никто не ходит, а «есть ли файл» — вопрос к нему же.
  if (scope === 'profile') return { root: paths.icarus, allowed: NO_FILES };
  return { root: paths.memory, allowed: memoryExtensions };
}

/**
 * Разделы, у которых файлов нет вовсе: список файлов у них запрашивать нечего.
 * Пустой набор вместо `[]` — потому что ниже его сравнивают как множество.
 */
const NO_FILES: ReadonlySet<string> = new Set();

/** Какие области есть у человека и что в них можно делать. */
function scopesFor(): Record<string, ScopeMode> {
  // Областей ровно две, и обе — память. Скиллы и математика сюда не входят: это
  // разделы со своим корнем, и в списке областей они появлялись бы вторым входом
  // туда же — ровно та путаница, из-за которой математику отсюда убрали.
  return { personal: 'memory', shared: 'memory' };
}

/** Репозитории и каталоги, без которых раздел не открыть: панель их и заводит. */
async function prepare(config: IcarusConfig, userId: string): Promise<void> {
  const user = findUser(config, userId);
  if (!user) return;
  const paths = userPaths(config, user);
  await ensureRepo(paths.memory);
  await ensureRepo(paths.sharedMemory);
  // Скиллы — свой репозиторий внутри каталога, который pi читает как `~/.pi/agent/skills`.
  // Отдельный от pi-agent: в самом pi-agent лежат auth.json и mcp.json с ключами, и
  // заводить репозиторий над ними значило бы коммитить ключи.
  await ensureRepo(paths.skills);
}

/** Сколько файлов в каждой области: панель показывает это числом у раздела. */
function countsFor(config: IcarusConfig, userId: string): Record<string, number> {
  const user = findUser(config, userId);
  if (!user) return {};
  const paths = userPaths(config, user);
  const counts: Record<string, number> = {
    personal: countFiles(paths.memory, memoryExtensions),
    shared: countFiles(paths.sharedMemory, memoryExtensions),
    // У скиллов считаем не файлы, а сами скиллы: бандл из десятка файлов —
    // это один скилл, и число рядом с разделом должно значить именно это.
    skills: listSkills(paths.skills).length,
  };
  try {
    counts.mcp = countVisible(config, userId);
  } catch (error) {
    // Сломанное хранилище MCP не должно ронять счётчики всей панели.
    logger.warn('MCP: счётчик не собрался', { user: userId, error: String(error) });
  }
  try {
    // Артефакты считаем по всем workspace'ам: раздел один, а лежат они в разных.
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

  // Публичные маршруты MCP: их зовёт authorization server и браузер после
  // редиректа, а не панель с заголовком SSO. В callback человека связывает state.
  if (url.pathname.startsWith('/panel/mcp/oauth/')) {
    if (await handleMcpPublic(req, res, url, ctx)) return true;
  }

  const access = identifyPanelUser(req, config);

  // Файл артефакта: путь, а не query, чтобы относительные ссылки внутри HTML
  // (стили, картинки) разрешались сами. SSO тут обязателен: это панель.
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

  // Корень панели — чат: это теперь главный экран, а память и скиллы живут
  // настройками. Старые ссылки на файл памяти по-прежнему ведут в память.
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
    // Старые ссылки открывали настройки поверх чата (?settings=memory). Теперь у
    // настроек своя страница с меню в левой панели — туда и ведём, не теряя раздел.
    const legacySettings = page.section === 'chat' ? url.searchParams.get('settings') : null;
    if (legacySettings && /^(artifacts|memory|skills|mcp|keys|profile)$/.test(legacySettings)) {
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
      // Раздел не прячем в 404: человек пришёл по ссылке из закладки и должен
      // понять, что дело в правах, а не в сломанной панели.
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

  // Артефакты — свой префикс, как у MCP и ключей: страница и API живут вместе.
  if (url.pathname === '/panel/artifacts/api' || url.pathname.startsWith('/panel/artifacts/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  if (url.pathname === '/panel/mcp' || url.pathname.startsWith('/panel/mcp/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  // Ключи — свой префикс, как у MCP: страница и API живут под одним разделом.
  if (url.pathname === '/panel/keys/api' || url.pathname.startsWith('/panel/keys/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  // Профиль — та же история, что у MCP: страница и её API живут под одним разделом,
  // поэтому API уходит по своему префиксу, а не делит адрес со страницей.
  if (url.pathname === '/panel/profile/api' || url.pathname.startsWith('/panel/profile/api/')) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  if (url.pathname.startsWith('/panel/api/') || routeApi(url.pathname)) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  return false;
}

/** Раздел из адреса: /panel/chat, /panel/artifacts, /panel/memory и остальные. */
function routePage(pathname: string): PanelPage | null {
  if (pathname === '/panel/chat' || pathname === '/panel/chat/') return { section: 'chat' };
  const match = /^\/panel\/(artifacts|memory|skills|mcp|keys|profile)\/?$/.exec(pathname);
  return match ? { section: match[1] } : null;
}

/** Маршрут API из адреса: /panel/<раздел>/<имя>. */
function routeApi(pathname: string): { section: string; name: string } | null {
  const match = /^\/panel\/(memory|skills)\/([\w-]+)$/.exec(pathname);
  return match ? { section: match[1], name: match[2] } : null;
}

/**
 * Разделы панели у этого человека: ключи — только у админа. Остальных разделов
 * не прячем: это его собственные память, скиллы и настройки.
 */
function sectionsFor(config: IcarusConfig, user: UserConfig | undefined): { id: string; label: string }[] {
  return SECTIONS.filter((section) => section.adminOnly !== true || isAdmin(user)).map(({ id, label }) => ({
    id,
    label,
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
  const session: PanelSession = {
    user: userId,
    sections: sectionsFor(config, user),
    scopes: scopesFor(),
    scopeLabels: SCOPE_LABELS,
    model: config.models[0]?.id ?? '—',
    storage: 'git · local',
    draftSkills,
    admin: isAdmin(user),
    // Язык ответов: панель показывает его в разделе «Пользователь» и подсвечивает
    // выбранный. Он же уезжает в AGENTS.md человека (см. workspace.ts).
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
  if (page.section === 'keys') {
    return keysPage(session);
  }
  if (page.section === 'artifacts') {
    // Workspace — состояние страницы, а не глобальная настройка: артефакты лежат
    // в рабочей папке, и человек может держать их в любой из своих.
    const workspaces = artifactWorkspaces(config, userId);
    const requested = url.searchParams.get('workspace');
    const workspace =
      workspaces.find((item) => item.slug === requested)?.slug ??
      workspaces.find((item) => item.slug === DEFAULT_WORKSPACE)?.slug ??
      workspaces[0]?.slug ??
      DEFAULT_WORKSPACE;
    return artifactsPage(session, {
      workspace,
      ...(url.searchParams.get('artifact') ? { artifact: url.searchParams.get('artifact')! } : {}),
      workspaces: workspaces.map((item) => ({ slug: item.slug, name: item.name })),
      counts: countsFor(config, userId),
    });
  }
  return panelHtml(session, {
    ...page,
    // Область — только у памяти: у скиллов и математики её нет, и тащить туда личную
    // значит показывать раздел в виде, которого не бывает.
    scope: scopeFor(page.section, url.searchParams.get('scope')),
    file: url.searchParams.get('file') ?? undefined,
    // Пустой редактор нового скилла — тоже состояние, и живёт оно в адресе: ссылку
    // «заведи скилл» можно переслать, а «назад» возвращает к списку.
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

  // Артефакты — свой раздел: список, чтение, ссылки и удаление. Его маршруты не
  // должны попадать в общий разбор памяти, иначе «файл артефакта» искали бы
  // среди записей памяти.
  if (url.pathname === '/panel/artifacts/api' || url.pathname.startsWith('/panel/artifacts/api/')) {
    await handleArtifactsApi(req, res, url, config, userId);
    return;
  }

  // Ключи — только админ: проверка живёт в обработчике, рядом с записью файлов,
  // чтобы её не обошёл ни один новый маршрут раздела.
  if (url.pathname === '/panel/keys/api' || url.pathname.startsWith('/panel/keys/api/')) {
    await handleKeysApi(req, res, url, { config, userId, bump: ctx.bump });
    return;
  }

  // MCP — отдельный раздел со своими маршрутами; в общий разбор областей он не
  // заходит, иначе «файлы» памяти попытались бы открыть MCP-сервер.
  if (url.pathname.startsWith('/panel/mcp/')) {
    await handleMcpApi(req, res, url, ctx, userId);
    return;
  }

  // Чат — отдельная ветка: у него свои сущности (диалоги и сессии pi), и общий
  // разбор памяти тут только мешал бы. Тело POST он читает сам, поэтому уходим
  // до общего readJsonBody ниже.
  if (url.pathname === '/panel/api/chats' || url.pathname.startsWith('/panel/api/chat/')) {
    await handleChatApi(req, res, url, { config, userId, registry: ctx.registry });
    return;
  }

  // Workspace'ы — папки, а не контейнеры: отдельная ветка, тот же человек из прокси.
  if (url.pathname === '/panel/api/workspaces' || url.pathname.startsWith('/panel/api/workspaces/')) {
    await handleWorkspacesApi(req, res, url, { config, userId });
    return;
  }

  // «Пользователь» — настройка, а не файлы: маршрут живёт до общего разбора области,
  // иначе запрос на сохранение языка попал бы в «память» и искал бы в ней файл
  // `profile`. Имя настройки стоит сразу за `api`, а не после имени раздела.
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
    json(res, 200, {
      user: userId,
      sections: sectionsFor(config, user),
      scopes: Object.keys(scopes),
      modes: scopes,
      labels: SCOPE_LABELS,
      counts: countsFor(config, userId),
      language: languageOf(config, user),
      languages: LANGUAGES,
      languageLabels: LANGUAGE_LABELS,
    });
    return;
  }

  // У GET область приходит в query, у POST — в теле. Человека в запросе нет:
  // его уже назвал прокси, и подменить его нельзя.
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (error) {
      // Битое тело — это отказ в запросе, а не падение панели: чинить его нечем.
      json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
      return;
    }
  }
  // Раздел в адресе старше области: /panel/skills/… — это скиллы, каким бы
  // ни был scope в запросе, а /panel/memory/… — только память.
  const scope = scopeFor(route?.section, url.searchParams.get('scope') ?? body.scope);
  const mode = modeFor(scope);
  const resolved = resolveScope(config, userId, scope);
  if (!resolved) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return;
  }
  const { root, allowed } = resolved;

  if (req.method === 'GET' && name === 'files') {
    // Память и скиллы — под git: их правки в панели откатываются коммитами.
    await ensureRepo(root);
    // У скиллов «файлы» — это сами скиллы: каталог с SKILL.md внутри и его бандл.
    // Панель показывает их списком, а не россыпью файлов, из которых они собраны.
    if (mode === 'skills') {
      json(res, 200, { user: userId, scope, mode, root, skills: listSkills(root) });
      return;
    }
    json(res, 200, { user: userId, scope, mode, root, files: listFiles(root, '', allowed) });
    return;
  }

  // ── скиллы ──────────────────────────────────────────────────────────────────
  // Раздел целиком свой: панель тут не «смотрит файлы», а пишет скиллы, поэтому и
  // маршруты у него свои. Всё, что ниже этой ветки, до скиллов не доходит — иначе
  // «забудь строку» и «удали файл» полезли бы в SKILL.md.
  if (mode === 'skills') {
    if (req.method === 'GET' && name === 'skill') {
      const skill = readSkill(root, url.searchParams.get('id') ?? '');
      if (!skill) {
        json(res, 404, errorBody('скилл не найден или недоступен'));
        return;
      }
      json(res, 200, skill);
      return;
    }

    // «Напиши за меня»: человек описывает идею — модель собирает черновик скилла.
    // Черновик только заполняет редактор: файл и коммит появляются после «Сохранить».
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

      // Занятые имена знает только диск: модель про них ничего не знает и вполне
      // может предложить имя существующего скилла.
      const taken = new Set(listSkills(root).map((skill) => skillLabel(skill.id)));
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

    // Файл скилла целиком: панель открывает скилл редактором, а скачивание — это
    // тот же SKILL.md, отданный файлом (и файлы бандла заодно).
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
      const result = writeSkill(root, {
        ...(typeof body.id === 'string' && body.id ? { id: body.id } : {}),
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        body: String(body.body ?? ''),
        hidden: body.hidden === true,
      });
      if (!result.ok) {
        json(res, 400, errorBody(result.message, 'invalid_request_error'));
        return;
      }
      // Коммит — часть сохранения: у скиллов та же история и тот же откат, что у памяти.
      const committed = await commitAll(root, `skills: скилл «${skillLabel(result.id)}»`);
      bumpResources(ctx, userId);
      logger.info('панель: скилл сохранён', { user: userId, id: result.id, committed });
      // Хеш коммита едет в панель: человек видит, что скилл не просто записан, а
      // лёг в историю, откуда его можно вернуть.
      const [head] = await log(root, 1);
      json(res, 200, { ...result, committed, commit: head?.hash ?? '' });
      return;
    }

    if (req.method === 'POST' && name === 'delete') {
      const id = String(body.id ?? '');
      const label = skillLabel(id);
      // Файлы бандла человек мог положить руками и не закоммитить: удалять их
      // безвозвратно нельзя, поэтому сначала фиксируем то, чего ещё нет в истории,
      // — тогда откат удаления вернёт скилл целиком, а не один SKILL.md.
      if (await hasChanges(root, skillScope(id))) {
        await commitAll(root, `skills: ${label} перед удалением`);
      }
      const result = removeSkill(root, id);
      if (result.ok) await commitAll(root, `skills: удалить «${label}»`);
      if (result.ok) bumpResources(ctx, userId);
      logger.info('панель: скилл удалён', { user: userId, id, ok: result.ok });
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'GET' && name === 'history') {
      // Без пути: у скиллов история общая по каталогу, но с теми же цифрами по
      // строкам коммита, что у файла памяти, — их рисует одна и та же вёрстка.
      json(res, 200, { commits: await fileHistory(root, '') });
      return;
    }

    if (req.method === 'GET' && name === 'show') {
      json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
      return;
    }

    if (req.method === 'POST' && name === 'revert') {
      const result = await revert(root, String(body.commit ?? ''));
      if (result.ok) bumpResources(ctx, userId);
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

  // Записи файла: строки с номерами и датами из истории — то, из чего панель рисует
  // список с галочками. Файл целиком остаётся отдельным маршрутом: его читает
  // подсветка картинок и старые вкладки панели.
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
    // Картинку отдаём байтами всегда, как её ни просят: строкой в JSON график не
    // уедет, да и читать .gif как utf8 — значит испортить его на глазах у человека.
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
    // download=1 — отдать файл как файл: браузер сохранит его под тем же именем,
    // а не покажет текстом. Проверки пути тут те же, что и у обычного чтения.
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

  // Пачка записей, отмеченных галочками: удаляем одним коммитом, чтобы в истории
  // это было одним осмысленным действием, а не десятком «забыть строку».
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

  // Удаление файла целиком — тоже коммит: пропажу видно в истории, и её можно
  // вернуть обратным коммитом, как и любую другую правку памяти.
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
 * Проверяет, что удалять собираются ровно записи: заголовок раздела — не запись,
 * и «убрать» его значит снести раздел вместе со всем, что под ним написано.
 * Заодно ловим случай, когда файл успел измениться: тогда номера уже не те.
 */
function guardEntries(
  root: string,
  relative: string,
  lines: number[],
  allowed: ReadonlySet<string>,
): string | null {
  const content = readMemoryFile(root, relative, allowed);
  if (content === null) return 'файл не найден или недоступен';
  // Даты тут не нужны: разбор идёт по строкам файла, а история приедет в панель.
  const entries = new Map(parseEntries(content).entries.map((entry) => [entry.line, entry.kind]));
  for (const line of lines) {
    const kind = entries.get(line);
    if (kind === undefined) return `строки ${line} в файле уже нет`;
    if (kind !== 'note') return `строка ${line} — не запись: заголовки и текст не удаляем`;
  }
  return null;
}
