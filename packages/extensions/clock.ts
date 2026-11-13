// Icarus's clock: a "Now" marker before the person's message and the `now` tool for exact time.
//
// Why not in the system prompt: the prompt must stay byte-for-byte the same until
// memory changes — otherwise the prompt cache breaks on every date change. That's why
// time arrives not in the prompt but in the last human message, and only for the
// duration of the model request (the context hook edits a copy of the messages; this is not written to the session).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exactMoment, momentLine, resolveZone, unknownZone } from "./lib/time-core.ts";

/** Tool name: escalation knows it too (see SEARCH_TOOLS in escalation.ts). */
export const NOW_TOOL = "now";

export type ContentBlock = { type?: string; text?: string };
export type ChatMessage = { role?: string; content?: string | ContentBlock[] };

/**
 * Appends a timestamp to the last human message.
 *
 * Returns a new array (we don't touch the original messages: pi expects the hook
 * to edit a copy) or null if there's no human message in the list.
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
  // The marker is computed once per turn, not on every model request: within a turn
  // time doesn't jump, and the same text isn't rewritten on every tool step.
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
