// Веб-поиск и чтение страниц как инструменты Икара.
//
// Провайдер выбирается переменной ICARUS_SEARCH_PROVIDER:
//   router (по умолчанию, если задан ICARUS_SEARCH_URL) | tavily | brave | searxng | none
// router — поиск через сервис: он держит ключи всех провайдеров, сам выбирает
// живого и обходит упавших. Контейнер ходит в сервис по docker-сети, без токена.
// tavily — поисковый API (https://tavily.com), свой ключ TAVILY_API_KEY. Отдельный
// провайдер здесь потому, что серверного веб-поиска у DeepInfra нет: её модели умеют
// только клиентские тулы, а поиск надо чем-то обслуживать. Ключ моделей для поиска не
// годится, и наоборот.
// Скрейпинг поисковиков выброшен: DuckDuckGo и Mojeek отдают ботам 403 и капчу, а
// страница без результатов разбиралась в пустую выдачу — «Ничего не нашлось» вместо
// причины отказа. Чтение страниц работает всегда и превращает HTML в текст без
// внешних зависимостей.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROUTER_URL = (process.env.ICARUS_SEARCH_URL ?? "").trim().replace(/\/$/, "");
const PROVIDER = (process.env.ICARUS_SEARCH_PROVIDER ?? (ROUTER_URL ? "router" : "tavily")).toLowerCase();
const TAVILY_KEY = process.env.TAVILY_API_KEY ?? "";
const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
const SEARXNG_URL = process.env.ICARUS_SEARXNG_URL ?? "";
/** basic хватает для разговора; advanced ищет глубже и тратит больше кредитов Tavily. */
const TAVILY_DEPTH = (process.env.ICARUS_SEARCH_DEPTH ?? "basic").toLowerCase() === "advanced" ? "advanced" : "basic";
const TAVILY_URL = "https://api.tavily.com/search";
/** Выдержка в списке результатов — одна строка: длинную мысль обрезаем. */
const SNIPPET_LIMIT = 500;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type SearchResult = { title: string; url: string; snippet?: string };

/** Грубое, но предсказуемое превращение HTML в читаемый текст. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Выдержка одной строкой: в списке результатов переводы строк только путают. */
function snippet(text: string): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed.length > SNIPPET_LIMIT ? `${squashed.slice(0, SNIPPET_LIMIT - 1)}…` : squashed;
}

/**
 * Разбирает выдачу Tavily.
 * @param payload - разобранное тело ответа /search.
 * @param limit - сколько результатов отдать.
 * @returns результаты; пустой массив, если тело не той формы.
 */
export function parseTavily(payload: unknown, limit = 6): SearchResult[] {
  const results = (payload as { results?: Array<{ title?: string; url?: string; content?: string }> })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((item) => item?.url && item?.title)
    .slice(0, limit)
    .map((item) => ({
      title: String(item.title),
      url: String(item.url),
      snippet:
        typeof item.content === "string" && item.content.trim() !== "" ? snippet(item.content) : undefined,
    }));
}

export function parseSearxng(payload: unknown, limit = 6): SearchResult[] {
  const results = (payload as { results?: Array<{ title?: string; url?: string; content?: string }> })
    ?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((item) => item?.url && item?.title)
    .slice(0, limit)
    .map((item) => ({ title: String(item.title), url: String(item.url), snippet: item.content }));
}

export function parseBrave(payload: unknown, limit = 6): SearchResult[] {
  const items = (payload as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } })
    ?.web?.results;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item?.url && item?.title)
    .slice(0, limit)
    .map((item) => ({
      title: String(item.title),
      url: String(item.url),
      snippet: item.description ? htmlToText(String(item.description)) : undefined,
    }));
}

