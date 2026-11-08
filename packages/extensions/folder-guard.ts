// Страж прав на папки для файловых инструментов агента.
//
// Это generic-слой: он не знает про артефакты, он знает про корни с
// `.folder-acl.json`. Сегодня корень один — /artifacts, завтра можно добавить
// ещё через ICARUS_ACL_ROOTS=... Общий формат ACL живёт в lib/folder-access.ts.
//
// Ограничение честное: это блокировка read/write/edit/grep/find/ls и запрет
// bash по защищённым путям. MCP-серверы проверяют права сами; чужой MCP,
// которому разрешено ходить в /artifacts, — дыра, которую закроет отдельный
// allow-list MCP, когда появится.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aclRoots, folderVerdict, type AccessLevel } from "./lib/folder-access.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export type GuardOptions = {
  viewer: string;
  roots: string[];
};

/**
 * Решение стража для одного вызова. undefined — пропустить.
 * Вынесено из pi.on, чтобы проверялось тестом без живого агента.
 */
export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: GuardOptions,
): { block: true; reason: string } | undefined {
  if (options.roots.length === 0) return undefined;
  if (toolName.startsWith("mcp_")) return undefined;

  // bash обошёл бы любой path-based страж: запрещаем в защищённых путях целиком.
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
    // Имена артефактов — глобальный листинг, его смотреть можно. Содержимое —
    // только с указанием конкретной папки.
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
