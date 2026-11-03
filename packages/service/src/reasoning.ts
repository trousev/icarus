// Превращает события тулов pi в короткие человеческие фразы для reasoning_content,
// чтобы в чате было видно, что Икар делает руками, а не только его ответ.

const WORKSPACE = '/workspaces/';
/** Служебный каталог: в чате его префикс только мешает, «memory/identity.md» понятнее. */
const HOME = '/workspaces/.icarus/';

function shortPath(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text) return 'файл';
  if (text.startsWith(HOME)) return text.slice(HOME.length);
  return text.startsWith(WORKSPACE) ? text.slice(WORKSPACE.length) : text;
}

function truncate(value: unknown, limit = 70): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Фраза на начало выполнения тула. null — если про этот тул говорить нечего. */
export function phraseForToolStart(toolName: string, args: Record<string, unknown> = {}): string | null {
  switch (toolName) {
    case 'read':
      return `читаю ${shortPath(args.path)}`;
    case 'write':
      return `пишу ${shortPath(args.path)}`;
    case 'edit':
      return `правлю ${shortPath(args.path)}`;
    case 'bash':
      return `выполняю: ${truncate(args.command, 60)}`;
    case 'grep':
      return `ищу по файлам: ${truncate(args.pattern, 40)}`;
    case 'find':
      return `ищу файлы: ${truncate(args.pattern, 40)}`;
    case 'ls':
      return 'смотрю, что в каталоге';
    case 'subagent': {
      // Задачи уже размечены моделью: показываем, скольким она раздала работу.
      const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return tasks > 0 ? `раздаю задачи субагентам: ${tasks}` : 'раздаю задачи субагентам';
    }
    default:
      return `работаю: ${truncate(toolName, 30)}`;
  }
}

/** Короткий итог выполнения тула. */
export function phraseForToolEnd(toolName: string, isError: boolean): string {
  if (isError) return `не получилось: ${truncate(toolName, 30)}`;
  switch (toolName) {
    case 'read':
      return 'прочитал';
    case 'write':
      return 'записал';
    case 'edit':
      return 'поправил';
    case 'bash':
      return 'команда отработала';
    case 'subagent':
      return 'субагенты закончили';
    default:
      return 'готово';
  }
}

/**
 * Строка про субагентов для статуса: «агенты 2/5 · researcher: ищет…».
 * Детали приходят от инструмента, и мусор в них — не повод падать: не разобрали,
 * значит сказать нечего.
 */
export function subagentStatus(details: unknown): string | null {
  const record = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
  const states = Array.isArray(record.subagents) ? record.subagents : [];
  const parsed = states
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      agent: String(item.agent ?? 'агент'),
      status: String(item.status ?? ''),
      activity: typeof item.activity === 'string' ? item.activity : '',
    }));
  if (parsed.length === 0) return null;

  const ok = parsed.filter((item) => item.status === 'ok').length;
  const running = parsed.filter((item) => item.status === 'running');
  if (running.length === 0) return `агенты ${ok}/${parsed.length}`;
  const now = running
    .slice(0, 2)
    .map((item) => `${item.agent}: ${item.activity || 'работает'}`)
    .join(' · ');
  return `агенты ${ok}/${parsed.length} · ${truncate(now, 90)}`;
}

/** Человеческая фраза про реальные размышления модели, если они есть. */
export function thinkingLabel(): string {
  return 'думаю';
}
