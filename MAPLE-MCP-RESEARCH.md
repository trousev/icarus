# Maple → MCP: исследование (черновик)

Цель: понять, как «привинтить» локально установленный Maple 2018/2022 к Икару
(и вообще к LLM) через собственный MCP-сервер. Вопросы: как создавать,
инспектировать и редактировать `.mw`-воркшиты, как выполнить одну ячейку, как
запустить процесс Maple и управлять им снаружи.

Статус: **черновик, почти готов**. Ключевые разделы подтверждены
первоисточниками (ссылки по тексту); детальные отчёты — в `research/01-*.md` …
`research/07-*.md`. Пункты, которые нельзя закрыть без живой установки Maple,
собраны в §9 («smoke-тесты»).

Дата: 2026-09-21. Целевые версии: Maple 2018 и Maple 2022 (тонкий прод).

---

## 1. Главное, что нужно знать сразу

1. **У Maplesoft есть официальный Maple MCP** — но это продукт 2025/2026,
   который поставляется *внутри актуального Maple* для подписчиков Elite
   Maintenance Program, либо как отдельный enterprise-деплой. Он не рассчитан
   на Maple 2018/2022.
   → [Maple MCP (EN)](https://www.maplesoft.com/products/maplemcp/index.aspx)
2. **У Maple есть 4 официальных внешних API (OpenMaple): C, Java, Python, VB6.**
   Python-API построен поверх C-API. Требуется установленный Maple и лицензия;
   условия — в `extern/OpenMapleLicensing.txt` в поставке.
   → [OpenMaple: Overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple)
3. **`.mw` — это XML-формат** (появился в Maple 9, заменил классический `.mws`).
   Maple умеет отдавать воркшит как XML-документ через пакет `Worksheet`
   (`ReadFile`, `ToString`, `Convert`, `WriteFile`, `WorksheetToJupyter`,
   `WorksheetToMapleText`, …), а хранилищный формат официально
   **не документирован и может меняться** — правильно ходить через XML-слой,
   а не парсить байты руками.
   → [Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW),
   [Worksheet](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)
4. **В Икаре уже есть слот под MCP**: серверы описываются в `config.yaml`
   (`mcp:`), транспорты `stdio` / `streamable-http` / `sse`, их читает
   `pi-mcp-extension`. Пример своего сервера — `docker/user/mcp/echo-server.mjs`.
   То есть Maple-MCP подключается **без правки ядра**.
   → `README.md`, `PLAN.md` (раздел «Итог M3»), `packages/service/src/config.ts`

### 1.1 Ответы на исходные вопросы (коротко)

**Можно ли привинтить доступ к локальному Maple 2018/2022?** Да. Официальный
облачный Maple MCP нам не подходит, но у Maple есть всё нужное локально:
консольный CLI, OpenMaple и (в 2022) Jupyter-ядро. Сообщества-MCP для Maple не
существует — это будет первый, но опираться есть на что (Wolfram/Matlab
MCP-серверы как образец формы).

| Вопрос | Ответ |
|---|---|
| **Как кодом создать `.mw`?** | `.mw` — обычный plain-text XML; генерируем сами, только 1-D: `<Group><Input><Text-field style="Maple Input">код</Text-field></Input></Group>`. Сторонних библиотек-писателей нет ни в npm, ни в PyPI, ни в Pandoc. **Официальный headless-путь:** конструкторы `DocumentTools:-Layout:-*` / `Components:-*` → `DocumentTools:-ContentToString` (возвращает XML-строку воркшита) → `FileTools:-Text:-WriteFile`. Плюс `printf`-спецификатор `%Zm` печатает XML воркшита. |
| **Как его inspect?** | Тем же XML (парсить защитно: формат официально «subject to change»), либо `Worksheet:-ReadFile` (XML-дерево), `Worksheet:-WorksheetToMapleText` (весь воркшит в 1-D текст), `DocumentTools:-Retrieve(file, L6)` (выражение по метке). **2-D вход снаружи нечитаем** (~34% реальных входов) — только через линеаризацию самим Maple. |
| **Как редактировать?** | Правка XML + запись файла. Ориентируемся на **уровень документа**, а не «ячейка за ячейкой» (так делают Wolfram и MathCAD). Внутри Maple — `DocumentTools:-InsertContent`/`SetProperty` (проверить headless). |
| **Как выполнить одну ячейку?** | Документированного API нет. Практически: достать текст группы из XML и отдать ядру; семантически честно — выполнять **префикс 1…k** (группы рассчитаны на общее состояние и порядок). Весь воркшит целиком — `DocumentTools:-RunWorksheet` (headless, новое ядро, ранний выход через `return`). |
| **Как запустить процесс и управлять снаружи?** | `<maple>/bin/maple -q -s -t` — это REPL; держим stdin открытым, читаем до маркера (`#-->` в режиме `-t` или свой `printf`-сентинел), при необходимости через pty. `errorbreak=0`, `quit` вырезать, убивать группу процессов. Надёжнее — **OpenMaple** (C или своя ctypes-обёртка по MIT-коду Maplesoft); на Maple 2022 есть **Jupyter-ядро**. |

**Вердикт:** реализуемо и без официального MCP. Разумный минимум — MCP-сервер
(stdio) на машине с Maple: ядро через CLI-процесс (fallback — процесс на запрос),
воркшиты — своим XML-кодом, `-e2`/`errorbreak=0`, лимиты `-T`, статус результата
честный. Java и .NET не нужны.

---

## 2. Официальный Maple MCP (что копируем, что недоступно)

Подтверждено страницей продукта ([EN](https://www.maplesoft.com/products/maplemcp/index.aspx),
[CN](https://www.maplesoft.com.cn/products/MapleMCP/)) и разбором PDF-инструкции
(см. `research/06-mcp-prior-art.md`):

- Это MCP-сервер, дающий LLM доступ к «Maple Math Engine» (точный
  символьный/численный счёт вместо вероятностного угадывания).
- **Это облачный сервис, а не локальный сервер.** Вербатим из PDF «Setting up
  Maple MCP for Copilot Studio»: endpoint
  `https://cloud-api.maplenet.cloud/api/v2/mcp`.
  Живая проба: AWS API Gateway/Lambda за CloudFront, MCP Streamable HTTP,
  `protocolVersion 2025-06-18`, `serverInfo = {name:"Maplesoft",
  title:"Maple Server", version:"2026.1"}`, capabilities — tools+resources
  (без prompts), серверная инструкция — «Use Maple for all math calculations».
- **Аутентификация — API-ключ в query-параметре `auth`** (в Copilot Studio:
  Authentication = API key, Type = Query, Label = `auth`). Ключ выдаётся только
  из ленты «My Maple» внутри Maple и требует активной подписки **Elite
  Maintenance Program**; Maple MCP заявлен как новая льгота EMP в Maple 2026.
- Список инструментов официального сервера **публично недоступен**:
  `tools/list` без ключа отдаёт HTTP 401; в реестрах MCP записи нет. Значит
  нельзя опираться на «официальные» имена инструментов — их просто нет в
  открытом доступе.
- Лучший публичный референс формы — официальный **Wolfram MCP**
  (`https://agenttools.wolfram.com/mcp`): ровно 3 инструмента —
  `WolframContext{context}`, `WolframLanguageEvaluator{code, timeConstraint=60s}`,
  `WolframAlpha{query}`. Важная деталь описания: «This is a stateless kernel,
  so you cannot reuse definitions from previous evaluations» — то есть про
  состояние сессии надо честно писать в описании инструмента.

**Вывод для нас:** официальный сервер (а) облачный, (б) требует Maple 2026 +
EMP, (в) не имеет режима совместимости с 2018/2022. Сообщества-MCP для Maple
CAS не существует (поиск по GitHub даёт только MapleStory/Maple Finance) —
мы делаем первый. Ориентир по форме инструментов берём у Wolfram MCP.

---

## 3. Форматы файлов: как создавать / читать / править воркшиты

Подтверждено ([Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW)):

- `MW` (Maple Worksheet, `.mw`) — родной формат документов/воркшитов,
  **XML-based**, введён в Maple 9, заменил `MWS` (классический воркшит).
- У Maple есть встроенный экспорт в другие форматы
  ([Exporting Worksheets to Other Formats](https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2fmanaging%2fexport)).
- «The `DocumentTools` package has several utilities for interacting with MW
  files» — в примере на странице показано извлечение выражения из воркшита
  **по метке**:
  ```maple
  MWFile := FileTools:-JoinPath("example/BesselsEquation.mw", base=datadir):
  DocumentTools:-Retrieve(MWFile, L6);
  ```

Пакет `Worksheet` ([обзор](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)):

- Назначение: «infrastructure for generating and manipulating Maple worksheets
  using the Maple language», программистский тулкит.
- Доступ к воркшиту — **через его XML-представление** средствами
  `XMLTools`; «The storage format for Maple worksheets is not documented, and
  is subject to change» — прямое предупреждение не парсить хранилище вручную.
- Команды (актуальная версия): `Comparator`, `Convert`, `Display`,
  `DisplayFile`, `FromString`, `ReadFile`, `RemoveSection`, `TableOfContents`,
  `ToString`, `WorksheetToJupyter`, `WorksheetToMapleText`, `WriteFile`.
- Есть опубликованные [Worksheet/DTD](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fDTD)
  и [Worksheet/Schema](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fSchema).

Из [примера WorksheetPackage](https://www.maplesoft.com/support/help/maple/view.aspx?path=examples/WorksheetPackage):

```maple
with(Worksheet);
wname := FileTools:-JoinPath([kernelopts(mapledir), "examplesclassic","WorksheetPackage.mws"]):
doc  := ReadFile(wname);                      # XML-документ, format="mw" по умолчанию
doc2 := ReadFile(wname, format = "maple8_xml");
doc3 := Convert(doc, format="maple8_xml");
str  := ToString(doc, format = "mws");        # назад в классический .mws
```

В XML воркшита видны атрибуты версии, например
`_XML_Element(_XML_ElementType("Version"), ... major=12, minor=0 ...)` —
то есть у формата есть номер версии (`major`/`minor`), и его надо учитывать
при генерации файлов «снаружи».

**Статус:** формат разобран на живых файлах (см. §3.1). Открытым остаётся один
пункт — работает ли пакет `Worksheet` в headless-режиме (см. §9, smoke-тест 2).

### 3.1 Что реально внутри `.mw` (проверено на живых файлах)

- `.mw` для 2018/2022 — **один plain-text UTF-8 XML-файл**. Это **не** ZIP/OPC:
  `unzip -l` падает, `zipfile.is_zipfile()` → `False`, нет `maple.xml`,
  `_rels/.rels`, `[Content_Types].xml`. Начало файла:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <Worksheet>
  ```
  Держится и на 258-КБ воркшитах со 124 формулами и графиками.
- Корень `<Worksheet>` без атрибутов/namespace; первые три ребёнка всегда
  `Version`, `Label-Scheme`, `View-Properties`.
  `<Version major="2022" minor="2"/>` — major = релиз (2018/2022), minor = точка.
  Стабильно от Maple 13 до 2024 (26 просэмплированных файлов).
- Ячейки: `<Group>`; вход —
  `<Group><Input><Text-field style="Maple Input">1-D код как plain text</Text-field>`;
  выход — `<Output>` с `<Equation>` (base64 в атрибуте `display` + base64-тело)
  и `<Plot>` (base64-тело); секции — `<Section><Title>`.
- **2-D математика и графики — непрозрачный base64 внутреннего формата Maple.**
  Снаружи их можно сохранить/перенести, но не синтезировать. Значит генерировать
  надо только 1-D `<Text-field style="Maple Input">`.
- **Измеренное ограничение (26 реальных воркшитов):** 2-D (типографский) ввод —
  это пустой `Text-field` + `<Equation>` с приватной вложенной base64.
  **190 из 566 непустых входных областей (~34%) — только-2-D и снаружи
  нечитаемы**; бывают воркшиты, где 100% ввода — 2-D. Чтобы всё-таки прочитать,
  надо дать самому Maple линеаризовать воркшит:
  `Worksheet:-WorksheetToMapleText` (2017+, есть в обеих наших версиях).
- Важные инварианты: `major` в `<Version>` — это **год релиза**
  (`major="2018"`, `major="2022"`), при этом Maple 18 (2014) пишет `major="18"` —
  не спутать.
- **Экосистемы нет.** Единственный подтверждённый сторонний читатель `.mw` —
  `davidovitch/maple-to-python` (`mw2txt.py`, мёртв с 2015, GPL-3.0/LGPL);
  агент прогнал его без правок на реальном файле 2022.2 — 1-D ввод извлёк
  корректно. **Ни одного пакета-писателя `.mw`, ни парсера `.mws`; в npm и PyPI
  пакетов для Maple-воркшитов нет; у Pandoc нет ни reader, ни writer.**
  Вывод: обработку формата MCP-сервер реализует сам.
- Открытый вопрос: `.mwz` (возможный сжатый вариант) — UNVERIFIED; совместимость
  `.mw` 2018 ↔ 2022 (вперёд/назад) не проверена на живых версиях.
- Опубликованные `Worksheet/DTD` и `Worksheet/Schema` описывают **НЕ `.mw`**,
  а legacy-словарь Maple 8 (`maple8_xml`: `worksheet/version/section/exchange/
  para/text/mapletext`, всё в нижнем регистре). `.mw` против этой схемы **не
  валидируется**. Официальная позиция: storage format не документирован и может
  меняться.
- `.mws` — текстовый формат в фигурных скобках:
  `{VERSION 6 0 "IBM INTEL LINUX" "6.0" }…{SECT 0 {EXCHG {PARA 0 "> " 0 "" {MPLTEXT …}}}}`.
  Maple 2018 ещё умеет Classic Worksheet (открыть/сохранить `.mws`),
  в Maple 2022 классического интерфейса **уже нет** — только миграция `.mws`→`.mw`.
- Пакет `Worksheet` по версиям. **2018:** `Comparator`, `Convert`,
  `Display`/`DisplayFile`, `FromString`, `ReadFile`, `ToString`,
  `WorksheetToMapleText` (2017+), `WriteFile`. **2022 добавляет**
  `RemoveSection` и `TableOfContents` (обе — 2020+) и `WorksheetToJupyter`
  (2022+). У `Convert` аргумент `outputfilename` — только 2025+ (в 2018/2022
  его нет).
- **Что headless, а что нет.** Явный запрет для командной строки есть только у
  `Display`/`DisplayFile` («cannot be used in the Command-line version of
  Maple»); `Comparator` поднимает Maplet (GUI), а
  `TableOfContents`/`RemoveSection` открывают GUI, **если не передан
  `destination=`**. У `ReadFile`/`WriteFile`/`FromString`/`ToString`/`Convert`/
  `WorksheetToMapleText` GUI-оговорки нет — это чистая работа с файлами и XML,
  но что пакет вообще грузится в CLI, Maplesoft не пишет → smoke-тест §9.
- Подписи: `ReadFile(filename, format="mw"|"maple8_xml")`;
  `WriteFile(fileName, xmlTree, …)` — **обратите внимание на порядок
  аргументов**; `FromString(str, …)`; `ToString(tree, …)`;
  `Convert(worksheet, [outputfilename], format=…)`;
  `WorksheetToMapleText(ws[, includeoutput])`;
  `WorksheetToJupyter(ws, outputfile=…)`;
  `RemoveSection`/`TableOfContents(target[, destination])`.
- **`DocumentTools` в 2018 и 2022 есть:** `InsertContent`, `GetProperty`,
  `SetProperty`, `Do`, `Tabulate`, `Components`, `Layout`, `ContentToString`,
  `Retrieve`, `RunWorksheet`. `GetDocumentProperty(attr, mwfile)` — 2017+;
  `SetDocumentProperty(…, mwfile, outfile)` — 2021+ (то есть только 2022).
  **`GetContent` не существует** (страница справки 404, нет в списках).
  Headless: `ContentToString`, конструкторы `Layout:-*`/`Components:-*`,
  `GetDocumentProperty`, `SetDocumentProperty` (2022), `Tabulate(…, output=XML)`;
  а `InsertContent`/`Tabulate`/`GetProperty`/`SetProperty`/`Do` требуют
  **открытого документа** (PG2018 §13.2 буквально: «the Do command must query
  the GUI»).
- Экспорт «As…» в 2018 и 2022 одинаков: HTML(+MathML), LaTeX, Maple input,
  Maplet, Maple text, plain text, PDF, RTF.
- Прочее: `.maple` (Maple Workbook) — SQLite-база, не воркшит; `.mla` — бинарный
  репозиторий; `.lib`+`.ind` — старая пара; `.m` — внутренний бинарный; `.mpl` —
  plain text.
- Единственный подтверждённый сторонний читатель `.mw` —
  `davidovitch/maple-to-python` (`mw2txt.py`, lxml, GPL-3.0/LGPL-заголовок,
  заброшен с 2015): читает `Text-field` со `style=="Maple Input"`.

**Главный невыясненный пункт:** действительно ли пакет `Worksheet`
(`ReadFile`/`WriteFile`/`ToString`/`Convert`/`WorksheetToMapleText`) работает
под командным `maple`/`cmaple` в 2018/2022 — по документации GUI-only только
`Display`, но нужен smoke-тест на реальной установке.

---

## 4. Внешние API: OpenMaple

Подтверждено ([OpenMaple: Overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple),
детали — `research/02-openmaple-c.md`):

- OpenMaple — **in-process embedding API**: наш процесс сам становится ядром
  Maple, отдельного процесса `maple` нет. Заголовок — **`maplec.h`** в
  `$MAPLE/extern/include` (не `maple.h`!). Библиотеки лежат в
  `$MAPLE/bin.<SYS>` (`bin.X86_64_LINUX` / `bin.APPLE_UNIVERSAL_OSX` /
  `bin.X86_64_WINDOWS`), а **не** в `extern/lib`:
  Linux `libmaplec.so` (+`libmaple.so`, `libhf.so`), macOS `libmaplec.dylib`,
  Windows `maplec.dll`/`maplec.lib`.
- Java: `$MAPLE/java/{jopenmaple.jar,externalcall.jar}`;
  C#/.NET: `$MAPLE/extern/include/maple.cs` (`MapleEngine`); VB6 тоже есть.
- Runtime: `MAPLE=<install root>` + `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` с
  bin-каталогом (Windows: `PATH`). Официальный бутстрап:
  `export MAPLE=...; . $MAPLE/bin/maple -norun`.
  Неверный `MAPLE` ⇒ `StartMaple` возвращает NULL с «license.dat does not exist».
- Точки входа:
  `StartMaple(argc,argv,&cb,user_data,info,err)` → `EvalMapleStatement(kv,str)`
  → `MapleToString(kv,algeb)` → `StopMaple(kv)`; для дешёвого сброса —
  `RestartMaple(kv,err)`. Функции `MapleOpenMaple` не существует. `argv[0]`
  должен быть `"maple"`, буфер `err` ≥ 2048 байт, `info` = NULL,
  `StopMaple` необратим (повторный `StartMaple` в том же процессе нельзя).
- Результаты: текстовый колбэк (результат приходит **фрагментами**, один
  результат ≠ один вызов) и структурированные `ALGEB` (`MapleToString`,
  `MapleToInteger64`, `IsMaple*`).
- **Threading:** API можно звать только из потока, вызвавшего `StartMaple`;
  одно ядро на поток ⇒ один OS-процесс на сессию.
- Лимиты — это просто флаги CLI в `argv`: `-T cpu,data,stack,core`,
  `--init-reserve-mem`, `--init-commit-mem`.
- Лицензия: нужна полноценная локально установленная лицензированная Maple;
  отдельного бесплатного рантайма нет; доп. условия —
  `$MAPLE/extern/OpenMapleLicensing.txt` (содержимое онлайн не опубликовано →
  UNVERIFIED).
- **Стабильность:** глава про OpenMaple текстуально совпадает в официальных
  Programming Guide для 2018, 2021 и 2023 — C API стабилен, ABI-изменений и
  deprecations не задокументировано. Для 2022 ProgrammingGuide.pdf не
  публикуется (404), то есть 2022 зажат между 2021 и 2023.

### Python: важная поправка

- Официальный **«OpenMaple for Python» появился только в Maple 2023**
  (verbatim из Maple 2023 Connectivity update). В 2023 модуль назывался
  `import maple`, с 2024 — `maplesoft.maple`, а README на GitHub прямо пишет
  «requires an installation of Maple 2024 or later».
  → **в 2018 и 2022 его нет.**
- Репозиторий `github.com/Maplesoft/openmaple` (MIT, создан 2024-08-21, жив)
  содержит `maplesoft/maple/maplec_ctypes.py` — готовый набор объявлений
  ctypes, который мы можем **адаптировать под 2018/2022**
  (нюансы: там буфер `err` всего 1024 байта при требуемых 2048; жёстко
  зашит `c_int64` для `M_INT`).
- Других рабочих Python-обёрток нет: PyPI `PyMaple` — не про то,
  `openmaple`/`pyopenmaple`/`maplebridge` не существуют. Единственная живая
  не-Python обёртка — `mezzarobba/openmaple-ocaml` (public domain, pre-alpha)
  как референс.
- **Разрешение неопределённости:** OpenMaple C API документирован уже в
  Maple 2018 Programming Guide (гл. про OpenMaple, с. 476) и текстуально совпал
  с 2021/2023 ⇒ `libmaplec` в 2018 и 2022 **есть**, и своя тонкая
  ctypes-обёртка под старые версии — рабочий путь.
- Модель сессии у официального Python-биндинга — **persistent, stateful**:
  модульная глобальная `Session` держит одно живое ядро, переменные переживают
  вызовы. Именно такая семантика нам и нужна.
- Ещё один референс модели результатов — **MapleNet Compute API**
  (protobuf Request/Reply, `Session{id,timeout}`, `OutputOptions TEXT|MATHML`,
  `PlotOptions IMAGE|PROTOBUFFER` с размерами в пикселях и типизированный поток
  событий `result/printf/print/lprint/error/warning/server_error/image_plot/plot`).
  Требует сервер MapleNet, а не desktop Maple, но как образец модели
  «результат + вывод + график» очень полезен.

**Вывод:** для 2018/2022 путь такой — либо C/C++ helper, либо **ctypes-обёртка
на базе MIT-кода Maplesoft**, либо (проще всего) отдельный процесс
`cmaple`/`maple`, см. `research/01-cli-batch.md`.

---

## 5. Запуск Maple снаружи: CLI и batch

(Раздел дополняется; ниже — подтверждённое официальной справкой и
Programming Guide 2018/2022, детали в `research/01-cli-batch.md`.)

**Имена команд — важно не перепутать:**

- Linux/macOS: консольный Maple — это `maple` (скрипт в `bin/` установки),
  GUI — `xmaple`.
- Windows: консольный — `cmaple(.exe)`, GUI — `maplew`.
- Официально: «To start the Command-line version in Mac or Linux, use the
  `maple` command. In Windows, use the `cmaple` command»
  ([Maple Versions](https://www.maplesoft.com/support/help/maple/view.aspx?path=versions));
  Maple 2018 Programming Guide §14.4 — то же самое.
  → MCP-сервер под Linux должен звать `<maple>/bin/maple`, а не `cmaple`.

**Запуск скрипта:**

```bash
maple -q -s script.mpl        # позиционный файл после опций
maple < script.mpl            # так делают на HPC-кластерах (NCSU)
```

- **`-f` — это НЕ «выполнить файл»**, а «использовать указанный license-файл».
  Исполняемый скрипт — это позиционный `file` в конце командной строки.
- `-c <команда>` — выполнить команду до чтения входа; опцию можно повторять,
  они выполняются по порядку. Классический паттерн:
  `cmaple -q -b <libdir> -cread(...) -cquit`.
- `-w` — это **warning level**, не «worksheet».
- По calling sequence: `-B` — batch-режим, `-b libname` — путь к главной
  библиотеке (уточняется).

**Коды возврата (одинаковы в 2018 и 2022):**

| Код | Значение |
|---|---|
| 0 | нормальное завершение |
| 1 | ошибка инициализации |
| 2 | скрипт оборвался (например, незакрытый разделитель) |
| 3 | не удалось переоткрыть stdin после скрипта с `-F` |
| 4 | ошибка при обработке скрипта (порог зависит от `interface(errorbreak)`) |
| 5 | ядро неожиданно завершилось |
| n | результат `quit(n)` / `done(n)` / `stop(n)` |

**Критично для автоматизации:** при дефолтном `errorbreak=1` прерывается
только **синтаксическая** ошибка (код 4), а **runtime-ошибка скрипт не
останавливает и код остаётся 0**. Чтобы любая ошибка давала код 4, нужно
запускать с `-e2` (в 2022+ есть и `-e3` — с печатью stack trace).
Это надо либо зашивать в наш запуск, либо явно проверять вывод на ошибки.

**Различия 2018 ↔ 2022 по опциям:** в 2018 есть `-cw` (Classic Worksheet) и
нет `--echofile`/`--strip-debug-info`; в 2022 наоборот. `-noAI` — только
свежие версии (2024+).

### 5.1 Варианты backend'а: сравнение

| Вариант | Версии | Состояние сессии | Старт/память | Сложность | Комментарий |
|---|---|---|---|---|---|
| CLI `maple -q -s -e2 file.mpl` (процесс на запрос) | 2018, 2022 | нет (stateless) | процесс живёт только на запрос; Maplesoft заявляет ~0.1 с на старт (проверить на месте) | низкая | самый предсказуемый; парсим stdout/stderr и код возврата |
| Долгоживущий `maple` + stdin/stdout с маркером-сентинелом | 2018, 2022 | да | резидентное ядро (сотни МБ) | средняя | хрупко: буферизация, частичные чтения, смешение вывода |
| OpenMaple C через свою ctypes-обёртку | 2018, 2022 (API стабилен 2018→2023) | да | in-process; одно ядро на поток ⇒ один процесс на сессию | средне-высокая | структурированные `ALGEB`; референс — MIT-код Maplesoft |
| OpenMaple Java | 2018, 2022 | да | +JVM; **обязателен `-Xss100M`** (иначе segfault); одно `Engine` на JVM; `stop()` терминален, сброс — `restart()`; `dispose()` на каждый результат | высокая | только если нужны типизированные объекты |
| **Официальное Jupyter-ядро Maple (ZeroMQ)** | **2022+** | да | как обычное ядро Jupyter | средняя (протокол готовый) | `Jupyter[GenerateKernelConfiguration](dir)` + `jupyter kernelspec install dir/maple` |
| OpenMaple for Python | 2023+ | да | — | — | не наш случай |
| MapleNet (сервер) | отдельно | да | — | высокая | не для тонкого локального бокса |

Нюанс по Java: имена JAR в доках расходятся — Programming Guides 2018/2021/2023
говорят `$MAPLE/java/{externalcall.jar,jopenmaple.jar}`, а текущая справка —
`Maple.jar` + `externalcall.jar` (класс `com.maplesoft.openmaple` внутри
`Maple.jar`). Официального `openmaple.jar` нет. На месте надо просто
посмотреть `ls $MAPLE/java`. Бутстрап из Guide 2018:

```java
Engine t = new Engine(new String[]{"java"}, new EngineCallBacksDefault(), null, null);
t.evaluate("int(x,x);");
```

(`args[0]` обязан быть `"java"`, четвёртый аргумент — `null`.)

**Рекомендация:** базовый backend — CLI (работает и в 2018, и в 2022, без JVM и
без нативных зависимостей); на Maple 2022 опционально подключаем официальное
Jupyter-ядро; Java — только если реально нужны типизированные Maple-объекты,
и тогда один долгоживущий helper-JVM (per-request JVM недопустим).

### 5.2 Рекомендуемая архитектура (черновик)

**Где живёт сервер.** Только на машине, где установлен и лицензирован Maple:
ядро, библиотеки и лицензия локальны, облачного обходного пути для 2018/2022 нет.
В Икар его подключаем как `stdio` (если это тот же хост) или `streamable-http`.

**Процесс.** Консольный Maple — это **REPL**: он живёт, пока открыт stdin, и
хранит состояние сессии. На EOF по умолчанию **выходит**; `-F` заставляет
продолжить. Готовим так:

- запуск `<maple>/bin/maple -q -s -t` (Linux/macOS) или `cmaple.exe …` (Windows);
  **`-t` — машинный режим**: prompt становится `#-->`, prettyprint отключается;
- `-q` **не** убирает prompt `"> "` — убирает `interface(quiet=true)`;
- **документированного управления flush для stdout нет** (`interface` и
  `kernelopts` не имеют `flush`; `fflush`/`FileTools:-Flush` — только для файлов).
  Поэтому реальные обёртки либо работают через **pty** (SageMath: `maple -t` +
  ожидание `#-->`; Emacs comint: `^> `), либо читают до **явного маркера**
  (TeXmacs: `printf(\`tmstart\n\`)` / `printf(\`tmend\n\`)`; старый maplev:
  `lprint(END_OF_OUTPUT);`);
- выставляем `interface(errorbreak=0)`: при чтении от пользователя обработка
  продолжается после любой ошибки, но для перенаправленного stdin значения 1–3
  останавливают разбор, а поведение ветки «pipe» не задокументировано;
- `quit`/`done`/`stop` — ключевые слова, сессию убивают и не перехватываются: их
  надо вырезать из приходящего кода или быть готовыми перезапустить процесс
  (старт ~0.1 с);
- `restart` — только отдельной строкой; сбрасывает и опции `interface`, но при
  `-c` команды `-c` выполняются заново (удобно переустановить настройки);
- убивать зависшее — `timelimit(N, …)` + `kernelopts(cpulimit)`/`-T`, снаружи
  SIGINT→SIGTERM→SIGKILL **в группу процессов** (Linux `bin/maple` — shell-скрипт,
  `exec`-поведение не подтверждено; TeXmacs делает `setsid()` + `killpg()`).

**Почему это хрупко.** Отсутствие гарантированного flush и опора на маркеры — ровно
та причина, по которой текущий maplev ушёл с `cmaple` на собственный
OpenMaple-бинарь (`pmaple` с `fflush(NULL)`), а SageMath/Emacs сидят на pty. Если
persistent-режим окажется нестабильным, переходим на OpenMaple или Jupyter-ядро.

- `-e2` **обязателен**: иначе runtime-ошибка не меняет код возврата, и провал
  легко «потерять».
- Перед запросами ставим машинно-читаемый вывод, иначе результат придёт
  типографским текстом и с ANSI-цветом (на UNIX ANSI **включён по умолчанию**):
  ```maple
  interface(prettyprint=0):
  interface(ansi=false):
  interface(quiet=true):
  ```
  Без `ansi=false` парсер обязан срезать escape-последовательности.
- «Выполнить одну ячейку» = отправить код ячейки как есть и собрать: stdout,
  поток ошибок, результат последнего выражения, при необходимости —
  LaTeX/MathML/PNG, выгруженные во временный файл.

**Fallback.** Для изоляции «чистого» запуска — процесс на запрос
(`maple -q -s -e2 tmp.mpl`), ценой старта. На Maple 2022 — опциональный backend
на официальном Jupyter-ядре.

**Формат воркшитов.** `.mw` — обычный XML, поэтому читаем/пишем сами, без
сторонних библиотек: парсим `<Group><Input><Text-field style="Maple Input">`,
генерируем только 1-D. 2-D вход снаружи нечитаем — для него зовём
`Worksheet:-WorksheetToMapleText` (если пакет работает headless; если нет —
честно сообщаем, что ячейка 2-D и снаружи не читается). Base64-выводы
(`<Equation>`, `<Plot>`) не синтезируем.

**Ресурсы тонкого прода.** Лимиты ядра через `-T` (cpu/data/stack/core);
`lifecycle: lazy` в конфиге Икара; idle-timeout, гасящий ядро; один сеанс на
пользователя, без пула ядер.

**Чего не делаем.** Per-request JVM; несколько ядер на тонком боксе;
GUI/X11 — если только не выяснится, что пакет `Worksheet` без GUI не работает
(тогда либо Xvfb, либо живём только XML-путём).

### 5.3 Как выполнить одну ячейку (execution group)

**Короткий ответ: документированного API «выполнить одну group из неоткрытого
`.mw`» нет.** Ни в `Worksheet`, ни в `DocumentTools` нет команды, принимающей
номер/идентификатор группы; в командной строке нет опции выбора группы или метки
(`DocumentTools:-Run` и `:-Evaluate` не существуют).

Что реально есть (детали — `research/07-…md`):

| Возможность | Команда | Выполняет? | Охват | GUI? |
|---|---|---|---|---|
| Выполнить **весь** воркшит как процедуру | `DocumentTools:-RunWorksheet(ws, …)` | да | все группы, в **новом ядре** | нет — явно поддерживает «command-line Maple» |
| Воркшит → **1-D текст** | `Worksheet:-WorksheetToMapleText("f.mw")` (2017+) | нет | все входные группы | UNVERIFIED в CLI |
| Воркшит → **XML-дерево** | `Worksheet:-ReadFile("f.mw")` | нет | все узлы | UNVERIFIED в CLI |
| Внутренняя метка → выражение | `DocumentTools:-Retrieve("f.mw", L6)` | **нет** (только возвращает) | один помеченный выход | UNVERIFIED в CLI |
| Открыть воркшит в GUI | `Worksheet:-Display` / `DisplayFile` | GUI | — | **да** — «cannot be used in the Command-line version» |

Про `RunWorksheet`: новый движок (состояние с вызывающим не разделяется), есть
`var_init`/`outputs`, а **досрочный выход — top-level `return`** в конце последней
нужной группы. Он **существовал уже в 2018** (PG2018, с. 190); в справке 2022 у
параметра `inheritlibname` пометка «(optional, cmaple only)», и прямо сказано,
что воркшит «runs headless». Часть параметров новее 2022, поэтому набор для 2018
надо проверить. `DocumentTools:-Retrieve(filename, label)` адресует по
`labelreference` (`L1`, `L6`; в реальном `.mw` подтверждён
`<Label-Scheme value="2"/>`), но только **возвращает** выражение, не выполняя
его. `WorksheetToMapleText` выдаёт весь файл **без разделителей групп**. Отсюда
практический приём: **один execution group — один файл** + `RunWorksheet`, либо
извлечение N-й группы из XML (наш основной путь).

**Практический путь (то, что и будем делать):** вытащить текст
`<Group><Input><Text-field style="Maple Input" prompt="&gt; ">…</Text-field></Input></Group>`
и отдать ядру (`read`, stdin, `-c` или OpenMaple). Одна execution group — это
просто один блок операторов; в формате файла в ней нет ничего «магического».

**Семантические оговорки:**

- Группа рассчитана на **общее состояние ядра и документный порядок**, поэтому
  выполнять группу *k* в одиночку осмысленно, только если она самодостаточна.
  Честная операция «выполнить часть воркшита» — **выполнить префикс 1…k по
  порядку**.
- `restart` внутри группы надо уважать: он сбрасывает всё (включая опции
  `interface`) и обязан быть на отдельной строке; при `-c` команды `-c` после
  него выполняются заново.
- **~34% реальных входов — только-2-D** и снаружи нечитаемы; их линеаризуем через
  `Worksheet:-WorksheetToMapleText`.
- Выполнение фрагмента **не создаёт метки уравнений** и **не меняет `.mw`** на
  диске.
- Формат официально «not documented, and is subject to change» — парсим защитно.

### 5.4 Эксплуатация: лимиты, лицензия, диагностика

- **Память/CPU.** `-T cpu,data,stack,core` — OS-лимиты, значения в
  **килобайтах**, можно указать любой префикс из четырёх. Пример «60 c CPU,
  4 ГиБ»: `maple -q -s -T 60,4194304 job.mpl`. `--init-reserve-mem=` задаёт
  размер виртуальной карты (и это же максимум памяти сессии); при конфликте
  **`-T` имеет приоритет**. Есть и `kernelopts(datalimit=…)`.
- **Лимит на одно вычисление.** `timelimit(seconds, expr)` внутри кода, а `-T` —
  внешний предохранитель.
- **Как убивать зависшее.** Сигнал (SIGINT/SIGTERM) надо слать **процессу ядра
  или группе процессов**, а не обёртке-скрипту `maple`: на Linux `maple` — это
  shell-обёртка (точное поведение `exec` — в списке непроверенного).
- **Лицензия.** Для batch не нужно ничего сверх обычной активированной лицензии:
  single-user `license.dat` в `<maple>/license/` либо сетевой FlexNet-сервер
  (`lmgrd` + `maplelmg`). **Каждый живой процесс Maple — отдельный лицензионный
  инстанс**, поэтому пул ядер плох ещё и по лицензии. Признак проблемы —
  код возврата `1`.
- **Проба при старте** (версия/платформа/лицензия):
  ```sh
  /opt/maple2022/bin/maple -q -s -e2 \
    -c 'printf("PROBE %a %a %a\n", kernelopts(version), kernelopts(platform), kernelopts(wordsize)):'
  ```
- **Проверка синтаксиса без выполнения** (отдельный полезный инструмент):
  `maple -q -s -P -e0 file.mpl`.
- **Официальная оценка старта** (PG2018 §14.4, тот же текст в 2021/2022):
  «Starting the Maple command-line interface, automatically executing a command
  file, and stopping the Maple session can take about **one tenth of a second**»
  — Maplesoft сами позиционируют CLI как пригодный для вызова из других
  приложений «даже для быстрых вычислений». Проверить на месте.

### 5.5 Сериализация результата (что реально есть)

| Что нужно | Чем делать | Статус |
|---|---|---|
| машиночитаемый текст | `interface(prettyprint=0)`, `lprint`, `printf`/`sprintf` (`%a %A %q %m`) | подтверждено |
| значение выражения строкой | `convert(expr, string)` | подтверждено |
| запись вывода в файл | `writeto`, `FileTools`; в CLI ещё `interface(echofile)` | подтверждено |
| XML воркшита из Maple | `printf("%Zm", …)`; `DocumentTools:-ContentToString` | подтверждено |
| LaTeX | `latex(expr, output=string)` | `latex` **переписан в 2021** → наборы опций 2018 и 2022 разные (для 2018 UNVERIFIED) |
| MathML | `MathML:-ExportContent(expr)` | подтверждено; **`convert(expr,'MathML')` не документирован** |
| график в файл | `plotsetup(png\|gif\|jpeg\|postscript, plotoutput=…)`, затем `plot(...)`; `Export(…, format="PNG"\|"GIF"\|"JPEG")`; `plottools:-exportplot` (GIF/JPEG/TIFF + вектор) | подтверждено |
| график в SVG/EPS | — | **SVG не поддерживается**, `plot(..., output=…)` — **такой опции нет** |

Важные дефолты CLI: `;` показывает значение, `:` подавляет; `interface(echo)` по
умолчанию 1, то есть **ввод эхом повторяется**, когда это не tty (`quiet=true`
перебивает); `prettyprint` в CLI по умолчанию 1 (в GUI — 3); **`printbytes` по
умолчанию true → в вывод попадает мусор «bytes used=…»** (надо выключать);
`warnlevel` 3; `errorbreak` 1. Поэтому протокол строим на **рамках-сентинелах
через `printf` и терминаторах-двоеточиях**, а не на разборе позиций.

---

## 6. Как это стыкуется с Икаром

Точная схема слота (`packages/service/src/config.ts`):

```ts
export type McpServerConfig = {
  transport?: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  lifecycle?: 'eager' | 'lazy';
};
```

- В `config.yaml` это `mcp: { <имя>: {...} }`; в README пример — `mcp: {}`.
- `pi-mcp-extension` читает `~/.pi/agent/mcp.json`; сервис генерирует
  `settings.json` + `mcp.json` из конфига.
- Есть образец минимального stdio-сервера: `docker/user/mcp/echo-server.mjs`
  (raw JSON-RPC построчно; `initialize` / `notifications/initialized` /
  `tools/list` / `tools/call`; протокол `2024-11-05`).
- `lifecycle: eager|lazy` — можно держать ядро Maple прогретым (`eager`) или
  поднимать по требованию (`lazy`); для «тонкого прода» это рычаг памяти.

Следствие: Maple-MCP — отдельный процесс, который удобнее всего запускать
**там, где стоит Maple** (на машине мамы), и подключать в Икар либо как
локальный stdio-сервер, либо как `streamable-http` (если Maple на другой
машине). Ядро Икара править не нужно.

**Что надо уточнить у владелицы железки:** ОС и версию (2018 или 2022). От этого
зависит имя исполняемого файла (`cmaple.exe` в Windows vs `bin/maple` в
Linux/macOS), пути (в Windows — что-то вида
`C:\Program Files\Maple 2022\bin.X86_64_WINDOWS\cmaple.exe`), наличие
Jupyter-ядра (только 2022) и вообще то, где физически может жить MCP-сервер.
До этого момента все конкретные команды в отчёте даны в двух вариантах.

---

## 7. Набор инструментов MCP (предложение)

Список официального Maple MCP неизвестен (§2), поэтому это **предложение**,
собранное из вендорских и community-поверхностей (детали —
`research/06-mcp-prior-art.md` §3.7). Префикс `maple_` обязателен: без него имена
вроде `matrix_operation` конфликтуют с SymPy/Sage-серверами.

**Tier 1 — ядро (делать первым):**

| Инструмент | Назначение | Параметры | По образцу |
|---|---|---|---|
| `maple_evaluate_code` | выполнить код в сессии, вернуть результаты | `code`, `timeout_seconds?`, `session?` | Wolfram `WolframLanguageEvaluator` |
| `maple_check_code` | статический анализ **без выполнения** | `code` или `path` | MathWorks `check_matlab_code` |
| `maple_help` | справка по команде/теме | `topic` | Wolfram `WolframContext` |
| `maple_health` | проверка, что счёт работает: версия + задержка | — | sagemath `check_sage_health` |

**Tier 2 — сессии и качество вывода:**

| Инструмент | Назначение |
|---|---|
| `maple_verify` | независимая перепроверка утверждения: proved / refuted / supported / undecided (родные `verify`/`is`) |
| `maple_validate_code` | нормализация/разбор кода и внятные синтаксические ошибки **без выполнения** |
| `maple_start_session` / `maple_list_sessions` / `maple_stop_session` | именованные рабочие пространства с независимым состоянием |
| `maple_reset_session` / `maple_interrupt_session` / `maple_cancel_session` | сброс / прерывание с сохранением состояния / отмена |
| `maple_to_latex` | выражение → LaTeX или MathML |
| `maple_plot` | график как изображение (`png`/`svg`, ширина/высота) |

**Tier 3 — документы: только на уровне документа, НЕ по ячейкам.** Это самая
важная поправка, которую даёт prior art: оба вендора, реально поставляющие
работу с документами (Wolfram `ReadNotebook`/`WriteNotebook`, MathCAD
`open_worksheet`/`calculate_worksheet`/`save_as_pdf`), дают **операции над целым
документом с текстовым форматом обмена**, а не `create_cell`/`edit_cell`/
`run_cell`. Придумывать per-cell API не нужно — прецедента нет, а поверхность
растёт. Если окажется, что локальный Maple не даёт удобной работы с документами,
Tier 3 можно выбросить целиком, не трогая Tier 1–2.

| Инструмент | Назначение |
|---|---|
| `maple_read_document` | прочитать воркшит как markdown/текст |
| `maple_write_document` | записать markdown/текст как документ Maple |
| `maple_run_document` | выполнить документ и вернуть результаты |
| `maple_export_document` | экспорт в PDF/LaTeX/… |

**Широкий tier операций (`maple_solve`, `maple_dsolve`, `maple_int`, …) — не
сейчас.** У вендорских серверов поверхность маленькая; но у ближайшего
community-аналога (`maxima-mcp`) — 133 операции, и там эмпирически требуется
отдельный routing-документ «тип задачи → инструмент», иначе выбор инструментов
деградирует. Рекомендация: начать с Tier 1–2, измерить, и добавлять широкий tier
только если generic-evaluator не хватает.

**Сквозные правила (все подкреплены источниками в §3.7 отчёта 06):**

- Машинно-читаемый **статус результата**: `exact` / `approximate` /
  `unevaluated` / `no_closed_form` / `error` / `timeout` + текст warning.
  Это защищает от того, чтобы «Maple вернул `int(...)` без изменений» модель
  подала как ответ.
- `isError: true` для ошибок Maple, а не JSON-RPC error; таймаут не должен
  выглядеть как математический ответ.
- Жёсткие таймауты с задокументированным дефолтом + лимит памяти, где возможно.
- **Усечение вывода с явным маркером** — символьный вывод Maple бывает огромным.
- **Биг-инты передавать строкой**: JSON-числа в JS-клиентах — это IEEE double,
  поэтому 30-значное целое молча округлится ещё до нас.
- Предупреждение в описании про команды, убивающие сессию (`restart`, `quit`,
  переопределение встроенных имён).
- Аннотации по эффекту: read-only для `check`/`help`/`health`/`read`,
  destructive для всего, что пишет или исполняет.
- Честность про sandbox: Maple исполняет произвольный код (файлы, `system()`,
  сокеты), поэтому «списки запрещённых подстрок» — защита от аварий, а не от
  злонамеренного кода; граница — OS-ограничение (отдельный пользователь,
  контейнер), и это надо написать в документации.
- Транспорт — **stdio** для локального сервера (и никаких API-ключей в
  query-параметрах, как у облачного Maple MCP).

---

## 8. Детальные отчёты (в этом же worktree)

| Файл | Тема | Состояние |
|---|---|---|
| `research/01-cli-batch.md` | CLI `maple`/`cmaple`, headless, batch, коды возврата, лимиты, лицензия | готов (кроме §3/§4 — см. 07) |
| `research/02-openmaple-c.md` | OpenMaple C API + Python-биндинги | готов |
| `research/03-openmaple-java-dotnet.md` | Java/.NET, стоимость моста, Jupyter | готов |
| `research/04-file-formats.md` | `.mw`/`.mws`/`.mpl`, XML, сторонние парсеры | готов |
| `research/05-in-maple-worksheet-api.md` | `Worksheet`/`DocumentTools`, одна ячейка, сериализация | готов |
| `research/06-mcp-prior-art.md` | официальный Maple MCP, CAS-MCP, набор инструментов | готов |
| `research/07-single-group-and-persistent-process.md` | одна execution group + долгоживущий процесс | готов |

## 9. Что прогнать на живой установке (smoke-тесты)

Порядок — от дешёвого к дорогому. Всё это надо сделать **на машине с Maple**,
до написания MCP-сервера.

1. **Лицензия и версия.**
   `maple -q -s -e2 -c 'printf("%a %a\n", kernelopts(version), kernelopts(wordsize)):'`
   (Linux: `<maple>/bin/maple`, Windows: `cmaple.exe`). Код возврата 1 — проблема
   с лицензией/установкой.
2. **Headless-пакет `Worksheet`** (главный невыясненный пункт): работает ли
   `Worksheet:-ReadFile` / `Worksheet:-ToString` / `Worksheet:-WriteFile` /
   `Worksheet:-WorksheetToMapleText` под командным `maple` без GUI. Заведомо
   GUI-only только `Display` (подтверждено вербатим). Если остальное работает —
   чтение и генерация воркшитов делаются «изнутри Maple», а не своим XML-кодом.
3. **`DocumentTools` headless:** `InsertContent`, `Retrieve(path, label)`,
   `GetProperty`/`SetProperty` — что работает без открытого окна.
4. **Persistent-протокол:** запустить `maple -q -s -t` как долгоживущий процесс
   (и отдельно — через pty), отправить два запроса с маркером-сентинелом,
   проверить: (а) сохраняется ли состояние между запросами, (б) флашится ли вывод
   при stdout=pipe, (в) что происходит после синтаксической и runtime-ошибки при
   `errorbreak=0`, (г) виден ли prompt `#-->` и годится ли он как sentinel.
5. **Замер старта и памяти:** время до первого результата и RSS ядра (idle и
   после тяжёлого счёта) — от этого зависит, можно ли держать ядро прогретым на
   тонком боксе.
6. **Круг `.mw`:** сгенерировать минимальный `.mw` нашим XML-кодом, открыть его
   в Maple 2018 и 2022 — проверяем, что формат принят; затем прочитать в Maple
   файл, созданный GUI, и сравнить структуру.
7. **Одна ячейка:** извлечь текст `<Group><Input><Text-field style="Maple Input">`
   из реального воркшита, выполнить префикс 1…k, сравнить с результатом
   выполнения тех же ячеек в GUI (порядок, состояние, вывод). Отдельно проверить
   `DocumentTools:-RunWorksheet` (весь воркшит headless, новый движок, ранний
   выход через top-level `return`) — существуют ли эти параметры в 2018/2022.
   И проверить линеаризацию 2-D через `Worksheet:-WorksheetToMapleText`.
8. **Сериализация:** `latex(expr, output=string)` (и какие опции есть именно в
   2018 — `latex` переписан в 2021), `MathML:-ExportContent`,
   `plotsetup(png, plotoutput=…)`, `Export(…, format="PNG")`, запись в файл — всё
   headless. Проверить, что `printf("%Zm", …)` и
   `DocumentTools:-ContentToString` дают валидный `.mw`.
9. **Тонкие места версий:** `.mws` в 2022 (только миграция), `-e3` в 2022 vs
   `-e2` в 2018, наличие `--echofile`, поведение `interface(ansi=false)`,
   выключение `printbytes` и `echo`.
10. **Создание `.mw` изнутри Maple (headless):** `DocumentTools:-Layout:-*` →
    `ContentToString` → `FileTools:-Text:-WriteFile`; открыть результат в GUI
    обеих версий.

---

## 10. Что подтвердилось на живой установке (Maple 18.00)

На машине оказался **Maple 18.00** (`X86 64 LINUX, Feb 10 2014, Build ID
922027`, `/opt/maple18`), а не «Maple 2018». Это важно: часть API, которую мы
считали доступной «в 2018», в 18.0 отсутствует.

Проверено вживую:

- `Worksheet:-ReadFile/WriteFile/FromString/ToString/Convert` — есть и
  **работают headless**; `Worksheet:-WorksheetToMapleText` — **нет** (2017+).
- `DocumentTools:-InsertContent/GetProperty/SetProperty/Do/Retrieve/RunWorksheet/GetDocumentProperty`
  — есть; **`Tabulate` и `ContentToString` — нет**.
- `Worksheet:-Display` — только GUI (как и писала справка).
- `latex(expr, output=string)`, `MathML:-ExportContent` работают; графику
  отдаёт `plottools:-exportplot` в **gif/jpeg/bmp**, а `png`/`tiff` — **нет**.
  `Export(..., format="PNG")` в 18.0 просто возвращает невычисленный вызов.
- **`maple -c` использовать нельзя**: launcher `maple` — shell-скрипт, который
  делает `eval` аргументов, поэтому код и пути с кавычками и слэшами ломаются.
  Надёжно — через stdin или файл-скрипт.
- **Синтаксическая ошибка в живом REPL вешает поток**: следующие операторы не
  выполняются. Runtime-ошибки безопасны. Спасает предварительная проверка
  синтаксиса отдельным процессом (`maple -P`) — тогда сессия не портится.
- `maple -q -s -t` даёт чистый вывод без prompt'а и без «bytes used»; вывод
  флэшится сразу; старт ~50 мс; RSS ядра ~5 МБ.
- `.mw` в Maple 18 — тот же plain-text XML; в примерах встречается
  `<Version major="11" …>` (файл, не пересохранённый ещё с Maple 11), то есть
  `major` — версия формата, а не год релиза.
- 2-D ввод удаётся читать по атрибуту `input-equation` (линейная форма Maple),
  а не только как «непрозрачный base64».
- **Внешние библиотеки Maple 18 не грузятся на современной glibc:**
  `libatlas.so` и `libmsp.so` (2014 год) требуют исполняемого стека, а `dlopen`
  в glibc 2.41+ (Ubuntu 26.04) такие объекты отвергает. Симптом —
  `Error, (in dsolve) external library libmodLA.so could not be found/used`,
  то есть молча ломаются `dsolve`, `pdsolve`, численные ОДУ и всё, что тянет
  ATLAS. Лечится снятием флага `PT_GNU_STACK RWE`:
  `tools/maple-mcp/fix-execstack.py` (с бэкапами `*.bak-execstack`, есть
  `--restore`). После фикса `dsolve` даёт `y(x) = 1/k*sin(k*x)`,
  `pdsolve` решает уравнение теплопроводности.

Реализация по итогам: **`tools/maple-mcp/`** — сервер (stdio + Streamable HTTP)
и самотесты (27 + 20 проверок, все зелёные).

### 10.1 Сессии между чатами: как это устроено на самом деле

- **Мост pi убивает наш MCP-процесс в конце чата** (`session_shutdown` →
  `manager.shutdownAll()`), так что держать состояние в памяти ядра нельзя.
  Поэтому состояние живёт в **журнале**: `$MAPLE_SESSION_DIR/<имя>.jsonl`,
  а при первом обращении к сессии в новом процессе журнал проигрывается в свежее
  ядро (в ответе — пометка «сессия восстановлена из журнала: N шагов»).
- Проверено на **трёх последовательных процессах** MCP: в первом вводим данные и
  решаем ОДУ, во втором продолжаем (`m=2 k=3`, `y(1)`) и дописываем шаг, в третьем
  снова читаем состояние. И отдельно — **на двух разных контейнерах**:
  `q:=5:` в одном, `q*100` → `500` в другом (журнал лёг в персистентный маунт
  `~/.pi/agent/maple-mcp`).
- Ядро гасится после **5 минут** простоя (`MAPLE_IDLE_SECONDS`), журнал остаётся —
  следующий вызов поднимает ядро и восстанавливает состояние.
- `restart` в коде очищает журнал; `maple_session_forget` стирает его совсем.
- `pi-mcp-extension` **выбрасывает изображения**, заменяя их текстом
  `[Image: image/gif, base64 encoded]`. Поэтому `maple_plot` возвращает и
  image-контент (для клиентов, которые его умеют), и путь к файлу на диске.
- Журнал — это повтор команд, а не снимок памяти: тяжёлый шаг при восстановлении
  выполняется заново. Для долгих расчётов результаты лучше сохранять в файл.

---

## 11. Источники

Официальное (Maplesoft):

- https://www.maplesoft.com/products/maplemcp/index.aspx — официальный Maple MCP
- https://www.maplesoft.com.cn/products/MapleMCP/ — то же (CN)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=maple — команда `maple` и опции
- https://www.maplesoft.com/support/help/maple/view.aspx?path=versions — `maple` vs `cmaple` vs `xmaple`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW — формат `.mw`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2fMWS — формат `.mws`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet — пакет `Worksheet`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fConvert — `Convert`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=examples/WorksheetPackage — примеры
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fDTD и `.../Worksheet%2fSchema` — legacy Maple-8 XML (не `.mw`)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple — OpenMaple overview
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API и `.../OpenMaple/C/Examples` — C API
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/Python/API — Python API (2023+)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Jupyter/MapleKernel/Configuring — Jupyter-ядро Maple (2022+)
- https://www.maplesoft.com/documentation_center/ — Programming Guides (2018/2021/2023), User Manual
- https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf — зеркало Guide 2018 (§14.3–14.4)
- https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf — модель результатов MapleNet

Стороннее и практика:

- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/RunWorksheet — выполнить весь воркшит headless
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/Retrieve — метка → выражение (без выполнения)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/ContentToString — XML воркшита строкой (headless)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/GetDocumentProperty и `.../SetDocumentProperty` — свойства документа из файла (2017+/2021+)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=latex — LaTeX (переписан в 2021)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=plotsetup и `.../Export` — вывод графиков
- https://www.maplesoft.com/support/help/maple/view.aspx?path=printf — спецификаторы, в т.ч. `%Zm`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet/Display — «cannot be used in the Command-line version»
- https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet/expressions/equationlabels — метки уравнений
- https://github.com/Maplesoft/openmaple — официальный ctypes-биндинг (MIT, Maple 2024+), референс для своей обёртки
- https://github.com/mezzarobba/openmaple-ocaml — OCaml-обёртка OpenMaple (public domain, референс)
- https://github.com/davidovitch/maple-to-python — `mw2txt.py`, единственный внешний читатель `.mw`
- https://agenttools.wolfram.com/mcp — Wolfram MCP, референс формы инструментов
- https://hpc.ncsu.edu/Software/Apps.php?app=Maple — реальный batch-запуск `maple < script.mpl`
- http://ftp.informatik.rwth-aachen.de/maple/mplbatch.htm — исторический паттерн `-c`/`-q`/`-b`
- SageMath (интерфейс `maple` через pexpect/`maple -t`), TeXmacs (плагин Maple: `tmstart`/`tmend`, `errorbreak=0`, `setsid`+`killpg`), maplev (Emacs; в 3.x ушёл на свой OpenMaple-бинарь `pmaple`) — реальные примеры обвязки CLI
