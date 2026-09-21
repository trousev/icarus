# 08 — Скиллы LibreChat и pi: почему не доходили и как доехали

**Статус:** разбор + реализованный вариант B1 (синхронизация через Management API),
проверен на локальном стенде. **Дата:** 21.09.2026.
**Метод.** Цепочку проследил по нашему коду (`packages/service/src/**`, `packages/extensions/**`,
`docker/librechat/*`) и по исходникам pi 0.85.1 в `node_modules/@earendil-works/pi-coding-agent/dist/**`.
Поведение LibreChat — по официальным докам и по исходникам LibreChat на GitHub (ссылки в конце);
что взято из исходников, а не из документации, помечено отдельно. Что именно сделано — в §9.

---

## Короткий ответ

1. **До pi не доходило не только системного промпта — до него не доходило ничего, кроме текста
   последней реплики пользователя** (и картинок). Это не поломка: icarus сознательно берёт из запроса
   LibreChat только новую реплику, а всю историю, персону и тулы держит на стороне pi.
2. **Для кастомного эндпоинта (`Icarus` в `librechat.yaml`) LibreChat скиллы вообще не посылает.**
   Skills — способность эндпоинта **Agents**; в custom-чате их неоткуда взять.
3. Даже если разговор идёт через Agent, всё, что несёт скилл, отбрасывалось на входе в icarus:
   каталог скиллов едет в **system**-промпте агента, тело `SKILL.md` — отдельным **user**-сообщением
   (`isMeta`) **перед** последней репликой, а инструменты `skill` / `read_file` — в поле `tools`.
   icarus читает только последнюю пользовательскую реплику, `system` и `tools` не читает вообще.
4. **pi ищет скиллы в `~/.pi/agent/skills` и `<cwd>/.pi/skills`** (то есть `/home/node/.pi/agent/skills`
   и `/workspace/.pi/skills`), а icarus не заводил ни один из этих каталогов. «Внутренние скиллы pi» —
   это буквально пустые каталоги, отсюда и «ищет свои скиллы и не находит».
5. Формат скилла у LibreChat и у pi **один и тот же** (`SKILL.md` + frontmatter Agent Skills), поэтому
   починка — не мост протокола, а доставка файлов туда, где pi их видит. Сделали вариант B1:
   скиллы пишутся в UI LibreChat и синхронизируются в `~/.pi/agent/skills` (см. §9).

---

## 1. Что такое Skills в LibreChat и на каком эндпоинте они живут

Скиллы — «переиспользуемые инструкции» для **LibreChat Agents**: `SKILL.md` с frontmatter
(`name`, `description`, `always-apply`, `user-invocable`, `disable-model-invocation`, `allowed-tools`),
тело — процедура/правила. Авторство: UI (написать/загрузить), runtime-авторинг агентом, файлы из
`DEPLOYMENT_SKILLS_DIR`, синк из GitHub. ([docs][skills], [changelog v0.8.6][v086])

Активация: capability `skills` на эндпоинте `agents` → у агента включён **Enable skills** → выбран
скоуп (весь каталог / отдельные скиллы / только авторинг) → в разговоре скилл может быть выбран
вручную (`$`), выбран моделью (каталог) или применён всегда (`always-apply`).

Из этого следует важное: **скиллы подключены к цепочке Agents** (agnostic-каталог в
`api/server/services/Endpoints/agents/initialize.js`, регистрация тулов и обработчиков в
`packages/api/src/agents/*`). Custom-эндпоинт (наш `Icarus`) в этой цепочке не участвует — в его
запрос скиллы просто не попадают. *(Вывод из исходников LibreChat: PR #12649 меняет только
`agents`-ветку; в доках скиллы описаны исключительно через Agent Builder. Если у тебя в чате с
«Икар» есть панель Skills и `$` — значит, разговор идёт через Agent, и работает §3.)*

При этом **Agent может использовать кастомный эндпоинт как модель** — в `initialize.js` основная
конфигурация агента резолвится через `getCustomEndpointConfig` для не-`agents` эндпоинтов, и
«custom-endpoint agents» отдельно упомянуты в комментарии про цены. То есть сценарий «Agent с моделью
Icarus» возможен, и именно в нём до icarus доедет системный промпт со скиллами.

