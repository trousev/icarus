// Launching a scheduled task: a new conversation and a prompt into it — the same way as
// a panel reply (SessionRegistry), only the person presses nothing.
//
// The new conversation is an ordinary chat, not a service thread: it appears in the list,
// can be opened, continued and archived. We take the title from the prompt right away: the
// person sees in the list what exactly launched, even before the model's first word.
import { DEFAULT_WORKSPACE, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { createChatRecord, recordTurn } from './chats.ts';
import type { SessionRegistry } from './registry.ts';
import type { TaskLauncher } from './scheduled.ts';

/** Conversation title: the first line of the prompt — the list shows what launched. */
function titleFor(prompt: string): string {
  const line = (prompt.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

export function taskLauncher(config: IcarusConfig, registry: SessionRegistry): TaskLauncher {
  return {
    // Busy means a turn or compaction is in progress: a person doesn't need a second
    // agent in the same container, and the launch will wait (see ScheduledTasks).
    busy: (user: UserConfig) => registry.busyConversations(user.id).length > 0,
    launch: async (user, task) => {
      const workspace = task.workspace ?? DEFAULT_WORKSPACE;
      const chat = createChatRecord(config, user, workspace, new Date(), { title: titleFor(task.prompt) });
      const chatId = chat.conversationId ?? chat.id;
      try {
        // The registry brings up a pi session in this conversation; the prompt goes into
        // it as an ordinary reply. The agent will append the answer to the session file,
        // and the panel will show it in the chat.
        const session = await registry.acquire(user, chatId, workspace);
        recordTurn(config, user, chatId, 'web');
        await session.prompt(task.prompt);
        log.info('задача: агент запущен в новом разговоре', { user: user.id, task: task.id, chat: chatId });
        return { chatId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('задача: агент не запустился', {
          user: user.id,
          task: task.id,
          chat: chatId,
          error: redact(message),
        });
        return { chatId, error: message };
      }
    },
  };
}
