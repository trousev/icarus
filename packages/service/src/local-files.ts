// Файл, на который сослался агент: путь из ответа → файл на хосте.
//
// Модель не «отправляет файл», она пишет ссылку в markdown: `/workspaces/talk/chart.gif`
// или `/artifacts/plany/index.png`. Панель рисует по такой ссылке картинку, Telegram
// отправляет вложение — и оба канала должны одинаково понимать, какой путь считается
// доступным, а какой ведёт за пределы рабочей папки. Поэтому разбор один на всех:
// здесь, а не в каждом канале по копии.
import fs from 'node:fs';
import path from 'node:path';
import { artifactFile, mimeOf } from './artifacts.ts';
import { CONTAINER_HOME, userPaths, type IcarusConfig, type UserConfig } from './config.ts';

/** Найденный файл: путь на хосте и тип, который знает mimeOf. */
export type LocalFile = { file: string; type: string };

/** Картинки, которые можно отдать браузеру как картинку (SVG — нет: он исполняет скрипты). */
const RASTER_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** Отдаёт ли тип картинку в браузере: по этому же признаку панель рисует её в чате. */
export function isRasterImage(type: string): boolean {
  return RASTER_IMAGE.has(type.split(';')[0]?.trim() ?? type);
}

/**
 * Путь в ответе агента → файл на хосте. null — пути нет, он чужой или это не файл:
 * ссылка на чужой файл не должна превращаться в «почитай хост».
 *
 * Понимаем три корня, которые видит контейнер человека: свои вложения (`incoming/`),
 * рабочие папки (`workspaces/`) и общую библиотеку артефактов (`artifacts/`, доступ
 * по ACL — чужой личный артефакт не отдаём).
 */
export function localFileOf(config: IcarusConfig, user: UserConfig, raw: unknown): LocalFile | null {
  if (typeof raw !== 'string') return null;
  let relative = raw.trim();
  if (!relative || relative.includes('\u0000')) return null;
  if (relative.startsWith('file://')) relative = relative.slice('file://'.length);
  // MCP-сервер отдаёт путь в markdown закодированным (пробелы в имени папки), а
  // %2e%2e после раскодирования всё равно упрётся в проверку «..» ниже.
  if (/%[0-9a-f]{2}/i.test(relative)) {
    try {
      relative = decodeURIComponent(relative);
    } catch {
      return null;
    }
  }
  // Служебный каталог снимаем первым: после общего '/workspace/' от него осталось бы
  // '.icarus/incoming/…', и ни incoming/, ни workspaces/ уже не совпали бы.
  if (relative.startsWith(`${CONTAINER_HOME}/`)) relative = relative.slice(CONTAINER_HOME.length + 1);
  else if (relative.startsWith('/workspace/')) relative = relative.slice('/workspace/'.length);
  else if (relative.startsWith('workspace/')) relative = relative.slice('workspace/'.length);
  else if (relative.startsWith('/')) relative = relative.slice(1);

  // Артефакты лежат общей библиотекой и живут по своим правам: путь знает только
  // владелец и те, кому он открыл доступ.
  if (relative.startsWith('artifacts/')) {
    const [slug, ...rest] = relative.slice('artifacts/'.length).split('/');
    if (!slug || rest.length === 0) return null;
    const found = artifactFile(config, user.id, slug, rest.join('/'));
    return found === null ? null : { file: found.file, type: found.type };
  }

  const paths = userPaths(config, user);
  let root = paths.incoming;
  if (relative.startsWith('incoming/')) relative = relative.slice('incoming/'.length);
  // Файлы, которые агент создал сам (графики и что угодно ещё), лежат в его
  // workspace: показать их человеку — единственный способ донести результат до него.
  else if (relative.startsWith('workspaces/')) {
    root = paths.workspaces;
    relative = relative.slice('workspaces/'.length);
  }

  if (!relative || relative.includes('..')) return null;
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { file: full, type: mimeOf(full) };
}
