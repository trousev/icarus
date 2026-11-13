// Conversation language — we append it to the human message rather than sending a separate system message.
//
// Why not a separate system message. That's exactly how it was intended at first, and on
// the bare API it worked (20/20), but in pi the message was silently lost: the agent runs
// the history through convertToLlm, and that filters out everything except user/assistant/toolResult —
//
//   function defaultConvertToLlm(messages){
//     return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
//   }
//
// A system message from the context hook doesn't make it into the request: only the
// system PROMPT (it travels as a separate field) and the messages reach the model. That's why the language
// rule lives in the same place as the timestamp from clock.ts: appended to the last human message.
// That way it always arrives — and doesn't depend on what pi decides to filter out.
//
// The language arrives via the ICARUS_LANGUAGE variable (full name: English, Russian) — it's
// prepared by the service from the person's profile (see containerEnv in docker/spec.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ChatMessage = { role?: string; content?: string | Array<{ type?: string; text?: string }> };

/**
 * The requirement text for a language name. Exported for testing: the rule is data,
 * and its form (the language name, the ban on mirroring, the first-answer case) must be
 * testable. Length doesn't work: 894 characters gave 9/10 on the bare API, 136 — 10/10.
 *
 * The last phrase — about hieroglyphs — didn't appear out of caution. On 08.11.2026 Icarus
 * greeted like this: «Воскресенье, день —理论上 время для подвигов». That's neither a translation nor
 * a calque, but a substitution of a Chinese word for the Russian «теоретически»: for
 * DeepSeek Chinese is native, and on a Russian word rare for it the language slips.
 * There was no explicit ban in the rules, and a model that thinks in Chinese understands such a
 * ban better than any "write vividly" (see specs/ru-language.md).
 */
export function languageOverride(name: string): string {
  return `[Твой язык разговора — ${name}. Не зеркаль язык его реплики: он пишет по-русски, ты отвечаешь на ${name}. Первый ответ — тоже на ${name}. Иероглифов нет: китайское слово или имя — буквами, кроме прямой просьбы.]`;
}

/** Full language name from the container variable. Empty — we don't send the rule. */
function languageNameFromEnv(): string | undefined {
  const raw = (process.env.ICARUS_LANGUAGE ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

/**
 * Append the rule to the last human message — like appendMoment in clock.ts.
 * We return a new array (pi edits a copy) or null if there's no message.
 */
export function appendLanguageOverride<T extends ChatMessage>(messages: T[], name: string): T[] | null {
  const lastUser = messages.map((message) => message?.role).lastIndexOf("user");
  if (lastUser === -1) return null;

  const target = messages[lastUser];
  const content = target?.content;
  const next = messages.slice();
  const block = { type: "text", text: languageOverride(name) };

  if (typeof content === "string") {
    next[lastUser] = { ...target, content: `${content}\n\n${languageOverride(name)}` };
    return next;
  }

  if (Array.isArray(content)) {
    const blocks = content.slice();
    const lastText = blocks.map((entry) => entry?.type).lastIndexOf("text");
    if (lastText === -1) blocks.push(block);
    else blocks[lastText] = { ...blocks[lastText], text: `${blocks[lastText]?.text ?? ""}\n\n${languageOverride(name)}` };
    next[lastUser] = { ...target, content: blocks };
    return next;
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  const name = languageNameFromEnv();
  // Without the setting the extension stays silent: we don't impose English by default.
  if (!name) return;

  pi.on("context", (event) => {
    const messages = appendLanguageOverride(event.messages as unknown as ChatMessage[], name);
    if (!messages) return;
    return { messages: messages as never };
  });
}
