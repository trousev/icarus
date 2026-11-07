# Web fetch / extract у наших провайдеров — кто умеет и почём

**Дата проверки:** 7 ноября 2026. Только первоисточники (доки и тарифы), ссылки внизу.
Речь про «дай URL — верни содержимое страницы», а не про поиск.

## Короткий ответ

Умеют **шесть из восьми**: Firecrawl, Tavily, Exa, Linkup, You.com и — неожиданно —
**SerpApi** (Extract API, вышла в октябре 2026). **Brave и Serpstack не умеют**: у Brave
только поиск/LLM Context/Answers, у Serpstack только выдача Google.

## Таблица

| Провайдер | Fetch? | Как звать | Что отдаёт | Цена за страницу | Страниц из бесплатной квоты |
|---|---|---|---|---|---|
| **Firecrawl** | ✅ | `POST /v1/scrape` `{url, formats:["markdown"], onlyMainContent:true}` | `data.markdown` (+ html/links) | 1 кредит | **1 000/мес** (вся квота, если не искать) |
| **Tavily** | ✅ | `POST /extract` `{urls:[url], format:"markdown", extract_depth:"basic"}` | `results[].raw_content`, `failed_results[]` | 0.2 кредита (1 за 5 страниц; advanced — 0.4) | **5 000/мес** basic (2 500 advanced) |
| **Exa** | ✅ | `POST /contents` `{ids:[url], text:{maxCharacters:20000}}` | `results[].text` + `statuses[]` | $0.001 | **10 000/мес** |
| **Linkup** | ✅ | `POST /v1/fetch` `{url, renderJs?:false, mode:"standard"}` | `markdown` (+ favicon, images, schema) | $0.001 ($0.005 с JS, $0.005 pro, $0.01 pro+JS) | **20 000/мес** standard |
| **You.com** | ✅ | `POST /contents` `{urls:[url], formats:["markdown"]}` | массив `[{url,title,markdown,html,metadata}]` | $0.001 | стартовые кредиты (сумма в доках не зафиксирована) |
| **SerpApi** | ✅ | `GET /search.json?engine=extract&url=...&output=md` | markdown-строка; в JSON ещё `page_information`, `meta_tags`, `inline_links` | 1 кредит | **250/мес, и это те же кредиты, что поиск** |
| **Brave** | ❌ | — | — | — | — |
| **Serpstack** | ❌ | — | — | — | — |

## Нюансы, которые важнее цены

**Квоты общие с поиском у всех шести.** Нет ни одного провайдера, у которого fetch был бы
на отдельном балансе: Tavily/Exa/Firecrawl/Linkup/You.com тратят тот же кредитный пул, что
поиск, а SerpApi — те же 250 кредитов. Значит, активный fetch-провайдер будет выедать квоту
поиска, если это один и тот же сервис.

**SerpApi соблюдает robots.txt** и просто не отдаст страницу, которую сайт закрыл для
краулеров (`User-agent: *`). Плюс у него 50 запросов/час на бесплатном плане и всего 250
кредитов в месяц на всё. Для fetch это худший вариант, несмотря на аккуратный markdown.

**JS и «сложные» страницы:**
- Firecrawl — лучший по антиботу и JS, но самый медленный и самый дорогой по кредитам
  (1 страница = 1 кредит; на free ещё и 10 запросов/мин);
- Exa — умеет JS и PDF, но по умолчанию отдаёт **кэш**; свежесть задаётся `maxAgeHours`
  (`0` — всегда тянуть заново, `-1` — только кэш);
- Tavily basic может не увидеть динамику; `advanced` берёт таблицы и встроенное, но вдвое
  дороже и медленнее; неудачные URL приходят в `failed_results` при HTTP 200;
- Linkup **по умолчанию без JS** (`renderJs:false`); `mode:"pro"` заметно повышает шансы
  на тяжёлых сайтах, но стоит уже $0.005;
