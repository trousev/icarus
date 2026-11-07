// Общие типы поискового роутера: один результат, один провайдер, один отказ.
//
// Роутер не знает про конкретные API: каждый провайдер — это функция «запрос →
// результаты» и список имён переменных, где лежит его ключ. Всё остальное (баны,
// рейтинг, текущий провайдер) живёт в state.ts и router.ts.
export type SearchResult = { title: string; url: string; snippet?: string };

/** Порядок в этом списке — он же рейтинг: первый доступный становится текущим. */
export const PROVIDER_IDS = [
  'serpapi',
  'serpstack',
  'brave',
  'exa',
  'tavily',
  'firecrawl',
  'you',
  'linkup',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Почему провайдер отвалился. От этого зависит длина карантина:
 *  - credits — кончились кредиты/квота, сутки;
 *  - rate — превышен темп, пять минут;
 *  - page — страница не отдалась (404, robots, пейволл): это свойство URL, а не
 *    здоровье ключа, поэтому провайдера за такое не баним;
 *  - http/network/timeout — обычный сбой, пять минут.
 */
export type FailureKind = 'credits' | 'rate' | 'page' | 'http' | 'network' | 'timeout';

export class SearchFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  /** Тело ответа или текст ошибки: панель показывает его человеку целиком. */
  readonly body: string;

  constructor(kind: FailureKind, message: string, details: { status?: number; body?: string } = {}) {
    super(message);
    this.name = 'SearchFailure';
    this.kind = kind;
    this.status = details.status ?? null;
    this.body = details.body ?? '';
  }
}

/**
 * Что считать «кончились кредиты».
 *
 * 402 и 432 (нестандартный код Tavily) — всегда деньги. 403 и 429 с упоминанием
 * кредитов, баланса или плана — тоже: провайдеры шлют их, кто во что горазд.
 * Голый 429 без таких слов — это темп, а не деньги, и банить на сутки нельзя.
 */
const CREDIT_HINTS = /\bcredits?\b|\bquota\b|insufficient|out of credits|no credits|run out|out of searches|exhausted|billing|payment required|plan limit|usage limit|\bbalance\b/i;

export function classifyFailure(status: number, body: string): FailureKind {
  if (status === 402 || status === 432) return 'credits';
  // Кто-то шлёт «кончились поиски» под 401/403 — это не мёртвый ключ, а деньги.
  if ((status === 401 || status === 403 || status === 429) && CREDIT_HINTS.test(body)) return 'credits';
  if (status === 429) return 'rate';
  return 'http';
}

export type ProviderContext = {
  key: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
};

export type SearchProvider = {
  id: ProviderId;
  /** Как провайдер называется в панели. */
  label: string;
  /** Переменные окружения, в которых ищется ключ (первая непустая побеждает). */
  keyNames: string[];
  search(query: string, limit: number, ctx: ProviderContext): Promise<SearchResult[]>;
};

/** Страница, вытащенная провайдером: текст уже обрезан по maxChars. */
export type FetchResult = { url: string; title?: string; text: string };

export type FetchContext = ProviderContext & { maxChars: number };

export type FetchProvider = {
  id: ProviderId;
  label: string;
  keyNames: string[];
  fetch(url: string, ctx: FetchContext): Promise<FetchResult>;
};
