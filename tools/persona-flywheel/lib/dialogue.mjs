// Прогон диалогов: пользователя играет отдельная модель, реплики Икара — кандидат.
import { chat, chatFinal, MODELS } from "./api.mjs";

const userSystem = (scenario) => `Ты играешь роль собеседника Икара в тестовом стенде. Не выходи из роли, не комментируй стенд.

Кто ты: ${scenario.userModel}

Правила игры:
- Ты пишешь в мессенджере. Максимум 20 слов, обычно 1 фраза. Разговорно, строчными буквами, можно с опечаткой.
- Реагируй на то, что реально сказал Икар. Пошутил — можешь засмеяться, подколоть в ответ или проигнорировать, как живой человек.
- Если Икар скучный, шаблонный или фальшивый — покажи это лёгким равнодушием или раздражением.
- Не объясняй свои чувства длинно и не упоминай, что ты «всего лишь модель».
- Никогда не пишешь реплики за Икара. Отвечай одной репликой, без пояснений и разметки.`;

const icarusStart = [
  "Начинается разговор в мессенджере с твоим другом. Пиши как в чате: коротко, без приветственных церемоний.",
  "Сейчас ты без рук: инструментов и файловой системы в этой сессии нет, поэтому не вызывай их и не изображай вызовы —",
  "отвечай обычным текстом. Если в сообщении приложен файл или документ, считай, что он уже перед тобой, и отвечай по нему.",
].join("\n");

export function transcript(dialogue) {
  return dialogue
    .map((turn) => `${turn.role === "user" ? "ДИМА" : "ИКАР"}: ${turn.text}`)
    .join("\n\n");
}

export async function runScenario({ system, context, scenario, maxTokens = 560 }) {
  const dialogue = [];
  const userHistory = [];

  for (let index = 0; index < scenario.turns.length; index++) {
    const userText =
      index === 0
        ? scenario.context
          ? `${scenario.turns[0]}\n\n[вложенный файл/текст]\n${scenario.context}`
          : scenario.turns[0]
        : (
            await chat({
              model: MODELS.user,
              system: userSystem(scenario),
              messages: [...userHistory, { role: "user", content: `Ответь Икару одной репликой.\n\n${transcript(dialogue)}` }],
              maxTokens: 120,
              temperature: 1.1,
            })
          ).content;
    userHistory.push({ role: "user", content: userText });

    dialogue.push({ role: "user", text: userText, scripted: index === 0 || Boolean(scenario.context && index === 0) });

    const reply = await replyOnce({ system, dialogue, maxTokens });
    dialogue.push({ role: "icarus", text: scrub(reply.content), usage: reply.usage });
  }

  return dialogue;
}

// Страховка стенда: если модель всё же изобразила вызов инструмента, оставляем только текст.
function scrub(text) {
  if (!/DSML|antml|<\|/.test(text)) return text;
  const cleaned = text
    .replace(/<[｜|]{0,2}DSML[｜|]{0,2}[\s\S]*?<\s*\/[｜|]{0,2}DSML[｜|]{0,2}\s*calls\s*>/gi, "")
    .replace(/<[^>]{0,40}>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || text;
}

function buildMessages({ system, dialogue }) {
  return [{ role: "user", content: `${icarusStart}\n\n---\n\n${transcript(dialogue)}` }];
}

async function replyOnce({ system, dialogue, maxTokens }) {
  const messages = buildMessages({ system, dialogue });
  let reply;
  try {
    reply = await chat({ model: MODELS.icarus, system, messages, maxTokens, temperature: 1 });
  } catch (error) {
    // бюджет сгорел в скрытых размышлениях — просим выдать только текст
    return chatFinal({ model: MODELS.icarus, system, messages, maxTokens: 260, temperature: 1 });
  }
  // реплика оборвалась на полуслове — просим дописать и склеиваем
  if (reply.finish === "length" && reply.content.length > 40) {
    try {
      const tail = reply.content.slice(-400);
      const rest = await chatFinal({
        model: MODELS.icarus,
        system,
        messages: [...messages, { role: "assistant", content: tail }, { role: "user", content: "Допиши последнюю фразу с того места, где оборвалось. Без повторов, только продолжение." }],
        maxTokens: 200,
        temperature: 1,
      });
      return { ...reply, content: `${reply.content}${rest.content}` };
    } catch {
      return reply;
    }
  }
  return reply;
}
