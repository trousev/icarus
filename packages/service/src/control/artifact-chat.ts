// Artifact edit chat: one conversation per artifact.
//
// This is not a separate agent and not a second registry: the conversation lives in the shared chats.json,
// but is tagged with the artifact. By that tag the session registry launches pi in the folder
// `/artifacts/<slug>`, and the persona builds a prompt about that specific folder, not about the
// workspace. So "add a heading here" edits exactly this artifact.
import { ArtifactError, readArtifact } from '../artifacts.ts';
import { DEFAULT_WORKSPACE, type IcarusConfig, type UserConfig } from '../config.ts';
import {
  createChatRecord,
  findArtifactChat,
  updateChatTitles,
  type ChatRecord,
} from '../sessions/chats.ts';

/** System title of the edit chat: it shows that this is a service conversation. */
export const ARTIFACT_CHAT_TITLE_PREFIX = 'Правка · ';

/** Conversation title: this is how it shows up in the shared chat list too. */
function chatTitle(title: string): string {
  const text = `${ARTIFACT_CHAT_TITLE_PREFIX}${title}`.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

/**
 * Opens the artifact chat, creating it on first access. Permissions are checked
 * right here: without `write` a person can view the artifact but cannot edit it with AI.
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

  // The artifact could have been renamed (the title in index.ai.md changes) — we
  // update the system title. We don't touch a name chosen by the person via /rename:
  // the service chat lives in the shared list, and a rename there should persist.
  if (existing.title !== title && existing.title.startsWith(ARTIFACT_CHAT_TITLE_PREFIX)) {
    updateChatTitles(config, user, new Map([[existing.id, title]]));
    return { ...existing, title };
  }
  return existing;
}
