# Провайдеры веб-поиска с бесплатной квотой — исследование под «прокси» поиска

**Дата проверки:** 7 ноября 2026. Все цифры — с официальных страниц тарифов/документации (ссылки в конце).
Где источник вторичный (обзоры, бенчмарки, Reddit) — это помечено. Где данные противоречивы — помечено явно.

**Зачем:** закончились кредиты Tavily. Нужен роутер, который держит ключи разных сервисов, знает, у кого
осталась бесплатная квота, и переключается на живого.

---

## 0. TL;DR

1. **Бесплатных поисков в месяц без карты можно набрать ~11 400.** С картой (Brave + Parallel) — **~17 400**.
   Плюс одноразовые «пакеты при регистрации» ещё на ~4 700–5 200 поисков.
2. **Квоту через API отдают далеко не все.** Чистый эндпоинт остатка есть у Tavily, Linkup, Firecrawl,
   SerpApi, SearchApi, Zenserp, ScrapingDog, ScrapingBee, ValueSERP, Parallel, Serper (косвенно), You.com (с ключом).
   У Brave — только заголовки `X-RateLimit-Remaining` в каждом ответе. У Exa — частично (Team Management API).
   У Jina, Google CSE, Marginalia, Serpstack — никак, только дашборд/локальный счётчик.
3. **Двух «очевидных» вариантов больше нет:** Google Custom Search JSON API **закрыт для новых клиентов**
   (работает до 01.01.2027), Bing Search API **выключен 11.08.2025**. Строить прокси на них нельзя.
4. **Лучший «скелет» прокси:** локальный ledger (счётчик по каждому ключу) как источник правды +
   периодическая сверка с `/usage`-эндпоинтами + автоматическое списание ключа по HTTP 402/429.
   Только на удалённые эндпоинты полагаться нельзя — половина провайдеров их не имеет.

---

## 1. AI-поисковики (индекс + выдержки, не скрейпинг Google)

| Провайдер | Бесплатная квота | Сброс | Карта | Отзывы о качестве поиска | Остаток квоты через API |
|---|---|---|---|---|---|
| **Tavily** | 1 000 кредитов/мес (план Researcher). basic = 1 кредит, advanced = 2 | 1-е число месяца | Нет | AIMultiple 2026: Agent Score **13.67** — нижняя граница топ-группы, Brave заметно выше. Самый распространённый в туториалах/RAG; жалобы в основном на цену, не на качество | ✅ `GET https://api.tavily.com/usage` → `key.usage`, `key.limit`, `account.plan_usage`, `account.plan_limit` |
| **Brave Search** | **$5 кредитов/мес** ≈ 1 000 запросов ($5/1k) | Ежемесячно, автоматически | **Да** (FAQ: «to prevent abuse») | AIMultiple: **#1, 14.89**, латентность 669 мс — лучший результат и самая быстрая. На HN хвалят общее веб-покрытие, но отмечают слабость на узких/финансовых запросах | ⚠️ Только заголовки каждого ответа: `X-RateLimit-Remaining`, `-Limit`, `-Reset`, `-Policy` (второе число — месячная квота) |
| **Exa** | **$10 кредитов/мес** (lite ≈ 2 500 поисков) + разовый бонус $10 за онбординг | 1-е число, без переноса | Нет | AIMultiple: **14.39**, в статистическом топе. Сильна в entity/people и технической документации, слабее в «свежих новостях» (HN) | 🟡 `GET https://admin-api.exa.ai/team-management/api-keys/{id}/usage` — нужен service key, включается per-team; иначе только дашборд. При исчерпании — `402` |
| **Linkup** | **$20 кредитов/мес** (standard $0.005 ⇒ ≈ 4 000 поисков); начисляют на проф. почту | Ежемесячный топ-ап до $20 | Не заявлена, нужна «professional email» | Независимых бенчмарков почти нет; свой бенчмарк (маркетинг) заявляет победу на сложных запросах. Считается «дешёвым аналогом Tavily» | ✅ `GET https://api.linkup.so/v1/credits/balance` → `{"balance": N}` |
| **Firecrawl Search** | 1 000 кредитов/мес; поиск = 2 кредита / 10 результатов ⇒ **500 поисков** | Ежемесячно, без переноса | Нет | AIMultiple: **14.58**, #2; сильнее всего там, где нужен полный контент страниц, а не ссылки | ✅ `GET https://api.firecrawl.dev/v2/team/credit-usage` → `remainingCredits`, `planCredits`, даты периода |
| **You.com** | **100 запросов/день без ключа и аккаунта** через MCP (`https://api.you.com/mcp?profile=free`) ⇒ ~3 000/мес. Только инструменты `you-search` и `you-discover` | Ежедневно | Нет | Независимых данных мало; один маленький тест (n=20) дал 90% recall — выборка несерьёзная | 🟡 С ключом: `GET https://api.you.com/v1/billing/account_balance`. У бесплатного keyless-профиля остаток не отдаётся — только локальный счётчик и 429 |
| **Parallel** | $5 кредитов/мес (≈ 5 000 `fast`-запросов) + до $80 при регистрации. Тариф Developer | Ежемесячно, без переноса | **Да** | AIMultiple: **14.21** (Pro), но очень медленный — 13.6 с в среднем | ✅ Account API: баланс/использование (`/service-api/balance/get-balance`, Usage API) |
| **Valyu** | $10 разово ($20 на корпоративную почту), без карты. Веб-поиск 0.1 кредита/результат ⇒ ≈ 1 000 поисков по 10 результатов | Одноразово, живёт 12 мес | Нет | Публичных независимых обзоров качества не нашёл | ❌ Публичного эндпоинта нет, только дашборд/спенд-кап |
| **Jina AI** | 10 млн токенов на новый ключ (≈ 1 000 поисков, поиск стоит от 10 000 токенов) | **Не возобновляется** | Нет | Позиционируется как дешёвая утилита (Reader сильный), поиск в независимых рейтингах не участвует | ❌ Публичного эндпоинта нет, только дашборд |
| **Search1API** | 100 кредитов при регистрации | Одноразово | Нет | Перепродажа чужих движков (метапоиск), своего индекса нет; обзоров мало | ✅ `GET https://api.search1api.com/usage` → `usage` = остаток кредитов |

