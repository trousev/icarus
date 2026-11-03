// Страж приватного workspace.
//
// Основной замок — тулы записи не выдаются вовсе (--exclude-tools в аргументах pi),
// а этот слой закрывает то, что могло просочиться: расширения, MCP-серверы и любые
// инструменты, которые появятся позже. Память и рабочая папка в приватном режиме
// не меняются — это обещание человеку, а не настройка по умолчанию.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);
/** MCP-серверы умеют писать сами: Maple, например, кладёт журналы. */
const WRITE_MCP = /^mcp_/;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    // Обычные разговоры страж не трогает: расширение ставится только приватной сессии.
    if (process.env.ICARUS_PRIVATE !== "1") return;

    const toolName = String((event as { toolName?: unknown }).toolName ?? "");
    // mcp_connect подключает произвольный сервер, который может писать в память.
    if (WRITE_TOOLS.has(toolName) || toolName === "mcp_connect" || WRITE_MCP.test(toolName)) {
      return { block: true, reason: "Приватный workspace: запись и запуск команд отключены." };
    }
  });
}
