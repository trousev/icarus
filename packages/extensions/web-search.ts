// Веб-поиск и чтение страниц как инструменты Икара.
//
// Провайдер выбирается переменной ICARUS_SEARCH_PROVIDER:
//   duckduckgo (по умолчанию, без ключа) | brave (BRAVE_API_KEY) | searxng (ICARUS_SEARXNG_URL) | none
// Чтение страниц работает всегда и превращает HTML в текст без внешних зависимостей.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = (process.env.ICARUS_SEARCH_PROVIDER ?? "duckduckgo").toLowerCase();
const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
const SEARXNG_URL = process.env.ICARUS_SEARXNG_URL ?? "";
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

/** Ссылки у DuckDuckGo завёрнуты в редирект — достаём настоящий адрес. */
export function decodeDuckDuckGoUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (!match) return href.startsWith("//") ? `https:${href}` : href;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return href;
  }
}

export function parseDuckDuckGo(html: string, limit = 6): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(htmlToText(snippetMatch[1]));
  }

  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = linkRe.exec(html)) !== null && results.length < limit) {
    const url = decodeDuckDuckGoUrl(match[1]);
    const title = htmlToText(match[2]);
    if (!url.startsWith("http") || !title) continue;
    results.push({ title, url, snippet: snippets[index] });
    index += 1;
  }
  return results;
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

async function search(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  if (PROVIDER === "brave") {
    if (!BRAVE_KEY) return "Поиск не настроен: нет BRAVE_API_KEY.";
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      { headers: { accept: "application/json", "x-subscription-token": BRAVE_KEY }, signal },
    );
    if (!response.ok) return `Поиск не удался: HTTP ${response.status}`;
    return format(parseBrave(await response.json(), limit));
  }

  if (PROVIDER === "searxng") {
    if (!SEARXNG_URL) return "Поиск не настроен: нет ICARUS_SEARXNG_URL.";
    const response = await fetch(
      `${SEARXNG_URL.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`,
      { headers: { accept: "application/json" }, signal },
    );
    if (!response.ok) return `Поиск не удался: HTTP ${response.status}`;
    return format(parseSearxng(await response.json(), limit));
  }

  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  });
  if (!response.ok) return `Поиск не удался: HTTP ${response.status}`;
  return format(parseDuckDuckGo(await response.text(), limit));
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

export default function (pi: ExtensionAPI) {
  if (PROVIDER !== "none") {
    pi.registerTool({
      name: "web_search",
      label: "Поиск в интернете",
      description:
        "Найти актуальную информацию в интернете. Возвращает несколько результатов со ссылками и краткими выдержками.",
      parameters: Type.Object({
        query: Type.String({ description: "Поисковый запрос" }),
        limit: Type.Optional(Type.Number({ description: "Сколько результатов вернуть (по умолчанию 5)" })),
      }),
      async execute(_toolCallId, params, signal) {
        const limit = Math.min(Math.max(Number(params.limit ?? 5), 1), 10);
        const text = await search(String(params.query), limit, signal);
        return { content: [{ type: "text", text }], details: { provider: PROVIDER } };
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
      const text = await fetchPage(String(params.url), signal);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
