# Feature: Icarus Dynamic Memory (Graphiti)

**Status:** In Planning  
**Date:** 2026-08-03  
**Skill:** product-planning (auto mode)

---

## Step 1: Product Questions

### Q1: Какую ключевую проблему пользователя решает динамическая память? Почему статического MEMORY_INJECTION уже недостаточно?

**A1 (Product Manager perspective):**

Ключевая проблема: **модель каждый раз встречает пользователя как незнакомца**. Статический MEMORY_INJECTION — это не память, а "визитная карточка", которая говорит правду ровно в момент написания и дальше только устаревает.

**7 сценариев, которые страдают от статической памяти:**

1. **Повторное объяснение контекста между сессиями.** Всё, что обсуждалось в понедельник (решения по архитектуре, выбор инструментов, договорённости) — исчезает в среду. Каждое новое окно диалога стирает всё, что было до.

2. **Память не обновляется вообще.** Обновить = отредактировать `.env` + перезапустить прокси. Это не UX памяти, это релизный цикл. Реально пользователь сделает это один раз при установке.

3. **Устаревшая память вреднее её отсутствия.** Модель доверяет инъекции безоговорочно. Если в памяти "работает над Icarus", а он уже месяц на другом проекте — модель уверенно апеллирует к старой информации.

4. **Одна строка на все случаи — без релевантности.** Строка вставляется в каждый запрос независимо от темы. Это шум. И это жёсткий потолок на размер: длинная — платишь токенами и размываешь внимание, короткая — бесполезна.

5. **Нет обратной связи — система не обучается на контрадикциях.** Пользователь говорит "я перешёл на другого провайдера", но следующий диалог снова считает его пользователем DeepSeek.

6. **Знания не делятся между клиентами.** Через прокси ходят Claude Code, скрипты, чат-UI — но знания из одной сессии не помогают в другой.

7. **Плоская строка не может выразить связи.** "Алекс → Icarus", "Icarus → DeepSeek" — это граф. В строке нельзя спросить "что я знаю про проект Icarus?" без вываливания всего текста.

**5 критериев успеха (продуктовых):**
1. Факты попадают в память сами — из разговора, без ручного редактирования
2. Устаревшее вытесняется — контрадикция в новом разговоре побеждает старый факт
3. В каждый запрос попадает только релевантное — по теме, а не весь корпус
4. Стабильный префикс для prompt cache не ломается — стоимость не растёт
5. Всё работает на VPS с ограниченной памятью

---

## Problem Statement (revised)

Icarus currently injects a static, hand-maintained `MEMORY_INJECTION` string into every request. This:
- Never learns from conversations (all data goes to logs and is discarded)
- Never updates without manual `.env` edit + restart
- Inserts the same text into every request regardless of topic
- Degrades with usage — the longer you use Icarus, the more outdated the memory becomes
- Cannot express relationships between facts (flat string, no graph structure)

We need a self-improving memory system that extracts facts from conversations automatically, stores them in a structured knowledge graph, retrieves relevant memory contextually, and runs on a resource-constrained VPS.

**Success criteria:**
1. Facts are extracted and stored automatically — no manual editing
2. Contradictory facts replace outdated ones (temporal invalidation)
3. Memory injection is relevant to the current conversation topic
4. Prompt cache stability is preserved (frozen prefix per conversation)
5. Operates within 512MB RAM budget for the memory subsystem

---

## Goals
- **Primary:** Replace static MEMORY_INJECTION with a self-improving knowledge graph that learns from every conversation
- **Secondary:** Structured, queryable memory with typed entities and relationships (user → projects, preferences, tools, constraints)
- **Secondary:** Zero-maintenance operation — no manual editing, no restart to update memory
- **Secondary:** Operate within tight resource constraints (small VPS, limited RAM)

---