function format(results: SearchResult[]): string {
  if (results.length === 0) return "Ничего не нашлось.";
  return results
    .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ""}`)
    .join("\n\n");
}

/** Причина отказа сети: у fetch под сообщением «fetch failed» спрятана настоящая ошибка. */
function networkErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error && cause.message && cause.message !== error.message ? `: ${cause.message}` : "";
  return `${error.message}${detail}`;
}

/** Отказ HTTP: статус плюс текст ошибки сервиса, если он там есть. */
async function httpError(response: Response, what = "Поиск"): Promise<string> {
  let message = `${what} не удался: HTTP ${response.status}`;
  try {
    const parsed = (await response.json()) as {
      error?: string | { message?: string };
      message?: string;
      detail?: string | { error?: string; message?: string };
    };
    const detail =
      typeof parsed?.error === "string"
        ? parsed.error
        : (parsed?.error?.message ??
          parsed?.message ??
          (typeof parsed?.detail === "string" ? parsed.detail : (parsed?.detail?.error ?? parsed?.detail?.message)));
    if (detail) message += `: ${detail}`;
  } catch {
    // тело может быть не JSON — тогда хватит одного статуса
  }
  return message;
}

async function searchTavily(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  if (!TAVILY_KEY) return "Поиск не настроен: нет TAVILY_API_KEY.";
  let response: Response;
  try {
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Ключ в заголовке, а не в теле: тело запроса оседает в логах охотнее.
        authorization: `Bearer ${TAVILY_KEY}`,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ query, max_results: limit, search_depth: TAVILY_DEPTH }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return `Поиск не удался: ${networkErrorText(error)}`;
  }
  if (!response.ok) return httpError(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return "Поиск не удался: Tavily вернул неразбираемый ответ.";
  }
  return format(parseTavily(payload, limit));
}

/** Выдача сервисного роутера: { results: [{ title, url, snippet }] }. */
export function parseRouter(payload: unknown, limit = 6): SearchResult[] {
  const results = (payload as { results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }> })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((item) => typeof item?.url === "string" && typeof item?.title === "string")
    .slice(0, limit)
    .map((item) => ({
      title: String(item.title),
      url: String(item.url),
      ...(typeof item.snippet === "string" && item.snippet.trim() !== "" ? { snippet: snippet(item.snippet) } : {}),
    }));
}

/** Кто на самом деле ответил и кого пришлось обойти — из ответа сервиса. */
export function parseRouterMeta(payload: unknown): { upstream?: string; tried?: Array<{ provider: string; reason: string }> } {
  const root = payload as { provider?: unknown; tried?: unknown } | null;
  const upstream = typeof root?.provider === "string" ? root.provider : undefined;
  const tried = (Array.isArray(root?.tried) ? root.tried : [])
    .map((item) => {
      const row = item as { provider?: unknown; reason?: unknown };
      return typeof row?.provider === "string"
        ? { provider: row.provider, reason: typeof row.reason === "string" ? row.reason : "" }
        : null;
    })
    .filter((item): item is { provider: string; reason: string } => item !== null);
  return { ...(upstream ? { upstream } : {}), ...(tried.length > 0 ? { tried } : {}) };
}

/** Что вернул поиск: текст для модели и, если знаем, кто ответил. */
type SearchOutcome = {
  text: string;
  upstream?: string;
  tried?: Array<{ provider: string; reason: string }>;
};

async function searchRouter(query: string, limit: number, signal?: AbortSignal): Promise<SearchOutcome> {
  if (!ROUTER_URL) return { text: "Поиск не настроен: нет ICARUS_SEARCH_URL." };
  let response: Response;
  try {
    response = await fetch(`${ROUTER_URL}/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: `Поиск не удался: ${networkErrorText(error)}` };
  }
  if (!response.ok) return { text: await httpError(response) };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { text: "Поиск не удался: сервис вернул неразбираемый ответ." };
  }
  return { text: format(parseRouter(payload, limit)), ...parseRouterMeta(payload) };
}