---

## 2. Google-SERP-скрейперы (по сути прокси к выдаче Google)

Качество выдачи = Google (это одновременно плюс и юридический риск: скрейпинг нарушает ToS Google).
Бесплатные квоты у большинства — **разовые приветственные**, а не ежемесячные.

| Провайдер | Бесплатная квота | Сброс | Карта | Отзывы о качестве поиска | Остаток квоты через API |
|---|---|---|---|---|---|
| **Serper.dev** | 2 500 запросов при регистрации | **Одноразово** (модель top-up, кредиты живут 6 мес) | Нет | Хвалят скорость (1–2 с) и цену ($0.30–1.00/1k). Trustpilot 3.1/5 — жалобы на биллинг/поддержку, не на выдачу. На Reddit — «дёшево, пока не начнёшь считать кредиты» | ✅ `GET https://google.serper.dev/account` — отдаёт остаток кредитов (подтверждено косвенно: сторонний шлюз пишет, что эндпоинт «reports remaining credit» и потому не проксируется) |
| **SerpApi** | 250 поисков/мес, 50/час | Ежемесячно | Не заявлена | Зрелый, самый широкий охват вертикалей, U.S. Legal Shield. Дорого ($25/1k). Жалобы — на цену, не на качество | ✅ `GET https://serpapi.com/account?api_key=KEY` → `plan_searches_left`, `total_searches_left`, `this_month_usage`, `plan_renewal_date` |
| **SearchApi.io** | 100 запросов | **Период не указан** — возможно, разово | Нет | Отзывы средние: дешевле SerpApi, но меньше вертикалей; встречаются жалобы на поддержку | ✅ `GET https://www.searchapi.io/api/v1/me?api_key=KEY` → `remaining_credits`, `monthly_allowance`, `current_month_usage` |
| **Zenserp** | 50 поисков/мес, «free forever» | Ежемесячно | Не заявлена | Мало свежих отзывов; нишевый, стабильный, но дорогой на платных тарифах | ✅ `GET https://app.zenserp.com/api/v2/status` (header `apikey`) → `{"remaining_requests": N}` |
| **Serpstack** | 100 поисков/мес, **только non-commercial**, JSON | Ежемесячно | Скорее да: на free-регистрации форма с полями карты (не подтверждено) | Часть APILayer; обзоров мало, воспринимается как «бюджетный Google SERP» | ❌ Публичного эндпоинта не нашёл |
| **ValueSERP** | Бесплатного плана нет, только trial (сумма не указана) | Trial | Не заявлена | Нормальные отзывы в SEO-кругах, но для старта не бесплатен | ✅ `GET https://api.valueserp.com/account?api_key=KEY` → `monthly_credits_remaining`, `monthly_credits_reset_at` |
| **ScrapingDog** | 100 кредитов (на странице тарифов) **или** 200 запросов/мес (в доках) — противоречие | Противоречиво | Нет | Дешёвый, но Google-поиск стоит 5–10 кредитов, т.е. «100 кредитов» — это ~10–20 поисков | ✅ `GET https://api.scrapingdog.com/account?api_key=KEY` → `remainingApiCredits` |
| **ScrapingBee** | 1 000 кредитов (trial) | Одноразово | Нет | Хорош как скрейпер, поиск — побочная функция; кредитов на поиск уходит много | ✅ `GET https://app.scrapingbee.com/api/v1/usage` (Bearer), не чаще 6 раз/мин |

