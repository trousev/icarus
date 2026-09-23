# maple-mcp

MCP-сервер (stdio + Streamable HTTP), который даёт LLM работать с **локально
установленным Maple**. Без внешних зависимостей — только Node.js.

Проверено на **Maple 18.00** (`X86 64 LINUX, Feb 10 2014, Build ID 922027`),
CLI `/opt/maple18/bin/maple`.

## Инструменты (14)

| Инструмент | Назначение |
|---|---|
| `maple_health` | версия, платформа, задержка, каталог сессий |
| `maple_evaluate_code` | выполнить код Maple в сессии; состояние и журнал — см. ниже |
| `maple_check_code` | проверить синтаксис, **не выполняя** (`maple -P`) |
| `maple_to_latex` | выражение → LaTeX (`latex(..., output=string)`; им агент обязан переводить формулы в ответе) |
| `maple_plot` | график → изображение (gif / jpeg / bmp) + файл на диске |
| `maple_session_list` | живые сессии и сохранённые журналы (в т.ч. из прошлых чатов) |
| `maple_session_resume` | поднять сессию из журнала (обычно не нужно — см. авто-восстановление) |
| `maple_session_history` | что именно считалось в сессии, по шагам |
| `maple_session_reset` | перезапустить ядро, **сохранив** журнал |
| `maple_session_forget` | стереть сессию и журнал совсем |
| `maple_worksheet_read` | прочитать `.mw`: группы, метки, секции, ввод, признак вывода |
| `maple_worksheet_create` | создать `.mw` из массива ячеек (и проверить его Maple) |
| `maple_worksheet_edit_cell` | заменить ввод одной группы |
| `maple_worksheet_run_cell` | выполнить одну группу из `.mw` |

## Долгие расчёты и сессии между чатами

Мост pi → MCP поднимает этот процесс на время чата и убивает в конце. Поэтому
состояние сессии живёт **не в памяти, а в журнале**:

- всё, что успешно выполнилось, дописывается в `$MAPLE_SESSION_DIR/<сессия>.jsonl`;
- при первом обращении к сессии в новом процессе журнал проигрывается в свежее
  ядро — переменные, функции и `assume` возвращаются (в ответе будет пометка
  `[сессия «…» восстановлена из журнала: N шагов]`);
- `restart` в коде очищает журнал — как и положено;
- когда ядро не трогают **5 минут** (`MAPLE_IDLE_SECONDS`), оно убивается, журнал
  остаётся; следующий вызов поднимает его и восстанавливает состояние.

Типичный сценарий: в одном чате вводим данные и решаем дифур, в другом —
«продолжим» и агент просто продолжает с тем же именем сессии.

```text
чат 1:  maple_evaluate_code(session="osc", code="m:=2: k:=3: ic:={y(0)=1, D(y)(0)=0}:")
        maple_evaluate_code(session="osc", code="sol:=dsolve(...);")
        → MCP-процесс умирает вместе с чатом, журнал на диске

чат 2:  maple_evaluate_code(session="osc", code="eval(rhs(sol), x=1);")
        → [сессия «osc» восстановлена из журнала: 3 шагов]
          cos(3)
```

Имена сессий лучше давать по смыслу (`osc`, `statmech`, `optics`) — тогда разные
расчёты не перемешиваются.

## Быстрый старт

```bash
node tools/maple-mcp/server.mjs              # stdio
node tools/maple-mcp/server.mjs --http 8770  # Streamable HTTP на /mcp
node tools/maple-mcp/test.mjs                # 27 проверок базовых возможностей
node tools/maple-mcp/test-sessions.mjs       # 25 проверок журнала, простоев и утечки процессов
```

