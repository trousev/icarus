// Два шага к памяти: сначала индекс файлов с описаниями, потом обычное чтение
// выбранных файлов. Модель сама решает, что читать, — и не получает факты
// в системный промпт, где они начинали выбирать тему разговора.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Type } from "typebox";
import { buildCatalog, formatCatalog, updateDescription } from "./lib/memory-catalog.ts";

const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const MEMORY = path.resolve(process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`);

export default function (pi: ExtensionAPI) {
  // Один индекс и не больше трёх чтений памяти за ход. Иначе модель уходит
  // читать полпамяти и заканчивает ход без ответа — проверено на живой памяти.
  let indexes = 0;
  let reads = 0;
  pi.on("before_agent_start", () => {
    indexes = 0;
    reads = 0;
  });

  pi.on("tool_call", (event) => {
    const toolName = String(event.toolName);
    const input = (event as { input?: { path?: unknown } }).input ?? {};

    if (toolName === "memory_index") {
      indexes += 1;
      if (indexes > 1) {
        return { block: true, reason: "Индекс уже получен. Выбирай файлы и читай их, не зови индекс снова." };
      }
      return;
    }

    if (toolName !== "read") return;
    const asked = String(input.path ?? "");
    const abs = path.resolve(asked);
    if (abs !== MEMORY && !abs.startsWith(`${MEMORY}${path.sep}`)) return;

    reads += 1;
    if (reads > 3) {
      return {
        block: true,
        reason: "Достаточно файлов памяти на этот ход. Отвечай по уже прочитанному; остальное можно прочитать в следующий раз.",
      };
    }
  });

  pi.registerTool({
    name: "memory_index",
    label: "Индекс памяти",
    description:
      "Показывает файлы памяти с короткими описаниями: что где лежит. " +
      "Зови, когда советуешь место, покупку или план, вспоминаешь событие или ответ станет точнее " +
      "от того, что ты знаешь о собеседнике. Сначала зови его, чтобы выбрать файлы, потом читай " +
      "выбранные инструментом read. Не зови, чтобы придумать тему: тему ведёт он. " +
      "action=update_description обновляет описание файла, когда его содержимое изменилось.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("list"), Type.Literal("update_description")], {
          description: "list (по умолчанию) или update_description",
        }),
      ),
      file: Type.Optional(
        Type.String({ description: "Файл для update_description, например projects/arduino.md" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Короткое описание файла, одна строка" }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { action?: "list" | "update_description"; file?: string; description?: string },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: { action: string; file?: string } }> {
      const action = String(params.action ?? "list");

      if (action === "update_description") {
        if (process.env.ICARUS_PRIVATE === "1") {
          return {
            content: [{ type: "text", text: "Приватный режим: описания памяти здесь не меняются." }],
            details: { action },
          };
        }
        const result = updateDescription(String(params.file ?? ""), String(params.description ?? ""));
        if (!result.ok) {
          return { content: [{ type: "text", text: result.error }], details: { action } };
        }
        return {
          content: [{ type: "text", text: `Описание обновлено: ${result.file}` }],
          details: { action, file: result.file },
        };
      }

      if (action !== "list") {
        return {
          content: [{ type: "text", text: `Неизвестное действие: ${action}. Ожидаю list или update_description.` }],
          details: { action },
        };
      }

      return {
        content: [{ type: "text", text: formatCatalog(buildCatalog()) }],
        details: { action },
      };
    },
  });
}