---

## 3. Big-tech и открытые варианты

| Провайдер | Бесплатная квота | Сброс | Карта | Отзывы о качестве поиска | Остаток квоты через API |
|---|---|---|---|---|---|
| **Google Custom Search JSON API** | 100 запросов/день | Ежедневно | Нужен billing-аккаунт для >100/день | Качество Google, но **API закрыт для новых клиентов**; существующие работают до **01.01.2027** | ❌ Только Cloud Console / Cloud Monitoring |
| **Bing Web Search API** | — | — | — | **Отключён 11.08.2025** ([Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)). Замена — Azure «Grounding with Bing Search» внутри AI Agents, отдельного free-tier поиска нет | — |
| **Mojeek** | Бесплатного плана нет; разовый тестовый кредит на Startup-плане, **нужна карта** | — | Да | Свой независимый индекс, маленький; хвалят приватность/ЕС-комплаенс, не полноту | ❌ Не подтверждено |
| **Marginalia** | Бесплатный ключ для **non-commercial** по письму; ключ `public` — с общим rate-limit | Не лимитируется явно | Нет | Ищет «старый, нетехнический, нон-коммерческий» веб — для общих запросов не подходит | ❌ Нет |
| **SearXNG** (self-host) | Без квоты, свой инстанс | — | Нет | Качество = сумма upstream-движков; часто ловит капчу/403 (в этом репо уже описан опыт) | 🟡 Локально: свои метрики/логи, но не «квота провайдера» |
| **DuckDuckGo** | Официального API нет; HTML/lite ломается и отдаёт капчу | — | Нет | Как источник для агента ненадёжен (подтверждено опытом проекта) | ❌ |
| **AskNews** | 25 кредитов разово + $5 на кошелёк | Одноразово | Нет | **Только новости на free-тарифе**: `/websearch` доступен лишь на платных Spelunker+; бесплатные кредиты тратятся на `/news`, `/wiki`, `/reddit` | ⚠️ Заголовок `X-RateLimit-Remaining` (в запросах, не в кредитах) |
| **Yandex Search API** | Платный, trial по запросу | — | Да | Сильная русская выдача; для англоязычных задач слабее | 🟡 Зависит от тарифа |
| **GDELT** | Бесплатно, без ключа | — | Нет | Только новости/события, не веб-поиск. На практике отдаёт `429` без предупреждения | ❌ |
| **Wikipedia / Wikimedia API** | Бесплатно | — | Нет | Только энциклопедия; отличный бесплатный fallback для фактов | ❌ |

---

## 4. Сколько всего получается бесплатно

**Ежемесячно, без карты (устойчивый минимум):**

