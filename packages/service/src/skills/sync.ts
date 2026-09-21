// Раскладка скиллов LibreChat туда, где их видит pi: `<pi-agent>/skills/<имя>/SKILL.md`.
//
// Почему так, а не «проброс промпта». Скиллы LibreChat живут в агентском цикле самого
// LibreChat: каталог едет в системном промпте, тело — отдельным сообщением перед
// репликой, вызов — тулом `skill`. До icarus из этого не доезжает ничего: icarus берёт
// из запроса только последнюю реплику человека, а всю агентскую работу ведёт pi. Зато
// формат `SKILL.md` у LibreChat и pi общий, поэтому достаточно положить файлы в
// агентский каталог pi — дальше он сам показывает модели имена и описания и читает
// тело по требованию.
//
// Каталог управляемый наполовину: что синхронизация положила, она же и убирает
// (манифест `.icarus-skills.json`); всё остальное в каталоге не трогается.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import { log } from '../log.ts';
import { LibreChatSkillsClient, type SkillDetail, type SkillFileContent, type SkillSummary } from './librechat.ts';

/** Имя манифеста: по нему синхронизация понимает, что она положила сама. */
export const SKILLS_MANIFEST = '.icarus-skills.json';

/**
 * Что синхронизация положила в прошлый раз. `version`/`updatedAt` — из списка
 * Management API: по ним обычный проход понимает, что скилл не менялся, и не тянет
 * его тело (то есть не делает лишних запросов).
 */
export type ManifestEntry = { id: string; version: number; updatedAt: string; hash: string };
export type SkillsManifest = { version: 1; digest: string; skills: Record<string, ManifestEntry> };

export type SyncResult = {
  /** Что-то реально изменилось на диске: сессии человека пора перезапустить. */
  changed: boolean;
  skills: number;
  /** Тела каких скиллов пришлось перечитать (в обычном проходе — ни одного). */
  fetched: string[];
  written: string[];
  removed: string[];
  skipped: string[];
  digest: string;
};

/** Имя скилла идёт в имя каталога и в frontmatter — pi сверяет их между собой. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isUsableSkillName(name: string): boolean {
  return SKILL_NAME.test(name) && name.length <= 64;
}

/** Ключи LibreChat, у которых есть смысл в pi: остальное сохраняем как есть. */
function frontmatterFor(skill: SkillDetail): Record<string, unknown> {
  const extra = skill.frontmatter ?? {};
  const frontmatter: Record<string, unknown> = { name: skill.name, description: skill.description };
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'name' || key === 'description') continue;
    frontmatter[key] = value;
  }
  // `disable-model-invocation` понимают оба: в LibreChat — «не показывать модели»,
  // в pi — то же самое. Остальные ключи LibreChat (always-apply, allowed-tools,
  // user-invocable) pi не знает и просто игнорирует — терять их не хочется, поэтому
  // они остаются в frontmatter как справка для человека.
  if (skill.disableModelInvocation === true) frontmatter['disable-model-invocation'] = true;
  return frontmatter;
}