- You.com отдаёт кэш с `max_age`, таймаут 10 с по умолчанию, умеет batch.

**Ошибки страницы ≠ поломка провайдера.** 404, закрытый robots.txt, пейволл, «слишком
большой PDF» — это свойства конкретного URL, а не здоровье ключа. Банить провайдера за них
нельзя, иначе один плохой URL выключит весь fetch на 5 минут.

**SSRF.** Все шесть качают страницу **у себя**, а не с нашего хоста, поэтому внутренняя сеть
им недоступна. Но `http(s)`-валидация и запрет `localhost`/приватных адресов всё равно нужны:
это дешевле, чем объяснять провайдеру, почему мы просим `http://192.168.1.1`.

**Кэш на нашей стороне выгоднее, чем на стороне провайдера.** Повторный fetch того же URL
стоит тех же денег. TTL-кэш (например, 1 час) на `/fetch` экономит заметно больше, чем
перестановка провайдеров.

## Кто «лучше» для fetch

Две разные оси, и они не совпадают:

- **по качеству на тяжёлых страницах:** Firecrawl → Exa → Tavily (advanced) → Linkup (pro) → You.com → SerpApi;
- **по экономии квоты:** Linkup (20k страниц) → Exa (10k) → Tavily (5k) → Firecrawl (1k) → You.com (?) → SerpApi (250, ещё и общие с поиском).

Разумный стартовый рейтинг для `fetch`, если хочется и качества, и квоты:

```
exa → tavily → firecrawl → linkup → you → serpapi
```

Exa первым: 10k страниц, JS/PDF и приличное качество; Firecrawl — как «тяжёлая артиллерия»
для страниц, на которых остальные сдались; SerpApi — последним (или вообще не включать,
чтобы не есть 250 кредитов поиска).

## Что это значит для роутера

1. `current` нужен **отдельный для каждой возможности**: `current.search` и `current.fetch`
   (как ты и сказал — они могут разойтись).
2. Рейтинги тоже разные: Brave и Serpstack из fetch-рейтинга выпадают, SerpApi из топа
   поиска уезжает в конец fetch-рейтинга.
3. Баны стоит разделить по возможности: 402/429 «кончились кредиты» — общий бан (баланс
   один), а вот 5xx/таймаут/отказ на конкретной странице — бан только fetch-возможности.
4. Ответ `/fetch` должен быть маленьким и предсказуемым: `{url, finalUrl?, title?, markdown,
   provider, tried, truncated}`. Текст режем (как сейчас, 20 000 знаков), иначе модель
   захлебнётся.
5. Кэш URL → текст с TTL — обязательная часть, иначе fetch будет самым дорогим маршрутом.

## Источники

- Tavily Extract: <https://docs.tavily.com/documentation/api-reference/endpoint/extract> · кредиты: <https://docs.tavily.com/documentation/api-credits>
- Exa Contents: <https://exa.ai/docs/contents/quickstart> · цены: <https://exa.ai/docs/admin/pricing>
- Firecrawl Scrape: <https://docs.firecrawl.dev/api-reference/v1-endpoint/scrape> · цены: <https://www.firecrawl.dev/pricing>
- Linkup Fetch: <https://docs.linkup.so/pages/documentation/endpoints/fetch/reference> · цены: <https://docs.linkup.so/pages/documentation/platform/pricing>
- You.com Contents: <https://you.com/docs/api-reference/contents> · биллинг: <https://you.com/docs/administration/billing>
- SerpApi Extract: <https://serpapi.com/extract-api> · анонс (13.10.2026): <https://serpapi.com/blog/introducing-extract-api/> · SDK-дока: <https://github.com/serpapi/serpapi-python/blob/master/docs/user_guide/extract.md>
- Brave (только поиск): <https://api-dashboard.search.brave.com/documentation>
- Serpstack (только поиск): <https://serpstack.com/pricing>
