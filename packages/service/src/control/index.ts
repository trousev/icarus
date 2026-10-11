// Панель управления Icarus: HTTP-часть — тонкий JSON-слой над файлами и git.
//
// Человека называет SSO-прокси (см. identity.ts), поэтому параметра user в запросах нет
// и подменить его нельзя: чужую память через свою сессию не открыть.
//
// Разделы живут по своим адресам: /panel/memory — память, /panel/skills — скиллы,
// /panel/maple — математика. Внутри памяти три области: личная, семейная и математика;
// математика — не память в том же смысле: её файлы создаёт Maple, и панель показывает
// их только для чтения (ни «забыть», ни откатов): журнал сессии — это код, из которого
// сессия восстанавливается, и построчная правка его сломает.
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
import { findUser, userPaths, type IcarusConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import {
  countFiles,
  isImageFile,
  listFiles,
  mapleExtensions,
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
import { log as logger } from '../log.ts';

export type PanelContext = {
  config: IcarusConfig;
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
export const SECTIONS: { id: string; label: string }[] = [
  { id: 'memory', label: 'Память' },
  { id: 'skills', label: 'Скиллы' },
  { id: 'maple', label: 'Математика' },
];

type Scope = 'personal' | 'shared' | 'skills' | 'maple';
/** Режим раздела: memory правится построчно, skills — целым файлом, maple — только смотрится. */
export type ScopeMode = 'memory' | 'skills' | 'maple';

/** Заголовки областей: их рисует панель, и держать их в браузере незачем. */
const SCOPE_LABELS: Record<string, string> = {
  personal: 'Личная',
  shared: 'Семейная',
  skills: 'Скиллы',
  maple: 'Математика',
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Скиллы поменялись — pi об этом ещё не знает.
 *
 * Каталог скиллов pi читает один раз при старте процесса, поэтому правка файла сама
 * по себе до живого разговора не доедет. Пометка «ресурсы обновились» говорит
 * реестру сессий поднять следующую сессию заново: идущий ход доигрывает на прежнем
 * наборе, а следующий ответ — уже с новым скиллом (см. SessionRegistry.bumpResources).
 * Ошибка тут не должна отменять сохранение: файл уже записан и закоммичен.
 */
function bumpResources(ctx: PanelContext, userId: string): void {
  try {
    ctx.bump?.(userId);
  } catch (error) {
    logger.warn('не удалось отметить обновление скиллов', { user: userId, error: String(error) });
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
 *
 * Математики здесь нет намеренно: это не область памяти, а отдельный раздел со
 * своим корнем и своим правом на запись. Пока она была и тем и другим, панель
 * показывала её дважды — таблеткой среди областей и разделом в сайдбаре, — а
 * `/panel/memory?scope=maple` рисовал чужие файлы под заголовком памяти.
 */
function parseScope(raw: unknown): 'personal' | 'shared' {
  return raw === 'shared' ? raw : 'personal';
}

function modeFor(scope: Scope): ScopeMode {
  if (scope === 'maple') return 'maple';
  if (scope === 'skills') return 'skills';
  return 'memory';
}

/**
 * Какую область читает запрос.
 *
 * У новых маршрутов раздел стоит в адресе (`/panel/maple/files`) и решает всё:
 * область из query там только путала бы. У старых (`/panel/api/*`) раздела в
 * адресе нет — они и раньше называли область параметром, и открытая в браузере
 * вкладка панели должна продолжать работать после обновления сервиса.
 */
function scopeFor(section: string | undefined, raw: unknown): Scope {
  if (section === 'maple') return 'maple';
  if (section === 'skills') return 'skills';
  if (section === 'memory') return parseScope(raw);
  const legacy = raw === 'shared' || raw === 'maple' ? raw : 'personal';
  return legacy;
}

/** Корень раздела и набор расширений, которые в нём вообще допустимы. */
function resolveScope(config: IcarusConfig, userId: string, scope: Scope) {
  const user = findUser(config, userId);
  if (!user) return null;
  const paths = userPaths(config, user);
  if (scope === 'shared') return { root: paths.sharedMemory, allowed: memoryExtensions };
  if (scope === 'maple') return { root: paths.maple, allowed: mapleExtensions };
  if (scope === 'skills') return { root: paths.skills, allowed: skillExtensions };
  return { root: paths.memory, allowed: memoryExtensions };
}

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
  // Математику в git не берём: журналы переписываются на каждом шаге расчёта,
  // и коммит на каждый вызов Maple — это история ни о чём. Панель её и не
  // показывает, а репозиторий заводить «на будущее» незачем.
  if (config.mcp?.maple) fs.mkdirSync(paths.maple, { recursive: true });
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
  if (config.mcp?.maple) counts.maple = countFiles(paths.maple, mapleExtensions);
  return counts;
}

export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
): Promise<boolean> {
  const { config } = ctx;
  const access = identifyPanelUser(req, config);

  // Старый адрес панели: он и раньше вёл на память, и в закладках у людей он есть.
  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    if (!access.ok) {
      res.writeHead(access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(panelHtml(access.denial));
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
    // Раздел математики есть только там, где настроен Maple. Прятать его из
    // сайдбара мало: в закладках у людей он остался, и открытая страница молча
    // показывала бы пустой раздел, у которого каждый запрос — отказ.
    if (page.section === 'maple' && !config.mcp?.maple) {
      res.writeHead(302, { location: '/panel/memory' });
      res.end();
      return true;
    }
    const html = access.ok
      ? await sectionPage(config, access.identity.userId, page, url, typeof ctx.draft === 'function')
      : panelHtml(access.denial);
    res.writeHead(access.ok ? 200 : access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (url.pathname.startsWith('/panel/api/') || routeApi(url.pathname)) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  return false;
}

/** Раздел из адреса: /panel/memory, /panel/skills и /panel/maple. */
function routePage(pathname: string): PanelPage | null {
  const match = /^\/panel\/(memory|skills|maple)\/?$/.exec(pathname);
  return match ? { section: match[1] } : null;
}

/** Маршрут API из адреса: /panel/<раздел>/<имя>. */
function routeApi(pathname: string): { section: string; name: string } | null {
  const match = /^\/panel\/(memory|skills|maple)\/([\w-]+)$/.exec(pathname);
  return match ? { section: match[1], name: match[2] } : null;
}

/** Разделы панели у этого человека: математика есть только там, где настроен Maple. */
function sectionsFor(config: IcarusConfig): { id: string; label: string }[] {
  return SECTIONS.filter((section) => section.id !== 'maple' || Boolean(config.mcp?.maple));
}

async function sectionPage(
  config: IcarusConfig,
  userId: string,
  page: PanelPage,
  url: URL,
  draftSkills: boolean,
): Promise<string> {
  await prepare(config, userId);
  const session: PanelSession = {
    user: userId,
    sections: sectionsFor(config),
    scopes: scopesFor(),
    scopeLabels: SCOPE_LABELS,
    model: config.models[0]?.id ?? '—',
    storage: 'git · local',
    draftSkills,
  };
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
      sections: sectionsFor(config),
      scopes: Object.keys(scopes),
      modes: scopes,
      labels: SCOPE_LABELS,
      counts: countsFor(config, userId),
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
  // Раздел в адресе старше области: /panel/maple/… — это математика, каким бы
  // ни был scope в запросе, а /panel/memory/… — только память.
  const scope = scopeFor(route?.section, url.searchParams.get('scope') ?? body.scope);
  const mode = modeFor(scope);
  const resolved = resolveScope(config, userId, scope);
  if (!resolved) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return;
  }
  const { root, allowed } = resolved;
  // Maple выключили из конфига, а старые файлы на диске остались. Раздел ему не
  // показывается — значит, и через API его не должно быть видно.
  if (scope === 'maple' && !config.mcp?.maple) {
    json(res, 404, errorBody('раздел математики выключен: в конфиге нет mcp.maple'));
    return;
  }

  if (req.method === 'GET' && name === 'files') {
    // Память и скиллы — под git (их правки в панели откатываются коммитами),
    // математика — просто каталог, который надо завести, если человек ещё ничего
    // не считал.
    if (mode === 'maple') fs.mkdirSync(root, { recursive: true });
    else await ensureRepo(root);
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

  if (mode === 'maple' && req.method === 'POST' && ['revert', 'forget', 'forget-many', 'delete'].includes(name)) {
    json(res, 400, errorBody('математика только для чтения: журналы и графики создаёт Maple', 'invalid_request_error'));
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