async function search(query: string, limit: number, signal?: AbortSignal): Promise<SearchOutcome> {
  if (PROVIDER === "router") return searchRouter(query, limit, signal);

  if (PROVIDER === "tavily") return { text: await searchTavily(query, limit, signal) };

  if (PROVIDER === "brave") {
    if (!BRAVE_KEY) return { text: "Поиск не настроен: нет BRAVE_API_KEY." };
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      { headers: { accept: "application/json", "x-subscription-token": BRAVE_KEY }, signal },
    );
    if (!response.ok) return { text: await httpError(response) };
    return { text: format(parseBrave(await response.json(), limit)) };
  }

  if (PROVIDER === "searxng") {
    if (!SEARXNG_URL) return { text: "Поиск не настроен: нет ICARUS_SEARXNG_URL." };
    const response = await fetch(
      `${SEARXNG_URL.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`,
      { headers: { accept: "application/json" }, signal },
    );
    if (!response.ok) return { text: await httpError(response) };
    return { text: format(parseSearxng(await response.json(), limit)) };
  }

  return {
    text: `Поиск не настроен: провайдер «${PROVIDER}» неизвестен — жду router, tavily, brave, searxng или none.`,
  };
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "Нужен обычный http(s)-адрес.";
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" }, signal });
  if (!response.ok) return `Страница не открылась: HTTP ${response.status}`;
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (type.includes("json")) return body.slice(0, 20_000);
  const text = htmlToText(body);
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (обрезано)` : text || "На странице не нашлось текста.";
}

/** Ответ сервисного /fetch: текст страницы плюс кто её прочитал. */
export function parseFetchRouter(payload: unknown): {
  text: string;
  title?: string;
  upstream?: string;
  tried?: Array<{ provider: string; reason: string }>;
} {
  const root = payload as { text?: unknown; title?: unknown } | null;
  const text = typeof root?.text === "string" ? root.text : "";
  return {
    text,
    ...(typeof root?.title === "string" && root.title.trim() !== "" ? { title: root.title } : {}),
    ...parseRouterMeta(payload),
  };
}

async function fetchViaRouter(url: string, signal?: AbortSignal): Promise<{
  text: string;
  title?: string;
  upstream?: string;
  tried?: Array<{ provider: string; reason: string }>;
}> {
  if (!ROUTER_URL) return { text: "Извлечение не настроено: нет ICARUS_SEARCH_URL." };
  let response: Response;
  try {
    response = await fetch(`${ROUTER_URL}/fetch?url=${encodeURIComponent(url)}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: `Страница не открылась: ${networkErrorText(error)}` };
  }
  if (!response.ok) {
    const detail = (await httpError(response)).replace(/^Поиск не удался: /, "");
    return { text: `Страница не открылась: ${detail}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { text: "Страница не открылась: сервис вернул неразбираемый ответ." };
  }
  const parsed = parseFetchRouter(payload);
  return parsed.text.trim() === "" ? { ...parsed, text: "На странице не нашлось текста." } : parsed;
}

export default function (pi: ExtensionAPI) {
  if (PROVIDER !== "none") {
    pi.registerTool({
      name: "web_search",
      label: "Поиск в интернете",
      description:
        "Найти актуальную информацию в интернете. Возвращает несколько результатов со ссылками и, когда поиск их отдаёт, краткими выдержками.",
      parameters: Type.Object({
        query: Type.String({ description: "Поисковый запрос" }),
        limit: Type.Optional(Type.Number({ description: "Сколько результатов вернуть (по умолчанию 5)" })),
      }),
      async execute(_toolCallId, params, signal) {
        const limit = Math.min(Math.max(Number(params.limit ?? 5), 1), 10);
        const outcome = await search(String(params.query), limit, signal);
        return {
          content: [{ type: "text", text: outcome.text }],
          details: {
            provider: PROVIDER,
            ...(outcome.upstream ? { upstream: outcome.upstream } : {}),
            ...(outcome.tried ? { tried: outcome.tried } : {}),
          },
        };
      },
    });
  }

  pi.registerTool({
    name: "web_fetch",
    label: "Открыть страницу",
    description: "Скачать страницу по ссылке и вернуть её текст без разметки.",
    parameters: Type.Object({
      url: Type.String({ description: "Адрес страницы" }),
    }),
    async execute(_toolCallId, params, signal) {
      // Через сервис — когда он есть: там свой роутер извлечения (Exa, Tavily,
      // Linkup, You.com), свои карантины и отдельный «текущий». Без сервиса
      // остаётся прежний прямой поход из контейнера.
      const outcome = ROUTER_URL
        ? await fetchViaRouter(String(params.url), signal)
        : { text: await fetchPage(String(params.url), signal) };
      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          ...(outcome.upstream ? { provider: "router", upstream: outcome.upstream } : {}),
          ...(outcome.title ? { title: outcome.title } : {}),
          ...(outcome.tried ? { tried: outcome.tried } : {}),
        },
      };
    },
  });
}
