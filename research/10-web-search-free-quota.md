# Web search providers with a free quota — research for the search "proxy"

**Date checked:** 7 November 2026. All figures are from official pricing/documentation pages (links at the end).
Where a source is secondary (reviews, benchmarks, Reddit) — that is marked. Where the data is contradictory — marked explicitly.

**Why:** Tavily credits ran out. Need a router that holds the keys of different services, knows who
still has a free quota, and switches to the live one.

---

## 0. TL;DR

1. **You can muster ~11,400 free searches a month without a card.** With a card (Brave + Parallel) — **~17,400**.
   Plus one-time "signup packages" for another ~4,700–5,200 searches.
2. **Far from everyone exposes the quota via the API.** A clean remaining-credits endpoint is available at Tavily, Linkup, Firecrawl,
   SerpApi, SearchApi, Zenserp, ScrapingDog, ScrapingBee, ValueSERP, Parallel, Serper (indirectly), You.com (with a key).
   Brave — only the `X-RateLimit-Remaining` headers in each response. Exa — partially (Team Management API).
   Jina, Google CSE, Marginalia, Serpstack — not at all, only a dashboard/local counter.
3. **The two "obvious" options are gone:** Google Custom Search JSON API **is closed to new clients**
   (works until 01.01.2027), Bing Search API **was turned off on 11.08.2025**. You can't build a proxy on them.