## Настройки (переменные окружения)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `MAPLE_BIN` | `/opt/maple18/bin/maple` | путь к CLI Maple |
| `MAPLE_ARGS` | — | доп. аргументы (добавляются к `-q -s -t`) |
| `MAPLE_TIMEOUT_SECONDS` | `60` | таймаут одного вычисления, сек |
| `MAPLE_IDLE_SECONDS` | `300` | простой, после которого ядро гасится |
| `MAPLE_MAX_SESSIONS` | `4` | максимум одновременных ядер |
| `MAPLE_SESSION_DIR` | `~/.pi/agent/maple-mcp`; в Икаре задан явно — `/workspace/maple` | журналы сессий |
| `MAPLE_PLOT_DIR` | `<SESSION_DIR>/plots`; в Икаре задан явно — `/workspace/maple` | куда складывать графики |
| `MAPLE_JOURNAL_MAX_BYTES` | `524288` | предел журнала (дальше старые записи отбрасываются) |
| `MAPLE_WORKSPACE_ROOT` | текущий каталог | база для относительных путей `.mw` |
| `MAPLE_HTTP_PORT` / `MAPLE_HTTP_HOST` | `8770` / `0.0.0.0` | адрес HTTP-режима |
| `MAPLE_MCP_DEBUG` | — | `1` — отладочные сообщения в stderr |

## Как это устроено

- Долгоживущий консольный Maple (`maple -q -s -t`): без prompt'а и «bytes used»,
  `prettyprint=0`, вывод флашится сразу, старт ~50 мс, RSS ядра ~5 МБ.
- Код пишем в stdin, читаем stdout до sentinel-маркера
  (`printf("__MAPLE_MCP_<random>\n")`).
- **Синтаксис проверяем отдельным процессом** (`maple -P`): сырая синтаксическая
  ошибка в живом REPL вешает разбор потока, а так сессия остаётся целой.
- Runtime-ошибки видны по `Error,` и возвращаются как `isError`.
- `quit`/`done`/`stop` на верхнем уровне блокируются — иначе сессия умрёт.
- Таймаут убивает ядро; журнал остаётся, состояние вернётся.
- **Maple — это два процесса**: обёртка `cmaple` (её pid возвращает `spawn`) и ядро
  `mserver`, которое обёртка порождает сама. Гасим поэтому не процесс, а **группу
  процессов**: Maple стартует с `detached: true` (это `setsid`), а остановка шлёт
  сигнал всей группе. Иначе ядро переживает обёртку, осиротеет, а в контейнере
  человека (PID 1 — `sleep infinity`, сирот он не подбирает) навсегда останется
  зомби `[mserver] <defunct>` — таких за разговор копились сотни. На выходе сервер
  добивает остатки групп, а контейнерам людей дополнительно включён `init: true`.
- HTTP-транспорт — стандартный MCP Streamable HTTP (POST `/mcp`, ответ JSON или
  SSE по `Accept`, заголовок `Mcp-Session-Id`). Проверен официальным
  `@modelcontextprotocol/sdk` — тем же, что использует `pi-mcp-extension`.

## Подключение к Икару (через docker compose)

Отдельный compose-сервис и systemd не нужны: **Maple 18 работает прямо внутри
контейнера агента** — проверено, лицензия не привязана к железу
(`HOSTID=INTERNET=*.*.*.*`). Всё делается штатными средствами Икара: `mounts:` +
stdio-MCP.

```yaml
mounts:
  - host: ${MAPLE_DIR}                    # сам Maple; обе стороны — из .env
    container: ${MAPLE_DIR}
    mode: ro
  - host: /home/trousev/src/icarus/tools  # каталог с сервером
    container: /opt/icarus/tools
    mode: ro

mcp:
  maple:
    command: node
    args:
      - /opt/icarus/tools/maple-mcp/server.mjs
    env:
      MAPLE_BIN: ${MAPLE_DIR}/bin/maple
      MAPLE_TIMEOUT_SECONDS: "25"
      # Журналы и графики — в постоянный каталог человека: /workspace/maple
      # сервис монтирует из dataDir сам, из config.yaml его прописывать не надо.
      MAPLE_SESSION_DIR: /workspace/maple
      MAPLE_PLOT_DIR: /workspace/maple
      MAPLE_PLOT_URL_BASE: http://localhost:8081/maple
    lifecycle: eager
```

`MAPLE_DIR=/opt/maple18` живёт в `.env` (см. `.env.example`); на проде то же
значение приезжает из `vars.MAPLE_DIR` через `script/redeploy`, а незаданная
переменная — это дефолт `/opt/maple18`, а не пустой путь. Обе стороны
маунта обязаны совпадать: launcher Maple ищет библиотеки по тому пути, который
записан внутри него самого.

