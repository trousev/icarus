// Folder permission guard for the agent's file tools.
//
// This is a generic layer: it knows nothing about artifacts, it knows about roots with
// `.folder-acl.json`. Today there's one root — /artifacts, tomorrow more can be added
// via ICARUS_ACL_ROOTS=... The common ACL format lives in lib/folder-access.ts.
//
// The limitation is honest: this blocks read/write/edit/grep/find/ls and forbids
// bash on protected paths. MCP servers check permissions themselves; a foreign MCP
// allowed to reach /artifacts is a hole that a separate MCP allow-list will close
// when it appears.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aclRoots, folderVerdict, type AccessLevel } from "./lib/folder-access.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export type GuardOptions = {
  viewer: string;
  roots: string[];
};

/**
 * The guard's decision for a single call. undefined — pass through.
 * Taken out of pi.on so it can be tested without a live agent.
 */
export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: GuardOptions,
): { block: true; reason: string } | undefined {
  if (options.roots.length === 0) return undefined;
  if (toolName.startsWith("mcp_")) return undefined;

  // bash would bypass any path-based guard: we forbid it entirely in protected paths.
  if (toolName === "bash" || toolName === "powershell") {
    const command = String(input.command ?? "");
    const hit = options.roots.find((root) => command.includes(root));
    if (hit) {
      return {
        block: true,
        reason: `К /artifacts (${hit}) — только через read/write/edit, не через ${toolName}: права папок иначе не проверить.`,
      };
    }
    return undefined;
  }

  const required: AccessLevel | null = READ_TOOLS.has(toolName)
    ? "read"
    : WRITE_TOOLS.has(toolName)
      ? "write"
      : null;
  if (!required) return undefined;

  const target = String(input.path ?? input.file ?? "");
  if (!target) return undefined;
  const verdict = folderVerdict(target, options.viewer, required, options.roots);
  if (!verdict.protected) return undefined;
  const parts = target.replace(/\\/g, "/").split("/");
  if (parts.includes(".git")) {
    return { block: true, reason: "История версий артефакта скрыта: не трогай .git, она ведётся сама." };
  }
  if (parts.some((part) => part === ".folder-acl.json" || part === ".artifact.json")) {
    return { block: true, reason: "Права и ссылка артефакта меняются через artifact_new или панель, не файлом." };
  }
  if (verdict.rootOnly) {
    // Artifact names are a global listing, they may be viewed. Contents —
    // only with a specific folder specified.
    if (toolName === "ls") return undefined;
    return { block: true, reason: "Уточни артефакт: /artifacts сам по себе — только список имён." };
  }
  if (verdict.allowed) return undefined;
  return { block: true, reason: verdict.reason ?? "Нет прав на эту папку." };
}

export default function (pi: ExtensionAPI) {
  const roots = aclRoots();
  const viewer = (process.env.ICARUS_USER_ID ?? "").trim();
  if (roots.length === 0) return;

  pi.on("tool_call", async (event) => {
    const input = ((event as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
    return guardToolCall(String(event.toolName ?? ""), input, { viewer, roots });
  });
}
