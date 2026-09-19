# Icarus

Агент для семьи из 2–5 человек: **хорош в обычном разговоре**, но умеет всё взрослое — читать и править файлы,
искать в интернете, вызывать MCP-инструменты и **помнить**. Наружу выглядит как обычный OpenAI-эндпоинт,
внутрь смотрит LibreChat.

Устроен как тонкий сервис поверх [pi](https://github.com/earendil-works/pi) — открытого агентского харнесса.
Своего цикла агента мы не пишем: pi живёт в контейнере пользователя, а icarus только превращает OpenAI-протокол
в живую сессию и обратно.

## Как это выглядит

```
LibreChat ──OpenAI API──► icarus ──docker exec + JSONL──► pi в контейнере человека
                            │                                   │
                            │                                   ├─ персона        (icarus.md)
                            │                                   ├─ ядро памяти    (память всегда под рукой)
                            │                                   ├─ разбор         (факты → полки → git)
                            │                                   ├─ веб-поиск      (web_search, web_fetch)
                            │                                   ├─ MCP            (pi-mcp-extension)
                            │                                   └─ эскалация      (быстро / сильно / зрение)
                            └─ панель памяти (просмотр, поиск, откат, забывание)
```

## Что уже работает

- разговор через `POST /v1/chat/completions` со стримом и отменой;
- память между разговорами: ядро в промпте, фоновый разбор после затишья, git-коммит на каждый разбор;
- изоляция: свой контейнер, своя память, свой ключ на человека; общая память — только по явной просьбе;
- вложения из чата: картинки уходят модели нативно, файлы ложатся в `incoming/`;
- веб-поиск и MCP-серверы без правки кода;
- эскалация моделей: болтовня на быстрой, работа на сильной, картинки на зрячей;
- панель памяти: смотреть, искать, откатывать коммит, забывать строку.

## Запуск

```bash
# 1. зависимости и локальные конфиги (запускать после clone и после каждого git pull)
./script/update
# он создаст config.yaml из config.example.yaml — поправить людей, модели и пути;
# ключи провайдеров кладутся в packages/service/.env (см. .gitignore)

# 2. образ контейнера пользователя (./script/server тоже умеет его собирать)
docker build -t icarus-user:dev docker/user/

# 3. стек: ./script/server собирает docker-compose.yml из config.yaml и поднимает его
./script/server                     # icarus на :8080, логи в консоли (Ctrl-C гасит стек)
./script/server -d                  # то же в фоне: переживёт и терминал, и перезагрузку
./script/server --with-librechat    # он же + стенд LibreChat на :3090
./script/server --down              # погасить стек

# панель памяти
open 'http://localhost:8080/panel?key=<panelKey>'
```

`./script/server` не запускает процесс, а **собирает `docker-compose.yml`** из `config.yaml`:
сервис icarus, по контейнеру на человека и, по флагу, стенд LibreChat. Сам icarus тоже едет
в контейнере (образ `icarus-service:dev` из `docker/service/`, собирается автоматически).
Жизненным циклом владеет docker, а не сервис: `restart: unless-stopped` возвращает контейнеры
и после падения, и после перезагрузки машины, а смена образа, маунтов или окружения
пересоздаёт их при следующем запуске. Сгенерированный `docker-compose.yml` в git не попадает;
правки в коде доезжают после `docker compose restart icarus` — репозиторий примонтирован.

Порядок запуска выбран ради меньшего простоя при обновлении: сначала `docker compose build`
и сборка образа человека — **пока старые контейнеры ещё работают**, и только потом `up`,
которому остаётся пересоздать изменившееся. Поэтому собирать образ руками (шаг 2) не обязательно:
`./script/server` делает это сам, а `--build` повторяет сборку без кеша.

Первый запуск после перехода со старой схемы: погаси icarus, запущенный обычным процессом на
хосте (`node packages/service/src/index.ts …`) — он держит :8080 и пересоздаёт контейнеры мимо
compose. `./script/server` один раз снесёт контейнеры без метки проекта и поднимет их заново.

## Конфиг

Один файл — `config.yaml` в корне (образец `config.example.yaml`, рабочий файл в git не попадает):

```yaml
apiKey: icarus-local-token      # Bearer, под которым ходит LibreChat
dataDir: ~/icarus-data          # память, сессии и каталоги людей

models:                         # общие модели: tier раздаёт эскалация
  - { provider: deepseek, id: deepseek-v4-flash, thinking: off, tier: fast }
auth: { deepseek: env:DEEPSEEK_API_KEY }   # ключи: сам ключ, env:VAR или ${VAR}
mounts: []                      # каталоги с хоста — пока общие для всех
mcp: {}                         # MCP-серверы

users:                          # люди: только id
  - probe
  - probe2
```

Человек описывается одним id: из него выводятся имя контейнера (`icarus-user-probe`), каталоги
`dataDir/users/probe` и id сессии pi. Тот же id должен быть у человека в LibreChat — он приезжает
заголовком `x-icarus-user-id`. Модели, ключи и MCP общие, так что новый человек — это одна строка.

## Команды

| команда | что делает |
| --- | --- |
| `./script/update` | ставит зависимости через pnpm и раскладывает конфиги из примеров; в CI — строго по lockfile |
| `./script/test` | гоняет тесты (`node --test`) по всем `packages/**/*.test.ts` — обходом дерева, чтобы тест из нового каталога не выпал из прогона молча; докер и модель не нужны, `ICARUS_E2E=1` включает сценарные |
| `./script/lint` | `tsc --noEmit` + `eslint` + `shellcheck` по `script/*` (можно по отдельности: `./script/lint tsc`, `./script/lint eslint`, `./script/lint shell`) |
| `./script/server` | собирает `docker-compose.yml` из `config.yaml`, сначала пересобирает образы, потом поднимает стек через `docker compose up`; `-d` уводит в фон, `--with-librechat` добавляет стенд, `--build` собирает без кеша, `--down` гасит стек |
| `./script/regenerate_user_passwords <пароль>` | сбрасывает пароли всех пользователей локального стенда LibreChat на заданный (в базе от них только bcrypt-хеши, восстановить забытый нельзя) |

Те же команды доступны через pnpm: `pnpm test`, `pnpm lint`, `pnpm start`. Установка — только
`./script/update`: у pnpm `pnpm update` означает другое (обновление версий зависимостей).

## Стенд LibreChat

`./script/server --with-librechat` поднимает рядом с icarus стенд LibreChat на `:3090`
(контейнеры `icarus-librechat` и `icarus-librechat-mongo`, база — в томе `icarus_mongo-data`).
Логинов в репозитории нет: пользователей заводят руками через UI, и в базе от них остаётся
только bcrypt-хеш пароля, поэтому забытый не восстановить. Имя пользователя должно совпадать
с id из `users` в `config.yaml` — оно приезжает в icarus заголовком `x-icarus-user-id`.
Перезаписать пароли сразу всем пользователям стенда:

```bash
./script/regenerate_user_passwords 'новый-пароль'
./script/regenerate_user_passwords - < пароль.txt   # пароль со stdin, чтобы не светить в истории
```

## Проверки

На каждый PR и на push в `main` крутится [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
`./script/lint` и `./script/test` на node 22 и 24. Локально ровно то же самое:

```bash
./script/lint && ./script/test
```

`eslint` идёт с базовым набором правил самого ESLint (`js.configs.recommended`) и с node-глобалями
для `.js`/`.mjs` — иначе правила typescript-eslint не ловят ни `no-duplicate-case`, ни
`no-fallthrough`, ни `no-useless-assignment`. `shellcheck` нужен только шагу `shell`: машина без
него получит предупреждение и пропуск, а CI упадёт, потому что в ubuntu-образе GitHub он есть
из коробки.

`main` защищена настройками ветки, а не уговорами:

- прямой push запрещён, включая админский (`enforce_admins`) — только PR;
- merge PR заблокирован, пока не позеленели все четыре проверки CI (job'ы `lint` и `test`
  на node 22 и 24);
- свежесть ветки PR относительно `main` не требуется: проверки гоняются на самом PR, а
  догонять `main` — забота автора (`strict` в required status checks выключен осознанно);
- force-push и удаление `main` запрещены.

Имена job'ов и матрица — часть этой защиты. Меняешь `name` в `ci.yml` — обнови required status
checks в настройках ветки, иначе PR навсегда повиснет на «Expected — Waiting for status to be
reported».

Сборки нет: код исполняется напрямую как TypeScript (`node src/index.ts`), поэтому `tsc` работает
только проверяльщиком и ничего не пишет на диск. TypeScript пока 6.x — typescript-eslint ещё не
умеет 7-ю ветку, так что при обновлении зависимостей это ограничение стоит держать в голове.

## Устройство репозитория

```
script/               команды разработчика: update, test, lint, server, regenerate_user_passwords
packages/service/     сервис: HTTP, сессии pi, контейнеры, панель памяти
packages/extensions/  расширения pi, которые живут в контейнере пользователя
docker/user/          образ контейнера пользователя
docker/service/       образ самого icarus: node, git и клиент docker
docker/librechat/     стенд для проверки стыка с LibreChat
docker-compose.yml    стек, который собирает ./script/server (в git не попадает)
specs/                спеки этапов
tools/rpc-probe.mjs   отладочный клиент к pi по RPC
```

## Документы

- [`PLAN.md`](PLAN.md) — план, решения интервью, итоги этапов M0–M3 и найденные грабли.
- [`specs/M1-service.md`](specs/M1-service.md) — границы и критерии готовности сервиса.
- [`icarus.md`](icarus.md) — характер Икара, он же системный промпт.

## Лицензия

MIT.
