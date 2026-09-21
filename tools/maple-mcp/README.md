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
| `maple_to_latex` | выражение → LaTeX |
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
node tools/maple-mcp/test-sessions.mjs       # 20 проверок журнала и простоев
```

## Настройки (переменные окружения)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `MAPLE_BIN` | `/opt/maple18/bin/maple` | путь к CLI Maple |
| `MAPLE_ARGS` | — | доп. аргументы (добавляются к `-q -s -t`) |
| `MAPLE_TIMEOUT_SECONDS` | `60` | таймаут одного вычисления, сек |
| `MAPLE_IDLE_SECONDS` | `300` | простой, после которого ядро гасится |
| `MAPLE_MAX_SESSIONS` | `4` | максимум одновременных ядер |
| `MAPLE_SESSION_DIR` | `~/.pi/agent/maple-mcp` (в контейнере Икара — персистентный маунт) | журналы сессий |
| `MAPLE_PLOT_DIR` | `<SESSION_DIR>/plots` | куда складывать графики |
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
  - host: /opt/maple18                    # сам Maple
    container: /opt/maple18
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
      MAPLE_BIN: /opt/maple18/bin/maple
      MAPLE_TIMEOUT_SECONDS: "25"
    lifecycle: eager
```

Дальше `./script/server -d`. Проверка в живом контейнере:

```bash
docker exec -u node icarus-user-probe node /opt/icarus/tools/maple-mcp/test.mjs
```

Инструкцию для агента Икар генерирует сам: если в `mcp` есть сервер `maple`,
в `AGENTS.md` добавляется раздел «Maple — точный счёт» (см.
`packages/service/src/workspace.ts`). Тот же текст лежит рядом —
`AGENT-INSTRUCTIONS.md`.

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
- **Картинки.** `maple_plot` возвращает и изображение, и путь к файлу. Но
  `pi-mcp-extension` заменяет image-контент на текст `[Image: image/gif, base64
  encoded]` — то есть до человека картинка через Икара не доедет. Поэтому в
  ответе всегда есть путь к файлу в `MAPLE_PLOT_DIR`.
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
