// Turns pi tool events into short human phrases for reasoning_content,
// so that the chat shows what Icarus does with his hands, not just his answer.

const WORKSPACE = '/workspaces/';
/** Service directory: in the chat its prefix only gets in the way, "memory/identity.md" is clearer. */
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

/** Phrase for the start of tool execution. null — if there is nothing to say about this tool. */
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
      // The tasks are already marked up by the model: we show how many it handed out work to.
      const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return tasks > 0 ? `раздаю задачи субагентам: ${tasks}` : 'раздаю задачи субагентам';
    }
    default:
      return `работаю: ${truncate(toolName, 30)}`;
  }
}

/** A short summary of tool execution. */
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
 * Line about subagents for the status: "agents 2/5 · researcher: searching…".
 * Details come from the tool, and garbage in them is no reason to crash: if we could not parse it,
 * there is nothing to say.
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

/** A human phrase about the model's real thinking, if there is any. */
export function thinkingLabel(): string {
  return 'думаю';
}