| Провайдер | Поисков/мес |
|---|---|
| Linkup ($20 / $0.005) | 4 000 |
| You.com (100/день) | 3 000 |
| Exa ($10 / $4 за 1k, lite) | 2 500 |
| Tavily | 1 000 |
| Firecrawl (1 000 кредитов / 2) | 500 |
| SerpApi | 250 |
| Serpstack (non-commercial) | 100 |
| Zenserp | 50 |
| **Итого** | **~11 400** |

**С картой добавляются:** Brave 1 000 + Parallel 5 000 = **~17 400/мес**.
**Разовые «пакеты при регистрации»:** Serper 2 500 + Valyu ~1 000 + Jina ~1 000 + Search1API 100 +
ScrapingDog ~100 (+ ScrapingBee trial) ≈ **4 700–5 200** на старте.

> Важно: это оценка «в идеале». Реально часть квот уйдёт на ретраи, часть провайдеров режет rate-limit
> (Firecrawl — 10 запросов/мин, Exa — 10 QPS, Brave — 1–50 rps в зависимости от плана).

---

## 5. Колонка №4 крупным планом: кто реально умеет сказать «сколько осталось»

**Чистый REST-эндпоинт баланса (можно опрашивать перед каждым запросом или раз в N минут):**

| Провайдер | Эндпоинт | Что отдаёт |
|---|---|---|
| Tavily | `GET /usage` | расход и лимит ключа + аккаунта |
| Linkup | `GET /v1/credits/balance` | `balance` |
| Firecrawl | `GET /v2/team/credit-usage` | `remainingCredits`, `planCredits` |
| SerpApi | `GET /account` | `plan_searches_left`, `total_searches_left` |
| SearchApi | `GET /api/v1/me` | `remaining_credits`, `monthly_allowance` |
| Zenserp | `GET /api/v2/status` | `remaining_requests` |
| ScrapingDog | `GET /account` | `remainingApiCredits` |
| ScrapingBee | `GET /api/v1/usage` | расход |
| ValueSERP | `GET /account` | `monthly_credits_remaining` |
| Serper | `GET /account` | остаток кредитов |
| Parallel | Account API | баланс/использование |
| Search1API | `GET /usage` | `usage` = остаток кредитов |
| You.com (с ключом) | `GET /v1/billing/account_balance` | баланс в центах |

**Только заголовки ответа:** Brave (`X-RateLimit-Remaining` — второе число месячное, `-Reset` — секунды до сброса).

**Частично:** Exa (Team Management API, нужен service key и включение per-team).

**Никак (только дашборд/локальный счётчик):** Jina, Google CSE, Marginalia, Serpstack, Mojeek,
бесплатный You.com MCP (без ключа), SearXNG (свои логи), DDG.

---

## 6. Что это значит для прокси (архитектурные выводы)

1. **Источник правды — локальный ledger, а не API провайдера.** У половины провайдеров эндпоинта нет,
   а у части он врёт/запаздывает. Схема: `{provider, key_id, period_start, used, limit, exhausted_until, last_error}`,
   запись — атомарная (файловая блокировка или SQLite), иначе параллельные запросы дважды спишут квоту.
2. **Три уровня знания о квоте:**
   - `probe()` — если есть эндпоинт (Tavily/Linkup/Firecrawl/SerpApi/…), сверять на старте и раз в 10–30 мин;
   - `headers()` — Brave: парсить `X-RateLimit-Remaining`/`-Reset` из каждого ответа;
   - `local counter` — все остальные: инкремент на успешный запрос, сброс по календарю провайдера
     (1-е число / сутки по UTC / никогда для разовых).
3. **Классификация ошибок — половина всей логики:**
   - `401/403` → ключ мёртв, выключить до ручного вмешательства;
   - `402` (Exa/Valyu), `432`/`429` с текстом про кредиты (Tavily) → квота кончилась, `exhausted_until = reset`;
   - `429` без «кончились кредиты» → просто rate-limit, cooldown по `Retry-After`, ключ не списывать;
   - `5xx`/timeout → деградация, 3 страйка → временно убрать из ротации.
4. **Порядок выбора:** сначала бесплатные с остатком, внутри — по качеству (Brave/Exa/Linkup/Tavily),
   при равенстве — round-robin, чтобы не выжигать один ключ. Платные (pay-as-you-go) — только последним
   или по явному флагу.
