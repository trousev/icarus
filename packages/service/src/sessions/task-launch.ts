// Launching a scheduled task: a new conversation and a prompt into it — the same way as
// a panel reply (SessionRegistry), only the person presses nothing.
//
// A new conversation is marked with a task: there are no such chats in the common list, the panel
// gathers them into the virtual «Задачи → task name → launch date» tree. The conversation title
// is the task name, not the prompt: the person sees in the tree and in the open chat WHAT this run
// is, even before the model's first word. Old tasks have no name — we take the prompt.
import { DEFAULT_WORKSPACE, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { createChatRecord, recordTurn } from './chats.ts';
import type { SessionRegistry } from './registry.ts';
import { taskName, type TaskLauncher } from './scheduled.ts';

export function taskLauncher(config: IcarusConfig, registry: SessionRegistry): TaskLauncher {
  return {
    // Busy means a turn or compaction is in progress: a person doesn't need a second
    // agent in the same container, and the launch will wait (see ScheduledTasks).
    busy: (user: UserConfig) => registry.busyConversations(user.id).length > 0,
    launch: async (user, task) => {
      const workspace = task.workspace ?? DEFAULT_WORKSPACE;
      const name = taskName(task);
      const chat = createChatRecord(config, user, workspace, new Date(), {
        title: name,
        task: { id: task.id, name },
      });
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