## 2. Что именно LibreChat кладёт в запрос

| Что | Как едет в `POST /v1/chat/completions` | Кем описано |
|---|---|---|
| Каталог скиллов (model-invoked) | секция `## Available Skills` приклеена к `additional_instructions` агента → **system-сообщение**; только `name` + `description` (≤100 скиллов, ~250 символов на запись) | `injectSkillCatalog` в [packages/api/src/agents/skills.ts][skills-src] |
| Ручной (`$`) и `always-apply` вызов | **полное тело `SKILL.md`** как `HumanMessage` с `additional_kwargs.isMeta = true`, вставляется **перед последней репликой пользователя** (`injectSkillPrimes`, `insertIdx = length - 1`) → в запросе это **user-сообщение** перед настоящей репликой | там же, `injectSkillPrimes` |
| Инструменты скиллов | `tools`: `skill` (всегда при включённых скиллах), `read_file` (всегда), `bash_tool` (если настроен code env) | PR #12649 |
| Файлы бандла | `references/…`, `scripts/…` в хранилище LibreChat под `skills/<name>/…`; при Code Interpreter монтируются в `/mnt/data/skills/<name>/…` | [docs][skills] |

Полезные лимиты: тела праймов — до 10 ручных и 20 always-apply за ход; каталог — до 100 записей.
Для модели это выглядит как «системный промпт + виртуальное user-сообщение + тул `skill`», а не как
файл на диске (файлы лежат в песочнице LibreChat, а не в контейнере человека).

## 3. Что делает icarus с этим запросом

`handleChatCompletions` ([openai.ts:223](packages/service/src/http/openai.ts)):

