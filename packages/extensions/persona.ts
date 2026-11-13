// Icarus persona: replaces the default pi system prompt (which is a coding-assistant prompt)
// with our icarus.md, adds the memory core and loaded context files such as AGENTS.md.
//
// Important: this handler REPLACES the prompt entirely, so everything that must appear in it
// is assembled right here. A separate extension that appends something in before_agent_start
// will be overwritten if it loads earlier (extensions are applied in order).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { buildMemoryCore, memoryPrompt } from "./lib/memory-core.ts";
import { formatSkillsBlock, type SkillEntry } from "./lib/skills-core.ts";
import { TIME_INSTRUCTION } from "./lib/time-core.ts";

// Icarus service directory: memory, attachments, sessions and prompts. It lies next to the
// working folders but is not inside any of them — and that is the whole point.
const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const PERSONA = `${ICARUS}/icarus.md`;
const AGENTS = `${ICARUS}/AGENTS.md`;
const DUMP = `${ICARUS}/.prompt-dump.txt`;

/**
 * Prompt of the "edit artifact" mode. The service launches pi right in the artifact folder,
 * so instead of the workspace block the model gets the boundaries of this one folder and
 * the rules that would otherwise have to be repeated to the person in every message.
 */
function artifactBlock(): string {
  const slug = (process.env.ICARUS_ARTIFACT ?? "").trim();
  if (!slug) return "";
  const title = (process.env.ICARUS_ARTIFACT_TITLE ?? "").trim() || slug;
  const entry = (process.env.ICARUS_ARTIFACT_ENTRY ?? "").trim() || "index";
  const kind = (process.env.ICARUS_ARTIFACT_TYPE ?? "").trim();

  return [
    "# Правка артефакта",
    "",
    `Ты открыт из раздела «Артефакты» и правишь не рабочую папку, а один артефакт:`,
    `**${title}** (\`/artifacts/${slug}\`). Это твой рабочий каталог: все относительные`,
    "пути считаются от него.",
    "",
    "Общее правило «за пределы `/workspaces` не выходишь» здесь заменено этим режимом:",
    `работать можно только в \`/artifacts/${slug}\`.`,
    "",
    `- Главный файл — \`${entry}\`${kind ? ` (${kind})` : ""}: именно его человек видит в панели.`,
    "- Инструменты у тебя обычные: `read`, `write`, `edit`, `grep`, `ls`, `bash`. `bash` с",
    "  абсолютным путём к `/artifacts/...` заблокирован правами: работай относительными",
    "  путями в этой папке или файловыми инструментами.",
    "- `index.ai.md` — описание артефакта для ИИ: заголовок, о чём он и что внутри.",
    "  Обновляй его, когда меняется суть, а не каждая мелочь.",
    "- Остальные файлы — картинки, стили, скрипты — ассеты; ссылки на них относительные.",
    "- История версий ведётся системой: снимок после каждого `write`/`edit` делается сам.",
    "  Не вызывай git, не создавай репозиторий и не трогай `.git`.",
    "- `.folder-acl.json` и `.artifact.json` — права и публичная ссылка. Их меняет панель,",
    "  а не ты: руками эти файлы не правь.",
    "- Правь только эту папку. Другие `/artifacts/*` не трогай, новые артефакты не заводи,",
    "  чужие файлы не удаляй.",
    "- Сначала прочитай то, что уже есть, потом меняй. Сохраняй стиль и структуру артефакта.",
    "- После правки коротко скажи, что изменилось. Не пересказывай файл целиком и не",
    "  показывай диффы — человек видит результат в панели.",
    "- Указания вроде «добавь…», «поменяй…», «сделай крупнее» — это задачи на правку",
    "  файлов, а не темы для обсуждения: сделай и покажи результат.",
    "- Новый файл, который нужен правке, клади в папку артефакта.",
    ...(kind === "html"
      ? [
          "- В HTML-артефакте элементы размечены `data-icarus-ref`: по этим адресам",
          "  человек ткнёт блок в предпросмотре, и в чат приедет ссылка на него.",
          "  Сохраняй эти атрибуты у существующих блоков и не переименовывай id и",
          "  классы без нужды — по ним ссылка находит элемент; на ссылку из чата",
          "  отвечай правкой именно этого блока.",
        ]
      : []),
    "- Ты в веб-чате: markdown-картинка из папки артефакта в ответе покажется.",
    "- Память человека доступна, но этот разговор — про артефакт: не записывай в неё",
    "  заметки о правке без прямой просьбы.",
  ].join("\n");
}