/** SKILL.md целиком: frontmatter + тело. */
export function renderSkillMd(skill: SkillDetail): string {
  const frontmatter = stringifyYaml(frontmatterFor(skill)).trimEnd();
  const body = skill.body.replace(/^\s*\n/, '').trimEnd();
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function fileDigest(files: Map<string, string>): string {
  const hash = createHash('sha256');
  for (const key of [...files.keys()].sort()) {
    hash.update(key);
    hash.update('\u0000');
    hash.update(files.get(key) ?? '');
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Содержимое скилла: SKILL.md и текстовые файлы бандла. Бинарные пропускаем —
 * их в API не отдают (content приходит только для текста), а без файла скилл
 * всё равно остаётся рабочим: тело лежит в SKILL.md.
 */
export function skillFiles(skill: SkillDetail, files: SkillFileContent[]): Map<string, string> {
  const result = new Map<string, string>();
  result.set('SKILL.md', renderSkillMd(skill));
  for (const file of files) {
    if (file.isBinary || typeof file.content !== 'string') {
      log.warn('файл скилла пропущен', { skill: skill.name, path: file.relativePath, binary: file.isBinary });
      continue;
    }
    const relative = file.relativePath.replace(/^\/+/, '');
    if (relative === '' || relative.split('/').includes('..')) {
      log.warn('файл скилла с негодным путём пропущен', { skill: skill.name, path: file.relativePath });
      continue;
    }
    result.set(relative, file.content);
  }
  return result;
}

/**
 * Что синхронизация положила в прошлый раз. Манифест — ещё и кэш: `version` и
 * `updatedAt` приходят списком, и если они не менялись, тело скилла можно не
 * запрашивать вовсе.
 */
export function readManifest(root: string): SkillsManifest {
  const empty: SkillsManifest = { version: 1, digest: '', skills: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, SKILLS_MANIFEST), 'utf8')) as Partial<SkillsManifest>;
    if (parsed.version !== 1 || typeof parsed.skills !== 'object' || parsed.skills === null) return empty;
    return { version: 1, digest: typeof parsed.digest === 'string' ? parsed.digest : '', skills: parsed.skills };
  } catch {
    return empty;
  }
}

/**
 * Нужно ли перечитывать скилл. Список Management API уже несёт `id`, `version` и
 * `updatedAt` — если всё совпадает с манифестом и файл на месте, тело не тянем.
 * Манифест без этих полей (старый формат) сюда не подходит: один лишний запрос на
 * скилл при первом проходе после обновления — и дальше кэш работает.
 */
export function needsFetch(root: string, summary: SkillSummary, manifest: SkillsManifest): boolean {
  const known = manifest.skills[summary.name];
  if (!known) return true;
  if (known.id !== summary.id) return true;
  if (known.version !== summary.version) return true;
  if (known.updatedAt !== summary.updatedAt) return true;
  return !fs.existsSync(path.join(root, summary.name, 'SKILL.md'));
}

