// «Action» in Telegram: the client shows it instead of the usual status — «typing…»,
// «uploading a file…», «choosing a sticker…». The list is closed: the Bot API accepts no
// actions of its own, so the phases of a turn are mapped to whatever in the list is closest.
// An exact match is rare, the rest is an honest metaphor (how honest — you can see in the
// table next to each line).

/** Bot API actions: Telegram shows no others. */
export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

/** An action lives in the client for about five seconds — we repeat a bit earlier. */
export const ACTION_INTERVAL_MS = 4500;

/**
 * Minimum between two actions: a phase change is visible right away, but a picket fence of
 * «typing — file — typing» on fast tools shouldn't be sent — Telegram
 * considers such a stream spam and bans all of the bot's requests, not just these.
 */
export const ACTION_GAP_MS = 1000;

/**
 * How long a turn may show a sticker before returning to the honest «typing»:
 * a thought without words is «choosing a sticker», but an overlong joke reads as a stuck bot.
 */
export const STICKER_LIE_MS = 15_000;

/** The model is thinking: nothing has gone out, and there's nothing more accurate than a sticker in the list. */
export const THINKING_ACTION: ChatAction = 'choose_sticker';

/** What to show for a tool until it responds. */
export function actionForTool(toolName: string): ChatAction {
  switch (toolName) {
    // Files: read, edit, write — the list has exactly one «about files».
    case 'read':
    case 'write':
    case 'edit':
      return 'upload_document';
    // Subagents go off to search around: the closest is «sending a location».
    case 'subagent':
      return 'find_location';
    // Searching files and commands: there's no action, and there's nothing louder to lie with.
    default:
      return 'typing';
  }
}
