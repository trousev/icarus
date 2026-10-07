// Инструмент Икара: адрес панели управления.
//
// Панель стоит за SSO-прокси: человек входит в неё своей обычной учёткой (на проде —
// Authelia), и открывается ему ровно его память. Поэтому ни ссылок с ключами, ни сроков
// годности тут больше нет: Икару достаточно назвать адрес, а пускать и не пускать —
// дело прокси.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Что нужно инструменту: внешний адрес панели в контейнере человека (ICARUS_URL). */
export type PanelEnv = {
  url?: string;
};

export type PanelLinkResult = { url: string } | { error: string };

/**
 * Собирает адрес или объясняет, почему его нет. Функция чистая: окружение передаётся
 * снаружи, поэтому её проверяют тесты без pi и без контейнера.
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
