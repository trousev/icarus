// Icarus's tool: the control panel address.
//
// The panel sits behind an SSO proxy: the person logs in with their regular account
// (Authelia in prod), and exactly their own memory opens up. That's why there are no
// more keyed links or expiry times here: it's enough for Icarus to name the address, and
// letting in or not is the proxy's job.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** What the tool needs: the external panel address in the person's container (ICARUS_URL). */
export type PanelEnv = {
  url?: string;
};

export type PanelLinkResult = { url: string } | { error: string };

/**
 * Builds the address or explains why it's missing. The function is pure: the environment
 * is passed in, so tests can check it without pi and without a container.
 */
export function controlPanelLink(env: PanelEnv): PanelLinkResult {
  const url = env.url?.trim();
  if (!url) {
    return { error: 'Адрес панели недоступен: сервис не передал его в контейнер (ICARUS_URL).' };
  }
  return { url: `${url.replace(/\/+$/, '')}/` };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_control_panel_link",
    label: "Панель управления",
    description:
      "Выдаёт адрес панели управления Icarus: там видно файлы памяти собеседника — посмотреть, найти, " +
      "забыть строку, удалить файл целиком, откатить разбор. Вход в панель — обычный вход человека " +
      "(SSO), и открывает она память только этого человека — никого другого.",
    parameters: Type.Object({}),
    async execute() {
      const env: PanelEnv = {
        url: process.env.ICARUS_URL,
      };
      const result = controlPanelLink(env);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], details: {} };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Панель управления Icarus: ${result.url}\n` +
              `Вход — твой обычный, через SSO; панель открывает только твою память.`,
          },
        ],
        details: {},
      };
    },
  });
}