4. **Free You.com lives only over MCP — and that doesn't get in the way.** The MCP server is a regular
   JSON-RPC over HTTP, with no authorization in the free profile; verified with curl. For search it
   works as a regular provider (in the router it's `you-free`), for reading pages it doesn't
   (see §1a).
5. **The best proxy "skeleton":** a local ledger (a counter per key) as the source of truth +
   periodic reconciliation with `/usage` endpoints + automatic key write-off on HTTP 402/429.
   You can't rely only on remote endpoints — half the providers don't have them.

---

## 1. AI search engines (index + snippets, not Google scraping)

| Provider | Free quota | Reset | Card | Search-quality reviews | Remaining quota via API |
|---|---|---|---|---|---|
| **Tavily** | 1,000 credits/mo (Researcher plan). basic = 1 credit, advanced = 2 | 1st of the month | No | AIMultiple 2026: Agent Score **13.67** — the lower edge of the top group, Brave noticeably higher. The most common in tutorials/RAG; complaints are mostly about price, not quality | ✅ `GET https://api.tavily.com/usage` → `key.usage`, `key.limit`, `account.plan_usage`, `account.plan_limit` |
| **Brave Search** | **$5 credits/mo** ≈ 1,000 requests ($5/1k) | Monthly, automatically | **Yes** (FAQ: "to prevent abuse") | AIMultiple: **#1, 14.89**, latency 669 ms — the best result and the fastest. On HN they praise the overall web coverage, but note weakness on narrow/financial queries | ⚠️ Only the headers of each response: `X-RateLimit-Remaining`, `-Limit`, `-Reset`, `-Policy` (the second number is the monthly quota) |
| **Exa** | **$10 credits/mo** (lite ≈ 2,500 searches) + a one-time $10 onboarding bonus | 1st of the month, no carryover | No | AIMultiple: **14.39**, in the statistical top. Strong in entity/people and technical documentation, weaker in "fresh news" (HN) | 🟡 `GET https://admin-api.exa.ai/team-management/api-keys/{id}/usage` — needs a service key, enabled per-team; otherwise only the dashboard. When exhausted — `402` |
| **Linkup** | **$20 credits/mo** (standard $0.005 ⇒ ≈ 4,000 searches); credited to a professional email | Monthly top-up of up to $20 | Not stated, a "professional email" is required | Almost no independent benchmarks; its own benchmark (marketing) claims victory on complex queries. Considered a "cheap Tavily analog" | ✅ `GET https://api.linkup.so/v1/credits/balance` → `{"balance": N}` |
| **Firecrawl Search** | 1,000 credits/mo; search = 2 credits / 10 results ⇒ **500 searches** | Monthly, no carryover | No | AIMultiple: **14.58**, #2; strongest where you need the full page content, not links | ✅ `GET https://api.firecrawl.dev/v2/team/credit-usage` → `remainingCredits`, `planCredits`, period dates |
| **You.com** | **100 requests/day without a key or account** via MCP (`https://api.you.com/mcp?profile=free`) ⇒ ~3,000/mo. Only the `you-search` and `you-discover` tools | Daily | No | Little independent data; one small test (n=20) gave 90% recall — an unserious sample | 🟡 With a key: `GET https://api.you.com/v1/billing/account_balance`. The free keyless profile has no remaining-credits info — only a local counter and `result.isError` in the MCP response (not 429, see §1a) |
| **Parallel** | $5 credits/mo (≈ 5,000 `fast` requests) + up to $80 at signup. Developer plan | Monthly, no carryover | **Yes** | AIMultiple: **14.21** (Pro), but very slow — 13.6 s on average | ✅ Account API: balance/usage (`/service-api/balance/get-balance`, Usage API) |
| **Valyu** | $10 one-time ($20 to a corporate email), no card. Web search 0.1 credit/result ⇒ ≈ 1,000 searches of 10 results | One-time, lives 12 months | No | Couldn't find any public independent quality reviews | ❌ No public endpoint, only the dashboard/spend cap |
| **Jina AI** | 10M tokens per new key (≈ 1,000 searches, a search costs from 10,000 tokens) | **Does not renew** | No | Positioned as a cheap utility (Reader is strong), search doesn't participate in independent ratings | ❌ No public endpoint, only the dashboard |
| **Search1API** | 100 credits at signup | One-time | No | Reselling other engines (metasearch), no index of its own; few reviews | ✅ `GET https://api.search1api.com/usage` → `usage` = remaining credits |

### 1a. You.com free MCP as a regular API — verified on a live server (2026-11-07)

"Only over MCP" is not "not an API": an MCP server speaks JSON-RPC over HTTP (streamable HTTP),
and from the router it's called with the same single POST as REST. Verified with curl, without a single
authorization header:

| Step | What the server answered |
|---|---|
| `initialize` | 200, `serverInfo: {name: "You.com", version: "4.0.7"}`, `Mcp-Session-Id` is **not** issued |
| `tools/call` without `initialize` and without a session | works — the server is stateless |
| `tools/list` | exactly two tools: `you-search` and `you-discover` |
| `tools/call you-search {query, count}` | works, returns `results.web[]` with `description` and `contents.highlights` |
| `tools/call you-contents` | `-32602 "Tool you-contents not found"` — it's not in the free profile |
| `you-search` with `extraction: "full_page"` | `result.isError: true`, "Free tier limit exceeded" — the full page text isn't included in the free profile |

Response shape: SSE frames `event: message` + `data: {...}`. Before the result come
service `notifications/message` ("Search successful…"), so the response must be found by
`id`, not taken from the first frame. The result itself is `content[0].text`, and inside is **a JSON
string of exactly the same shape as REST `/v1/search`** (`{results: {web, news, knowledge}}`), that
is, the output parser is reused as is.

The main trap: **an exhausted quota doesn't come as 429 or 402**, but as `200 OK` with
`result.isError: true` and the text "Free tier limit exceeded. Please upgrade" — without
`Retry-After` and without `X-RateLimit-*`. If this isn't distinguished, the router will record the refusal as
an ordinary failure (5 minutes) or, worse, mistake it for an empty result. In the code this is a separate classification
branch: `credits`, and quarantine — until the next UTC midnight, not a full day
(the quota is daily, after all).

Separately, `you-discover` searches for agents/skills, not pages — a search engine doesn't need it.

**Bottom line: for search — yes, for fetch — no.** In the router this is the `you-free` provider:
enabled by default (search works on an empty `.env`), disabled by
`ICARUS_SEARCH_FREE=off`; it's not suitable for `web_fetch` — there you need a key and a real
`/v1/contents`.

---

## 2. Google-SERP scrapers (essentially proxies to Google results)

The result quality = Google (which is both a plus and a legal risk: scraping violates Google's ToS).
The free quotas at most of them are **one-time welcome**, not monthly.

| Provider | Free quota | Reset | Card | Search-quality reviews | Remaining quota via API |
|---|---|---|---|---|---|
| **Serper.dev** | 2,500 requests at signup | **One-time** (top-up model, credits live 6 months) | No | Praised for speed (1–2 s) and price ($0.30–1.00/1k). Trustpilot 3.1/5 — complaints about billing/support, not results. On Reddit — "cheap until you start counting credits" | ✅ `GET https://google.serper.dev/account` — returns remaining credits (confirmed indirectly: a third-party gateway writes that the endpoint "reports remaining credit" and therefore isn't proxied) |
| **SerpApi** | 250 searches/mo, 50/hour | Monthly | Not stated | Mature, the widest coverage of verticals, U.S. Legal Shield. Expensive ($25/1k). Complaints — about price, not quality | ✅ `GET https://serpapi.com/account?api_key=KEY` → `plan_searches_left`, `total_searches_left`, `this_month_usage`, `plan_renewal_date` |
| **SearchApi.io** | 100 requests | **Period not stated** — possibly one-time | No | Middling reviews: cheaper than SerpApi, but fewer verticals; there are complaints about support | ✅ `GET https://www.searchapi.io/api/v1/me?api_key=KEY` → `remaining_credits`, `monthly_allowance`, `current_month_usage` |
| **Zenserp** | 50 searches/mo, "free forever" | Monthly | Not stated | Few fresh reviews; niche, stable, but expensive on paid plans | ✅ `GET https://app.zenserp.com/api/v2/status` (header `apikey`) → `{"remaining_requests": N}` |
| **Serpstack** | 100 searches/mo, **non-commercial only**, JSON | Monthly | Probably yes: the free signup form has card fields (unconfirmed) | Part of APILayer; few reviews, perceived as a "budget Google SERP" | ❌ Didn't find a public endpoint |
| **ValueSERP** | No free plan, only a trial (amount not stated) | Trial | Not stated | Normal reviews in SEO circles, but not free to start | ✅ `GET https://api.valueserp.com/account?api_key=KEY` → `monthly_credits_remaining`, `monthly_credits_reset_at` |
| **ScrapingDog** | 100 credits (on the pricing page) **or** 200 requests/mo (in the docs) — a contradiction | Contradictory | No | Cheap, but Google search costs 5–10 credits, i.e. "100 credits" is ~10–20 searches | ✅ `GET https://api.scrapingdog.com/account?api_key=KEY` → `remainingApiCredits` |
| **ScrapingBee** | 1,000 credits (trial) | One-time | No | Good as a scraper, search is a side feature; a lot of credits go into search | ✅ `GET https://app.scrapingbee.com/api/v1/usage` (Bearer), no more than 6 times/min |

---

## 3. Big tech and open options

| Provider | Free quota | Reset | Card | Search-quality reviews | Remaining quota via API |
|---|---|---|---|---|---|
| **Google Custom Search JSON API** | 100 requests/day | Daily | A billing account is required for >100/day | Google quality, but the **API is closed to new clients**; existing ones work until **01.01.2027** | ❌ Only Cloud Console / Cloud Monitoring |
| **Bing Web Search API** | — | — | — | **Turned off on 11.08.2025** ([Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)). The replacement — Azure "Grounding with Bing Search" inside AI Agents, no separate free-tier search | — |
| **Mojeek** | No free plan; a one-time trial credit on the Startup plan, **a card is required** | — | Yes | Its own independent index, small; praised for privacy/EU compliance, not completeness | ❌ Not confirmed |
| **Marginalia** | A free key for **non-commercial** by email; the `public` key — with a shared rate limit | Not explicitly limited | No | Searches the "old, non-technical, non-commercial" web — not suitable for general queries | ❌ No |
| **SearXNG** (self-host) | No quota, your own instance | — | No | Quality = the sum of upstream engines; often hits captchas/403 (the experience is already described in this repo) | 🟡 Local: your own metrics/logs, but not a "provider quota" |
| **DuckDuckGo** | No official API; HTML/lite breaks and returns a captcha | — | No | Unreliable as a source for an agent (confirmed by the project's experience) | ❌ |
| **AskNews** | 25 credits one-time + $5 to the wallet | One-time | No | **Only news on the free plan**: `/websearch` is available only on paid Spelunker+; free credits are spent on `/news`, `/wiki`, `/reddit` | ⚠️ The `X-RateLimit-Remaining` header (in requests, not in credits) |
| **Yandex Search API** | Paid, trial on request | — | Yes | Strong Russian results; weaker for English-language tasks | 🟡 Depends on the plan |
| **GDELT** | Free, no key | — | No | News/events only, not web search. In practice returns `429` without warning | ❌ |
| **Wikipedia / Wikimedia API** | Free | — | No | Encyclopedia only; an excellent free fallback for facts | ❌ |

---

## 4. How much you get in total for free

**Monthly, without a card (a sustainable minimum):**

| Provider | Searches/mo |
|---|---|
| Linkup ($20 / $0.005) | 4,000 |
| You.com (100/day) | 3,000 |
| Exa ($10 / $4 per 1k, lite) | 2,500 |
| Tavily | 1,000 |
| Firecrawl (1,000 credits / 2) | 500 |
| SerpApi | 250 |
| Serpstack (non-commercial) | 100 |
| Zenserp | 50 |
| **Total** | **~11,400** |

**With a card, these are added:** Brave 1,000 + Parallel 5,000 = **~17,400/mo**.
**One-time "signup packages":** Serper 2,500 + Valyu ~1,000 + Jina ~1,000 + Search1API 100 +
ScrapingDog ~100 (+ ScrapingBee trial) ≈ **4,700–5,200** at the start.

> Important: this is an "ideal case" estimate. In reality, some of the quota will go to retries, some providers cut the rate limit
> (Firecrawl — 10 requests/min, Exa — 10 QPS, Brave — 1–50 rps depending on the plan).

---

## 5. Column #4 up close: who can actually say "how much is left"

**A clean REST balance endpoint (can be polled before every request or once every N minutes):**

| Provider | Endpoint | What it returns |
|---|---|---|
| Tavily | `GET /usage` | key + account spend and limit |
| Linkup | `GET /v1/credits/balance` | `balance` |
| Firecrawl | `GET /v2/team/credit-usage` | `remainingCredits`, `planCredits` |
| SerpApi | `GET /account` | `plan_searches_left`, `total_searches_left` |
| SearchApi | `GET /api/v1/me` | `remaining_credits`, `monthly_allowance` |
| Zenserp | `GET /api/v2/status` | `remaining_requests` |
| ScrapingDog | `GET /account` | `remainingApiCredits` |
| ScrapingBee | `GET /api/v1/usage` | spend |
| ValueSERP | `GET /account` | `monthly_credits_remaining` |
| Serper | `GET /account` | remaining credits |
| Parallel | Account API | balance/usage |
| Search1API | `GET /usage` | `usage` = remaining credits |
| You.com (with a key) | `GET /v1/billing/account_balance` | balance in cents |

**Response headers only:** Brave (`X-RateLimit-Remaining` — the second number is monthly, `-Reset` — seconds until reset).

**Partially:** Exa (Team Management API, needs a service key and per-team enablement).

**Not at all (only a dashboard/local counter):** Jina, Google CSE, Marginalia, Serpstack, Mojeek,
free You.com MCP (without a key), SearXNG (its own logs), DDG.

---

## 6. What this means for the proxy (architectural conclusions)

1. **The source of truth is the local ledger, not the provider's API.** Half the providers have no endpoint,
   and some of those that do lie/lag. Schema: `{provider, key_id, period_start, used, limit, exhausted_until, last_error}`,
   the write — atomic (a file lock or SQLite), otherwise parallel requests will double-spend the quota.
2. **Three levels of quota knowledge:**
   - `probe()` — if there's an endpoint (Tavily/Linkup/Firecrawl/SerpApi/…), reconcile at startup and once every 10–30 min;
   - `headers()` — Brave: parse `X-RateLimit-Remaining`/`-Reset` from each response;
   - `local counter` — everyone else: increment on a successful request, reset by the provider's calendar
     (1st of the month / UTC days / never for one-time).
3. **Error classification is half of all the logic:**
   - `401/403` → the key is dead, disable it until manual intervention;
   - `402` (Exa/Valyu), `432`/`429` with text about credits (Tavily) → the quota ran out, `exhausted_until = reset`;
   - `429` without "credits ran out" → just a rate limit, cooldown by `Retry-After`, don't write off the key;
   - `5xx`/timeout → degradation, 3 strikes → temporarily remove from rotation.
4. **Selection order:** first the free ones with a remaining balance, inside — by quality (Brave/Exa/Linkup/Tavily),
   on a tie — round-robin, so as not to burn out one key. Paid (pay-as-you-go) — only last
   or by an explicit flag.
5. **Cache — the cheapest "provider".** Query normalization + TTL 1 h (news) / 24 h (facts) removes
   30–40% of calls, and that's half the quota problem.
6. **Don't spin up accounts to bypass limits.** Multiple keys of *different* providers is legal and that's the whole point.
   Multiple accounts of one provider is a ToS violation, and it gets caught by fingerprint/payments.
7. **Be careful with "free" licenses:** Serpstack — non-commercial only, Jina — CC-BY-NC, Marginalia — non-commercial,
   Google-SERP scrapers — violate Google's ToS (for an internal agent the risk is lower, for a product — higher).
8. **Don't build on Google CSE** (closed to new clients, EOL 01.01.2027) or **Bing Search API** (turned off on 11.08.2025).
9. **MCP is just as much an API if the server is stateless.** Free You.com is worth keeping in the pool
   as a regular provider: no key, no registration, 100 searches a day. But it reports the quota
   only through a tool refusal, and it can't read pages — it's a search-only
   provider.

### The minimal set for the first version

`Tavily + Exa + Linkup + Brave + You.com` — that's ~11,500 searches/mo, everyone except You.com has a
normal way to find out the remaining balance, and everyone except Brave doesn't require a card.
`Serper` (2,500 one-time) — as a burst pool at the start. `Firecrawl` — if you need the full page text,
not just snippets.

---

## 7. Sources (primary, checked 2026-11-07)

- Tavily: <https://docs.tavily.com/documentation/api-credits> · <https://docs.tavily.com/documentation/api-reference/endpoint/usage>
- Brave: <https://api-dashboard.search.brave.com/documentation/pricing> · <https://api-dashboard.search.brave.com/documentation/quickstart> · <https://api-dashboard.search.brave.com/documentation/guides/rate-limiting>
- Exa: <https://exa.ai/docs/admin/pricing.md> · <https://exa.ai/docs/admin/billing.md> · <https://exa.ai/docs/reference/team-management/get-api-key-usage>
- Linkup: <https://docs.linkup.so/pages/documentation/platform/pricing.md> · <https://docs.linkup.so/pages/documentation/endpoints/account/balance>
- Firecrawl: <https://www.firecrawl.dev/pricing.md> · <https://docs.firecrawl.dev/api-reference/v1-endpoint/credit-usage>
- You.com: <https://you.com/docs/agents/mcp-server.md> · <https://you.com/docs/administration/billing>
- Parallel: <https://parallel.ai/pricing> · <https://docs.parallel.ai/getting-started/pricing.md>
- Valyu: <https://docs.valyu.ai/pricing.md>
- Jina: <https://jina.ai/api-dashboard/> (token limits — secondary source <https://agentdeals.dev/vendor/jina-ai>)
- Serper: <https://serper.dev/> · <https://docs.nativeport.ai/serper.md> (mention of `/account`)
- SerpApi: <https://serpapi.com/pricing> · <https://serpapi.com/account-api>
- SearchApi: <https://www.searchapi.io/pricing> · <https://www.searchapi.io/docs/account-api>
- Zenserp: <https://zenserp.com/pricing-plans/>
- Serpstack: <https://serpstack.com/pricing>
- ValueSERP: <https://docs.trajectdata.com/valueserp/account-api>
- ScrapingDog: <https://www.scrapingdog.com/pricing/>
- ScrapingBee: <https://www.scrapingbee.com/pricing/>
- Google CSE: <https://developers.google.com/custom-search/v1/overview>
- Bing: <https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement> (date 11.08.2025) + <https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview>
- Search1API: <https://www.search1api.com/pricing>
- AskNews: <https://docs.asknews.app/en/rate-limiting>
- Mojeek: <https://www.mojeek.com/services/search/web-search-api/>
- Marginalia: <https://about.marginalia-search.com/article/api/>

**Secondary (quality):**
- AIMultiple, Agentic Search Benchmark, 8 APIs, 100 queries, LLM judge (updated 13.05.2026): <https://aimultiple.com/agentic-search>
- HN discussion about the strengths/weaknesses of Brave and Exa: <https://news.ycombinator.com/item?id=49470750>
- Trustpilot Serper (3.1/5): <https://uk.trustpilot.com/review/serper.dev>
- Serper pricing overview (checked 05.07.2026): <https://coldiq.com/blog/serper-pricing>