function writeFileInto(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error(`файл скилла вне каталога: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/**
 * Кладёт один скилл в каталог. Пишем во временный каталог и переименовываем: pi
 * читает скиллы на старте процесса, и полупустой каталог ему показывать не хочется.
 * Переименование каталога поверх существующего не работает, поэтому старый сносим
 * непосредственно перед подменой — окно, в котором каталога нет, микроскопическое,
 * и синхронизация в это время ни с кем не соревнуется.
 */
function materializeSkill(root: string, name: string, files: Map<string, string>): void {
  const target = path.join(root, name);
  const staging = path.join(root, `.${name}.staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  writeFileInto(staging, 'SKILL.md', files.get('SKILL.md') ?? '');
  for (const [relative, content] of files) {
    if (relative === 'SKILL.md') continue;
    writeFileInto(staging, relative, content);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
}

/**
 * Приводит каталог скиллов человека в соответствие с тем, что отдал LibreChat.
 *
 * `fetched` — только те скиллы, чьи тела синхронизация перечитала (в обычном проходе
 * их нет: см. `needsFetch`); `listed` — всё, что видно в LibreChat, по нему же
 * вычищается то, что оттуда пропало.
 *
 * Возвращает `changed: true`, только если поменялись сами файлы скиллов: по этому
 * признаку перезапускаются сессии pi. Правка одного лишь `updatedAt` (например,
 * переименование) манифест обновит, но сессии не тронет.
 */
export function materializeSkills(
  root: string,
  fetched: Array<{ summary: SkillSummary; files: Map<string, string> }>,
  listed: SkillSummary[],
): SyncResult {
  fs.mkdirSync(root, { recursive: true });
  const manifest = readManifest(root);
  const byName = new Map(fetched.map((entry) => [entry.summary.name, entry]));
  const fresh: string[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const next: Record<string, ManifestEntry> = {};
  const digestHash = createHash('sha256');

  for (const summary of listed) {
    if (!isUsableSkillName(summary.name)) {
      // pi сверяет имя в frontmatter с именем каталога и ждёт a-z0-9-; имя из LibreChat
      // почти всегда такое, но импортированные бандлы бывают любые. Спорить не будем.
      log.warn('скилл пропущен: имя не годится для pi', { skill: summary.name });
      skipped.push(summary.name);
      continue;
    }

    const entry = byName.get(summary.name);
    if (entry) {
      fresh.push(summary.name);
      const hash = `${summary.version}:${fileDigest(entry.files)}`;
      const previous = manifest.skills[summary.name];
      const exists = fs.existsSync(path.join(root, summary.name, 'SKILL.md'));
      // Тело перечитали, но содержимое могло не измениться (правили только описание
      // или метаданные) — тогда на диск не пишем и сессии не перезапускаем.
      if (!previous || previous.id !== summary.id || previous.hash !== hash || !exists) {
        materializeSkill(root, summary.name, entry.files);
        written.push(summary.name);
      }
      next[summary.name] = {
        id: summary.id,
        version: summary.version,
        updatedAt: summary.updatedAt,
        hash,
      };
    } else {
      const known = manifest.skills[summary.name];
      if (!known) {
        // Такого быть не должно: тело не перечитали, а класть нечего. Не роняем проход,
        // но и молчать нельзя — скилл не доедет до pi.
        log.warn('скилл не перечитан и в манифесте его нет — пропускаю', { skill: summary.name });
        skipped.push(summary.name);
        continue;
      }
      next[summary.name] = known;
    }
    digestHash.update(`${summary.name}:${next[summary.name].hash}\u0000`);
  }

  // Скиллы, которые синхронизация клала раньше, а теперь их в LibreChat нет
  // (удалили или выключили) — убираем. Чужое в каталоге не трогаем.
  for (const name of Object.keys(manifest.skills)) {
    if (next[name] || !fs.existsSync(path.join(root, name))) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }

  const digest = digestHash.digest('hex').slice(0, 16);
  const nextManifest: SkillsManifest = { version: 1, digest, skills: next };
  const serialized = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const manifestPath = path.join(root, SKILLS_MANIFEST);
  if (fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') !== serialized : true) {
    fs.writeFileSync(manifestPath, serialized, 'utf8');
  }

  return {
    changed: written.length > 0 || removed.length > 0,
    skills: Object.keys(next).length,
    fetched: fresh,
    written,
    removed,
    skipped,
    digest,
  };
}

/** Минимум клиента, которого хватает одному проходу: так его подменяет тест. */
export type SkillsSource = Pick<LibreChatSkillsClient, 'listSkills' | 'getSkill' | 'listFiles' | 'getFile'>;

/** Тело скилла и текстовые файлы его бандла. */
export async function fetchSkillContents(
  client: SkillsSource,
  summary: SkillSummary,
): Promise<Map<string, string>> {
  const detail = await client.getSkill(summary.id);
  const files: SkillFileContent[] = [];
  if (summary.fileCount > 0) {
    for (const file of await client.listFiles(summary.id)) {
      files.push(await client.getFile(summary.id, file.relativePath));
    }
  }
  return skillFiles(detail, files);
}

/**
 * Один проход синхронизации: список скиллов, тела — только у изменившихся, раскладка
 * на диске. Обычный проход (ничего не менялось) — ровно один запрос к LibreChat, и
 * тот за списком.
 */
export async function syncSkillDirectory(root: string, client: SkillsSource): Promise<SyncResult> {
  const listed = await client.listSkills();
  const manifest = readManifest(root);
  const fetched: Array<{ summary: SkillSummary; files: Map<string, string> }> = [];
  for (const summary of listed) {
    if (!needsFetch(root, summary, manifest)) continue;
    fetched.push({ summary, files: await fetchSkillContents(client, summary) });
  }
  return materializeSkills(root, fetched, listed);
}
