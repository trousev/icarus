// Наблюдение за журналами Maple: единственный честный признак того, что агент
// действительно считал движком, а не «в голове».
//
// Maple-MCP пишет журнал сессии в `${MAPLE_SESSION_DIR}/<сессия>.jsonl` — по
// строке на вызов. Разница числа строк до и после задачи и есть число шагов
// Maple в ней. Фразы тулов в reasoning_content для этого не годятся: они
// локализованы и меняются, а журнал — это факт.
import fs from 'node:fs';
import path from 'node:path';

/** Сколько записей в каждом журнале каталога. Отсутствующий каталог — пустая карта. */
export function journalEntryCounts(dir: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (!dir) return counts;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // Каталога ещё нет — Maple в этом прогоне не звали.
    return counts;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const entries = text.split('\n').filter((line) => line.trim().length > 0).length;
      counts.set(name, entries);
    } catch {
      // Журнал исчез между readdir и read (forget/reset) — считаем, что не было.
    }
  }
  return counts;
}

/** Сколько записей дописано во все журналы. */
export function journalDelta(before: Map<string, number>, after: Map<string, number>): number {
  let total = 0;
  for (const [name, count] of after) {
    const was = before.get(name) ?? 0;
    if (count > was) total += count - was;
  }
  return total;
}