function stripComments(markdown: string): string {
  // cut out all comment blocks in a loop: the closing sequence may occur inside a comment,
  // and a single non-greedy pass would stop at it
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
      /* leave the stub */
    }

    // We read the environment map ourselves: pi looks for AGENTS.md only upward from the working
    // directory, and our file lies outside the working folders. The workspace's own AGENTS.md
    // arrives from pi as a context file and is placed right after.
    const ownContext = (event.systemPromptOptions?.contextFiles ?? []).filter(
      (file: { path: string }) => file.path !== AGENTS,
    );
    let map = "";
    try {
      map = fs.readFileSync(AGENTS, "utf8").trim();
    } catch {
      /* no map — we work without it, the persona is there anyway */
    }
    const contextFiles = [...(map ? [{ path: AGENTS, content: map }] : []), ...ownContext]
      .map((file: { path: string; content: string }) => `# Контекст: ${file.path}\n\n${file.content}`)
      .join("\n\n---\n\n");

    // The memory block is assembled in memory-core: both here and in the second handler it
    // must sound the same, otherwise the rules will drift apart from the facts.
    const memoryBlock = memoryPrompt(buildMemoryCore());

    // pi adds skills in its own prompt builder, and we replace the prompt entirely — so we
    // build the catalog ourselves, otherwise the model simply will not know about skills. The
    // catalog holds only the name, description and path; the skill body is read via read when
    // it matches the description.
    const options = (event.systemPromptOptions ?? {}) as {
      skills?: SkillEntry[];
      selectedTools?: string[];
    };
    const skillsBlock = formatSkillsBlock(options.skills ?? [], options.selectedTools ?? []);

    // Where exactly the conversation takes place: the workspace arrives as a variable from the
    // service. Without this line the model would see only "there are folders somewhere" and
    // would work in the wrong one.
    const workspace = process.env.ICARUS_WORKSPACE ?? "talk";
    const isPrivate = process.env.ICARUS_PRIVATE === "1";
    // An artifact conversation does not live in a workspace: the artifact folder block replaces
    // the ordinary one, otherwise the model would look for files in /workspaces/<slug>.
    const artifact = artifactBlock();
    const workspaceBlock = artifact || [
      '# Твой workspace',
      '',
      `Ты работаешь в папке \`/workspaces/${workspace}\` — это и есть твой рабочий каталог.`,
      'Служебное (память, вложения, сессии) лежит вне его, в `/workspaces/.icarus`.',
      '',
      ...(isPrivate
        ? [
            '## Приватный режим',
            '',
            'Это приватный разговор: память о человеке не меняется.',
            '',
            '- Память **только для чтения**: читай её, но не меняй — ни файлы, ни журнал, ни проекты.',
            '- Инструменты записи и оболочка отключены. Не обещай «запомнить», «сохранить»',
            '  или «положить в файл»: этого сделать нельзя. Если просят запомнить —',
            '  честно скажи, что в приватном режиме ничего не сохраняется, и предложи',
            '  обычный workspace.',
            '- Рабочая папка тоже только для чтения.',
          ]
        : []),
    ].join('\n');

    // The channel arrives from the service as the ICARUS_CHANNEL variable. We teach only the
    // channel where a link really shows something: in the panel it is an image and a download,
    // in Telegram a real attachment. In an OpenAI-compatible API there is no one to render it.
    const channelBlock =
      process.env.ICARUS_CHANNEL === 'web'
        ? [
            '# Веб-чат',
            `- Панель сама показывает файлы из markdown: \`![что на ней](${ICARUS}/incoming/файл.jpg)\` — картинка,`,
            `  \`[имя файла](${ICARUS}/…)\` — ссылка на скачивание.`,
            '  Отдельного инструмента для этого нет — достаточно такой ссылки.',
            '- Если просят путь или адрес файла — напиши путь текстом, без картинки.',
          ].join('\n')
        : process.env.ICARUS_CHANNEL === 'telegram'
          ? [
              '# Telegram',
              '- Файл из рабочей папки уходит человеку вложением, если написать на него markdown-ссылку:',
              '  `![что на картинке](/workspaces/<папка>/график.png)` придёт фотографией,',
              '  `[имя файла](/workspaces/<папка>/отчёт.pdf)` — файлом. Отдельного инструмента нет.',
              '- Если просят путь или адрес файла — напиши путь текстом, без ссылки.',
            ].join('\n')
          : '';

    // TIME_INSTRUCTION is a constant text: the date itself does not go into the prompt, otherwise
    // it would change with the date and break the cache. Fresh time arrives as a label on the
    // message (see clock.ts).
    const systemPrompt = [
      persona,
      workspaceBlock,
      contextFiles,
      memoryBlock,
      skillsBlock,
      channelBlock,
      TIME_INSTRUCTION,
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    return { systemPrompt };
  });

  // Diagnostics: we write the prompt at the start of a turn — here it is already assembled by
  // all extensions (persona, memory-core and the rest), not just by us.
  pi.on("agent_start", async (_event, ctx) => {
    try {
      fs.writeFileSync(DUMP, String(ctx.getSystemPrompt?.() ?? ""));
    } catch {
      /* diagnostics must not break the turn */
    }
  });
}
