// The person's commands, shared across all inputs: slash-string parsing and response
// texts. The actions themselves live in the session registry, while "what to tell the
// person" lives here, so that Telegram and the web chat reply the same way.
//
// Parsing is deliberately narrow: a command is the entire message. `/skill:имя` and
// `/fix-tests прогони` don't land here and travel to pi as regular text: it has its own
// commands, and there's no reason to take them away from the person.
import type {
  AbortOutcome,
  ClearOutcome,
  CommandsOutcome,
  CompactOutcome,
  RenameOutcome,
  StatsOutcome,
} from './registry.ts';

/** A parsed command: the name without «/» and without «@бота», and everything the person wrote after. */
export type ParsedCommand = { name: string; args: string };

/**
 * `/compact`, `/compact@the_icarus_bot`, `/compact пожелание` are a command; `/etc/hosts`
 * and «а /compact потом» are a message.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name) return null;
  return { name: name.toLowerCase(), args: (match?.[2] ?? '').trim() };
}

/** Commands the web chat parses itself rather than sending as a message to pi. */
export const WEB_COMMANDS: { name: string; description: string }[] = [
  { name: 'help', description: 'что я умею' },
  { name: 'compact', description: 'подвести итог разговора' },
  { name: 'stop', description: 'остановить ответ' },
  { name: 'stats', description: 'токены, деньги, контекст' },
  { name: 'clear', description: 'начать разговор с чистого листа' },
  { name: 'rename', description: 'переименовать текущий чат' },
  { name: 'skills', description: 'скиллы, шаблоны и команды pi' },
];

/** Names the web chat claims: everything else with a slash is a message for pi. */
export const WEB_COMMAND_NAMES = new Set(WEB_COMMANDS.map((command) => command.name));

/**
 * Commands we removed. We answer directly rather than sending them to pi as a message:
 * otherwise `/topic Работа` would travel to the model as regular text.
 */
export const REMOVED_COMMANDS = new Set(['topic', 'topics']);
export const TOPICS_REMOVED =
  'Команд /topic и /topics больше нет: топики заводятся в клиенте Telegram, а текущий разговор переименовывается через /rename.';

export const UNKNOWN_COMMAND = 'Такой команды не знаю. /help — что я умею.';

