// Команды человека, общие для всех входов: разбор строки с косой черты и тексты
// ответов. Сами действия живут в реестре сессий, а «что сказать человеку» —
// здесь, чтобы Telegram и веб-чат отвечали одинаково.
//
// Разбор нарочно узкий: команда — это вся реплика целиком. `/skill:имя` и
// `/fix-tests прогони` сюда не попадают и уезжают в pi как обычный текст: у него
// свои команды, и отбирать их у человека незачем.
import type {
  AbortOutcome,
  ClearOutcome,
  CommandsOutcome,
  CompactOutcome,
  RenameOutcome,
  StatsOutcome,
} from './registry.ts';

/** Разобранная команда: имя без «/» и без «@бота», и всё, что человек написал после. */
export type ParsedCommand = { name: string; args: string };

/**
 * `/compact`, `/compact@the_icarus_bot`, `/compact пожелание` — команда; `/etc/hosts`
 * и «а /compact потом» — реплика.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name) return null;
  return { name: name.toLowerCase(), args: (match?.[2] ?? '').trim() };
}

/** Команды, которые веб-чат разбирает сам, а не отправляет репликой в pi. */
export const WEB_COMMANDS: { name: string; description: string }[] = [
  { name: 'help', description: 'что я умею' },
  { name: 'compact', description: 'подвести итог разговора' },
  { name: 'stop', description: 'остановить ответ' },
  { name: 'stats', description: 'токены, деньги, контекст' },
  { name: 'clear', description: 'начать разговор с чистого листа' },
  { name: 'rename', description: 'переименовать текущий чат' },
  { name: 'skills', description: 'скиллы, шаблоны и команды pi' },
];

/** Имена, которые веб-чат берёт себе: всё остальное с косой черты — реплика для pi. */
export const WEB_COMMAND_NAMES = new Set(WEB_COMMANDS.map((command) => command.name));

/**
 * Команды, которые мы убрали. Отвечаем прямо, а не отправляем их в pi репликой:
 * иначе `/topic Работа` уехало бы модели как обычный текст.
 */
export const REMOVED_COMMANDS = new Set(['topic', 'topics']);
export const TOPICS_REMOVED =
  'Команд /topic и /topics больше нет: топики заводятся в клиенте Telegram, а текущий разговор переименовывается через /rename.';

export const UNKNOWN_COMMAND = 'Такой команды не знаю. /help — что я умею.';

/** Что показать на /help в вебе: те же команды, что в палитре, но с объяснением. */
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
  'Ещё я понимаю файлы и картинки, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

function tokens(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

/** Число из ответа pi: там всё необязательное, и падать на пропуске незачем. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Деньги в отчёте: у разговора на день копейки и есть цена, округлять их жалко. */
function money(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** Что ответить на /compact: решает не вход, а реестр сессий. */
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

/** Что ответить на /stop. */
export function stopText(outcome: AbortOutcome): string {
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
}

/** Что ответить на /stats: цифры разговора человеческими словами. */
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

/** Что ответить на /clear. */
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

/** /rename без имени: подсказываем форму, а не угадываем. */
export const RENAME_NEEDS_NAME = 'Напиши так: /rename Письмо из налоговой.';

export function renamed(name: string): string {
  return `Теперь этот разговор называется «${name}».`;
}

export function renameFailed(reason: string): string {
  return `Не получилось переименовать: ${reason}`;
}

/** Что ответить на /rename: имя разговора живёт в реестре, а не в сессии pi. */
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

/** Порядок в списке команд: сначала скиллы человека, потом шаблоны и команды. */
function commandRank(source: string | undefined): number {
  if (source === 'skill') return 0;
  if (source === 'prompt') return 1;
  return 2;
}

/** Что ответить на /skills: что человек может позвать сам. */
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
