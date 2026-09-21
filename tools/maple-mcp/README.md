# maple-mcp

MCP-сервер (stdio + Streamable HTTP), который даёт LLM работать с **локально
установленным Maple**. Без внешних зависимостей — только Node.js.

Проверено на **Maple 18.00** (`X86 64 LINUX, Feb 10 2014, Build ID 922027`),
CLI `/opt/maple18/bin/maple`. Именно эта версия и закладывалась в проверки;
для Maple 2018/2022 почти всё то же, но часть команд там есть, а часть — нет
(см. «Ограничения»).

## Что умеет

| Инструмент | Назначение |
|---|---|
| `maple_health` | версия, платформа, разрядность, каталог, задержка |
| `maple_evaluate_code` | выполнить код Maple в долгоживущей сессии (состояние сохраняется) |
| `maple_check_code` | проверить синтаксис, **не выполняя** (`maple -P`) |
| `maple_to_latex` | выражение → LaTeX |
| `maple_plot` | график → изображение (gif / jpeg / bmp) |
| `maple_session_list` / `maple_session_reset` | живые сессии / сброс |
| `maple_worksheet_read` | прочитать `.mw`: группы, метки, секции, ввод, признак вывода |
| `maple_worksheet_create` | создать `.mw` из массива ячеек (и проверить его Maple) |
| `maple_worksheet_edit_cell` | заменить ввод одной группы |
| `maple_worksheet_run_cell` | выполнить одну группу из `.mw` |

## Быстрый старт

```bash
# stdio (для клиента, который сам запускает процесс)
node tools/maple-mcp/server.mjs

# HTTP (рекомендуется, если Maple стоит на хосте, а агент — в контейнере)
node tools/maple-mcp/server.mjs --http 8770
# → http://0.0.0.0:8770/mcp
```

Самотест (поднимает сервер и прогоняет 24 сценария на живом Maple):

```bash
node tools/maple-mcp/test.mjs
```

## Настройки (переменные окружения)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `MAPLE_BIN` | `/opt/maple18/bin/maple` | путь к CLI Maple |
| `MAPLE_ARGS` | — | доп. аргументы (добавляются к `-q -s -t`) |
| `MAPLE_TIMEOUT_SECONDS` | `60` | таймаут одного вычисления, сек |
| `MAPLE_IDLE_SECONDS` | `900` | через сколько гасить простаивающую сессию |
| `MAPLE_MAX_SESSIONS` | `4` | максимум одновременных ядер |
| `MAPLE_WORKSPACE_ROOT` | текущий каталог | база для относительных путей `.mw` |
| `MAPLE_HTTP_PORT` / `MAPLE_HTTP_HOST` | `8770` / `0.0.0.0` | адрес HTTP-режима |
| `MAPLE_MCP_DEBUG` | — | `1` — отладочные сообщения в stderr |

## Как это устроено

- Держим долгоживущий консольный Maple (`maple -q -s -t`). `-t` — тестовый
  режим: без prompt'а, без «bytes used», `prettyprint=0`.
- Код пишем в stdin, читаем stdout до sentinel-маркера
  (`printf("__MAPLE_MCP_<random>__\n")`). Вывод флашится сразу, так что
  задержка минимальна.
- **Синтаксис проверяем отдельным процессом** (`maple -P`, только разбор):
  сырая синтаксическая ошибка в живой сессии вешает разбор потока, а так
  сессия остаётся целой и сохраняет переменные. Проверено: после
  синтаксической и после runtime-ошибки сессия продолжает работать.
- Runtime-ошибки видны по `Error,` в выводе и возвращаются как `isError`.
- `quit`/`done`/`stop` на верхнем уровне блокируются — иначе сессия умрёт;
  для этого есть `maple_session_reset`.
- Таймаут → процесс убивается, сессия помечается мёртвой и поднимется заново
  при следующем вызове (старт ~50 мс, RSS ядра ~5 МБ).
- Транспорт HTTP — стандартный MCP Streamable HTTP: POST `/mcp`, ответ JSON
  или SSE в зависимости от `Accept`, заголовок `Mcp-Session-Id`. Проверено
  официальным `@modelcontextprotocol/sdk` (`StreamableHTTPClientTransport`) —
  тем же, что использует `pi-mcp-extension`.

## Подключение к Икару

Икар запускает MCP-серверы **внутри контейнера** агента, а Maple стоит на
хосте, поэтому нужен HTTP-режим (в контейнерах Икара уже есть
`extra_hosts: host.docker.internal:host-gateway`, см. `compose.ts`).

1. На хосте поднять сервер (лучше через systemd, см. ниже):

```bash
MAPLE_TIMEOUT_SECONDS=25 node /home/trousev/src/icarus/tools/maple-mcp/server.mjs --http 8770
```

2. В `config.yaml`:

```yaml
mcp:
  maple:
    transport: streamable-http
    url: http://host.docker.internal:8770/mcp
    lifecycle: eager
```

3. `./script/update && ./script/server` (сервис перегенерирует
   `~/.pi/agent/mcp.json`); проверить можно вопросом «посчитай в Maple …».

Почему не stdio в контейнере: Maple пришлось бы монтировать внутрь образа
(гигабайты и системные библиотеки), а `license.dat` обычно привязан к
оборудованию хоста и в контейнере с другим MAC не пройдёт.

### systemd (пример)

```ini
# ~/.config/systemd/user/maple-mcp.service
[Unit]
Description=Maple MCP server
After=network.target

[Service]
Environment=MAPLE_BIN=/opt/maple18/bin/maple
Environment=MAPLE_TIMEOUT_SECONDS=25
ExecStart=/usr/bin/node /home/trousev/src/icarus/tools/maple-mcp/server.mjs --http 8770
Restart=on-failure

[Install]
WantedBy=default.target
```

## Ограничения и грабли (проверено на Maple 18)

- **Графику** отдаём через `plottools:-exportplot`: работают `gif`, `jpeg`,
  `bmp`; **`png` и `tiff` Maple 18 не умеет**. По умолчанию — `gif`
  (MCP-клиенты его понимают).
- `DocumentTools:-ContentToString`, `Tabulate` и
  `Worksheet:-WorksheetToMapleText` в Maple 18 **отсутствуют** — поэтому `.mw`
  генерируется своим XML-кодом, а 2-D ввод читается через атрибут
  `input-equation` (линейная форма Maple).
- **`-c` через launcher использовать нельзя**: скрипт `/opt/maple18/bin/maple`
  делает `eval` аргументов, и код/пути с кавычками и слэшами ломаются. Внутри
  сервера всё идёт через stdin или файл-скрипт.
- **Таймаут клиента.** Икар генерирует `requestTimeoutMs: 30000`
  (`packages/service/src/workspace.ts`), это значение зашито. Поэтому
  `MAPLE_TIMEOUT_SECONDS=25`: длинные вычисления лучше дробить, иначе клиент
  отвалится раньше сервера.
- **Безопасность.** Код Maple может читать/писать файлы и вызывать
  `system()`. Граница — контейнер/пользователь ОС; списки запрещённых подстрок
  такой защиты не дают. При необходимости можно добавить в `MAPLE_ARGS`
  `-z` и `--secure-read/--secure-write/--secure-syscall` (с нашим сервером не
  тестировалось).
- **Состояние** живёт в сессии (`default`), теряется при таймауте и сбросе.
- `.mw` официально «storage format is not documented» — парсер терпимый, но
  причуды конкретных файлов возможны; после каждой записи файл проверяется
  самим Maple через `Worksheet:-ReadFile`.
