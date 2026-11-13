// Icarus tool: create a skill the human way.
//
// The ordinary `write` can also create a `SKILL.md`, but it does not know the layout rules
// and puts the file wherever it was asked to. Here the model names the skill, description and
// instruction, and the tool chooses the directory itself: personal (the panel and pi read it)
// or the project `.pi/skills` of the current folder — if the skill is needed only by this
// workspace and not by the whole home.
//
// The panel and pi read the personal directory at session start, so a just-created skill
// appears in the next conversation — this is what the tool says, so that the model does not
// promise "it already works".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";
import {
  personalSkillsRoot,
  workspaceSkillsRoot,
  writeSkill,
  type SkillFileInput,
} from "./lib/skill-writer-core.ts";

export const SKILL_WRITER_TOOL = "skill_writer";

const SCOPES = Type.Union([Type.Literal("personal"), Type.Literal("workspace")], {
  description: "personal — личный каталог Икара (по умолчанию), workspace — .pi/skills текущей папки",
});

const FILE_SCHEMA = Type.Object({
  path: Type.String({ description: "Относительный путь внутри скилла, например scripts/run.sh" }),
  content: Type.String({ description: "Содержимое файла целиком" }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: SKILL_WRITER_TOOL,
    label: "Создать скилл",
    description:
      "Создаёт новый скилл: каталог с SKILL.md и, если нужно, файлами бандла. " +
      "Кладёт его в личный каталог Икара (его видит панель и следующий разговор) " +
      "или в .pi/skills текущей папки, если скилл нужен только этому workspace'у. " +
      "Имя — строчными латинскими буквами, цифрами и дефисом; описание обязательно: " +
      "по нему модель решает, когда скилл звать.",
    parameters: Type.Object({
      name: Type.String({ description: "Имя скилла и его каталога, например pirate-mode" }),
      description: Type.String({
        description: "Что скилл делает и в какой момент его звать — одна-две фразы",
      }),
      body: Type.String({ description: "Инструкция в Markdown: шаги, на что смотреть, чего не делать" }),
      scope: Type.Optional(SCOPES),
      folder: Type.Optional(
        Type.String({ description: "Полка внутри каталога, например sea: получится sea/<имя>/SKILL.md" }),
      ),
      files: Type.Optional(Type.Array(FILE_SCHEMA, { description: "Файлы бандла рядом с SKILL.md" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Переписать существующий скилл" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (process.env.ICARUS_PRIVATE === "1") {
        return {
          content: [{ type: "text", text: "Приватный режим: скиллы здесь не создаются." }],
          details: {},
        };
      }

      const scope = params.scope === "workspace" ? "workspace" : "personal";
      const root =
        scope === "workspace"
          ? workspaceSkillsRoot(path.resolve(ctx.cwd ?? process.cwd()))
          : personalSkillsRoot();

      let result: ReturnType<typeof writeSkill>;
      try {
        result = writeSkill(root, {
          name: String(params.name ?? ""),
          description: String(params.description ?? ""),
          body: String(params.body ?? ""),
          ...(params.folder ? { folder: String(params.folder) } : {}),
          ...(params.files ? { files: params.files as SkillFileInput[] } : {}),
          overwrite: params.overwrite === true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Скилл не создан: ${message}` }],
          details: { ok: false, error: message },
        };
      }

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Скилл не создан: ${result.error}` }],
          details: { ok: false, error: result.error },
        };
      }

      const where = scope === "workspace" ? "проектный .pi/skills" : "личный каталог Икара";
      return {
        content: [
          {
            type: "text",
            text:
              `Скилл «${result.id.replace(/\/SKILL\.md$/, "")}» создан в ${where}: ${result.file}\n` +
              "Он появится у Икара в следующем разговоре: каталог скиллов читается при старте сессии. " +
              "В git его зафиксирует панель при следующем сохранении скилла.",
          },
        ],
        details: { ok: true, scope, id: result.id, file: result.file },
      };
    },
  });
}
