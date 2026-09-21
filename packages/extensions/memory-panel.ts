// Инструмент Икара: личная ссылка на управление памятью.
//
// Человек просит ссылку — Икар подписывает личный пропуск со сроком годности.
// Панель по этой ссылке показывает память ровно одного человека (личную и семейную)
// и живёт ограниченное время. Секрет сервиса в контейнере не лежит: сюда приезжает
// только личный ключ (см. lib/panel-link.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { linkTtlMinutes, panelLinkUrl, signPanelCredential } from "./lib/panel-link.ts";

/** Что нужно инструменту: кто я, личный ключ и внешний адрес панели. */
export type PanelEnv = {
  userId?: string;
  panelKey?: string;
  url?: string;
  ttlMinutes?: string;
};

export type PanelLinkResult = { url: string } | { error: string };

/**
 * Собирает ссылку или объясняет, почему её нет. Функция чистая: окружение и время
 * передаются снаружи, поэтому её проверяют тесты без pi и без контейнера.
 */
export function memoryManagementLink(env: PanelEnv, now: number = Date.now()): PanelLinkResult {
  const userId = env.userId?.trim();
  const panelKey = env.panelKey?.trim();
  const url = env.url?.trim();
  if (!userId || !panelKey || !url) {
    return { error: 'Ссылка на память недоступна: сервис не передал личный ключ или адрес панели.' };
  }
  const expiresAt = now + linkTtlMinutes(env.ttlMinutes) * 60_000;
  return { url: panelLinkUrl(url, signPanelCredential(panelKey, userId, expiresAt)) };
}

/** Человеческое «сколько живёт»: сутки — «24 ч», полтора часа — «1.5 ч». */
function humanTtl(ttlMinutes: string | undefined): string {
  const minutes = linkTtlMinutes(ttlMinutes);
  return `${Math.round((minutes / 60) * 10) / 10} ч`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_memory_management_link",
    label: "Ссылка на память",
    description:
      "Выдаёт личную ссылку на управление памятью собеседника: посмотреть файлы, найти, " +
      "забыть строку, удалить файл целиком, откатить разбор. Ссылка действует ограниченное время и открывает " +
      "память только этого человека — никого другого.",
    parameters: Type.Object({}),
    async execute() {
      const env: PanelEnv = {
        userId: process.env.ICARUS_USER_ID,
        panelKey: process.env.ICARUS_PANEL_KEY,
        url: process.env.ICARUS_URL,
        ttlMinutes: process.env.ICARUS_MEMORY_LINK_TTL_MINUTES,
      };
      const result = memoryManagementLink(env);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], details: {} };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Ссылка на управление твоей памятью (действует ${humanTtl(env.ttlMinutes)}, ` +
              `открывает только твою память):\n${result.url}`,
          },
        ],
        details: {},
      };
    },
  });
}
