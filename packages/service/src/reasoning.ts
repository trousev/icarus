// Превращает события тулов pi в короткие человеческие фразы для reasoning_content,
// чтобы в LibreChat было видно, что Икар делает руками, а не только его ответ.

const WORKSPACE = '/workspace/';

function shortPath(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text) return 'файл';
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
    default:
      return 'готово';
  }
}

/** Человеческая фраза про реальные размышления модели, если они есть. */
export function thinkingLabel(): string {
  return 'думаю';
}
