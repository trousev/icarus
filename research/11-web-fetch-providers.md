# Web fetch / extract at our providers — who can do it and at what price

**Date checked:** 7 November 2026. Primary sources only (docs and pricing), links at the bottom.
This is about «дай URL — верни содержимое страницы» [“give a URL — return the page content”], not about search.

## Short answer

**Six out of eight** can do it: Firecrawl, Tavily, Exa, Linkup, You.com and — unexpectedly —
**SerpApi** (Extract API, released in October 2026). **Brave and Serpstack can't**: Brave has
only search/LLM Context/Answers, Serpstack only Google results.

## Table

| Provider | Fetch? | How to call | What it returns | Price per page | Pages from the free quota |
|---|---|---|---|---|---|
| **Firecrawl** | ✅ | `POST /v1/scrape` `{url, formats:["markdown"], onlyMainContent:true}` | `data.markdown` (+ html/links) | 1 credit | **1,000/mo** (the whole quota, if you don't search) |
| **Tavily** | ✅ | `POST /extract` `{urls:[url], format:"markdown", extract_depth:"basic"}` | `results[].raw_content`, `failed_results[]` | 0.2 credit (1 per 5 pages; advanced — 0.4) | **5,000/mo** basic (2,500 advanced) |
| **Exa** | ✅ | `POST /contents` `{ids:[url], text:{maxCharacters:20000}}` | `results[].text` + `statuses[]` | $0.001 | **10,000/mo** |
| **Linkup** | ✅ | `POST /v1/fetch` `{url, renderJs?:false, mode:"standard"}` | `markdown` (+ favicon, images, schema) | $0.001 ($0.005 with JS, $0.005 pro, $0.01 pro+JS) | **20,000/mo** standard |
| **You.com** | ✅ | `POST /contents` `{urls:[url], formats:["markdown"]}` | array `[{url,title,markdown,html,metadata}]` | $0.001 | signup credits (the amount isn't fixed in the docs) |
| **SerpApi** | ✅ | `GET /search.json?engine=extract&url=...&output=md` | a markdown string; in JSON also `page_information`, `meta_tags`, `inline_links` | 1 credit | **250/mo, and these are the same credits as search** |
| **Brave** | ❌ | — | — | — | — |
| **Serpstack** | ❌ | — | — | — | — |

**Free You.com MCP is not suitable for fetch** (verified live 2026-11-07): in
`profile=free` only `you-search` and `you-discover` are available, a call to `you-contents`
answers `-32602 "Tool you-contents not found"`, and `you-search` with `extraction:
"full_page"` — `result.isError: "Free tier limit exceeded"`. So "100 requests/day
without a key" — that's search only; pages are paid for by a key (`/v1/contents`, $0.001).

## Nuances that matter more than the price

**The quotas are shared with search at all six.** There isn't a single provider whose fetch runs
on a separate balance: Tavily/Exa/Firecrawl/Linkup/You.com spend the same credit pool as
search, and SerpApi — the same 250 credits. So an active fetch provider will eat into the search quota
if it's the same service.

**SerpApi honors robots.txt** and simply won't return a page that the site has closed to
crawlers (`User-agent: *`). Plus it has 50 requests/hour on the free plan and only 250
credits a month for everything. For fetch this is the worst option, despite the neat markdown.

**JS and "complex" pages:**
- Firecrawl — the best against anti-bot and JS, but the slowest and the most expensive in credits
  (1 page = 1 credit; on free there's also 10 requests/min);
- Exa — can do JS and PDF, but by default returns a **cache**; freshness is set by `maxAgeHours`
  (`0` — always fetch again, `-1` — cache only);
- Tavily basic may not see the dynamic bits; `advanced` picks up tables and embedded content, but is twice
  as expensive and slower; failed URLs come in `failed_results` with HTTP 200;
- Linkup **without JS by default** (`renderJs:false`); `mode:"pro"` noticeably raises the chances
  on heavy sites, but costs $0.005;
- You.com returns a cache with `max_age`, a 10 s timeout by default, and supports batch.

**Page errors ≠ provider breakage.** 404, closed robots.txt, a paywall, "PDF too
large" — these are properties of a specific URL, not the health of the key. You can't ban a provider for them,
otherwise one bad URL will disable the entire fetch for 5 minutes.

**SSRF.** All six fetch the page **on their side**, not from our host, so the internal network is
unreachable to them. But the `http(s)` validation and the prohibition of `localhost`/private addresses are still needed:
it's cheaper than explaining to the provider why we're asking for `http://192.168.1.1`.

**A cache on our side is more profitable than on the provider's side.** Re-fetching the same URL
costs the same money. A TTL cache (say, 1 hour) on `/fetch` saves noticeably more than
rearranging providers.

## Who's "better" for fetch

Two different axes, and they don't coincide:

- **by quality on heavy pages:** Firecrawl → Exa → Tavily (advanced) → Linkup (pro) → You.com → SerpApi;
- **by quota savings:** Linkup (20k pages) → Exa (10k) → Tavily (5k) → Firecrawl (1k) → You.com (?) → SerpApi (250, and shared with search at that).

A reasonable starting ranking for `fetch`, if you want both quality and quota:

```
exa → tavily → firecrawl → linkup → you → serpapi
```

Exa first: 10k pages, JS/PDF and decent quality; Firecrawl — as the "heavy artillery"
for pages the others gave up on; SerpApi — last (or not enabled at all,
so as not to eat up 250 search credits).

## What this means for the router

1. `current` is needed **separately for each capability**: `current.search` and `current.fetch`
   (as you said — they can diverge).
2. The rankings are different too: Brave and Serpstack drop out of the fetch ranking, SerpApi goes
   from the top of search to the bottom of the fetch ranking.
3. Bans should be split by capability: 402/429 "credits ran out" — a shared ban (the balance is
   one), while 5xx/timeout/refusal on a specific page — a ban only on the fetch capability.
4. The `/fetch` response should be small and predictable: `{url, finalUrl?, title?, markdown,
   provider, tried, truncated}`. We trim the text (as now, 20,000 characters), otherwise the model will
   choke.
5. A URL → text cache with a TTL is a mandatory part, otherwise fetch will be the most expensive route.

## Sources

- Tavily Extract: <https://docs.tavily.com/documentation/api-reference/endpoint/extract> · credits: <https://docs.tavily.com/documentation/api-credits>
- Exa Contents: <https://exa.ai/docs/contents/quickstart> · prices: <https://exa.ai/docs/admin/pricing>
- Firecrawl Scrape: <https://docs.firecrawl.dev/api-reference/v1-endpoint/scrape> · prices: <https://www.firecrawl.dev/pricing>
- Linkup Fetch: <https://docs.linkup.so/pages/documentation/endpoints/fetch/reference> · prices: <https://docs.linkup.so/pages/documentation/platform/pricing>
- You.com Contents: <https://you.com/docs/api-reference/contents> · billing: <https://you.com/docs/administration/billing>
- SerpApi Extract: <https://serpapi.com/extract-api> · announcement (13.10.2026): <https://serpapi.com/blog/introducing-extract-api/> · SDK docs: <https://github.com/serpapi/serpapi-python/blob/master/docs/user_guide/extract.md>
- Brave (search only): <https://api-dashboard.search.brave.com/documentation>
- Serpstack (search only): <https://serpstack.com/pricing>