/** What to show on /help in the web: the same commands as in the palette, but with explanations. */
export const WEB_HELP = [
  'Что я умею в чате:',
  '',
  '/compact — подвести итог разговора, если он разросся',
  '/compact <пожелание> — то же, но с оговоркой, что важно сохранить',
  '/stop — остановиться, если я ушёл не туда',
  '/stats — сколько токенов и денег ушло и сколько занято в контексте',
  '/clear — начать разговор с чистого листа (память остаётся при мне)',
  '/rename <имя> — переименовать текущий чат',
  '/skills — что можно позвать сверх разговора: скиллы, шаблоны и команды pi',
  '',
  'Пока я думаю, писать можно: Enter ставит реплику в очередь, а «прервать и отправить»',
  'останавливает текущий ответ и берётся за неё сразу.',
  '',
  'Ещё я понимаю файлы и картинки, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

function tokens(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

/** A number from pi's answer: everything there is optional, and there's no point failing on a miss. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Money in the report: for a day's conversation pennies are a real cost, it's a shame to round them. */
function money(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** What to reply to /compact: it's decided not by the input but by the session registry. */
export function compactText(outcome: CompactOutcome): string {
  switch (outcome.status) {
    case 'compacted':
      return `Подвёл итог: ${tokens(outcome.tokensBefore)} → ${tokens(outcome.tokensAfter)} токенов. Продолжаем с этого места.`;
    case 'nothing':
      return 'Сжимать пока нечего: разговор короткий или уже сжат.';
    case 'no-session':
      return 'Сжимать нечего: разговор ещё не начат или уже сжат и закрыт — начнём, когда напишешь.';
    case 'busy':
      return 'Сейчас думаю над ответом — сожму, когда договорю.';
    case 'failed':
      return `Не получилось сжать: ${outcome.error}`;
  }
}

/** What to reply to /stop. */
export function stopText(outcome: AbortOutcome, dropped = 0): string {
  const base = ((): string => {
    switch (outcome.status) {
      case 'stopped':
        return 'Остановился. Скажи, если нужно иначе.';
      case 'idle':
        return 'Я и так ничего не делаю — можно писать.';
      case 'no-session':
        return 'Останавливать нечего: разговор ещё не начат или уже закрыт.';
      case 'failed':
        return `Не получилось остановиться: ${outcome.error}`;
    }
  })();
  // The queue is dropped along with the turn: we don't stay silent about it, the person wrote those messages themselves.
  return dropped > 0 ? `${base}\nИз очереди снял: ${dropped}.` : base;
}

/** What to reply to /stats: the conversation's numbers in human words. */
export function statsText(outcome: StatsOutcome): string {
  if (outcome.status === 'failed') return `Не смог посчитать: ${outcome.error}`;

  const stats = outcome.stats;
  const used = (stats.tokens ?? {}) as Record<string, unknown>;
  const context = (stats.contextUsage ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  const replies = count(stats.userMessages);
  const tools = count(stats.toolCalls);
  if (replies !== null) {
    lines.push(
      tools !== null && tools > 0
        ? `Твоих реплик: ${tokens(replies)}, шагов с инструментами: ${tokens(tools)}.`
        : `Твоих реплик: ${tokens(replies)}.`,
    );
  }

  const total = count(used.total);
  if (total !== null && total > 0) {
    const parts = [`вход ${tokens(count(used.input) ?? 0)}`, `выход ${tokens(count(used.output) ?? 0)}`];
    const cached = count(used.cacheRead);
    if (cached !== null && cached > 0) parts.push(`из кэша ${tokens(cached)}`);
    lines.push(`Токенов всего: ${tokens(total)} (${parts.join(', ')}).`);
  }

  const percent = count(context.percent);
  const contextTokens = count(context.tokens);
  const window = count(context.contextWindow);
  if (percent !== null && contextTokens !== null && window !== null) {
    lines.push(`Занято в контексте: ${Math.round(percent)}% (${tokens(contextTokens)} из ${tokens(window)}).`);
  }

  const cost = count(stats.cost);
  if (cost !== null && cost > 0) lines.push(`Потрачено: ${money(cost)}.`);

  return lines.length > 0 ? lines.join('\n') : 'Разговор пока пустой: ни реплик, ни токенов.';
}

/** What to reply to /clear. */
export function clearText(outcome: ClearOutcome): string {
  switch (outcome.status) {
    case 'started':
      return 'Начали с чистого листа: прошлую нить pi больше не подхватит. Память не трогал — то, что я о вас знаю, осталось.';
    case 'empty':
      return 'Разговор и так с чистого листа — начинать заново нечего.';
    case 'busy':
      return 'Сейчас думаю над ответом: сначала /stop, потом начнём заново.';
    case 'failed':
      return `Не получилось начать заново: ${outcome.error}`;
  }
}

/** /rename without a name: we suggest the form rather than guess. */
export const RENAME_NEEDS_NAME = 'Напиши так: /rename Письмо из налоговой.';

export function renamed(name: string): string {
  return `Теперь этот разговор называется «${name}».`;
}

export function renameFailed(reason: string): string {
  return `Не получилось переименовать: ${reason}`;
}

/** What to reply to /rename: the conversation name lives in the registry, not in the pi session. */
export function renameText(outcome: RenameOutcome): string {
  switch (outcome.status) {
    case 'renamed':
      return renamed(outcome.title);
    case 'empty':
      return RENAME_NEEDS_NAME;
    case 'failed':
      return renameFailed(outcome.error);
  }
}

/** Order in the command list: the person's skills first, then templates and commands. */
function commandRank(source: string | undefined): number {
  if (source === 'skill') return 0;
  if (source === 'prompt') return 1;
  return 2;
}

/** What to reply to /skills: what the person can call themselves. */
export function skillsText(outcome: CommandsOutcome): string {
  if (outcome.status === 'failed') return `Не смог спросить у pi: ${outcome.error}`;
  if (outcome.commands.length === 0) {
    return 'Сверх разговора у меня сейчас ничего нет — только память, поиск и руки. Скажи, чего не хватает.';
  }

  const lines = ['Вот что можно позвать прямо в чате:', ''];
  const commands = [...outcome.commands].sort(
    (a, b) => commandRank(a.source) - commandRank(b.source) || a.name.localeCompare(b.name),
  );
  for (const command of commands) {
    lines.push(command.description ? `/${command.name} — ${command.description}` : `/${command.name}`);
  }
  return lines.join('\n');
}
