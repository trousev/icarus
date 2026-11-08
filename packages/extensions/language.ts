// Язык разговора — дописываем к реплике человека, а не отдельным системным сообщением.
//
// Почему не отдельным system-сообщением. Именно так и было задумано сначала, и на
// голом API это работало (20/20), но в pi сообщение тихо терялось: агент прогоняет
// историю через convertToLlm, а тот фильтрует всё, кроме user/assistant/toolResult —
//
//   function defaultConvertToLlm(messages){
//     return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
//   }
//
// Системное сообщение из хука context в запрос не попадает: до модели доезжает только
// системный ПРОМПТ (он едет отдельным полем) и реплики. Поэтому правило языка живёт
// там же, где метка времени из clock.ts: дописано к последней реплике человека.
// Так оно доезжает всегда — и не зависит от того, что pi решит отфильтровать.
//
// Язык приезжает переменной ICARUS_LANGUAGE (полное имя: English, Russian) — его
// готовит сервис из профиля человека (см. containerEnv в docker/spec.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ChatMessage = { role?: string; content?: string | Array<{ type?: string; text?: string }> };

/**
 * Текст требования по имени языка. Экспортируется ради теста: правило — данные,
 * и его форма (имя языка, запрет зеркалить, случай первого ответа) должна быть
 * проверяема. Длина не работает: 894 символа давали 9/10 на голом API, 136 — 10/10.
 *
 * Последняя фраза — про иероглифы — появилась не из осторожности. 08.11.2026 Икар
 * поздоровался так: «Воскресенье, день —理论上 время для подвигов». Это не перевод и
 * не калька, а подстановка китайского слова вместо русского «теоретически»: у
 * DeepSeek китайский — родной, и на редком для него русском слове срывается язык.
 * Явного запрета в правилах не было, а модель, которая думает по-китайски, такой
 * запрет понимает лучше любого «пиши живо» (см. specs/ru-language.md).
 */
export function languageOverride(name: string): string {
  return `[Твой язык разговора — ${name}. Не зеркаль язык его реплики: он пишет по-русски, ты отвечаешь на ${name}. Первый ответ — тоже на ${name}. Иероглифов нет: китайское слово или имя — буквами, кроме прямой просьбы.]`;
}

/** Полное имя языка из переменной контейнера. Пустое — правило не шлём. */
function languageNameFromEnv(): string | undefined {
  const raw = (process.env.ICARUS_LANGUAGE ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

/**
 * Дописать правило к последней реплике человека — как appendMoment в clock.ts.
 * Возвращаем новый массив (pi правит копию) или null, если реплики нет.
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
  // Без настройки расширение молчит: английский по умолчанию не навязываем.
  if (!name) return;

  pi.on("context", (event) => {
    const messages = appendLanguageOverride(event.messages as unknown as ChatMessage[], name);
    if (!messages) return;
    return { messages: messages as never };
  });
}
