// Чат правки артефакта: один разговор на один артефакт.
//
// Это не отдельный агент и не второй реестр: разговор живёт в общем chats.json,
// но помечен артефактом. По этой пометке реестр сессий запускает pi в папке
// `/artifacts/<slug>`, а персона собирает промпт про конкретную папку, а не про
// workspace. Так «добавь сюда заголовок» правит именно этот артефакт.
import { ArtifactError, readArtifact } from '../artifacts.ts';
import { DEFAULT_WORKSPACE, type IcarusConfig, type UserConfig } from '../config.ts';
import {
  createChatRecord,
  findArtifactChat,
  updateChatTitles,
  type ChatRecord,
} from '../sessions/chats.ts';

/** Заголовок разговора: по нему его видно и в общем списке чатов. */
function chatTitle(title: string): string {
  const text = `Правка · ${title}`.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

/**
 * Открывает чат артефакта, заводя его при первом обращении. Права проверяются
 * здесь же: без `write` человек может смотреть артефакт, но не править его ИИ.
 */
export function ensureArtifactChat(config: IcarusConfig, user: UserConfig, slug: string): ChatRecord {
  const { artifact } = readArtifact(config, user.id, slug);
  if (!artifact.canWrite) {
    throw new ArtifactError('править артефакт может тот, у кого есть право записи', 403);
  }

  const title = chatTitle(artifact.title);
  const existing = findArtifactChat(config, user, slug);
  if (!existing) {
    return createChatRecord(config, user, DEFAULT_WORKSPACE, new Date(), {
      artifact: artifact.name,
      title,
    });
  }

  // Артефакт могли переименовать (заголовок в index.ai.md меняется) — заголовок
  // разговора должен оставаться узнаваемым, а не врать про старое имя.
  if (existing.title !== title) {
    updateChatTitles(config, user, new Map([[existing.id, title]]));
    return { ...existing, title };
  }
  return existing;
}
