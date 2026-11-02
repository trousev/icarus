// Персона Икара: заменяет дефолтный системный промпт pi (это промпт кодинг-ассистента)
// на наш icarus.md, добавляет ядро памяти и подгруженные контекстные файлы вроде AGENTS.md.
//
// Важно: этот обработчик ЗАМЕНЯЕТ промпт целиком, поэтому всё, что должно в нём оказаться,
// собирается здесь же. Отдельное расширение, дописывающее что-то в before_agent_start,
// будет затёрто, если загрузится раньше (расширения применяются по очереди).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { buildMemoryCore } from "./lib/memory-core.ts";
import { formatSkillsBlock, type SkillEntry } from "./lib/skills-core.ts";
import { TIME_INSTRUCTION } from "./lib/time-core.ts";

// Служебный каталог Икара: память, вложения, сессии и промпты. Сам /workspace
// оставлен человеку под свободную работу — наших файлов там больше нет.
const ICARUS = process.env.ICARUS_HOME ?? "/workspace/.icarus";
const PERSONA = `${ICARUS}/icarus.md`;
const AGENTS = `${ICARUS}/AGENTS.md`;
const DUMP = `${ICARUS}/.prompt-dump.txt`;
const SHARED = `${ICARUS}/shared-memory`;
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`;

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

    // Карту окружения читаем сами: pi ищет AGENTS.md только вверх от рабочего
    // каталога, а наш файл теперь лежит в служебном каталоге. Свой AGENTS.md
    // человека в /workspace, если он появится, приедет из pi и встанет следом.
    const ownContext = (event.systemPromptOptions?.contextFiles ?? []).filter(
      (file: { path: string }) => file.path !== AGENTS,
    );
    let map = "";
    try {
      map = fs.readFileSync(AGENTS, "utf8").trim();
    } catch {
      /* нет карты — работаем без неё, персона всё равно есть */
    }
    const contextFiles = [...(map ? [{ path: AGENTS, content: map }] : []), ...ownContext]
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

    // Скиллы pi добавляет в свой сборщик промпта, а мы промпт заменяем целиком — значит,
    // каталог собираем сами, иначе модель о скиллах просто не узнает. В каталоге только
    // имя, описание и путь; тело скилла читается через read по совпадению с описанием.
    const options = (event.systemPromptOptions ?? {}) as {
      skills?: SkillEntry[];
      selectedTools?: string[];
    };
    const skillsBlock = formatSkillsBlock(options.skills ?? [], options.selectedTools ?? []);

    // Канал приезжает из сервиса переменной ICARUS_CHANNEL. В веб-чате картинку
    // из workspace можно показать markdown-ом — в Telegram такая разметка не
    // рендерится, поэтому учим только тот канал, где это правда работает.
    const channelBlock =
      process.env.ICARUS_CHANNEL === 'web'
        ? [
            '# Веб-чат',
            `- Панель сама рисует картинки из markdown: \`![что на ней](${ICARUS}/incoming/файл.jpg)\`.`,
            '  Отдельного инструмента для этого нет — достаточно такой ссылки.',
            '- Если просят путь или адрес файла — напиши путь текстом, без картинки.',
          ].join('\n')
        : '';

    // TIME_INSTRUCTION — текст постоянный: сама дата в промпт не едет, иначе он менялся
    // бы от смены даты и рвал кэш. Свежее время приезжает меткой к реплике (см. clock.ts).
    const systemPrompt = [persona, contextFiles, memoryBlock, skillsBlock, channelBlock, TIME_INSTRUCTION]
      .filter(Boolean)
      .join("\n\n---\n\n");

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