1. `const messages = body.messages` — [openai.ts:246](packages/service/src/http/openai.ts). Дальше
   `body.tools` **не читается нигде** (проверил grep'ом: поля `tools` в коде сервиса нет).
2. `extractLatestUserMessage(messages, incoming)` — [openai.ts:264](packages/service/src/http/openai.ts):
   берёт `[...messages].reverse().find(m => m.role === 'user')` — [openai.ts:160](packages/service/src/http/openai.ts) —
   и из него только текстовые блоки и `image_url` с data-URI —
   [openai.ts:170-192](packages/service/src/http/openai.ts). Всё остальное (`system`, предыдущие
   `user`, `assistant`, `tool`) не используется.
3. Сверка истории `compareHistory` тоже смотрит только роли `user`/`assistant` —
   «системные сообщения и служебное не считаем» ([divergence.ts:38-49](packages/service/src/sessions/divergence.ts)).
   То есть system-промпт не только не доезжает, но и в дифф не попадает.
4. Сессия pi поднимается с аргументами
   `--mode rpc --session-dir /workspace/.sessions --session-id … --model … --thinking …` —
   [pi-session.ts:15-28](packages/service/src/sessions/pi-session.ts). Ни `--system-prompt`,
   ни `--append-system-prompt`, ни `--skill` там нет.
5. Окружение человека готовит `prepareUser` — [workspace.ts:206](packages/service/src/workspace.ts):
   `AGENTS.md`, `icarus.md`, `auth.json`, `settings.json`, `mcp.json`, `models.json` и каталог
   `extensions` (копируется с очисткой, [workspace.ts:253-255](packages/service/src/workspace.ts)).
   **Каталога `skills` там нет** — слово `skills` в коде сервиса не встречается ни разу (кроме
   `--no-skills` в `one-shot.ts:34` и в `memory-extractor.ts:406`).
6. `runtime/users/<id>/pi-agent` монтируется в `/home/node/.pi/agent` —
   [compose.ts:90](packages/service/src/docker/compose.ts), `cwd` контейнера — `/workspace`
   ([docker/user/Dockerfile](docker/user/Dockerfile)).

Итог по слоям:

| Пришло от LibreChat | Что стало |
|---|---|
| system: инструкции агента + `## Available Skills` | выброшено (никто не читает `role: "system"`) |
| user (isMeta): тело `SKILL.md` | выброшено (берём только последнюю user-реплику) |
| user: настоящая реплика | уехало в pi как `prompt` |
| `tools`: `skill`, `read_file`, `bash_tool` | выброшено (pi живёт своими тулами и расширениями) |
| файлы скилла `/mnt/data/skills/…` | недоступны: это песочница LibreChat, не контейнер человека |
| вложения (картинки/файлы) | картинки — в модель, файлы — в `incoming/` (работает) |

**Ответ на «может, до pi вообще системный промпт LibreChat не доходит?» — да, не доходит, и это
принципиально.** Персона Икара живёт в `icarus.md` (+ `AGENTS.md`), история — в сессии pi, а промпт
LibreChat считается чужой копией разговора, нужной только для сверки расхождений.

> **Риск на будущее.** Сегодня спасает то, что прайм скилла (`isMeta`-сообщение) вставляется *перед*
> последней репликой. Это не контракт, а деталь реализации LibreChat: если прайм когда-нибудь
> окажется последним user-сообщением, icarus примет тело `SKILL.md` за реплику пользователя и
> «ответит на скилл». Стоит либо зафиксировать этот инвариант тестом на нашей стороне (игнорировать
> `isMeta`-подобные user-сообщения), либо не завязываться на него вовсе (вариант A).

## 4. Что ищет pi и почему находит пустоту

pi 0.85.1, каталог конфига `.pi`, агентский каталог `~/.pi/agent`
(`dist/config.js:403`, `CONFIG_DIR_NAME`/`getAgentDir`):

- скиллы по умолчанию ищутся в **`~/.pi/agent/skills`** (user scope) и **`<cwd>/.pi/skills`**
  (project scope) — `dist/core/resource-loader.js:623,629`;
- project scope загружается **только если проект «доверенный»** (`dist/core/resource-loader.js:811,822`);
  в RPC-режиме UI нет, поэтому `resolveProjectTrusted` при `defaultProjectTrust: "ask"` возвращает
  `false` (`dist/core/project-trust.js`). То есть `/workspace/.pi/skills` сам по себе не заработает —
  нужен `--approve`, запись в trust store или `defaultProjectTrust: "always"` в настройках pi;
- явный флаг **`--skill <path>`** (повторяемый; файл или каталог) и **`--no-skills`** —
  `dist/cli/args.js:142,164`, справка `dist/cli/args.js:295`;
- модель видит скиллы как `<available_skills>` (name, description, **location**) в системном промпте,
  и **сама читает `SKILL.md` своим `read`-тулом** — отдельного «skill tool» у pi нет
  (`formatSkillsForPrompt`, `dist/core/skills.js:275-298`).

У нас `~/.pi/agent` = `runtime/users/<id>/pi-agent`, и каталога `skills` там нет — как и
`/workspace/.pi/skills`. Оба источника пусты, поэтому pi честно отвечает, что скиллов нет.
Отдельно: `one-shot` (заголовки) и memory-экстрактор зовут pi с `--no-skills` — там это осознанно.

## 5. Почему это не «баг icarus»

LibreChat Skills спроектированы под **модель без рук**: LibreChat сам крутит tool-loop (`skill`,
`read_file`, `bash_tool`, code env), сам подкладывает каталог в промпт и сам исполняет вызов скилла.
pi — **сам себе агент**: у него свой цикл, свои тулы, своя память, своя персона.

Если попытаться «пробросить» скиллы LibreChat внутрь pi как есть, получится двойной агентский цикл:
LibreChat ждёт от icarus `tool_calls` (`skill`/`read_file`), icarus их не отдаёт и не должен — он
отдаёт готовый текст pi. Единственное, что физически переживает границу, — **текст** (промпт и
праймы), и именно его icarus сейчас сознательно выбрасывает.

## 6. Варианты

### A. Файловые скиллы там, где их видит pi (рекомендую)

- **A1. Общий каталог + копирование в pi.** Завести `skills/` в репозитории (или `config.skills.dir`),
  в `prepareUser` копировать в `~/.pi/agent/skills` — ровно тем же приёмом, что уже применён к
  `extensions` ([workspace.ts:253-255](packages/service/src/workspace.ts)). Каталог LibreChat-стенда
  получает тот же каталог через `DEPLOYMENT_SKILLS_DIR` (read-only, нужен рестарт LibreChat).
  *Плюсы:* один источник правды для обеих сторон, ноль изменений протокола, работает даже без
  `agents`-эндпоинта, user scope — без возни с project trust. *Минусы:* авторство в git, а не в UI;
  новый скилл подхватится при следующем старте сессии pi (сессии живут до `sessionIdleMinutes`,
  по умолчанию 30 минут; перезапуск — `docker compose restart`/пересборка окружения).
- **A2. `--skill /opt/icarus/skills` без копирования.** Монтируем общий каталог ro в контейнер
  человека и добавляем флаг в `piArgsFor`. *Плюсы:* дешевле (нет копии на человека).
  *Минусы:* каталог обязан существовать (иначе pi ругается ошибкой пути), содержимое не меняется
  без рестарта; для каждого человека всё равно свой маунт.

### B. Синхронизация скиллов, написанных в UI LibreChat

- **B1. Management API (выбрано и реализовано — см. §7).** В v0.8.6 есть `GET /api/agents/v1/skills`,
  `GET /api/agents/v1/skills/{id}`, `GET …/{id}/files[/{path}]`; аутентификация — OIDC machine token,
  привязанный к пользователю ([docs][agents-api]). Синк (по расписанию или при старте) забирает
  `SKILL.md` и файлы бандла и раскладывает их в каталог pi. *Плюсы:* UI остаётся местом авторства,
  ACL и версии уважаются. *Минусы:* нужен OIDC-провайдер и `endpoints.agents.managementApi` в конфиге
  LibreChat; клиент, креды, расписание; для удалённого инстанса — сеть наружу.
- **B2. Чтение Mongo** (`skills` + `skillfiles`). Без OIDC, но жёстко завязано на схему LibreChat и
  на доступ к его БД; для внешнего инстанса (память/прод) — самый хрупкий путь.

### C. Проброс системного контекста LibreChat в pi (патч icarus)

Собрать из входящего запроса то, что не является репликами (`system`-сообщения; опционально
`isMeta`-user-праймы) и отдать pi:
- стабильную часть — `--append-system-prompt` при старте сессии (сессия поднимается один раз на
  разговор, значит содержимое первого запроса зафиксируется до конца разговора);
- нестабильную — префиксом к очередной реплике («контекст из LibreChat: …»).

*Плюсы:* чинит не только скиллы — сейчас молча теряются `modelSpecs.promptPrefix` и инструкции
агента (всё, что LibreChat положил в system). *Минусы:* праймы LibreChat повторяются каждый ход
(sticky-семантика), каталог в промпте без tool-loop всё равно бесполезен, возможна путаница между
персоной `icarus.md` и чужим промптом, и это надо делать флагом конфига, а не по умолчанию.

### D. Осознанно не поддерживать LibreChat Skills

LibreChat = UI + история + панель памяти, агент и его скиллы = pi. Дешевле всего, но авторство
скиллов остаётся за git.

**Выбрали B1** — скиллы пишутся в UI LibreChat, icarus забирает их через Management API и
раскладывает в каталог pi. Ниже — как это сделано и что проверено.

## 7. Как это сделано (B1)

### Сторона icarus

| Место | Что делает |
|---|---|
| `packages/service/src/skills/librechat.ts` | Клиент Management API: `GET /api/agents/v1/skills`, `/{id}`, `/{id}/files[/{path}]`; токен статикой (`token`) или по client_credentials (`tokenUrl`+`clientId`+`clientSecret`) с кэшем до `exp`. |
| `packages/service/src/skills/sync.ts` | Материализация: `SKILL.md` (frontmatter из `name`/`description`/чужих ключей + `disable-model-invocation`) и текстовые файлы бандла; манифест `.icarus-skills.json` хранит `id`/`version`/`updatedAt`/`hash` и работает кэшем: тела перечитываются только у скиллов с изменившейся версией или датой, поэтому **обычный проход — ровно один запрос к LibreChat, за списком**; удаление того, что убрали в LibreChat; идемпотентно — одинаковый набор не пишет ничего. |
| `packages/service/src/skills/service.ts` | Расписание (сразу при старте и раз в `intervalSeconds`, по умолчанию 300 с), авторизация по людям (`accounts`), лог, и главное — `registry.bumpResources(user)` только когда набор реально изменился. |
| `packages/service/src/sessions/registry.ts` + `pi-session.ts` | Поколение ресурсов: у сессии есть `generation`, при `acquire` устаревшая (и не занятая) сессия пересоздаётся. Идущий ход не рвём — он доигрывает на старом каталоге, а следующий запрос поднимает свежий pi. История не теряется: она в `/workspace/.sessions` и открывается по `--session-id`. |
| `packages/service/src/config.ts` | Секция `skills.sync` (`url`, `intervalSeconds`, `audience`, `token`/`tokenUrl`/`clientId`/`clientSecret`, `accounts`). Пустой `url` (не подставилась переменная) = синхронизация выключена. |
| `packages/extensions/persona.ts` + `lib/skills-core.ts` | **Важно.** Персона заменяет системный промпт pi целиком, а pi добавляет каталог скиллов только в свой сборщик промпта — то есть до правки каталог терялся. Теперь персона дописывает блок `<available_skills>` сама (тот же формат, что у pi: имя, описание, путь; только если есть `read`/`bash`). |

### Сторона стенда

- `docker/librechat/librechat.yaml`: включён `endpoints.agents.managementApi` (OIDC `http://localhost:9100`,
  audience `icarus-skills`, привязка `clientId: icarus-sync` → `userId`/`tenantId` пользователя стенда).
- `docker/librechat/oidc-stub/server.mjs`: OIDC-заглушка для локального стенда (JWKS + discovery +
  `POST /token` по client_credentials, ключ генерируется сам в `docker/librechat/oidc-data/`).
  В бою вместо неё — настоящий провайдер.
- `compose.ts`: заглушка поднимается двумя экземплярами с одним ключом подписи — внутри контейнера
  LibreChat (тот видит её как `http://localhost:9100`: по http LibreChat пускает только к localhost,
  и заодно заглушка переживает пересоздание LibreChat) и обычным сервисом `oidc` в сети compose
  (у него icarus берёт токен). Сервис icarus получает переменные `ICARUS_LIBRECHAT_URL`,
  `ICARUS_SKILLS_*`, на которые ссылается `skills.sync` в `config.yaml`.
- `script/librechat-skills-bind`: подставляет в рабочую копию конфига ObjectId и тенант пользователя
  стенда; зовётся сам из `./script/server --with-librechat` до `up` и после него (в git лежит только
  шаблон с заглушкой — ObjectId живёт в томе Mongo).
- `script/server`: заранее создаёт `docker/librechat/oidc-data` (иначе docker сделает каталог
  root-овым) и предупреждает, пока привязка не заполнена.

### Как проверить на стенде

1. `./script/server --with-librechat -d` — стек вместе со стендом и заглушкой.
2. Завести пользователя LibreChat (регистрация в UI или `POST /api/auth/register`), при желании
   сменить пароль: `./script/regenerate_user_passwords <пароль>`.
3. Ничего привязывать руками не нужно: `./script/server --with-librechat` делает это сам.
   Стенд монтирует не шаблон `docker/librechat/librechat.yaml`, а его рабочую копию
   `librechat.local.yaml` (в git не попадает): её заводит `compose-write` из шаблона, а скрипт
   `script/librechat-skills-bind` подставляет в неё `userId`/`tenantId` — берёт первого человека
   из `users` в `config.yaml` (можно позвать и вручную: `./script/librechat-skills-bind [имя|ObjectId]`,
   флаги `--file/--ensure/--quiet/--no-restart`). Привязка ставится до `up`, а если Mongo на тот
   момент ещё не поднят — сразу после: LibreChat перезапускается, потому что читает конфиг только
   на старте (иначе привязка лежит в файле, а в памяти остаётся старая, и Management API отвечает 401).
   Тенант `__SYSTEM__` Management API запрещает явно, а `${VAR}` в `managementApi` не
   подставляется — только литеральный ObjectId, поэтому и рабочая копия, а не переменные.
4. Написать скилл в UI (Skills → «+» → Write skill instructions) или через API
   `POST /api/skills` с браузерным JWT (`POST /api/auth/login`).
5. Через один проход (по умолчанию до 5 минут; после неудачного прохода сервис повторяет через
   15 секунд, так что гонка на старте стека рассасывается сама) в логе icarus появится `скиллы обновлены`, а на хосте —
   `runtime/users/<id>/pi-agent/skills/<name>/SKILL.md`. Дальше Икар читает скилл сам.

### Что проверено живьём (21.09.2026, стенд в этом worktree)

- Скилл, созданный в LibreChat, доехал до `~/.pi/agent/skills` внутри контейнера человека
  (и до `pi.getSkills()` — без диагностик).
- Кэш живёт как задумано: проход без изменений не пишет ни файлов скиллов, ни манифеста
  (проверено по mtime и md5), правка скилла в UI (`version` 2 → 3 → 4) перечитывается и
  доезжает, а пропавший с диска `SKILL.md` восстанавливается, даже если версия не менялась.
- В системном промпте pi появился блок `<available_skills>` с именем, описанием и путём.
- Икар на вопрос «какое кодовое слово у скилла pirate-mode» прочитал `SKILL.md`
  (`read` на `/home/node/.pi/agent/skills/pirate-mode/SKILL.md` виден в сессии pi) и ответил
  кодовым словом, которое существует только внутри файла; требование скилла «заканчивать ответ
  строкой 🏴☠️ Йо-хо-хо, сухопутный!» выполнено.
- Правка скилла в UI (version 1 → 2) доехала и перезапустила сессию; удаление скилла убрало
  каталог из pi; повторный проход с тем же набором ничего не переписывает (сессии не дёргаются).
- `./script/test` — 284 теста, включая `skills-sync.test.ts` и `skills-prompt.test.ts`;
  `./script/lint` (tsc + eslint) чисто.

## 8. Что осталось за кадром

- **Боевой LibreChat.** Нужен `managementApi` с настоящим OIDC-провайдером (issuer/audience + привязка
  клиента к пользователю LibreChat). Скиллы появляются в UI с v0.8.6; на стенде стоит `v0.8.8-rc3`.
- **Один токен = один набор скиллов.** Если `accounts` пуст, все люди получают набор того
  пользователя LibreChat, к которому привязан машинный клиент. Личные наборы — через `accounts`.
- **`always-apply` не переносится.** В LibreChat это «праймить скилл каждый ход»; в pi каталог
  работает иначе — модель читает `SKILL.md`, когда задача совпала с описанием. Ключ
  `always-apply` остаётся в frontmatter как справка, но поведения не меняет.
- **Файлы бандла** переносятся только текстовые: бинарные (`assets/*.png`) API не отдаёт,
  синхронизация их пропускает с предупреждением в логе.
- **Горячая перезагрузка** делается перезапуском сессии pi (см. `generation`), а не перечитыванием
  каталога на лету: pi читает скиллы при старте процесса.
- Точная версия и раскладка твоего боевого LibreChat (Agents включены? тенантность есть?) —
  проверяется на месте по §7.

## Источники

- [LibreChat Skills (docs)][skills] — режимы вызова, frontmatter, лимиты, deployment skills, sync.
- [LibreChat v0.8.6 changelog][v086] — «Agent Skills» в релизе.
- [PR #12649, Skill runtime integration][pr] — каталог в `additional_instructions`, тулы
  `skill`/`read_file`/`bash_tool`, праймы как `isMeta` HumanMessage, файлы в code env.
- [Agent Management API][agents-api] — skill-роуты `GET /api/agents/v1/skills…`.
- [LibreChat Agents (docs)][agents] — скиллы включаются у агента; [Compatibility Matrix][compat] —
  «Agents» как самый полный эндпоинт.
- pi 0.85.1 (`node_modules/@earendil-works/pi-coding-agent/dist/**`) — пути поиска скиллов,
  `--skill`/`--no-skills`, project trust, `formatSkillsForPrompt`.

[skills]: https://www.librechat.ai/docs/features/skills
[skills-src]: https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/agents/skills.ts
[v086]: https://www.librechat.ai/changelog/v0.8.6
[pr]: https://github.com/danny-avila/LibreChat/pull/12649
[agents-api]: https://www.librechat.ai/docs/features/agents_api
[agents]: https://www.librechat.ai/docs/features/agents
[compat]: https://www.librechat.ai/docs/compatibility
