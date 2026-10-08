# 09 — Мультичат Икара в Telegram: Mini App или нативные топики

**Статус:** разбор к решению, ничего не сделано. **Дата:** 08.10.2026.
**Вопрос.** Хочу мультичат в Telegram для Икара (список разговоров, как в ChatGPT/LibreChat),
и слышал про Telegram Apps — приложения, открывающиеся прямо в телеге. Реально ли это?
**Метод.** Первоисточники Telegram: Bot API reference (v10.3, 24.08.2026), `bots/features`,
`bots/webapps`, `bots/api-changelog`, `bots/faq`, блог telegram.org. Свой код:
`packages/service/src/**` (текущая ветка). Чужой опыт: hermes-agent (NousResearch) — прямой
аналог нашей задачи, nekoclaw (тот же `pi`, Docker на человека), tg-llm-router (Mini App для
LLM). Где источник — не документация, а чужой код/сообщество, это сказано явно. Что проверить
руками — §10.

---

## Короткий ответ

1. **Да, Mini App — реальная штука**, и мультичат в нём собрать можно: Telegram даёт webview,
   подписанные данные о человеке и запуск в один тап. Но это **не лучший инструмент именно для
   чата**: Mini App не имеет доступа к переписке (кроме attachment-menu режима), не умеет
   пушить, живёт только пока открыт, и весь UI — включая список чатов, историю и стриминг —
   придётся написать и хостить самим.

