# harness-probe — пробник второго движка

Запускает **Claude Code headless** против Anthropic-совместимого эндпоинта (по умолчанию
DeepSeek) и переводит его поток в события хода Икара: `text`, `step`, `step-update`,
`step-end`, `done`. Это проверка идеи «выбор между pi и Claude Code» на живом протоколе,
а не на рассуждениях.

```
Claude Code (stream-json) ──► parse.mjs ──► наши события (как от pi)
        │                                        │
        ├── raw.jsonl     как пришло             ├── turn.jsonl   что увидит панель
        ├── summary.json  тайминги и расход       └── report.html  терминальный стенд
```

## Что нужно

- Node 24 (репозиторий и так на нём);
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code` или локально
  `npm install @anthropic-ai/claude-code` и `--claude ./node_modules/.bin/claude`;
- ключ провайдера в переменной `ANTHROPIC_API_KEY` (подходит и `ANTHROPIC_AUTH_TOKEN`).

Пробник **не ходит в сеть сам** — в сеть ходит Claude Code. Парсер и тесты сети не требуют.

## Запуск

```bash
# ключ из окружения
ANTHROPIC_API_KEY="$DEEPSEEK_API_KEY" \
  node tools/harness-probe/probe.mjs \
  --prompt "Прочитай probe.txt и ответь ровно его содержимым" \
  --seed "probe.txt=МАЯК-42" \
  --out /tmp/harness-probe/run

# ключ из файла (значение не печатается и в стенд не попадает)
node tools/harness-probe/probe.mjs \
  --env-file .env --key-env DEEPSEEK_API_KEY \
  --prompt "Ответь ровно: PONG" --out /tmp/harness-probe/run
```

Полезные флаги (полностью — `--help`):

| флаг | зачем |
|---|---|
| `--model deepseek-chat` | модель; эндпоинт по умолчанию `https://api.deepseek.com/anthropic` |
| `--base-url` | другой Anthropic-совместимый эндпоинт |
| `--cwd`, `--seed "файл=текст"` | рабочий каталог агента и файлы для инструментов |
| `--allowed-tools Read` | что разрешено без вопросов (по умолчанию только `Read`) |
| `--tools "Read,Bash"` | явный список инструментов (`--tools` у Claude Code) |
| `--thinking` | тащить thinking-дельты в `turn.jsonl` |
| `--timeout 120000` | сколько ждать `result`; по истечении процесс гасится, статус — `timeout` |
| `--html`, `--no-html` | стенд; `--json` — сводка в stdout |

Пример вывода:

```
движок:     Claude Code 2.1.319 (Claude Code) · deepseek-chat
эндпоинт:   https://api.deepseek.com/anthropic
статус:     ok
время:      2.80 с · первый event 194 мс · result 2731 мс
поток:      122 строк → 11 событий Икара
инструменты: 3 доступно (Bash, Edit, Read)
ответ:      "МАЯК-42"
токены:     вход 1380 · выход 99 · ходов 2
```

Код возврата 0 — ход дошёл до `result:success`; 1 — ошибка, таймаут или поток без `result`.

## Изоляция — часть честности прогона

Claude Code по умолчанию читает `~/.claude/settings.json`, плагины, хуки и `CLAUDE.md`
человека. В этой песочнице его `settings.json` **переопределяет `ANTHROPIC_BASE_URL`** на
локальный прокси, поэтому прогон «против DeepSeek» без изоляции на самом деле шёл бы в
прокси. Пробник:

- запускает с `--bare` (без хуков, плагинов, автоматического `CLAUDE.md`, keychain);
- подставляет изолированный `HOME` (`<out>/home`), если не передан `--keep-home`;
- передаёт только `ANTHROPIC_API_KEY`, убирая `ANTHROPIC_AUTH_TOKEN` и модели-подсказки из
  окружения песочницы;
- передаёт `--no-session-persistence`, чтобы не оставлять чужие сессии в `~/.claude`.

`--keep-home` оставлен для отладки: тогда на результат влияют настройки человека.

## Что важно знать по измерениям

- Модель `deepseek-chat` Claude Code не знает и пишет в stderr
  `[claude-code:unrecognized_model]`, но прогон работает: ответ и инструменты в порядке.
- `--bare` оставляет три встроенных инструмента (`Bash`, `Edit`, `Read`), `--tools` в
  2.1.319 этот список не расширил; для полноценного движка нужен отдельный прогон с
  `--settings`/`--allowedTools`.
- Цена в `result.total_cost_usd` считается по прайсу Anthropic (`costBasis: unknown`) —
  для DeepSeek это не наши деньги; реальный расход считаем по токенам.
- У pi есть `tool_execution_update` (прогресс bash), у Claude Code прогресса инструмента
  нет: `step-update` в адаптере — это досылка аргументов, а не поток вывода.
- Ошибка приходит финальным `result` с `is_error`/`subtype`, а не отдельным событием;
  если `result` вообще нет — это ошибка, а не пустой успешный ход.

## Файлы прогона

| файл | что внутри |
|---|---|
| `raw.jsonl` | поток Claude Code как есть, строка в строку |
| `turn.jsonl` | наши события: `engine`, `text`, `step`, `step-update`, `step-end`, `done`/`error` |
| `summary.json` | статус, команда, тайминги, токены, инструменты, что не разобрано |
| `report.html` | тот же прогон терминальной страницей (для скриншотов) |

## Проверка

```bash
./script/test packages/service/test/harness-probe.test.ts
```

Тесты берут `fixtures/*.jsonl` — реальные прогоны, из которых убран служебный шум
(подробности — `fixtures/README.md`). Сеть и Claude Code в тестах не нужны.