Без `MAPLE_SESSION_DIR`/`MAPLE_PLOT_DIR` сервер пишет в `~/.pi/agent/maple-mcp`
(а если такого каталога нет — в `<текущий каталог>/.maple-mcp`). Для Икара так
делать не стоит: мост pi живёт только на время чата, и расчёт переживёт разговор
лишь потому, что журнал лежит на хосте.

Дальше `./script/server -d`. Проверка в живом контейнере:

```bash
docker exec -u node icarus-user-probe node /opt/icarus/tools/maple-mcp/test.mjs
```

Инструкция для агента — отдельный файл **`MAPLE.md`** в корне репозитория. Если в
`config.yaml` есть `mcp.maple`, сервис кладёт его в каталог человека и монтирует
как `/workspace/MAPLE.md:ro`, а в `AGENTS.md` добавляет **только указатель**:

> Математика, аналитика, Maple — читай `MAPLE.md`.

Так инструкция про символьный счёт не висит в промпте каждого разговора, а
подхватывается тогда, когда речь действительно о математике. Там же — правило
про оформление: **формулы человеку всегда в LaTeX** (`$…$` в строке, `$$…$$`
отдельной строкой), через `latex()`/`maple_to_latex`, а не текстом вроде `x^2`.
Правки в `MAPLE.md` доезжают до людей при следующем `./script/server`.

## Ограничения и грабли (проверено на Maple 18)

- **Если `dsolve`/`pdsolve` падают с `external library libmodLA.so could not be
  found/used`** — это не сервер, а старые библиотеки Maple: `libatlas.so` и
  `libmsp.so` из 2014 года требуют исполняемого стека, а glibc 2.41+ (Ubuntu
  26.04) такие `dlopen` отвергает. Лечится снятием флага:

  ```bash
  python3 tools/maple-mcp/fix-execstack.py                 # предпросмотр
  sudo python3 tools/maple-mcp/fix-execstack.py --apply    # бэкапы *.bak-execstack
  ```

  После этого работают `dsolve`, `pdsolve`, численные ОДУ. Откат — `--restore`.
- **Картинки.** `pi-mcp-extension` заменяет image-контент на текст
  `[Image: image/gif, base64 encoded]`, поэтому сам image-блок до человека не
  доходит. Решение: MCP кладёт график в `MAPLE_PLOT_DIR` и возвращает
  markdown-ссылку `![график](http://localhost:8081/maple/<16hex>.gif)`, а icarus
  отдаёт её маршрутом `GET /maple/<файл>` — ищет файл в каталогах людей, имя файла
  это 16 случайных hex. База URL задаётся `MAPLE_PLOT_URL_BASE` (env сервера
  `maple` в `config.yaml`). Агент обязан вставить эту строку в ответ дословно —
  так написано в `MAPLE.md`.
- **Графику** отдаём через `plottools:-exportplot`: `gif`, `jpeg`, `bmp`;
  **`png` и `tiff` Maple 18 не умеет**.
- `DocumentTools:-ContentToString`, `Tabulate` и
  `Worksheet:-WorksheetToMapleText` в Maple 18 **отсутствуют** — `.mw`
  генерируется своим XML-кодом, 2-D ввод читается через атрибут `input-equation`.
- **`-c` через launcher использовать нельзя**: скрипт `/opt/maple18/bin/maple`
  делает `eval` аргументов. Внутри сервера всё идёт через stdin или файл.
- **Таймаут клиента.** Икар генерирует `requestTimeoutMs: 30000`
  (`packages/service/src/workspace.ts`), это значение зашито. Поэтому
  `MAPLE_TIMEOUT_SECONDS=25`.
- **Безопасность.** Код Maple может читать/писать файлы и вызывать `system()`.
  Граница — контейнер/пользователь ОС. При необходимости добавьте в `MAPLE_ARGS`
  `-z` и `--secure-*` (с сервером не тестировалось).
- Журнал — это **повтор выполненных команд**, а не снимок памяти: если шаг был
  долгим, восстановление займёт столько же времени. Для тяжёлых расчётов лучше
  сохранять результаты в файл и продолжать с файла.
