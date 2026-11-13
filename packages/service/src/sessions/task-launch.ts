// Запуск задачи по расписанию: новый разговор и промпт в него — тем же путём, что и
// реплика из панели (SessionRegistry), только человек ничего не нажимает.
//
// Новый разговор помечен задачей: в общем списке таких чатов нет, панель собирает
// их в виртуальное дерево «Задачи → имя задачи → дата запуска». Заголовок разговора
// — имя задачи, а не промпт: человек видит в дереве и в открытом чате, ЧТО это за
// прогон, ещё до первого слова модели. У старых задач имени нет — берём промпт.
import { DEFAULT_WORKSPACE, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { createChatRecord, recordTurn } from './chats.ts';
import type { SessionRegistry } from './registry.ts';
import { taskName, type TaskLauncher } from './scheduled.ts';

export function taskLauncher(config: IcarusConfig, registry: SessionRegistry): TaskLauncher {
  return {
    // Занят — значит идёт ход или сжатие: второй агент в том же контейнере человеку
    // не нужен, а запуск подождёт (см. ScheduledTasks).
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
        // Реестр заводит сессию pi в этом разговоре; промпт уезжает в неё как обычная
        // реплика. Ответ агент допишет в файл сессии, и панель покажет его в чате.
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