5. **Кэш — самый дешёвый «провайдер».** Нормализация запроса + TTL 1 ч (новости) / 24 ч (факты) снимает
   30–40% вызовов, а это половина проблемы с квотами.
6. **Не крутить аккаунты ради обхода лимитов.** Мульти-ключи *разных* провайдеров — легально и в этом весь смысл.
   Мульти-аккаунты одного провайдера — нарушение ToS, и это палится по fingerprint/платежам.
7. **Осторожно с «free» лицензиями:** Serpstack — non-commercial only, Jina — CC-BY-NC, Marginalia — non-commercial,
   Google-SERP-скрейперы — нарушают ToS Google (для внутреннего агента риск ниже, для продукта — выше).
8. **Не строить на Google CSE** (закрыт для новых, EOL 01.01.2027) и **Bing Search API** (выключен 11.08.2025).

### Минимальный набор для первой версии

`Tavily + Exa + Linkup + Brave + You.com` — это ~11 500 поисков/мес, у всех кроме You.com есть
нормальный способ узнать остаток, и все, кроме Brave, не требуют карты.
`Serper` (2 500 разово) — как burst-пул на старте. `Firecrawl` — если нужен полный текст страниц,
а не только сниппеты.

---

## 7. Источники (первоисточники, проверено 2026-11-07)

- Tavily: <https://docs.tavily.com/documentation/api-credits> · <https://docs.tavily.com/documentation/api-reference/endpoint/usage>
- Brave: <https://api-dashboard.search.brave.com/documentation/pricing> · <https://api-dashboard.search.brave.com/documentation/quickstart> · <https://api-dashboard.search.brave.com/documentation/guides/rate-limiting>
- Exa: <https://exa.ai/docs/admin/pricing.md> · <https://exa.ai/docs/admin/billing.md> · <https://exa.ai/docs/reference/team-management/get-api-key-usage>
- Linkup: <https://docs.linkup.so/pages/documentation/platform/pricing.md> · <https://docs.linkup.so/pages/documentation/endpoints/account/balance>
- Firecrawl: <https://www.firecrawl.dev/pricing.md> · <https://docs.firecrawl.dev/api-reference/v1-endpoint/credit-usage>
- You.com: <https://you.com/docs/agents/mcp-server.md> · <https://you.com/docs/administration/billing>
- Parallel: <https://parallel.ai/pricing> · <https://docs.parallel.ai/getting-started/pricing.md>
- Valyu: <https://docs.valyu.ai/pricing.md>
- Jina: <https://jina.ai/api-dashboard/> (лимиты токенов — вторичный источник <https://agentdeals.dev/vendor/jina-ai>)
- Serper: <https://serper.dev/> · <https://docs.nativeport.ai/serper.md> (упоминание `/account`)
- SerpApi: <https://serpapi.com/pricing> · <https://serpapi.com/account-api>
- SearchApi: <https://www.searchapi.io/pricing> · <https://www.searchapi.io/docs/account-api>
- Zenserp: <https://zenserp.com/pricing-plans/>
- Serpstack: <https://serpstack.com/pricing>
- ValueSERP: <https://docs.trajectdata.com/valueserp/account-api>
- ScrapingDog: <https://www.scrapingdog.com/pricing/>
- ScrapingBee: <https://www.scrapingbee.com/pricing/>
- Google CSE: <https://developers.google.com/custom-search/v1/overview>
- Bing: <https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement> (дата 11.08.2025) + <https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview>
- Search1API: <https://www.search1api.com/pricing>
- AskNews: <https://docs.asknews.app/en/rate-limiting>
- Mojeek: <https://www.mojeek.com/services/search/web-search-api/>
- Marginalia: <https://about.marginalia-search.com/article/api/>

**Вторичные (качество):**
- AIMultiple, Agentic Search Benchmark, 8 API, 100 запросов, LLM-судья (обновлён 13.05.2026): <https://aimultiple.com/agentic-search>
- HN-обсуждение о сильных/слабых сторонах Brave и Exa: <https://news.ycombinator.com/item?id=49470750>
- Trustpilot Serper (3.1/5): <https://uk.trustpilot.com/review/serper.dev>
- Обзор цен Serper (проверено 05.07.2026): <https://coldiq.com/blog/serper-pricing>
