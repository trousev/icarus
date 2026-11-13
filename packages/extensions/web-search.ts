// Web search and page reading as Icarus tools.
//
// The provider is chosen by the ICARUS_SEARCH_PROVIDER variable:
//   router (default if ICARUS_SEARCH_URL is set) | tavily | brave | searxng | none
// router — search through the service: it holds the keys of all providers, picks a live one
// itself and skips the fallen ones. The container talks to the service over the docker network,
// without a token.
// tavily — search API (https://tavily.com), its own TAVILY_API_KEY. A separate provider is
// here because DeepInfra has no server-side web search: its models only support client-side
// tools, and the search needs something to serve it. The models' key does not work for search,
// and vice versa.
// Scraping search engines was dropped: DuckDuckGo and Mojeek return 403 and a captcha to bots,
// and a page without results was parsed into an empty result — "Ничего не нашлось" instead of
// the reason for the refusal. Page reading always works and turns HTML into text without
// external dependencies.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROUTER_URL = (process.env.ICARUS_SEARCH_URL ?? "").trim().replace(/\/$/, "");
const PROVIDER = (process.env.ICARUS_SEARCH_PROVIDER ?? (ROUTER_URL ? "router" : "tavily")).toLowerCase();
const TAVILY_KEY = process.env.TAVILY_API_KEY ?? "";
const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
const SEARXNG_URL = process.env.ICARUS_SEARXNG_URL ?? "";
/** basic is enough for a conversation; advanced searches deeper and spends more Tavily credits. */
const TAVILY_DEPTH = (process.env.ICARUS_SEARCH_DEPTH ?? "basic").toLowerCase() === "advanced" ? "advanced" : "basic";
const TAVILY_URL = "https://api.tavily.com/search";
/** Snippet in the result list — one line: we cut a long thought. */
const SNIPPET_LIMIT = 500;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type SearchResult = { title: string; url: string; snippet?: string };

/** Crude but predictable conversion of HTML into readable text. */
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

/** One-line snippet: in the result list line breaks only confuse. */
function snippet(text: string): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed.length > SNIPPET_LIMIT ? `${squashed.slice(0, SNIPPET_LIMIT - 1)}…` : squashed;
}

/**
 * Parses the Tavily response.
 * @param payload - parsed body of the /search response.
 * @param limit - how many results to return.
 * @returns results; an empty array if the body is of the wrong shape.
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

/** Reason for a network failure: under the "fetch failed" message, fetch hides the real error. */
function networkErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error && cause.message && cause.message !== error.message ? `: ${cause.message}` : "";
  return `${error.message}${detail}`;
}

/** HTTP failure: status plus the service error text, if there is one. */
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
    // the body may not be JSON — then the status alone is enough
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
        // Key in the header, not in the body: the request body settles into logs more readily.
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

/** Response of the service router: { results: [{ title, url, snippet }] }. */
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

/** Who actually answered and who had to be skipped — from the service response. */
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

/** What the search returned: text for the model and, if known, who answered. */
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

/** Response of the service /fetch: page text plus who read it. */
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
      // Through the service — when it exists: it has its own extraction router (Exa, Tavily,
      // Linkup, You.com), its own quarantines and a separate "current" one. Without the service,
      // the previous direct trip from the container remains.
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