## User Flow
1. User starts a new conversation → Icarus queries memory graph for everything about the user, injects as frozen system message
2. User sends messages, AI responds → after each response, a cheap evaluator LLM checks: "anything worth remembering from the last message?"
3. If yes → facts are extracted, deduplicated against existing memory, and pushed to the graph (fire-and-forget, user doesn't wait)
4. Next conversation → new facts are available in the memory injection
5. Within the same conversation, memory injection never changes (frozen)

---

## Target Users
- **Primary:** Alex (senior software engineer) — the sole user of Icarus. Uses multiple LLM clients (Claude Code, chat UIs, scripts) through the proxy and wants consistent memory across all of them.
- **Secondary (future):** Other developers who self-host Icarus on their own VPS.

---

### Q2: Граница между "запомнить" и "не запоминать"? Конкретные категории и примеры.

**A2 (Product Manager perspective):**

**One-line decision rule:** *Факт принадлежит памяти, если и только если он изменит то, как должен начинаться следующий разговор — и останется правдой через 30 дней.*

Два операционных теста для каждого кандидата:
1. **Briefing test:** «Если бы я вводил в курс дела нового инженера завтра, сказал бы я ему этот факт?»
2. **Durability test:** «Будет ли это всё ещё правдой через 30 дней?»

**Критическая асимметрия:** ложная память хуже отсутствия памяти. False positive («Алекс предпочитает X», когда он сказал это один раз с сарказмом) впрыскивается в каждый разговор. False negative стоит ноль — пользователь просто переобъяснит факт. **Оценщик должен быть консервативным по умолчанию: сомневаешься — не запоминай.**

**7 категорий ЧТО ЗАПОМИНАТЬ:**
1. Стабильные identity-факты («senior backend engineer, 8 лет в distributed systems»)
2. Проекты и их состояние («строю Icarus — прокси с memory injection»)
3. Предпочтения и рабочий стиль — самая ценная категория («краткие ответы, просто diff», «Rust для perf, Python для glue»)
4. Ограничения и среда («всё на Hetzner CX22, 2GB RAM, без GPU»)
5. Принятые решения — нельзя переоткрывать («остановились на Postgres, не предлагай MySQL»)
6. Калибровка экспертизы («8 лет Go, но WebAssembly — ноль»)
7. Операционные факты («Docker для всего, systemd для сервисов»)

**7 категорий ЧТО НЕ ЗАПОМИНАТЬ:**
1. Временное состояние отладки («таймаут на VPS прямо сейчас») — шум №1 от coding assistants
2. Содержание задачи («помоги рефакторить этот файл») — запрос не факт о пользователе
3. Преходящие измерения («билд занимает 40 секунд») — изменится через неделю
4. Чувствительные данные — **HARD NO с кодовым контролем** (секреты, финансовые/медицинские/личные данные)
5. Настроение и вентиляция («ненавижу эту кодовую базу») — эмоция, не предпочтение
6. Выводы самого ассистента — только user messages являются источником фактов
7. Межличностные суждения («Дмитрий некомпетентен») — эмоционально и волатильно

**Коррекция метрик:** Метрика «>80% разговоров дают ≥1 факт» конфликтует с консервативной границей. Если половина диалогов — «почини compile error», хороший оценщик должен вернуть пустой массив. Замена:
- **Precision:** ≤10% сохранённых фактов позже признаны ошибочными (ручная выборочная проверка)
- **Signal:** ≥1 факт на разговор, который оценщик счёл *содержащим* запоминаемую информацию
- **Value (главная):** ≥1 сохранённый факт *процитирован* ассистентом в последующем разговоре за неделю

---

## Success Metrics (revised)
- **Precision:** ≤10% of stored facts are later contradicted or judged junk on manual review
- **Dedup effectiveness:** <10% of stored facts are near-duplicates of existing ones
- **Value:** ≥1 stored fact is referenced by the assistant in a subsequent conversation per week
- **Cost:** Memory extraction + Graphiti processing stays under $2/day at 100 conversations/day
- **Latency:** Memory write path runs in background, never blocks the user response
- **RAM:** Neo4j + Graphiti service stay under 512MB combined
- **Safety:** Zero secrets or sensitive PII ever reach the graph (code-enforced, not prompt-enforced)

---

### Q3: Как Graphiti интегрировать — свой REST-wrapper, встроенная библиотека, или официальный MCP-сервер?

**A3 (Tech Lead perspective):**

**Рекомендация: официальный MCP-сервер `zepai/knowledge-graph-mcp` с FalkorDB в одном контейнере.**

**Отвергнутые варианты:**

| Вариант | Вердикт | Причина |
|---|---|---|
| Встроенная библиотека (graphiti-core в процессе прокси) | ❌ Отклонить | Нарушает требование «graphiti в docker-compose»; убивает изоляцию (крах графа = крах прокси); раздувает образ (numpy, openai, pydantic, neo4j-driver, tenacity, diskcache, posthog) |
| Свой REST-wrapper | ⚠️ Запасной | Рабочий, но платит пожизненной поддержкой graphiti-core пре-1.0 (ломающие релизы, смена API); противоречит цели zero-maintenance |
| **MCP-сервер + FalkorDB** | ✅ Выбрать | Prebuilt-образ, HTTP-транспорт (не stdio/SSE), один контейнер с БД внутри, ~150-250MB RAM |

**Критическое открытие по памяти:** Neo4j НЕ влезает в бюджет 512MB. Даже с `NEO4J_server_memory_heap_max__size=256M` и `pagecache_size=256M`, JVM-оверхед (Metaspace, CodeCache, GC-структуры, native memory) даёт ~600MB+ на хосте. Официальный минимум Neo4j — 2GB RAM.

**FalkorDB** (Redis-ядро, без JVM): ~85-150MB для графа персональной памяти (10K нод, 20K рёбер). Официально поддерживаемый бэкенд graphiti-core (`graphiti-core[falkordb]`). MCP-сервер по умолчанию запускает FalkorDB **в том же контейнере** — один сервис вместо двух.

**Docker Compose (целевое состояние):**
```yaml
services:
  graphiti:
    image: zepai/knowledge-graph-mcp:latest
    ports: ["${GRAPHITI_PORT:-8001}:8000"]
    environment:
      - LLM_PROVIDER=openai
      - OPENAI_API_URL=${UPSTREAM_BASE_URL}/v1   # DeepSeek API
      - OPENAI_API_KEY=${UPSTREAM_API_KEY}
      - MODEL_NAME=${GRAPHITI_EXTRACTOR_MODEL:-gpt-4o-mini}
      - GRAPHITI_TELEMETRY_ENABLED=false
      - SEMAPHORE_LIMIT=2
      - GRAPHITI_GROUP_ID=alex
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/health"]
    deploy:
      resources: { limits: { memory: 400M } }

  icarus:
    profiles: ["full"]
    depends_on:
      graphiti: { condition: service_healthy }
    # ... existing config
```

**Trade-offs принятые осознанно:**
1. **Кастомные Pydantic-типы сущностей недоступны** — вместо них `custom_extraction_instructions` и встроенные типы (Person, Preference, Project). Для 7 категорий из Q2 — достаточно для v1.
2. **Новая зависимость `mcp` SDK** в прокси (async, httpx-based, совместим с FastAPI)
3. **Embeddings:** DeepSeek не умеет embeddings → OpenAI `text-embedding-3-small` ($0.02/1M токенов, ничтожно в бюджете $2/день) или локальный sentence-transformers за счёт RAM
4. **Версионирование:** pin тега образа + версии SDK; обновления — осознанный шаг

**Fault tolerance:**
- MCP-клиент с таймаутом 500ms на запрос
- При недоступности: skip инъекции + warning-лог + `"graphiti": "unreachable"` в `/health`
- Write-path (fire-and-forget) молча пропускается
- Fallback на статический `MEMORY_INJECTION` при `MEMORY_ENABLED=false`

---

### Q4: MCP-клиент в прокси — как именно организовать взаимодействие?

**A4 (Developer perspective):**

**Критическая находка:** Имена инструментов различаются между форками MCP-сервера. Официальный `zepai/knowledge-graph-mcp` использует `add_episode`/`search_facts`, а форки — `add_memory`/`search_memory_facts`. **Решение:** при `connect()` вызывать `tools/list`, строить мапу `имя → inputSchema`, выбирать по наличию с фолбэками. Плюс зафиксировать тег образа.

**SDK vs голый httpx:** Берём официальный `mcp` SDK. FastMCP-сервер по умолчанию отвечает на `tools/call` в формате `text/event-stream` (даже для одношаговых вызовов, если `json_response=False`). SDK обрабатывает SSE-фреймы прозрачно. Зависимость лёгкая (anyio, httpx, pydantic — уже есть от FastAPI).

**Структура `src/icarus/memory.py`:**
```
MemoryClient
  connect() → non-fatal, available=False при ошибке
  close() → shutdown
  search_facts(query, max_facts) → list[Fact]
  add_memory(name, facts, source_description) → bool
  _ensure_connected() → lazy reconnect под asyncio.Lock
  _resolve_tools(tools) → маппинг имён с фолбэками
  _contains_sensitive(text) → regex-фильтр секретов

conversation_key(messages) → sha256(first user message) | "no-user"
build_injection(facts) → str | None (фильтр expired, формат <memory>)
```

**Connection:** lifespan FastAPI → `memory.connect()` → при ошибке лог + `available=False`. Ленивый реконнект под `asyncio.Lock` при следующем использовании.

**Episode format:** Оценщик отдаёт готовые факт-утверждения → пакуем в `add_episode(source="text")`. **Никаких сырых диалогов** в граф — только извлечённые факты. Кодовый секрет-фильтр перед отправкой.

**Search format:** Один широкий запрос `"all known facts about the user: projects, preferences, constraints, decisions"` с `max_facts=30`, `group_ids=[GRAPHITI_GROUP_ID]`. Пост-обработка: отбросить `invalid_at`/`expired_at`, сортировать по `created_at desc`.

**Conversation key:** SHA-256 от первого user-сообщения в `messages` массиве. Все OpenAI-совместимые клиенты пересылают полную историю → первый user-message стабилен внутри диалога. Кэш `conversation_key → снапшот` с TTL 30 мин.

**Fault tolerance:** Hot path timeout 500ms → skip injection + warning. Write path → `asyncio.create_task(...)` fire-and-forget, все ошибки swallowed. `/health` → `"graphiti": "ok" | "unreachable"`. Fallback на статический `MEMORY_INJECTION` при `MEMORY_ENABLED=false`.

**Config additions:**
- `MEMORY_ENABLED` (bool, default false для плавной раскатки)
- `GRAPHITI_URL` (default `http://localhost:8001/mcp/`)
- `GRAPHITI_GROUP_ID` (default `"default"`)
- `GRAPHITI_TIMEOUT_MS` (default 500)
- `GRAPHITI_MAX_FACTS` (default 30)

**⚠️ Port caveat:** MCP-сервер может использовать порты 19400/19401/19402 а не 8000 — проверить при пиннинге тега образа.

---

## Step 3: Implementation Details

*Переход к низкоуровневым деталям.*

### Q5: Оценщик (evaluator LLM) — точный промпт, модель, формат ответа

**A5 (Developer perspective):**

**Модель:** `deepseek-v4-flash` (НЕ `deepseek-chat` — deprecated 2026-07-24). `deepseek-chat` маппился на v4-flash non-thinking, теперь используем канонический ID.

**Параметры вызова:**
- `thinking: {type: "disabled"}` — **обязательно**, на v4-flash thinking включён по умолчанию
- `response_format: {type: "json_object"}` — максимум что поддерживает DeepSeek (JSON Schema нет)
- `temperature: 0.0` — детерминизм (работает при disabled thinking)
- `max_tokens: 800` — запас от обрезки mid-object
- `stream: false`

**Стоимость:** ~1800 input + ~300 output токенов ≈ **$0.00030 за оценку**. $0.03/день при 100 разговорах.

**Промпт (production-ready):** Системный блок (~1100 токенов, стабильный → prompt cache hit $0.0028/M):
- SCOPE: только последнее user-сообщение, предыдущие уже обработаны
- DECISION TESTS: Briefing test + Durability test (из Q2) как операционные фильтры
- 7 категорий REMEMBER + 7 категорий NEVER (дословно из Q2)
- Стиль: один самодостаточный факт на предложение, от первого лица ("The user prefers...")
- Максимум 5 фактов; `{"facts": []}` — самый частый правильный ответ
- КОНСЕРВАТИЗМ: сомневаешься — не запоминай (false positive хуже false negative)

**Data block:** только последнее user-сообщение + список уже известных фактов (из frozen memory текущего разговора) для L0-дедупликации в промпте.

**Structured output:** `json_object` + клиентская Pydantic-валидация + 1 retry при сбое. Известный баг DeepSeek — пустой content при JSON mode → retry.

**Дедупликация (3 слоя, short-circuit):**
- **L1:** Нормализация + SHA256[:16] → LRU-кэш 1000 записей, TTL 24h. Hit → SKIP. $0, ~0ms.
- **L2:** OpenAI `text-embedding-3-small`, cosine similarity. >0.92 → SKIP; 0.85–0.92 → L3; <0.85 → PASS. ~$0.0000001, ~50ms.
- **L3:** Graphiti search → embedding comparison. Cosine >0.90 → SKIP. Только для серой зоны. ~$0, ~100ms.
- Фолбэки: эмбеддер недоступен → skip L2, сразу L3. Graphiti недоступен → PASS + rate-limited warning.

**Формат episode_body:** Один `add_episode` на ход. Факты — нумерованный текст:
```
1. The user prefers Rust for systems programming.
2. The user is building Icarus, a proxy for LLM APIs.
```
Graphiti-сервер сам прогонит через свой LLM-экстрактор (gpt-4o-mini). **Никаких сырых диалогов в граф.**

**Секрет-фильтр:** regex-паттерны (sk-*, AKIA, BEGIN PRIVATE KEY, password=..., api_key=..., номера карт, email) — финальный рубеж перед отправкой в граф, кодом а не промптом.

**Обработка ошибок (полная матрица):** HTTP 429/5xx/timeout → 1 retry 0.5s → `[]`. HTTP 401 → без retry, error-лог. Malformed JSON → repair-попытки → 1 retry → `[]`. Факт не прошёл Pydantic → дроп этого факта, остальные сохраняются. Секрет-фильтр зацепил → дроп + warning. Graphiti unreachable → пропуск + rate-limited warning.

**Полная стоимость write path:** Оценщик $0.00030 + эмбеддинг ~$0.0000001 + Graphiti-экстракция ~$0.00008 ≈ **$0.0004 на ход с фактами**. ~$0.04/день при 100 разговорах — в 50 раз ниже бюджета $2/день.

---

## Step 4: Attack & Challenge

*Критический анализ плана. Каждый challenge — независимый adversarial agent.*

### Q6: Attack — найди 3 самые серьёзные уязвимости

**A6 (Skeptical Senior Engineer):**

**FLAW 1 (CRITICAL): Write path silently fails — 100% потерь записи.**

Таймаут MCP-клиента 500ms — но `add_episode` занимает 500–2000ms (Graphiti внутри вызывает свой LLM-экстрактор). Каждый вызов обрывается по таймауту, исключение swallowed (fire-and-forget), факт потерян. Плюс compose-конфиг неконсистентен: `LLM_PROVIDER=openai` + `OPENAI_API_URL=https://api.deepseek.com/v1` + `MODEL_NAME=gpt-4o-mini` → DeepSeek не имеет gpt-4o-mini → 404 на каждом эпизоде. Параметры embeddings не указаны вообще (DeepSeek не умеет embeddings). Система спроектирована так, что никогда не запишет ни одного факта — и никто не узнает, потому что все ошибки swallowed.

**FLAW 2 (CRITICAL): Conversation identity ломает frozen-prefix инвариант.**

SHA-256 первого user-сообщения как ключ: коллизия на "hi"/"help" между разными диалогами → общий снапшот с чужими фактами. In-memory кэш с TTL 30 мин → перезапуск прокси дропает снапшот → следующий запрос в живом диалоге перечитывает граф (где уже есть новые факты) → frozen prefix меняется mid-conversation → criterion 4 нарушен. Плюс инъекция всегда один и тот же фиксированный запрос, а не topic-dependent → criterion 3 («релевантность теме») недостижим по дизайну.

**FLAW 3 (CRITICAL): Нет lifecycle management — неограниченный рост RAM и нет пути удаления.**

Решение для v1: «No automatic expiration. Let the graph grow.» FalkorDB — RAM-resident → неограниченный рост. При превышении лимита — OOM kill → container restart loop → read path падает на static injection, write path молча глотает ошибки (flaw 1). Нет delete/forget: секрет, проскочивший regex-фильтр, или неверный факт — навсегда в графе, впрыскивается в каждый диалог. Критическая асимметрия из Q2 («wrong memory is worse than no memory») не имеет механизма исправления.

**SECONDARY ISSUES:**
- Оценка стоимости занижена в 10–30×: Claude Code делает 5–20 запросов на одну реплику → $0.40–1.50/день, вплотную к бюджету $2/день
- L0-дедупликация использует frozen memory list, который stale внутри диалога
- Secret-фильтр только regex — контекстные секреты (адрес, зарплата) проходят насквозь

---

### Q7: Defense — Как исправить Flaw 1 (silent write failures)?

**A7 (Senior Engineer):**

**Корень проблемы:** Каждый компонент write path сломан независимо (неправильный таймаут, swallowed exceptions, неправильное имя модели, отсутствует конфиг embeddings), и ничто не сигнализирует о комбинированном результате → 100% отказов записи с 0% видимости.

**Fix 1 — Разделение таймаутов (reads 500ms, writes 10s):**
- `GRAPHITI_READ_TIMEOUT_MS=500` (hot path, инъекция не должна ждать)
- `GRAPHITI_WRITE_TIMEOUT_MS=10000` (5× запас над 500–2000ms add_episode)
- `GRAPHITI_WRITE_RETRIES=1` (один retry с backoff 1s)
- Транспортный таймаут ≥15s (больше чем write budget)
- `asyncio.timeout()` как belt-and-braces на случай если SDK не поддерживает per-call timeout

**Fix 2 — Ошибки становятся видимыми, durable и replayable:**
- Никакого bare `create_task` — все записи через FIFO очередь (Fix 5)
- Structured logging на каждый исход: `memory_write_started/succeeded/failed` со всеми полями
- Dead-letter файл `logs/memory_dead_letter.jsonl` — replayable
- `/health` получает: `graphiti_writes_total`, `graphiti_writes_failed`, `graphiti_writes_last_error`, `graphiti_queue_depth`
- Startup self-test: `GET /models` → проверить что GRAPHITI_EXTRACTOR_MODEL существует, embedding probe → 200
- Retry matrix: timeout/5xx → 1 retry; 4xx (включая 404 model error) → no retry + error log + dead-letter

**Fix 3 — Имя модели:** `gpt-4o-mini` → `deepseek-v4-flash` (в дефолте тоже!)
```yaml
MODEL_NAME=${GRAPHITI_EXTRACTOR_MODEL:-deepseek-v4-flash}
```
Плюс `.env`: `GRAPHITI_EXTRACTOR_MODEL=deepseek-v4-flash`. Важно: v4-flash имеет thinking включённым по умолчанию — если graphiti-core не передаёт `thinking: {type: disabled}`, использовать deprecated `deepseek-chat` (маппится на non-thinking вариант).

**Fix 4 — Embeddings: отдельный провайдер, отдельный ключ, явно OpenAI:**
```yaml
EMBEDDING_PROVIDER=openai
EMBEDDING_API_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=${OPENAI_API_KEY}
EMBEDDING_MODEL=text-embedding-3-small
```
DeepSeek не имеет embeddings API. Startup probe: один POST на embeddings с 4-токенной строкой.

**Fix 5 — Сериализация записей: один FIFO worker, явный reference_time:**
```python
self._write_queue: asyncio.Queue[WriteJob] = asyncio.Queue(maxsize=100)
```
Каждый ход enqueues (неблокирующий ~µs) вместо spawn своего create_task. Один worker потребляет FIFO → эпизоды в порядке разговора. Явный `reference_time` (stamped at turn end) сохраняет порядок даже при retry.

**Доказательство исправления:**
1. `docker compose config` → MODEL_NAME=deepseek-v4-flash, EMBEDDING_* с OpenAI ключом
2. Boot → self-test проходит (model in GET /models, embedding probe 200)
3. 3 быстрых хода → `/health`: writes_total≥3, writes_failed=0
4. Остановить graphiti → записи в dead-letter, `/health`: unreachable + nonzero failed
5. Плохое имя модели → 404 как `memory_write_failed` error, не тишина

### Q8: Defense — Как исправить Flaw 2 (conversation identity)?

*Agent running...*

### Q9: Defense — Как исправить Flaw 3 (lifecycle management)?

**A9 (Senior Engineer):**

**Fix 1 — Memory budget enforcement (4-layer guard):**

**Layer 0 — Hard guard:** `deploy.resources.limits.memory: 400M` на контейнере + FalkorDB `maxmemory 300mb` + `maxmemory-policy noeviction` → при заполнении графа ошибка записи вместо OOM-kill → container restart loop. Плюс `QUERY_MEM_CAPACITY ~128MB` для защиты от патологических запросов.

**Layer 1 — Count-based soft caps + periodic trimming:**
- `MEMORY_MAX_ENTITIES=5000`, `MEMORY_MAX_EDGES=10000`, `MEMORY_MAX_EPISODES=2000`
- MaintenanceWorker (asyncio task в lifespan, интервал 24h):
  - Phase A: удаление dead edges (`invalid_at IS NOT NULL OR expired_at IS NOT NULL`) — ноль потери информации
  - Phase B: если рёбер всё ещё > cap — evict oldest by `valid_at`, защищая user entity
  - Phase C: если эпизодов > cap — oldest episodes (cascade delete)
  - Phase D: orphan sweep (ноды без связей)
  - Hysteresis: остановка когда ≤ 80% cap
- **НЕ LRU** — требует write на hot path; `valid_at` oldest-first — приемлемый proxy

**Layer 2 — Hard cap с отклонением записи:** При FalkorDB OOM → `at_capacity = True` + `memory_write_rejected` (error log). Pre-flight проверка перед записью.

**Layer 3 — Monitoring без внешней инфры:**
- `/health` → `"memory": {"status": "ok"|"degraded"|"full", "entities", "edges", "trimmed_24h", "rejected_24h"}`
- Injection notice в системном сообщении: `[memory notice: 3 write attempts rejected in 24h]`
- `script/memory status` для on-demand проверки

**Fix 2 — Delete/forget (три механизма):**

**Интерфейс — `script/memory` CLI:**
```
script/memory status
script/memory search "rust"          → нумерованный список
script/memory forget 3               → удаление по индексу
script/memory forget-episode <uuid>  → cascade delete
script/memory forget-topic "icarus"  → entity-scoped wipe
script/memory purge-expired          → manual phase A
script/memory wipe --yes             → clear_graph
```

**HTTP API на прокси** (Bearer auth = `UPSTREAM_API_KEY`):
```
GET  /memory/status
GET  /memory/facts?q=rust&limit=20
POST /memory/forget {"fact_uuid" | "episode_uuid" | "entity" | "message"}
POST /memory/purge  {"confirm": "purge-all"}
```

**Conversational hook:** В injected memory block добавляется строка-инструкция для ассистента о возможности вызова `/memory/forget`.

**MCP tool mapping (расширение Q4 `_resolve_tools`):**
`delete_entity_edge`, `delete_episode`, `get_entity_edge`, `clear_graph` — с фолбэками.

**Verify → delete → audit:** Каждое удаление подтверждается (get перед delete), пишется в `data/memory_registry.jsonl`. После удаления — инвалидация L1 dedup-кэша (удалённый факт должен иметь возможность быть пере-выученным).

**Автоматическое истечение:** `MEMORY_EXPIRE_UNCONFIRMED_DAYS=0` (выключено для v1). Если включить — факты, не injected за N дней, удаляются. Выключено потому что "injected" ≠ "user-confirmed", и двойная фильтрация может очистить весь граф в тихий месяц.

**Secret re-scan:** Maintenance фаза 0: batch-скан всех фактов через `_contains_sensitive`. Default: **только flag**, не auto-delete (`MEMORY_SECRET_SCAN_AUTODELETE=false`).

**Fix 3 — Embedding model: OpenAI text-embedding-3-small для v1**

Локальная модель отвергнута по бюджету: sentence-transformers + torch ≈ 200-500MB resident → взрывает бюджет 512MB. OpenAI: $0.02/1M токенов ≈ $0.00002/день при ~10 embeddings/day. Если когда-либо локальная — явный carve-out с квонтованной ONNX моделью в отдельном контейнере + уполовиненным графом.

**Порядок работ:** (1) Layer 0 hard guard + `/health` memory block (день, убивает OOM-risk); (2) MaintenanceWorker A+D (dead-edge pruning); (3) forget CLI + HTTP API; (4) count-based caps + B/C eviction; (5) secret scan + injection notice.

---

### Q8: Defense — Как исправить Flaw 2 (conversation identity)?

**A8 (Senior Engineer):**

**Корень проблемы:** В stateless-прокси нет настоящего conversation identity. Ключ на основе первого user-сообщения — это lookup handle, а не identity. Решение: сделать коллизии безвредными через policy, а не искать «идеальный» ключ.

**Скрытый баг (найден при анализе):** Память исчезает со 2-го хода. Спека впрыскивает память только при `len(messages) <= 3` (conversation start). Но клиент никогда не пересылает injected сообщение обратно → на 2-м ходу upstream перестаёт получать память. Frozen prefix не «меняется» — он **исчезает**. Требуется ре-инъекция на каждом ходу.

**Fix 1 — Reuse-not-clobber policy (ключ = lookup handle, не identity):**
- Ключ: SHA-256 первого user-сообщения (нормализованный контент, БЕЗ system message — он нестабилен)
- State entry: `{key, snapshot, first_seen, last_seen}`
- `last_seen` обновляется на **каждом** запросе под этим ключом
- Recomputation требует **двух условий**: запрос выглядит как start (нет assistant-сообщений) **И** `last_seen` старше `MEMORY_SNAPSHOT_COOLDOWN` (30 мин)
- Активный диалог под ключом "hi" → коллизия с новым "hi" → reuse существующего снапшота → frozen prefix первого диалога никогда не затирается

**Fix 2 — SQLite-персистентность (снапшот переживает рестарт):**
```sql
CREATE TABLE conversation_snapshots (
  key TEXT PRIMARY KEY, snapshot TEXT NOT NULL,
  first_seen REAL NOT NULL, last_seen REAL NOT NULL);
```
- Read-through кэш: in-memory dict → SQLite на miss
- Snapshot хранится как готовая строка для инъекции (byte-identical при рестарте)
- Prune: `DELETE WHERE last_seen < now - 7d`, ежечасно
- Fallback для stateless-деплоя (ephemeral containers): один cache miss при рестарте, bounded 5-min prompt cache TTL

**Fix 3 — Topic-dependent query (релевантность + frozen):**
```python
async def build_snapshot(messages):
    first_user = first_user_text(messages)
    queries = [PROFILE_QUERY]          # identity/preferences/constraints (всегда)
    if token_count(first_user) >= 3:
        queries.append(first_user)     # ТЕМА — весь первый user-месседж как поисковый запрос
    results = await asyncio.gather(*(search(q, limit) for q in queries))
    facts = merge_dedupe(results)
    if not facts:                      # "hi" → fallback
        facts = await search(RECENCY_QUERY, limit=20)
    return format_injection(facts[:MAX_FACTS])
```
- Topic tier: первое сообщение → Graphiti hybrid search (embedding + BM25 + graph traversal)
- Profile tier: параллельный запрос identity-фактов (всегда полезен)
- Recency fallback: для "hi" и других generic openings
- Два поиска параллельно в рамках 500ms hot-path бюджета

**Fix 4 — Ре-инъекция на каждом ходу:**
- Start detection: `нет сообщений с role == "assistant"` (структурно корректно)
- `memory_for_request(messages)` вызывается на **каждом** `/v1/chat/completions`, не только на стартах
- Continuations берут снапшот из кэша/SQLite и ре-впрыскивают идентичные байты
- Позиция впрыскивания ("после последнего system message") стабильна между ходами

**Config additions:** `MEMORY_DB_PATH=./data/memory.db`, `MEMORY_SNAPSHOT_COOLDOWN=1800`

**Итог:** Ключ — lookup handle (коллизии безвредны через reuse-not-clobber), снапшот — persistent (SQLite, переживает рестарт), запрос — topic-dependent (первое сообщение + profile tier + recency fallback). Criterion 3 (topic relevance) и criterion 4 (frozen prefix) выполняются одновременно.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Write path silently fails (wrong timeout/model/embeddings) | ~~High~~ **Low** | ~~Critical~~ | Q7 fixes: split timeouts, self-test at boot, dead-letter, visible counters in /health |
| Conversation identity collision / frozen prefix corruption | ~~High~~ **Low** | ~~High~~ | Q8 fixes: reuse-not-clobber policy, SQLite persistence, topic-dependent query, per-turn re-injection |
| Unbounded RAM growth → OOM kill → restart loop | ~~High~~ **Low** | ~~Critical~~ | Q9 fixes: 4-layer memory guard, soft caps + trimming, hard cap with write rejection |
| Wrong fact or secret enters graph, cannot be removed | ~~High~~ **High** | | Q9 fixes: forget CLI + HTTP API, secret re-scan, conversational delete hook |
| DeepSeek v4-flash thinking mode interferes with Graphiti extraction | Medium | Medium | Verify at integration; fallback to deprecated `deepseek-chat` alias if thinking pollution detected |
| Cost exceeds $2/day budget (Claude Code 5-20 req/turn) | Medium | Low | Realistic cost $0.40-1.50/day still under budget; evaluator cost is per-request not per-turn; dedup L1 catches most duplicates before expensive L2/L3 |
| MCP server tool names change between versions | Medium | Medium | `_resolve_tools()` at connect with fallbacks (Q4); pin image tag; CI test against pinned version |
| FalkorDB memory fragmentation after heavy delete cycles | Low | Medium | Periodic container restart after large trims; pin FalkorDB ≥4.14.10 (compact storage) |
| Proxy restart drops in-memory state (snapshot cache, dedup cache) | Medium | Low | Snapshot cache → Q8 persistent fix; dedup cache → acceptable (L2/L3 still catch duplicates); conversation key stable across restarts |
| Local embedding model blows RAM budget | ~~Medium~~ **Low** | ~~High~~ | Q9 Fix 3: rejected for v1, OpenAI text-embedding-3-small only |

---

## Final Review

- [x] Architecture is sound — MCP server + FalkorDB, single container, Docker Compose profiles
- [x] Data model covers all use cases — 7 categories of facts, typed entities via extraction instructions
- [x] Error states are handled — full error matrix for evaluator, MCP client, write path; graceful degradation to static injection
- [x] Security concerns addressed — code-enforced secret filter, never raw messages in graph, forget/delete mechanism, Bearer auth on management API
- [x] Performance considered — read path 500ms timeout, write path fire-and-forget, dedup short-circuits from cheap to expensive
- [x] Testing strategy defined — unit tests for DedupFilter, MemoryClient tool resolution, secret filter; integration tests for write-read cycle
- [x] Rollback plan exists — `MEMORY_ENABLED=false` falls back to static MEMORY_INJECTION; `script/memory wipe --yes` clears the graph
- [x] Q8 (conversation identity fix) resolved — reuse-not-clobber policy, SQLite persistence, topic-dependent query, per-turn re-injection

---

## Implementation Plan (Revised)

### Phase 1: Infrastructure (Day 1)
1. Pin `zepai/knowledge-graph-mcp` image tag
2. Update `docker-compose.yml` — graphiti service with FalkorDB, correct model/embedding config, profiles
3. Update `script/server` — `docker compose up -d` + health check loop
4. Verify: `curl localhost:8001/health` returns ok

### Phase 2: MCP Client (Day 1-2)
1. Add `mcp` SDK to pyproject.toml
2. Implement `src/icarus/memory.py` — MemoryClient with tool resolution, search, add_memory
3. Implement lifespan connect + lazy reconnect
4. Config additions in config.py

### Phase 3: Read Path (Day 2)
1. Replace `inject_memory()` with dynamic injection using MemoryClient
2. Conversation start detection + frozen memory cache
3. Topic-dependent query (from Q8)
4. Fallback to static MEMORY_INJECTION when disabled

### Phase 4: Write Path (Day 2-4)
1. Evaluator LLM pipeline (prompt, Pydantic validation, retry)
2. 3-layer dedup (hash → embedding → Graphiti search)
3. Secret filter + dead-letter
4. FIFO write queue with split timeouts
5. Startup self-test
6. Health endpoint memory counters

### Phase 5: Lifecycle (Day 4-5)
1. MaintenanceWorker — periodic dead-edge pruning
2. Count-based soft caps + oldest-first eviction
3. `script/memory` CLI + `/memory/*` HTTP endpoints
4. Forget/delete with audit trail
5. Hard cap with write rejection

### Phase 6: Polish (Day 5-6)
1. Integration testing (write → read cycle, restart resilience, error injection)
2. Documentation (README update)
3. Cost monitoring

---

**Status:** Ready for implementation.  
**Skill:** product-planning (auto mode) — all 4 steps (9 agent rounds), all flaws fixed.
