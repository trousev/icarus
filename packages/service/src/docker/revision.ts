// Отпечаток кода сервиса для docker compose.
//
// Compose пересоздаёт контейнер при смене образа, маунтов или окружения, а исходники
// приезжают в контейнер bind-mount'ом и в это сравнение не входят. Без отпечатка
// `docker compose up` оставляет жить старый процесс со старым кодом в памяти: деплой
// зелёный, /healthz зелёный, а на стенде старый код. Так фикс кнопки «забыть» уехал
// в main, но на проде остался старый confirm — сервис просто не перезапустился.
//
// Отпечаток кладётся в окружение сервиса (ICARUS_REVISION): изменился код — изменилось
// окружение — compose пересоздаёт контейнер и node читает новый код с диска.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Что считаем кодом сервиса: правка любого из этих путей обязана пересоздать icarus. */
export const SERVICE_CODE = [
  'packages/service/src',
  'packages/extensions',
  'package.json',
  'pnpm-lock.yaml',
];

/** Обходит путь и собирает файлы относительно корня репозитория; отсутствующие пути пропускает. */
function collect(repoRoot: string, entry: string, prefix: string, files: string[]): void {
  const full = path.join(repoRoot, entry);
  const stat = fs.statSync(full, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) {
    files.push(prefix);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of entries) {
    // node_modules и скрытые каталоги (.git) — не код: их содержимое меняется само по себе.
    if (child.name === 'node_modules' || child.name.startsWith('.')) continue;
    collect(repoRoot, path.join(entry, child.name), `${prefix}/${child.name}`, files);
  }
}

/**
 * Считает отпечаток содержимого кода: путь плюс байты каждого файла. Порядок обхода
 * фиксирован, поэтому один и тот же код даёт один и тот же отпечаток, а правка любого
 * байта — другой. Короткого hex хватает: это не защита от подделки, а признак «код другой».
 */
export function sourceRevision(repoRoot: string, entries: readonly string[] = SERVICE_CODE): string {
  const files: string[] = [];
  for (const entry of entries) collect(repoRoot, entry, entry, files);

  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(repoRoot, relative)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
