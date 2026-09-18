# M1 — сервис icarus

## Цель

LibreChat разговаривает с Икаром как с обычной моделью: стрим, отмена, история, вложения. За каждым
разговором стоит живая сессия pi внутри контейнера пользователя. Память между разговорами сохраняется.

## Границы

**Входит:** HTTP-фасад под OpenAI, реестр сессий, управление контейнерами, генерация `AGENTS.md` и `auth.json`,
трансляция активности тулов в `reasoning_content`, отмена по обрыву, сверка истории с логом диффов,
расширение-персона, контрактные и интеграционные тесты.

**Не входит:** экстрактор памяти, ядро памяти в промпте, мини-панель, веб-поиск, MCP, egress-политика, квоты,
работа с кодом в репозиториях.

## Структура репозитория

```
packages/
  service/                     # сам icarus
    src/
      index.ts                 # точка входа
      config.ts                # разбор icarus.config.json
      http/server.ts           # http-сервер и аутентификация
      http/openai.ts           # /v1/models, /v1/chat/completions
      http/sse.ts              # упаковка в OpenAI-чанки
      sessions/registry.ts     # (user, conversation) → сессия, TTL, очередь
      sessions/pi-session.ts   # жизненный цикл pi-процесса
      sessions/rpc-client.ts   # JSONL по stdio через docker exec
      sessions/divergence.ts   # сверка истории, дифф в лог
      reasoning.ts             # события тулов → человеческие фразы
      docker/manager.ts        # контейнер на пользователя (dockerode)
      workspace.ts             # AGENTS.md, auth.json, incoming/
  extensions/                  # наши расширения pi (persona, …)
docker/
  user/Dockerfile              # уже собран и проверен
specs/M1-service.md            # этот файл
tools/rpc-probe.mjs            # отладочный клиент (уже есть)
```

## HTTP-контракт

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/healthz` | живость + статус контейнеров |
| `GET` | `/v1/models` | одна модель, id `icarus` |
| `POST` | `/v1/chat/completions` | основной маршрут, `stream` поддержан |

**Идентичность.** Заголовки от LibreChat: `x-icarus-user-id` ← `{{LIBRECHAT_USER_ID}}`,
`x-icarus-conversation-id` ← `{{LIBRECHAT_BODY_CONVERSATIONID}}`. Фолбэки: `body.user`, иначе
`sha1(первое сообщение)`. Неизвестный пользователь → `403` и запись в лог.

**Аутентификация.** Один общий `Bearer`-токен из конфига (его же указываем в `librechat.yaml`).

**Вложения.** Части `image_url` с data-URL раскодируются в `/workspace/incoming/<uuid>.<ext>`; в текст реплики
добавляется строка «Пользователь приложил файл: <путь>». Дальше агент сам решает — pi умеет читать и картинки.

## Сессии

- Ключ — `(user_id, conversation_id)`. Один pi-процесс на разговор: `docker exec -i <c> pi --mode rpc
  --session-dir /workspace/.sessions/<conversation_id>` — так разговор переживает перезапуск сервиса.
- **Занят:** один ход на сессию. Пока идёт стрим, второе сообщение получает `409` и лог.
- **Простой:** процесс гасится через N минут без запросов; контейнер остаётся поднятым.
- **Сверка истории (решение 14):** перед ходом сравниваем присланную историю с `get_messages`. Совпал префикс —
  просто подаём новую реплику. Разошлось — пишем дифф в `logs/divergence/<conversation>.log` и продолжаем
  **свою** сессию (правки и регенерации в UI не откатывают память Икара — это осознанно).

## Стриминг, отмена, видимость

- Текст: `message_update.text_delta` → `choices[].delta.content`.
- Активность: `tool_execution_start/end` → короткие фразы в `choices[].delta.reasoning_content`
  («читаю `memory/identity.md`», «правлю `preferences.md`», «выполняю команду»). Реальные размышления модели,
  если включены, идут туда же.
- Финал: чанк с `finish_reason: "stop"`, затем `data: [DONE]`; `usage` — из статистики сессии pi.
- **Отмена:** `res.on('close')` при `writableEnded === false` → `{"type":"abort"}` в pi (проверено в M0).

## Конфигурация

`icarus.config.json`:

```jsonc
{
  "host": "0.0.0.0",
  "port": 8080,
  "apiKey": "…",                                   // Bearer для LibreChat
  "docker": { "image": "icarus-user:dev", "socket": "http://docker-socket-proxy:2375", "network": "icarus" },
  "sharedMemory": "~/icarus/shared",              // общая память семьи (git)
  "users": [
    {
      "id": "trousev",
      "name": "Саня",
      "memory": "~/icarus/users/trousev/memory",  // личная память (git)
      "mounts": [{ "host": "~/src/scratchpad", "container": "/workspace/scratchpad", "mode": "rw" }],
      "models": [
        { "provider": "deepseek", "id": "deepseek-v4-flash", "thinking": "off", "tier": "fast" },
        { "provider": "deepseek", "id": "deepseek-v4-pro",   "thinking": "medium", "tier": "strong" }
      ],
      "auth": { "deepseek": "env:DEEPSEEK_API_KEY" }
    }
  ]
}
```

Из этого сервис генерирует `models.json` и `auth.json` в примонтированный `~/.pi/agent` и `AGENTS.md`
с картой окружения. Ключи в логи не попадают никогда.

## Готово, когда

1. ✅ LibreChat на стенде получает стриминговый ответ от icarus (эхо-сервер больше не нужен).
2. ✅ Два пользователя — два контейнера, две независимые памяти; общая память общая.
3. ✅ Разговор продолжается между запросами, а правка сообщения в UI даёт дифф в логе и не ломает сессию.
4. ✅ Отмена в UI реально останавливает агента (видно по логу и по `abort` в pi).
5. ✅ Вложение из чата оказывается в `incoming/`, и агент может его прочитать.
6. ✅ Перезапуск сервиса не теряет разговоры (`--session-id` + `--session-dir`).
7. ✅ `npm test`: 36 тестов — контракт формы, сверка истории, фразы тулов, вложения, RPC на заглушке, HTTP целиком.

**Уточнения, найденные при реализации** (в спеке было иначе — оставляю как историю решений):

- сверка истории идёт по репликам **пользователя**, а не по всем: ответы pi дробятся тулами, LibreChat их
  склеивает, и построчное сравнение давало ложные расхождения на каждом ходу;
- `usage` отдаётся только при `stream_options.include_usage`, первый чанк несёт `delta.role`;
- идентичность по умолчанию берём из `{{LIBRECHAT_USER_USERNAME}}` (в конфиге стенда), а не из id — так удобнее
  заводить людей; заголовок всё равно настраивается.

## Риски

Молодой API pi (пины версий, вся логика — в расширениях и одном слое `rpc-client`); гонки при обрыве
и одновременных запросах (закрываем тестами на заглушке); утечка памяти в пуле процессов (TTL и метрики).
