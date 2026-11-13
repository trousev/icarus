// Shared types of the search router: one result, one provider, one failure.
//
// The router doesn't know about specific APIs: each provider is a function "request →
// results" and a list of variable names holding its key. Everything else (bans,
// rating, current provider) lives in state.ts and router.ts.
export type SearchResult = { title: string; url: string; snippet?: string };

/**
 * All providers the router knows. The search rating is defined separately
 * (router.ts): cloudflare can only fetch pages and doesn't take part in search.
 */
export const PROVIDER_IDS = [
  'serpapi',
  'serpstack',
  'brave',
  'exa',
  'tavily',
  'firecrawl',
  'you',
  'you-free',
  'linkup',
  'cloudflare',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Search providers: all except cloudflare — it can only fetch pages. */
export type SearchProviderId = Exclude<ProviderId, 'cloudflare'>;

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Why the provider dropped out. The quarantine length depends on this:
 *  - credits — credits/quota ran out, one day;
 *  - rate — rate exceeded, five minutes;
 *  - page — the page wasn't served (404, robots, paywall): this is a property of the URL, not
 *    the health of the key, so we don't ban the provider for it;
 *  - http/network/timeout — a normal failure, five minutes.
 */
export type FailureKind = 'credits' | 'rate' | 'page' | 'http' | 'network' | 'timeout';

export class SearchFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  /** Response body or error text: the panel shows it to the person in full. */
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
 * What counts as "credits ran out".
 *
 * 402 and 432 (Tavily's non-standard code) — always money. 403 and 429 mentioning
 * credits, balance or plan — too: providers send them however they fancy.
 * A bare 429 without such words is rate, not money, and we can't ban for a day.
 */
const CREDIT_HINTS = /\bcredits?\b|\bquota\b|insufficient|out of credits|no credits|run out|out of searches|exhausted|billing|payment required|plan limit|usage limit|\bbalance\b/i;

export function classifyFailure(status: number, body: string): FailureKind {
  // 402/432 — money by the standard and at Tavily; 433 — its "pay-as-you-go limit".
  if (status === 402 || status === 432 || status === 433) return 'credits';
  // Some send "searches ran out" under 401/403 — that's not a dead key, but money.
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
  /** What the provider is called in the panel. */
  label: string;
  /** Environment variables searched for the key (the first non-empty one wins). */
  keyNames: string[];
  /** No key needed: the provider is always available (free You.com MCP). */
  keyless?: boolean;
  /**
   * Who does the same thing without a key. Using this field the panel says "there's no key,
   * and none is needed" rather than "no key" — for You.com that's exactly the case.
   */
  keylessTwin?: ProviderId;
  /**
   * When the quota returns after "credits ran out". For daily limits — the
   * next midnight: a full 24 hours would keep the provider out longer than needed.
   */
  creditsResetAt?: (now: number) => number;
  search(query: string, limit: number, ctx: ProviderContext): Promise<SearchResult[]>;
};

/** Page pulled by the provider: the text is already truncated to maxChars. */
export type FetchResult = { url: string; title?: string; text: string };

export type FetchContext = ProviderContext & {
  maxChars: number;
  /** Access to any secret: Cloudflare needs both account and token. */
  secret: (name: string) => string;
};

export type FetchProvider = {
  id: ProviderId;
  label: string;
  keyNames: string[];
  /** Secrets without which the provider isn't ready (all are checked). */
  requires?: string[];
  fetch(url: string, ctx: FetchContext): Promise<FetchResult>;
};