2. **Мультичат в Telegram уже есть нативно, и он ровно про наш случай.** Bot API 9.3
   (31.12.2025) и 9.4 (09.02.2026) добавили **топики в личке с ботом**: бот и человек заводят
   внутри одного личного чата отдельные топики, у каждого своя история. Документация Telegram
   сама продаёт это как замену веб-чатам с ИИ: *«Topics in Private Chats keep separate projects
   or support cases organized — improving on established web-based AI chat UIs»*
   ([features#ai-agents](https://core.telegram.org/bots/features#ai-agents)).
   Включается одной галкой в BotFather, а не разработкой.

3. **Икару это стоит почти нуля изменений.** Ключ сессии у нас уже `(человек, разговор)`
   (`sessions/registry.ts`), а `conversationId` для лички — `telegram-<chat_id>`
   (`telegram/bot.ts:conversationIdFor`). Достаточно добавить в ключ `thread_id`, и каждый
   топик автоматически получит свой процесс pi, свою историю в `/workspace/.sessions`
   (`sessions/pi-session.ts:sessionIdFor`) и свой `/compact`. Никакой БД не нужно: привязка
   топик→разговор выводится из самого сообщения.

4. **Правильная роль Mini App у нас — панель, а не чат.** Панель уже есть
   (`control/ui.ts`, `control/identity.ts`), у неё архитектура разделов (`SECTIONS` в
   `control/index.ts`), и Mini App — естественный способ открыть её с телефона в один тап,
   с авторизацией через `initData` вместо SSO-прокси. Чат-клиент в webview — это вторая,
   сильно более дорогая история с уведомлениями, которых у Mini App нет.

5. **Из 2026 года Икару нужны не Mini Apps, а три вещи из Bot API:** `sendMessageDraft`
   (нативный стриминг ответа + кнопка Stop вместо нашей правки сообщения раз в 1.2 с),
   rich messages (таблицы и LaTeX — прямо про Maple) и, если захочется, guest mode
   (позвать `@icarus` в любой чат, не добавляя бота). Подробности — §6.

**Итого:** «Telegram Apps» — реально, но мультичат делать надо не в них. Сначала §2 (топики),
потом §5 (Mini App как панель), Mini App как чат-клиент — только если первых двух не хватит.

---

## 1. Что случилось в Telegram за 2026 год (таймлайн для нас)

Всё ниже — Bot API changelog и `bots/features`; версия API на дату разбора — **10.3
(24.08.2026)**.

| Дата | Версия | Что появилось | Чем полезно Икару |
|---|---|---|---|
| 31.12.2025 | 9.3 | **Topics in private chats**: `has_topics_enabled` в `getMe`, `message_thread_id`/`is_topic_message` в личке | Список разговоров внутри личного чата |
| 09.02.2026 | 9.4 | Бот сам создаёт топики в личке (`createForumTopic`), `allows_users_to_create_topics` | `/topic` заводит топик из бота |
| 01.03.2026 | 9.5 | `sendMessageDraft` разрешён всем ботам, эмодзи на кнопках | — |
| 03.04.2026 | 9.6 | Managed bots, `WebApp.requestChat` | Не нужно |
| 08.05.2026 | 10.0 | **Guest mode** (бот отвечает в чатах, где его нет), бизнес-боты без Premium | Позвать Икара в любой чат |
| 11.06.2026 | 10.1 | **Rich messages** + `sendRichMessage`, `sendRichMessageDraft`, join-request Mini Apps | Таблицы/формулы, стриминг |
| 14.07.2026 | 10.2 | **Ephemeral messages** в группах, Communities; закрытие Mini App-методов для чужих origin (с 20.07.2026) | Личный ответ в общем чате |
| 24.08.2026 | 10.3 | Правки rich/ephemeral, `can_stop`/`keep_on_stop`, `MessageGenerationStopped` | Stop у стрима |

Главный вывод из таблицы: **пока мы думали про Mini App, Telegram закрыл нашу задачу
штатными средствами.** Дальше — по вариантам.

---

## 2. Вариант A (рекомендую): топики в личке — нативный мультичат

### 2.1 Как это выглядит для человека

В личном чате с ботом появляется тот же интерфейс, что у форума в супергруппе: список топиков
сверху, внутри — отдельная лента сообщений. Человек может заводить топики сам — через кнопку
**All Messages** в шапке чата с ботом: отправленное там сообщение создаёт новый топик (так это
описано в [доках hermes-agent](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md),
у Telegram в Bot API пользовательский сценарий не расписан). Бот создаёт топики вызовом API.
Формулировка документации:
*«Bots and users can organize long-running private conversations into separate topics — for
example, one topic for an order, another for technical support and a third for a recurring
task»* ([features#topics-in-private-chats](https://core.telegram.org/bots/features#topics-in-private-chats)).

Это буквально ChatGPT-подобный сайдбар, но нативный: ни вёрстки, ни хостинга, ни онбординга.

### 2.2 Что нужно включить (и где обычно спотыкаются)

Настройка — **на стороне владельца бота, в Mini App BotFather**, а не в чате:

1. Открыть **Mini App** BotFather: в поиске Telegram набрать `botfather` и нажать синюю кнопку
   **Open** у результата (прямая ссылка — <https://t.me/BotFather?startapp>). Текстовое меню
   `/mybots` этого пункта **не показывает** — на этом спотыкаются все;
2. `My bots → <бот> → Bot Settings →` прокрутить до **Threads Settings**;
3. **Threaded Mode** — включить; **«Disallow users to create new threads»** — оставить
   выключенным (иначе человек не заведёт топик сам, `allows_users_to_create_topics: false`).

Наглядный скриншот пути лежит у hermes-agent:
`gateway/assets/telegram-botfather-threads-settings.jpg`
([файл](https://github.com/NousResearch/hermes-agent/blob/main/gateway/assets/telegram-botfather-threads-settings.jpg)),
а история «не нашёл галку» разобрана в
[issue #48811](https://github.com/NousResearch/hermes-agent/issues/48811) — закрыт как проблема
навигации, а не rollout'а.

Проверка — `getMe`:

* `has_topics_enabled` — *«True, if the bot has forum topic mode enabled in private chats»*;
* `allows_users_to_create_topics` — *«True, if the bot allows users to create and delete
  topics in private chats»*.

Если режим выключен, `createForumTopic` возвращает `400 the chat is not a forum`. Поэтому наш
бот считает флаги из `getMe` (лениво, при первом `/topic` или `/start`) и в выключенном режиме
показывает инструкцию вместо ошибки Telegram. В личке с ботом галки «Topics» нет — она есть
только у групп; живой баг-репорт про это:
[hermes-agent#115019](https://github.com/NousResearch/hermes-agent/issues/115019).

### 2.3 API: что можно, а что нельзя

| Метод | В личке с ботом | Примечание |
|---|---|---|
| `createForumTopic` | да | *«Use this method to create a topic in a forum supergroup chat **or a private chat with a user**»*; `name` 1-128, `icon_color` из 6 значений, `icon_custom_emoji_id` |
| `editForumTopic` | да | Переименование и смена иконки, `message_thread_id` обязателен |
| `deleteForumTopic` | да | Удаляет топик вместе с сообщениями |
| `unpinAllForumTopicMessages` | да | — |
| `closeForumTopic` / `reopenForumTopic` | скорее нет | В документации на 10.3 — только «forum supergroup chat»; для лички не упомянуты. Похоже на не обновлённый текст, а не на запрет — **UNVERIFIED**, проверить вызовом |
| `message_thread_id` в `send*`, `sendChatAction`, `copy*`, `forward*` | да | `sendChatAction` явно оговаривает: *«for supergroups and private chats of bots with forum topic mode enabled only»* |
| `getForumTopicIconStickers` | да | Иконки-эмодзи для топика |

Как бот узнаёт про топик, созданный человеком: приходит служебное сообщение
`forum_topic_created` (`ForumTopicCreated`) с полем `is_name_implicit` — *«True, if the name
of the topic wasn't specified explicitly by its creator and likely needs to be changed by the
bot»*. То есть Telegram сам намекает: имя «New Topic» надо переписать осмысленным. У нас для
этого уже есть генератор заголовков (`http/title.ts`) — и `oneShot` в реестре, которым
заголовки и делаются.

Важная деталь маршрутизации: **General-топик** (закреплённый сверху) в личке — это корень
чата, и его сообщения могут приходить как с `message_thread_id=1`, так и вообще без
`thread_id`. Обрабатывать надо оба случая, иначе корень и General разъедутся в два разговора
(так это решено у hermes-agent, см. §7).

### 2.4 Чего в документации нет

* **Предел числа топиков в личке** — не задокументирован. Для супергрупп клиенты умеют
  пагинацию (`getForumTopics` в TDLib), жёсткого «максимум N» в Bot API нет. **UNVERIFIED**,
  проверить на стенде (§10).
* **Требования к версии клиента** (с какого релиза Telegram в iOS/Android/Desktop показывает
  список топиков в личке с ботом) — в Bot API не указано. Практически: фича от 31.12.2025,
  любой клиент 2026 года её умеет; старые клиенты покажут ленту без топиков. **UNVERIFIED.**
* Поведение `sendMessageDraft` внутри топика лички: параметр `message_thread_id` в методе
  есть, но примеров в доках нет. **UNVERIFIED**, проверяется одним вызовом.

### 2.5 Что это значит для нашего кода

Хорошая новость: менять почти нечего, потому что мультиразговорность у нас уже есть.

* `telegram/bot.ts:conversationIdFor(message, userId)` → добавить `thread_id`:
  личка без топика — `telegram-<chat_id>`, топик — `telegram-<chat_id>-<thread_id>`.
* `sessions/registry.ts` уже держит `Map<"<user>:<conversationId>", PiSession>` — топики
  разъедутся сами, каждый со своим контейнером/сессией.
* `sessions/pi-session.ts:sessionIdFor(user, conversationId)` → SHA1 → свой файл истории в
  `/workspace/.sessions`. История на топик появляется даром.
* `/compact` уже работает по `conversationId` — в топике сожмёт только этот разговор.
* Новые команды: `/topic [имя]` (создать топик), `/topics` (список + привязка), `/rename`, при
  желании `/close` — последнее только для супергрупп.
* Автопереименование: `forum_topic_created` с `is_name_implicit` + наш `title.ts` → топик
  сам становится «Разбор письма из налоговой».

Оценка: **1-2 дня** работы с тестами, из них полдня — на BotFather, флаги и разбор
`General`-топика. Ни схемы БД, ни миграций, ни новой инфраструктуры.

---

## 3. Вариант B: Mini App как чат-клиент — реально, но дорого и с изъянами

### 3.1 Что даёт

Полный контроль над UI: свой список чатов, поиск по истории, папки, кастомный стриминг,
вложения, настройки. Запуск — кнопкой меню, инлайн-кнопкой под сообщением, из профиля бота
(main Mini App), прямой ссылкой `t.me/<bot>/<app>?startapp=...`. Внутри — `initData` с
подписанными данными человека, тема Telegram, safe-area, BackButton, haptic. Уже есть
`fetch`, значит наш SSE-стриминг (`http/sse.ts`) подключается как есть.

### 3.2 Что не даёт (и это главное)

| Ограничение | Формулировка/источник |
|---|---|
| Нет доступа к чатам | *«Mini Apps opened from a direct link have **no access** to the chat – they can't read messages or send new ones on behalf of the user»*; то же для inline-режима ([webapps](https://core.telegram.org/bots/webapps)) |
| Нет пушей | Mini App не может разбудить человека. Единственный канал уведомления — сообщение бота; чтобы вернуть человека в приложение, нужна кнопка `web_app` в этом сообщении |
| Живёт только пока открыт | Закрылся webview — нет процесса, нет фоновой работы; фоновые задачи всё равно на сервере |
| Отдельный хостинг | HTTPS-URL, домен, привязка в BotFather; с Bot API 10.2 Mini App-методы запрещены с чужих origin (включено для всех с 20.07.2026) |
| Своя авторизация | `initData` + HMAC, а не наш SSO-заголовок (см. 3.3) |
| Свой UI целиком | История, скролл, клавиатура, iOS-специфика — всё на нас; нативного списка сообщений в webview нет |

Доступ к чату есть только у Mini App, запущенного из **attachment menu**, — и этот путь нам
закрыт: *«Attachment menu integration is currently only available for major advertisers on the
Telegram Ad Platform. However, all bots can use it in the test server environment»*
([webapps](https://core.telegram.org/bots/webapps#adding-bots-to-the-attachment-menu)). Плюс
`query_id` даёт право отправить сообщение от имени человека, но `answerWebAppQuery` при этом
**закрывает** приложение — как транспорт это не годится, это «вернуть результат в чат».

Справедливости ради: **отсутствие доступа к чатам — не приговор нашей затее.** История
разговоров и так лежит у нас (`/workspace/.sessions`), а не в Telegram, и Mini App, открытый
инлайн-кнопкой или кнопкой меню, получает `initData` и `query_id` — этого хватает, чтобы
работать со своим бэкендом по HTTPS. Приговор — не это, а уведомления и жизненный цикл: из
webview нельзя написать человеку, а «фонового» Mini App не существует.

### 3.3 Авторизация: `initData` вместо SSO-прокси

Правило из доков: *«Validate data from this field before using it on the bot's server»*.
Алгоритм: `secret_key = HMAC_SHA256(bot_token, "WebAppData")`,
`hex(HMAC_SHA256(data_check_string, secret_key)) == hash`, где `data_check_string` — все поля
кроме `hash`, отсортированные по имени, `key=value` через `\n`; плюс проверка `auth_date` от
протухания ([webapps#validating-data](https://core.telegram.org/bots/webapps)).

Для нас это ложится на `control/identity.ts`: сейчас человека называет SSO-прокси заголовком
(`panel.userHeader`), Mini App должен уметь второй путь — «валидный `initData` → telegram id →
`telegram.mapping` → человек из `users`». Тогда панель открывается из телеги без логина.
Тонкость, которую надо проверить на живых клиентах: webview Telegram — отдельное хранилище
cookies, и SSO-сессия браузера туда, скорее всего, не доедет (то есть надеяться на заголовок
прокси не получится). Хуже: если URL приложения отвечает редиректом на логин, открывается
пустая оболочка — *«the Mini App itself opens successfully: initData is received correctly…
However, all WebApp API methods stop working»*
([Telegram-Mini-Apps#85](https://github.com/Telegram-Mini-Apps/issues/issues/85), сообщество,
**UNVERIFIED**). То есть панель за SSO и Mini App — это **два разных входных хоста**: наружу
смотрит публичный HTTPS без редиректов, а человека называет `initData`. Проверяется первым же
запуском; `initData`-путь надёжнее в любом случае. И помнить, что `telegram.mapping` у нас
ключуется по username, а `initData` отдаёт и id, и username.

### 3.4 Стоимость и риски

* Фронтенд: однофайловое приложение в стиле нашей панели (`ui.ts` — один HTML без сборки)
  реально, но чат-клиент — не панель памяти: виртуализация списка, стриминг, скролл-анкоры,
  вложения. Реалистично **1-2 недели** до «не стыдно пользоваться», и дальше он живёт.
* Каталог Mini Apps (Apps-таб) нам не нужен и не грозит: для попадания нужно Main Mini App +
  >1000 DAU + >1000 Stars/день; обычный запуск из профиля/кнопки/ссылки работает без каталога
  и без модерации ([разбор требований](https://kak-v-telegramme.ru/boty-mini-apps/kak-razmeshhat-mini-app-v-kataloge-telegram-2/),
  вторичный источник).
* Хранилища (если понадобятся): CloudStorage — 1024 ключа на человека, значение ≤4096
  символов; DeviceStorage — 5 МБ на человека; SecureStorage — 10 элементов (Keychain/Keystore).
* Приоритет: пока топики дают 80% результата за 1 день, Mini App-чат — это 20% сверху за две
  недели. Делать его первым — значит заплатить за то, что Telegram уже отдал бесплатно.

### 3.5 Что конкретно ломается у людей (и о чём надо знать до старта)

Всё ниже — сообщество и трекер Telegram-Mini-Apps, не документация; помечено как **UNVERIFIED**,
но именно эти грабли определяют объём работ:

* **Webview перезагружается сам.** На Android есть открытый баг: клиент перезагружает Mini App
  каждые 5-10 секунд (*«12 full page loads in 6 minutes»* на реальном устройстве,
  [#86](https://github.com/Telegram-Mini-Apps/issues/issues/86), OPEN). При сворачивании в
  трей соединение рвётся с кодом 1006 ([#78](https://github.com/Telegram-Mini-Apps/issues/issues/78)).
  Вывод: длинный ход pi живёт на сервере и ключуется разговором, а UI — переподключаемое
  представление серверного состояния, а не владелец процесса. Наш `SessionRegistry` это уже
  умеет, Mini App обязан просто переподключаться к SSE.
* **Минимизация ≠ фон.** С 2024 года Mini App можно свернуть в полоску внизу экрана и вернуть
  без перезагрузки, на desktop есть вкладки
  ([анонс](https://telegram.org/blog/mini-app-bar-paid-media-and-more#mini-app-bar)), но
  фонового выполнения и гарантий жизни webview нет.
* **Deep-link не переключает разговор.** Если экземпляр уже открыт, новые `startapp`-параметры
  игнорируются ([#44](https://github.com/Telegram-Mini-Apps/issues/issues/44)), а экземпляров
  может быть несколько ([#70](https://github.com/Telegram-Mini-Apps/issues/issues/70)). Значит
  «уведомление открывает чат №123» само по себе не работает: нужна маршрутизация внутри
  приложения и «активный разговор» с сервера.
* **`ready()` и версия клиента.** Без `ready()` заглушка снимается только после полной загрузки;
  старые клиенты отдают старый Bot API, поэтому всё новое — через `isVersionAtLeast()`
  ([#55](https://github.com/Telegram-Mini-Apps/issues/issues/55)). Официального репозитория
  `telegram-web-app.js` нет: файл отдаётся минифицированным с telegram.org и
  кэш-бастится вручную (`?64`) — вендорить и пинить самим.
* **iOS/Android-специфика:** неверный `viewportHeight` при открытой клавиатуре
  ([#14](https://github.com/Telegram-Mini-Apps/issues/issues/14)), прыгающие нижние панели из-за
  safe-area ([#39](https://github.com/Telegram-Mini-Apps/issues/issues/39)), Service Workers не
  работают на iOS ([#27](https://github.com/Telegram-Mini-Apps/issues/issues/27), OPEN),
  `ClosingConfirmation` врёт и надёжного события закрытия нет
  ([#1](https://github.com/Telegram-Mini-Apps/issues/issues/1),
  [#69](https://github.com/Telegram-Mini-Apps/issues/issues/69)) — то есть «сохранить черновик
  при закрытии» асинхронным запросом не получится.
* **Ревью при публикации нет.** Создал бота → `/newapp` → указал HTTPS-URL, и всё; каталог
  (Apps-таб) — отдельная история про featured и Stars. Для личного Икара это не нужно вовсе.
* **История чатов в Telegram-хранилищах не помещается:** CloudStorage — 4096 символов на ключ
  (1024 ключа), то есть ~4 КБ; DeviceStorage — 5 МБ; SecureStorage — 10 элементов. История
  остаётся на нашем сервере, в облако кладём только состояние UI (курсор, активный разговор).

---

## 4. Вариант C: супергруппа с топиками (старый путь, до 9.3)

Классика: супергруппа-форум, бот-админ с `can_manage_topics`, каждый топик — разговор, разные
люди в одной группе. Работает с 2022 года, ограничений почти нет, топики можно закрывать
(`closeForumTopic`). Но: человеку надо вступить в группу, у группы есть участники и правила,
личная память Икара перемешивается с групповой видимостью, а «просто поговорить с Икаром»
превращается в «зайти в комнату». Для семьи/команды — да; для личного мультичата — нет.

---

## 5. Вариант D (второй по приоритету): Mini App как панель

Здесь Mini App на своём месте: конфигурация, approvals, дашборды — формулировка самих
доков: *«Mini Apps provide a richer workspace for configuration, approvals and dashboards»*
([features#ai-agents](https://core.telegram.org/bots/features#ai-agents)).

Что даёт нам: панель (`/panel`, память, история git, Maple-графики) уже написана и уже
разделена на `SECTIONS`. Кнопка меню бота (`setChatMenuButton` с `MenuButtonWebApp`:
`type: web_app`, `text`, `web_app: WebAppInfo`; можно поставить дефолтом или только для
личного чата с человеком) → панель открывается одним тапом из чата, `initData` называет
человека, долгий логин не нужен. Дальше туда же естественно просятся:
* список разговоров и их `/compact`/удаление (то, что в чате живёт командами);
* память (уже есть);
* статус: живые сессии, контейнеры, расход (`registry.list()` и `/healthz` уже это отдают).

Оценка: **1-2 дня** на раздел «чаты» + initData-путь в `identity.ts`. Именно так Mini App
усиливает чат, не пытаясь его заменить.

---

## 6. Что ещё из 2026 стоит забрать (независимо от варианта)

1. **Стриминг: `sendMessageDraft` / `sendRichMessageDraft`.** *«stream a partial message to a
   user while the message is being generated… the streamed draft is ephemeral and acts as a
   temporary 30-second preview — once the output is finalized, you must call sendMessage»*.
   Пустой текст = плейсхолдер «Thinking…». `draft_id` — один на генерацию, изменения с тем же
   id анимируются. `can_stop: true` показывает человеку кнопку Stop, бот получает апдейт
   `MessageGenerationStopped` (`chat`, `message_thread_id`, `draft_id`) и может прервать ход.
   Это прямая замена нашего `EDIT_INTERVAL_MS = 1200` и текстов «Ещё думаю над прошлым
   сообщением»: сейчас мы правим одно сообщение и молимся на 429, теперь можно отдавать
   партиалы нативно, а финал — обычным `sendMessage`.
   **Оговорка:** `chat_id` у метода описан как «Unique identifier for the target **private**
   chat» — то есть в группах стриминг черновиками недоступен, там остаётся наш
   `editMessageText`. В личке (и в топиках лички) — работает, `message_thread_id` в параметрах
   есть.
   **Риск:** FAQ по-прежнему требует «не больше одного сообщения в секунду в чат»; как это
   соотносится с частотой черновиков — не задокументировано. **UNVERIFIED**, мерить на стенде.
2. **Rich messages (`sendRichMessage`).** Заголовки, списки, таблицы, сворачиваемые блоки,
   LaTeX (inline и блоками), медиа, кнопки внутри сообщения. Для Икара это ответ про Maple:
   формулы и таблицы поедут нативно, а не картинкой через `/maple/`.
3. **Ephemeral messages (10.2).** В группе бот может ответить так, что увидит только один
   человек (и бот): *«let bots send private responses inside group chats – visible only to a
   specific user and the bot»*. Сценарий: в общем чате спросили личное — Икар отвечает
   шёпотом, а не молчит.
4. **Guest mode (10.0).** *«allowing bots to receive certain messages and issue replies within
   chats they are not a member of»*: человек пишет `@icarus_bot <вопрос>` в любом чате, бот
   получает это сообщение (и то, на что отвечали) и может ответить один раз, без добавления в
   чат. Доступ к истории и участникам при этом не даётся. Это ровно «Икар рядом, когда нужен»,
   и это дешевле, чем заводить его в каждый чат.
5. **Secretary mode / business bots (10.0).** Бот подключается к аккаунту и отвечает в личных
   чатах от имени человека; права (`can_reply`, `can_read_messages`, удаление) выдаёт
   владелец, Premium больше не требуется. Для Икара это отдельное решение про приватность, не
   про мультичат; в этом же разборе не рассматриваем.
6. **Bot-to-bot (10.0/10.1).** Если когда-нибудь появятся боты-помощники (Maple-бот, бот-
   архивариус), они смогут переписываться напрямую. Пока не нужно.

---

## 7. Чужой опыт: как это уже сделали

* **hermes-agent (NousResearch)** — агентная платформа, у которой есть и config-driven топики
  (`extra.dm_topics`), и **user-driven режим `/topic`**: *«A ChatGPT-style multi-session DM —
  one bot, many parallel conversations… The end user flips it on with /topic, then taps the
  Telegram + button to create as many topics as they want, each one a fully independent
  session»* ([telegram.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)).
  Полезное оттуда:
  * ключ изоляции — `chat_id + thread_id` (у нас будет то же в `conversationId`);
  * корень лички превращают в «лобби»: обычные сообщения отклоняются с подсказкой, системные
    команды работают (у нас корень остаётся разговором — решать нам);
  * авто-переименование топика по сгенерированному заголовку сессии (и флаг, чтобы выключить);
  * `General`-топик считается корнем независимо от того, пришёл `thread_id=1` или ничего;
  * темы, созданные человеком, подхватываются по `forum_topic_created`, без перезапуска;
  * напоминания в корне — с rate-limit, чтобы человек не получал десять ответов «вы в лобби».
  * Реализация: коммит [5506139](https://github.com/NousResearch/hermes-agent/commit/55061390fc726c08975456e7f3bef1d56b90e5fc)
    (`_create_dm_topic`, `_setup_dm_topics`, `_persist_dm_topic_thread_id`,
    `_cache_dm_topic_from_message`) — 290 строк на адаптер. Масштаб правки показывает, что это
    небольшая задача, а не проект.
* **nekoclaw** ([github](https://github.com/oines/nekoclaw)) — сосед по архитектуре: тот же
  `pi-coding-agent`, Docker-контейнер на агента, память в Markdown, Telegram через grammy. Ни
  Mini App, ни топиков для мультичата там нет — то есть «мультичат» не является обязательным
  атрибутом зрелого ИИ-бота в телеге.
* **tg-llm-router** ([github](https://github.com/x100Value/tg-llm-router)) — пример Mini App
  поверх LLM (роутер моделей, BYOK, TON Connect). Полезен как референс «как выглядит TMA для
  LLM», но это именно клиент-приложение, а не мультичат в чате бота.
* **hermes-miniapp** ([github](https://github.com/jessicarust/hermes-miniapp)) — ближайший
  аналог варианта B: *«full-screen mobile chat interface… Streaming chat — responses appear
  token-by-token… Persistent sessions — conversation history survives app restarts… The mini
  app authenticates via Telegram WebApp initData»*; эндпоинты `/v1/webapp/auth` (initData →
  session token) и `/v1/webapp/chat` (SSE), HTTPS через туннель. Репозиторий свежий и
  малозвёздный — качество **UNVERIFIED**, но архитектура ровно та, что описана в §3:
  initData-авторизация, SSE-стриминг, сессии, привязанные к telegram id.
* **`web_app`-кнопка как уведомление** — так это делают и в самом hermes-agent: отдельный PR
  добавляет *«an optional `web_app_button` payload for Telegram private chats»*
  ([PR #67864](https://github.com/NousResearch/hermes-agent/pull/67864)). Это подтверждает
  единственную рабочую схему: бот = канал уведомлений, Mini App = поверхность чтения.
* **notepher-bot** ([github](https://github.com/deptyped/notepher-bot)) — пример Mini App со
  списком и деталью, offline-first, синхронизация через CloudStorage: полезен как референс
  хранения состояния UI, если до варианта B дойдёт.
* **Честный итог по prior art:** зрелого открытого «списка чатов + окна разговора» на Mini App
  нет; мейнстрим LLM-ботов в Telegram — обычные сообщения бота. Случаев, где стриминг ответа
  LLM идёт через webview с надёжным уведомлением о завершении, найти не удалось: это
  **UNVERIFIED** территория, и проектировать надо с расчётом на переподключение.

---

## 8. Чего не делать

* **Не писать свой клиент Telegram** и не пытаться читать чужие чаты: у Bot API такого нет, а
  userbot (MTProto/TDLib от лица человека) — это другой класс рисков (ToS, блокировки) и
  отдельный разговор, не для мультичата.
* **Не заводить БД под привязки топиков**, пока `conversationId` выводится из сообщения. Файлы
  сессий у нас и так append-only в `/workspace/.sessions`.
* **Не тащить Mini App-чат «потому что можно»**: уведомлений в нём нет, а именно уведомления —
  причина, по которой Икар живёт в телеге, а не в браузере.
* **Не включать топики молча**: если человек привык к одной ленте, включённый Threaded Mode
  меняет ему интерфейс. Это переключатель, а не дефолт (и он на стороне BotFather, то есть
  требует ручного шага владельца бота).

---

## 9. Итог по вариантам

| Вариант | Что даёт | Цена | Вердикт |
|---|---|---|---|
| A. Топики в личке | Нативный список разговоров, изоляция контекста, `/compact` на разговор | 1-2 дня, ключ `conversationId` + команды | **Делать первым** |
| B. Mini App-чат | Свой UI, поиск, папки | 1-2 недели + хостинг/домен + initData-авторизация, без пушей и фона, перезагрузки webview, deep-link не переключает разговор | Позже, если A не хватит |
| C. Супергруппа-форум | Общий мультичат для семьи/команды | Онбординг в группу, общая видимость | Когда появится «для всех» |
| D. Mini App-панель | Чаты/память/статус с телефона в один тап | 1-2 дня поверх существующей панели | **Делать вторым** |

---

## 10. Что проверить руками на стенде (spike, полдня)

1. BotFather (Mini App) → Bot Settings → **Threads Settings → Threaded Mode**; `getMe` →
   `has_topics_enabled: true`, `allows_users_to_create_topics: true`. Выключить обратно →
   убедиться, что `createForumTopic` даёт `400 the chat is not a forum` (это наша понятная
   ошибка для человека, а не стектрейс).
2. `createForumTopic` из бота → отправить сообщение в топик → получить ответ в топике.
3. Создать топик руками в клиенте → проверить, что пришёл `forum_topic_created` и что
   `is_name_implicit=true` (значит, можно переименовывать под заголовок разговора).
4. Корень лички vs General: посмотреть, с каким `message_thread_id` приходят сообщения
   (1 или ничего) — от этого зависит `conversationIdFor`.
5. `sendMessageDraft` в топике: анимация, «Thinking…» на пустом тексте, `can_stop` → апдейт
   `stopped_message_generation`; замерить, сколько апдейтов в секунду держит Telegram до 429.
6. `/compact` внутри топика — сжимается только этот разговор, соседние не трогаются.
7. Клиенты: iOS, Android, Desktop, Web — виден ли список топиков и что показывают старые
   версии; проверить, что разговор в корне не смешивается с топиками.
8. Отдельно — насколько `rich messages` рисуются в наших клиентах (LaTeX/таблицы), прежде чем
   обещать Maple-вывод в чате.

**Если всё-таки решимся на Mini App (вариант B/D)** — проверять до кода, а не после:
9. Публичный HTTPS без редиректов: открыть URL из инлайн-кнопки за нашим SSO-прокси и
   убедиться, что WebApp-методы работают (а не только страница открывается).
10. Deep-link в уже открытый экземпляр: `?startapp=<разговор>` при живом приложении —
    увидеть своими глазами, что параметры игнорируются, и решить, как это обходить.

---

## Источники

**Первоисточники Telegram**
* Bot API 10.3 и справочник методов/классов: <https://core.telegram.org/bots/api> (сверялось 08.10.2026)
* Changelog по версиям (9.3 — 31.12.2025, 9.4 — 09.02.2026, 10.0 — 08.05.2026, 10.1 — 11.06.2026, 10.2 — 14.07.2026, 10.3 — 24.08.2026): <https://core.telegram.org/bots/api-changelog>
* Фичи ботов: топики в личке, стриминг, ephemeral, rich messages, guest bots, business/secretary, AI-агенты: <https://core.telegram.org/bots/features>
* Mini Apps: способы запуска, доступ к чату, `initData` и его проверка, хранилища: <https://core.telegram.org/bots/webapps>
* Лимиты (1 сообщение/сек в чат, 20/мин в группе, ~30/сек рассылка): <https://core.telegram.org/bots/faq>
* Анонс AI-фич (guest bots, bot-to-bot, стриминг, chat automation): <https://telegram.org/blog/ai-bot-revolution-11-new-features>
* Анонс Mini App Bar (сворачивание приложений в полоску, возврат без перезагрузки): <https://telegram.org/blog/mini-app-bar-paid-media-and-more>
* Трекер Telegram-Mini-Apps (перезагрузки webview, deep-link, SSO-редиректы, iOS/Android-баги): <https://github.com/Telegram-Mini-Apps/issues/issues>

**Чужой опыт и вторичные источники**
* hermes-agent: доки по Telegram (в т.ч. Private Chat Topics и `/topic`): <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md>
* Баг-репорт про BotFather Threaded Mode и `has_topics_enabled`: <https://github.com/NousResearch/hermes-agent/issues/115019>
* Реализация DM-топиков (коммит): <https://github.com/NousResearch/hermes-agent/commit/55061390fc726c08975456e7f3bef1d56b90e5fc>
* `web_app`-кнопка как канал «уведомление → приложение»: <https://github.com/NousResearch/hermes-agent/pull/67864>
* hermes-miniapp — Mini App как чат-клиент агента (initData + SSE, свежий, качество не проверено): <https://github.com/jessicarust/hermes-miniapp>
* notepher-bot — Mini App список+деталь с CloudStorage: <https://github.com/deptyped/notepher-bot>
* Гайды по Mini Apps от сообщества (initData, создание приложения): <https://docs.telegram-mini-apps.com/platform/init-data>
* nekoclaw — ИИ-агент на `pi` + Docker в Telegram: <https://github.com/oines/nekoclaw>
* tg-llm-router — Mini App для LLM: <https://github.com/x100Value/tg-llm-router>
* Требования каталога Mini Apps (вторичный источник): <https://kak-v-telegramme.ru/boty-mini-apps/kak-razmeshhat-mini-app-v-kataloge-telegram-2/>

**Наш код, на который опирается разбор**
* `packages/service/src/telegram/bot.ts` — `conversationIdFor`, `/compact`, `EDIT_INTERVAL_MS`, опрос и очередь по чату
* `packages/service/src/sessions/registry.ts` — сессии по `(человек, разговор)`, сжатие простаивающих
* `packages/service/src/sessions/pi-session.ts` — `sessionIdFor` → файл истории в `/workspace/.sessions`
* `packages/service/src/http/sse.ts`, `http/title.ts` — стриминг и заголовки разговоров
* `packages/service/src/control/{index,identity,ui}.ts` — панель, SSO-идентификация, однофайловый UI
* `config.example.yaml`, раздел `telegram:` — маппинг username → человек, речь
