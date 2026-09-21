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
- эскалация моделей: болтовня, поиск и чтение — на быстрой, работа руками (bash, правки, MCP) — на сильной, картинки — на зрячей;
- панель памяти: личная ссылка от Икара — смотреть, искать, откатывать коммит, забывать строку.

## Запуск

```bash
# 1. зависимости и локальные конфиги (запускать после clone и после каждого git pull)
./script/update
# он создаст config.yaml из config.example.yaml — поправить людей, модели и пути;
# ключи провайдеров кладутся в .env (образец .env.example, в git не попадает)

# 2. образ контейнера пользователя (./script/server тоже умеет его собирать)
docker build -t icarus-user:dev docker/user/

# 3. стек: ./script/server собирает docker-compose.yml из config.yaml и поднимает его
./script/server                     # icarus на :8081, логи в консоли (Ctrl-C гасит стек)
./script/server -d                  # то же в фоне: переживёт и терминал, и перезагрузку
./script/server --with-librechat    # он же + стенд LibreChat на :3090
./script/server --down              # погасить стек

# панель памяти: общего ключа нет — попроси у Икара личную ссылку
# («дай ссылку на управление памятью»), она живёт сутки и открывает только твою память
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
хосте (`node packages/service/src/index.ts …`) — он держит :8081 и пересоздаёт контейнеры мимо
compose. `./script/server` один раз снесёт контейнеры без метки проекта и поднимет их заново.

## Конфиг

Конфиг — `config.yaml` в корне (образец `config.example.yaml`, рабочий файл в git не попадает):

```yaml
apiKey: icarus-local-token      # Bearer, под которым ходит LibreChat
# url: https://memory.trousev.pro/   # внешний адрес панели для личных ссылок Икара
                                    # (локально по умолчанию http://localhost:8081)
dataDir: ~/icarus-data          # память, сессии и каталоги людей

models:                         # общие модели: tier раздаёт эскалация
  - { provider: deepinfra, id: deepseek-ai/DeepSeek-V4.1-Flash, thinking: off, tier: fast }
# auth: { deepinfra: env:DEEPINFRA_API_KEY }   # обычно не нужно: ключ подхватится из .env
mounts: []                      # каталоги с хоста — пока общие для всех
mcp: {}                         # MCP-серверы

users:                          # люди: только id
  - probe
  - probe2
```

Провайдер `deepinfra` — не встроенный в pi, поэтому его описание (базовый адрес, протокол,
ключ, метаданные моделей) живёт в `packages/service/src/providers.ts` и уезжает в
`models.json` контейнера. В `config.yaml` остаётся только выбор: провайдер, id модели,
уровень размышлений и tier.

Ключи живут в `.env` в корне (образец — `.env.example`, рабочий файл в git не попадает и
создаётся `./script/update`):

```bash
DEEPINFRA_API_KEY=...     # ключ провайдера из models: кроме окружения, попадает в auth.json
TAVILY_API_KEY=...        # ключ веб-поиска: серверного поиска у DeepInfra нет
BRAVE_API_KEY=...         # необязательная альтернатива: ICARUS_SEARCH_PROVIDER=brave
```

Ключ провайдера из `models`, для которого в `.env` нашлось значение, подставляется сам:
дублировать его в `config.yaml` не нужно. Блоки `auth:` и `env:` остаются для переопределения
и для провайдеров, которых нет в списке известных (`PROVIDER_ENV` в
`packages/service/src/config.ts`). Окружение сильнее файла: `export DEEPINFRA_API_KEY=…`
перебьёт строку в `.env`. После правки `.env` хватит `./script/server` — compose пересоздаст
контейнеры; сами значения в `docker-compose.yml` не пишутся, туда едет только путь к файлу.

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
| `./script/redeploy` | боевой деплой на trousev.pro: его зовёт workflow, руками — уже на хосте (`--no-cache` собирает образы с нуля) |
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

## Деплой

Прод — `trousev.pro`: чекаут в `~/deployments/icarus` и стек `docker compose`, который
поднимает `./script/server -d`. LibreChat живёт рядом и деплоится отдельно — этот
workflow его не трогает, поэтому `--with-librechat` на проде не используется.

Push в `main` запускает [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
GitHub по SSH заходит на `trousev.pro` под `trousev`, обновляет чекаут (`git fetch` +
`git reset --hard origin/main`) и зовёт [`./script/redeploy`](script/redeploy). Тот
ставит node, если на хосте он старее 22.19 (официальная сборка в `~/.local/share/icarus`),
гоняет `./script/update`, переносит секреты в `.env`, правит `config.yaml` через
`render-config.ts` (люди, порт, `dataDir`, `apiKey`), поднимает стек и падает, если
`/healthz` не подтвердил, что сервис и контейнеры людей на месте. Руками то же самое:
`ssh trousev@trousev.pro`, `cd ~/deployments/icarus`, `./script/redeploy` (`--no-cache`
собирает образы с нуля).

`config.yaml` и `.env` на хосте деплой переживают — они в git не попадают. А вот
правки трекаемых файлов `git reset --hard` стирает: код на проде меняется только через PR.

Настройки прода живут в GitHub:

| имя | где | что |
| --- | --- | --- |
| `ICARUS_USERS` | переменная environment `production` | люди через пробел или запятую — из неё собирается `users:` в `config.yaml` |
| `ICARUS_DNS` | необязательная переменная environment `production` | DNS-серверы контейнеров (`docker.dns`); не задана — дефолт из `script/redeploy`, `none` — убрать |
| `ICARUS_URL` | необязательная переменная environment `production` | внешний адрес панели памяти (`url`) для личных ссылок Икара; на проде `https://memory.trousev.pro/`, локально по умолчанию `http://localhost:8081`; пусто — прежнее значение из `config.yaml` |
| `ICARUS_API_KEY` | секрет environment `production` | Bearer, под которым LibreChat ходит в icarus (`apiKey` в `config.yaml`) |
| `DEEPINFRA_API_KEY` | секрет environment `production` | ключ провайдера — уезжает в `.env` |
| `TAVILY_API_KEY` | секрет environment `production` | ключ веб-поиска — тоже уезжает в `.env` |
| `DEPLOY_HOST` | секрет environment `production` | `trousev.pro` |
| `DEPLOY_SSH_SECRET` | секрет environment `production` | приватный ключ `github-actions-deploy@icarus`; его публичная часть — в `~/.ssh/authorized_keys` на хосте |

