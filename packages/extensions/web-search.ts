// Веб-поиск и чтение страниц как инструменты Икара.
//
// Провайдер выбирается переменной ICARUS_SEARCH_PROVIDER:
//   deepseek (по умолчанию) | brave (BRAVE_API_KEY) | searxng (ICARUS_SEARXNG_URL) | none
// deepseek — родной веб-поиск DeepSeek: Anthropic-совместимый Messages API с серверным тулом
// web_search. Отдельного ключа не нужно: годится тот же DEEPSEEK_API_KEY, что у моделей, — но
// эндпоинт другой, поэтому и переменная базы своя (ICARUS_SEARCH_BASE_URL).
// Скрейпинг поисковиков выброшен: DuckDuckGo отдаёт ботам 403 и страницу-заглушку, а страница
// без результатов разбиралась в пустую выдачу — «Ничего не нашлось» вместо причины отказа.
// Чтение страниц работает всегда и превращает HTML в текст без внешних зависимостей.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = (process.env.ICARUS_SEARCH_PROVIDER ?? "deepseek").toLowerCase();
const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
const SEARXNG_URL = process.env.ICARUS_SEARXNG_URL ?? "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
/** База Messages API (не chat-completions): «/messages» дописывается здесь. */
const DEEPSEEK_BASE_URL = process.env.ICARUS_SEARCH_BASE_URL ?? "https://api.deepseek.com/anthropic/v1";
const DEEPSEEK_MODEL = process.env.ICARUS_SEARCH_MODEL ?? "deepseek-v4-flash";
/** Сколько раз за один запрос модель может сходить в web_search: один поиск — один запрос. */
const DEEPSEEK_MAX_USES = Math.max(Math.trunc(Number(process.env.ICARUS_SEARCH_MAX_USES ?? 1)) || 1, 1);
/** Потолок ответа модели; платим только за фактические токены, потолок страхует от обрыва. */
const DEEPSEEK_MAX_TOKENS = 4096;
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

/** Блок контента Anthropic-совместимого ответа: нас интересуют только поисковые и текстовые. */
type MessagesBlock = {
  type?: string;
  content?: unknown;
  citations?: Array<{ url?: string; cited_text?: string }>;
};

/** Итог разбора ответа DeepSeek: либо результаты, либо причина, по которой поиска не было. */
export type DeepSeekOutcome = { results: SearchResult[]; error?: string };

/**
 * Достаёт блоки контента из тела ответа.
 * @param payload - разобранное тело Messages API.
 * @returns блоки контента; пустой массив, если тело не той формы.
 */
function contentBlocks(payload: unknown): MessagesBlock[] {
  const blocks = (payload as { content?: unknown } | null)?.content;
  return Array.isArray(blocks) ? (blocks as MessagesBlock[]) : [];
}

/**
 * Собирает выдержки из цитат: DeepSeek кладёт их в текстовые блоки, ключ — адрес страницы.
 * Сейчас поиск цитат не отдаёт, но формат их допускает, и терять их незачем.
 * @param blocks - блоки контента ответа.
 * @returns карта «адрес → выдержка» (первое вхождение побеждает).
 */
function citationSnippets(blocks: MessagesBlock[]): Map<string, string> {
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      const url = citation?.url;
      const cited = citation?.cited_text;
      if (typeof url === "string" && url && typeof cited === "string" && cited && !snippets.has(url)) {
        snippets.set(url, cited);
      }
    }
  }
  return snippets;
}

/**
 * Разбирает ответ DeepSeek на результаты поиска.
 * Пустая выдача здесь — честный ноль: отсутствие блока `web_search_tool_result` и ошибка
 * внутри него возвращаются отдельной причиной, чтобы агент не принимал отказ за пустоту.
 * @param payload - разобранное тело Messages API.
 * @param limit - сколько результатов отдать.
 * @returns результаты и, если поиск не состоялся, текст причины.
 */
export function parseDeepSeekSearch(payload: unknown, limit = 6): DeepSeekOutcome {
  const blocks = contentBlocks(payload);
  const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
  if (resultBlocks.length === 0) {
    return { results: [], error: "Поиск не удался: DeepSeek не вызвал web_search." };
  }

  const snippets = citationSnippets(blocks);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const block of resultBlocks) {
    // Удавшаяся попытка — массив результатов, отказ серверного тула — объект с error_code.
    if (!Array.isArray(block.content)) {
      const code = (block.content as { error_code?: unknown } | null)?.error_code;
      const suffix = typeof code === "string" && code ? ` (${code})` : "";
      return { results: [], error: `Поиск не удался: DeepSeek ответил ошибкой${suffix}.` };
    }
    for (const item of block.content as Array<{ type?: string; url?: string; title?: string }>) {
      if (item?.type !== "web_search_result") continue;
      const url = item.url;
      if (typeof url !== "string" || !url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : url,
        url,
        snippet: snippets.get(url),
      });
      if (results.length >= limit) return { results };
    }
  }

  return { results };
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

/** Отказ HTTP: статус плюс текст от DeepSeek, если он там есть. */
async function deepSeekHttpError(response: Response): Promise<string> {
  let message = `Поиск не удался: HTTP ${response.status}`;
  try {
    const parsed = (await response.json()) as { error?: string | { message?: string }; message?: string };
    const detail =
      typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.message ?? parsed?.message);
    if (detail) message += `: ${detail}`;
  } catch {
    // тело может быть не JSON — тогда хватит одного статуса
  }
  return message;
}

async function searchDeepSeek(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  if (!DEEPSEEK_KEY) return "Поиск не настроен: нет DEEPSEEK_API_KEY.";
  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": DEEPSEEK_KEY,
        authorization: `Bearer ${DEEPSEEK_KEY}`,
        "anthropic-version": "2023-06-01",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: DEEPSEEK_MAX_TOKENS,
        messages: [
          { role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: DEEPSEEK_MAX_USES }],
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return `Поиск не удался: ${networkErrorText(error)}`;
  }
  if (!response.ok) return deepSeekHttpError(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return "Поиск не удался: DeepSeek вернул неразбираемый ответ.";
  }
  const outcome = parseDeepSeekSearch(payload, limit);
  return outcome.error ?? format(outcome.results);
}

async function search(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  if (PROVIDER === "deepseek") return searchDeepSeek(query, limit, signal);

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

  return `Поиск не настроен: провайдер «${PROVIDER}» неизвестен — жду deepseek, brave, searxng или none.`;
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
        "Найти актуальную информацию в интернете. Возвращает несколько результатов со ссылками и, когда поиск их отдаёт, краткими выдержками.",
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
