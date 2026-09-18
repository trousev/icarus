// Персона Икара: заменяет дефолтный системный промпт pi (это промпт кодинг-ассистента)
// на наш icarus.md, добавляет ядро памяти и подгруженные контекстные файлы вроде AGENTS.md.
//
// Важно: этот обработчик ЗАМЕНЯЕТ промпт целиком, поэтому всё, что должно в нём оказаться,
// собирается здесь же. Отдельное расширение, дописывающее что-то в before_agent_start,
// будет затёрто, если загрузится раньше (расширения применяются по очереди).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { buildMemoryCore } from "./lib/memory-core.ts";

const PERSONA = "/workspace/icarus.md";
const DUMP = "/workspace/.prompt-dump.txt";
const SHARED = "/workspace/shared-memory";
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";

function stripComments(markdown: string): string {
  // вырезаем все блоки комментариев в цикле: внутри комментария может встретиться
  // последовательность закрытия, и один нежадный проход оборвётся на ней
  let result = markdown;
  for (;;) {
    const next = result.replace(/<!--[\s\S]*?-->/g, "");
    if (next === result) break;
    result = next;
  }
  return result.trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    let persona = "(icarus.md не найден — работаю на дефолтном промпте)";
    try {
      persona = stripComments(fs.readFileSync(PERSONA, "utf8"));
    } catch {
      /* оставляем заглушку */
    }

    const contextFiles = (event.systemPromptOptions?.contextFiles ?? [])
      .map((file: { path: string; content: string }) => `# Контекст: ${file.path}\n\n${file.content}`)
      .join("\n\n---\n\n");

    const core = buildMemoryCore();
    const memoryBlock = core
      ? [
          '# Ядро памяти',
          'Это ты уже знаешь про собеседника. Не переспрашивай и не перечитывай эти файлы без нужды:',
          'если ответ есть здесь — отвечай сразу. За деталями (журнал, полные файлы) иди в память сам.',
          '',
          core,
          '',
          `Полная память лежит в ${MEMORY}/, семейная — в ${SHARED}/.`,
        ].join('\n')
      : '';

    const systemPrompt = [persona, contextFiles, memoryBlock].filter(Boolean).join("\n\n---\n\n");

    return { systemPrompt };
  });

  // Диагностика: пишем промпт на старте хода — тут он уже собран всеми расширениями
  // (persona, memory-core и остальными), а не только нами.
  pi.on("agent_start", async (_event, ctx) => {
    try {
      fs.writeFileSync(DUMP, String(ctx.getSystemPrompt?.() ?? ""));
    } catch {
      /* диагностика не должна ломать ход */
    }
  });
}