Секреты лежат именно в environment `production`, а у него правило «разрешена только
ветка `main`»: репозиторий публичный, и секреты уровня репозитория читала бы любая ветка.

`ICARUS_USERS` — это **username из LibreChat**, а не имя человека: заголовок
`x-icarus-user-id`, которым LibreChat зовёт icarus, собирается из него
(`{{LIBRECHAT_USER_USERNAME}}` в `librechat.yaml`). Поэтому на проде там
`alexander vitaliia julia`, а не короткие `trousev vita julia` — с чужим id icarus
отвечает 403 «пользователь … не заведён в конфиге», и человек не может поговорить.
Проверить, кого видит icarus, можно по `/healthz`: он отдаёт `users` и состояние
контейнеров (`missing` должен быть 0).

Прод-специфику деплой подставляет сам: `dataDir` внутри чекаута (`runtime/`, в git не попадает).
Порт `8081` — общий дефолт (`config.example.yaml` локально и `script/redeploy` на проде): он выбран
потому, что на прод-хосте `8080` занят jitsi-jvb, а локально удобнее тот же порт, что в бою. По той же
причине endpoint Icarus в LibreChat на проде — `http://host.docker.internal:8081/v1` с ключом
`ICARUS_API_KEY`; `librechat.yaml` правится вместе с деплоем LibreChat, а не здесь.

Отдельная грабля хоста — резолвер. Docker отдаёт контейнерам серверы из `/etc/resolv.conf`
хозяина, и если локальный резолвер не пускает docker-подсети, каждый внешний запрос
сначала ждёт таймаут. Так, `unbound` с `access-control` только на `127.0.0.0/8` и
`10.0.0.0/8` отвечает контейнерам (они в `172.16.0.0/12`) `REFUSED`, Docker ждёт ~4 с и
только потом уходит на следующий сервер — резолв `api.deepinfra.com` из контейнера занимает
**4 секунды вместо 0,02**, и это платит каждый вызов pi к модели (ходы 4,8 и 11,2 с против
1,2 и 1,5 с локально). Проверка одной командой:
`docker exec icarus-user-<кто-то> getent ahostsv4 api.deepinfra.com` — должно быть ~20 мс.

Правильное лечение — на хосте (`access-control` на docker-подсеть в unbound + reload,
тогда перестают тормозить и остальные контейнеры). Но `./script/redeploy` на всякий случай
всегда прописывает контейнерам явный `docker.dns` — сейчас `1.1.1.1 8.8.8.8` (значение
приезжает в `render-config.ts` переменной `ICARUS_DNS`, а не правится руками на хосте).
Цена — имена других контейнеров и локальные зоны (`*.trousev.pro`) внутри контейнеров
резолвятся публично; когда хост починят, `ICARUS_DNS=none` (в variables environment или
в вызове скрипта) уберёт строку из `config.yaml`, и контейнеры вернутся на резолвер хоста.
То же поле есть и в `config.yaml` (`docker.dns`, см. `config.example.yaml`) — им можно
задаться и без деплоя.

## Устройство репозитория

```
script/               команды разработчика: update, test, lint, server, redeploy, regenerate_user_passwords
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
