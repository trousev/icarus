// Guard of the private workspace.
//
// The main lock is that write tools are not provided at all (--exclude-tools in the pi args),
// and this layer closes what could leak through: extensions, MCP servers and any tools that
// appear later. Memory and the working folder are not changed in private mode — this is a
// promise to the person, not a default setting.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);
/** MCP servers can write on their own: their tools are not ours, and they have no business in a private folder. */
const WRITE_MCP = /^mcp_/;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    // The guard does not touch ordinary conversations: the extension is installed only for a private session.
    if (process.env.ICARUS_PRIVATE !== "1") return;

    const toolName = String((event as { toolName?: unknown }).toolName ?? "");
    // mcp_connect connects an arbitrary server that can write to memory.
    if (WRITE_TOOLS.has(toolName) || toolName === "mcp_connect" || WRITE_MCP.test(toolName)) {
      return { block: true, reason: "Приватный workspace: запись и запуск команд отключены." };
    }
  });
}
