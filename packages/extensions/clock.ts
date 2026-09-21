// Часы Икара: метка «Сейчас» перед репликой человека и тул `now` для точного времени.
//
// Почему не в системном промпте: промпт должен оставаться байт-в-байт тем же, пока
// не изменилась память — иначе кэш промпта ломается на каждой смене даты. Поэтому
// время приезжает не в промпт, а в последнюю реплику человека, и только на время
// запроса к модели (хук context правит копию сообщений, в сессию это не пишется).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exactMoment, momentLine, resolveZone, unknownZone } from "./lib/time-core.ts";

/** Имя тула: его же знает эскалация (см. SEARCH_TOOLS в escalation.ts). */
export const NOW_TOOL = "now";

export type ContentBlock = { type?: string; text?: string };
export type ChatMessage = { role?: string; content?: string | ContentBlock[] };

/**
 * Дописывает метку времени к последней реплике человека.
 *
 * Возвращает новый массив (исходные сообщения не трогаем: pi ждёт, что хук
 * правит копию) или null, если реплики человека в списке нет.
 */
export function appendMoment<T extends ChatMessage>(messages: T[], line: string): T[] | null {
  const lastUser = messages.map((message) => message?.role).lastIndexOf('user');
  if (lastUser === -1) return null;

  const target = messages[lastUser];
  const content = target?.content;
  const next = messages.slice();

  if (typeof content === 'string') {
    next[lastUser] = { ...target, content: `${content}\n\n${line}` };
    return next;
  }

  if (Array.isArray(content)) {
    const blocks = content.slice();
    const lastText = blocks.map((block) => block?.type).lastIndexOf('text');
    if (lastText === -1) {
      blocks.push({ type: 'text', text: line });
    } else {
      const block = blocks[lastText] ?? {};
      blocks[lastText] = { ...block, text: `${block.text ?? ''}\n\n${line}` };
    }
    next[lastUser] = { ...target, content: blocks };
    return next;
  }

  return null;
}

function log(message: string): void {
  process.stderr.write(`[clock] ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  // Метка считается раз на ход, а не на каждый запрос к модели: внутри хода время
  // не скачет, и один и тот же текст не переписывается на каждом шаге тулов.
  let moment: string | null = null;
  let warned = false;

  pi.on('before_agent_start', () => {
    if (!warned) {
      const broken = unknownZone();
      if (broken) log(`пояс «${broken}» не распознан — работаю по системному ${resolveZone()}`);
      warned = true;
    }
    moment = momentLine(new Date(), resolveZone());
  });

  pi.on('context', (event) => {
    if (!moment) return;
    const messages = appendMoment(event.messages as unknown as ChatMessage[], moment);
    if (!messages) return;
    return { messages: messages as never };
  });

  pi.registerTool({
    name: NOW_TOOL,
    label: 'Точное время',
    description:
      'Точное текущее время и часовой пояс собеседника. Зови, когда важно знать день, ' +
      'час или пояс: назначить встречу, посчитать срок, понять, что для него «сегодня».',
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: 'text', text: `Сейчас: ${exactMoment(new Date(), resolveZone())}` }],
        details: {},
      };
    },
  });
}
