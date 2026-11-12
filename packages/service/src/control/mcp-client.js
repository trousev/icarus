/* Панель MCP: список серверов, переключатели, форма и OAuth-подключение.
   Данные приезжают с /panel/mcp/*; страница не хранит секретов и не рисует их. */
(function () {
  const cfg = window.__MCP_CFG__ || {};
  const ui = cfg.ui || {};
  const el = (id) => document.getElementById(id);
  // Адрес «мёртвого» loopback приходит со страницы: порт живёт в oauth.ts.
  // Запасное значение — на случай страницы из кэша, отданной старым сервисом.
  const MIMIC_CALLBACK =
    (window.__MCP_CFG__ && window.__MCP_CFG__.mimicCallback) || 'http://localhost:47821/callback';

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('application/json')) {
      const message = type.includes('application/json')
        ? (await response.json().catch(() => ({}))).error?.message || response.statusText
        : ui.sessionExpired || 'сессия входа истекла — обнови страницу';
      throw new Error(message);
    }
    return response.json();
  };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Подстановка в шаблон словаря: «{n} {word}» и подобные. */
  const fill = (template, values) =>
    Object.entries(values).reduce((text, [key, value]) => text.split('{' + key + '}').join(String(value)), template);

  function notice(message, bad) {
    const box = el('mcp-notice');
    if (!box) return;
    box.className = 'mcp-notice' + (bad ? ' bad' : '');
    box.textContent = message;
    box.hidden = false;
  }

  async function post(name, body) {
    return api('/panel/mcp/' + name, { method: 'POST', body: JSON.stringify(body) });
  }

  async function loadCounts() {
    try {
      const state = await api('/panel/api/state');
      const counts = state.counts || {};
      for (const [id, value] of Object.entries(counts)) {
        const node = el('count-' + id);
        if (node && typeof value === 'number') node.textContent = String(value);
      }
    } catch {
      /* счётчик — украшение; раздел важнее */
    }
  }

  const transportLabel = (transport) =>
    transport === 'stdio' ? 'stdio' : transport === 'sse' ? 'SSE' : 'streamable HTTP';

  const authLabel = (server) => {
    if (server.auth === 'oauth') return 'OAuth 2.1';
    if (server.auth === 'headers') return server.transport === 'stdio' ? 'переменные окружения' : 'ключ доступа';
    return 'без авторизации';
  };

  const authText = (server) => {
    if (server.auth === 'none') return '';
    if (server.authState === 'ready') return server.auth === 'oauth' ? 'OAuth: доступ получен' : 'Доступ настроен';
    if (server.authState === 'expired') return 'Токен истёк — обновится при следующем подключении';
    if (server.authState === 'error') return 'Ошибка доступа: ' + (server.authMessage || 'нужно подключиться заново');
    return server.authMessage || (server.auth === 'oauth' ? 'Нужно войти через браузер' : 'Нужен ключ доступа');
  };

  function badge(text, kind) {
    return '<span class="badge ' + (kind || '') + '">' + esc(text) + '</span>';
  }

  function card(server) {
    const node = document.createElement('article');
    node.className = 'mcp-card' + (server.enabled ? '' : ' off');
    node.dataset.id = server.id;

    const badges = [];
    if (server.global) badges.push(badge('config.yaml', 'global'));
    if (server.global || server.shared) badges.push(badge(server.global ? 'всем' : server.ownerIsMe ? 'поделился' : 'расшарен', 'shared'));
    if (!server.global && !server.shared) badges.push(badge('только мой'));
    badges.push(badge(server.enabled ? 'включён' : 'выключен', server.enabled ? 'on' : 'off'));
    if (server.enabled && !server.ready) badges.push(badge('ждёт доступа', 'wait'));
    if (server.auth === 'oauth' && server.mimic) {
      badges.push(
        '<span class="badge mimic" title="Вход идёт через локальный адрес: адрес из строки браузера нужно вставить в панель">мимикрия</span>',
      );
    }

    const auth = authText(server);
    const own = !server.global && !server.ownerIsMe && server.owner ? '<div class="mcp-auth">Поделился: ' + esc(server.owner) + '</div>' : '';

    node.innerHTML =
      '<div class="mcp-card-head">' +
        '<div><h3>' + esc(server.name) + '</h3>' +
        '<div class="badges">' + badges.join('') + '</div></div>' +
        '<label class="switch" title="' + (server.enabled ? 'выключить' : 'включить') + '">' +
          '<input type="checkbox" data-action="toggle"' + (server.enabled ? ' checked' : '') + '>' +
          '<span></span></label>' +
      '</div>' +
      (server.description ? '<p class="mcp-desc">' + esc(server.description) + '</p>' : '') +
      '<div class="mcp-meta"><code>' + esc(transportLabel(server.transport)) + '</code>' +
        '<span>' + esc(authLabel(server)) + '</span></div>' +
      '<div class="mcp-meta"><span class="mcp-target">' + esc(server.target) + '</span></div>' +
      own +
      (auth ? '<div class="mcp-auth' + (server.ready || server.auth === 'none' ? '' : ' bad') + '">' + esc(auth) + '</div>' : '') +
      '<div class="mcp-actions"></div>' +
      '<div class="mcp-result" hidden></div>';

    const actions = node.querySelector('.mcp-actions');
    const add = (label, action, className) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (className) button.className = className;
      button.dataset.action = action;
      actions.append(button);
      return button;
    };

    add('Проверить', 'test');
    if (!server.global && server.auth === 'oauth') {
      add(server.ready ? 'Переподключить' : 'Подключить', 'connect', 'primary');
      // Готовому серверу секрет клиента нужен только если authorization server
      // его требует; для DCR-серверов этой кнопкой не пользуются.
      add('Секрет клиента', 'credentials');
      // Кнопка есть всегда: если authorization server отверг сохранённую
      // регистрацию (invalid_client), человеку нужен способ её сбросить, а не
      // только ждать, когда сервер «сам починится».
      add('Сбросить доступ', 'disconnect');
    }
    if (!server.global && server.auth === 'headers') add('Настроить доступ', 'credentials', server.ready ? '' : 'primary');
    if (server.canEdit) add('Изменить', 'edit');
    if (server.canShare) add(server.shared ? 'Скрыть от других' : 'Поделиться', 'share');
    if (server.canDelete) add('Удалить', 'delete', 'danger');

    node.querySelector('[data-action="toggle"]').addEventListener('change', async (event) => {
      const checkbox = event.currentTarget;
      checkbox.disabled = true;
      try {
        await post('toggle', { id: server.id, enabled: checkbox.checked });
        await load();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
        notice('Не вышло: ' + error.message, true);
      }
    });

    node.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        const result = node.querySelector('.mcp-result');
        if (action === 'test') return runTest(server, result, button);
        if (action === 'edit') return openForm(server.id);
        if (action === 'share') return toggleShare(server);
        if (action === 'delete') return removeServer(server);
        if (action === 'connect') return startOauth(server, button);
        if (action === 'disconnect') return disconnectOauth(server);
        if (action === 'credentials') return openCredentials(server);
      });
    });
    return node;
  }

  // Ссылка из чата/Telegram: ?server=<id> — подсветить карточку, к которой
  // человеку идти за «Переподключить».
  function focusRequestedServer() {
    const id = new URLSearchParams(location.search).get('server');
    if (!id) return;
    const safe = id.replace(/["\\]/g, '');
    const node = document.querySelector('.mcp-card[data-id="' + safe + '"]');
    if (!node) return;
    node.classList.add('focus');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function load() {
    const box = el('mcp-list');
    try {
      const data = await api('/panel/mcp/servers');
      box.innerHTML = '';
      el('mcp-summary').textContent = fill(ui.mcpSummary, {
        n: data.servers.length,
        word: plural(data.servers.length, ui.serversWord),
        enabled: data.enabled,
        ready: data.ready,
      });
      if (!data.servers.length) {
        box.innerHTML = '<p class="mcp-empty">' + esc(ui.mcpEmpty) + '</p>';
        return;
      }
      for (const server of data.servers) box.append(card(server));
      focusRequestedServer();
    } catch (error) {
      box.innerHTML = '<p class="mcp-empty">Не удалось прочитать список: ' + esc(error.message) + '</p>';
    }
    // Счётчик в сайдбаре — часть того же состояния: после добавления/удаления
    // он должен совпадать со списком, а не жить до перезагрузки.
    void loadCounts();
  }

  function plural(n, one, few, many) {
    // Старый вызов передаёт три строки, новый — формы из словаря.
    const words = typeof one === 'string' ? { one, few, many } : one;
    if (ui.lang && ui.lang !== 'ru') return n === 1 ? words.one : words.many;
    const tens = n % 100;
    const ones = n % 10;
    if (tens >= 11 && tens <= 14) return words.many;
    if (ones === 1) return words.one;
    if (ones >= 2 && ones <= 4) return words.few;
    return words.many;
  }

  async function runTest(server, result, button) {
    button.disabled = true;
    result.hidden = false;
    result.className = 'mcp-result';
    result.textContent = 'Проверяю…';
    try {
      const data = await post('test', { id: server.id });
      if (data.unsupported) {
        result.textContent = data.error || 'stdio-сервер проверится при подключении.';
      } else if (data.ok) {
        const tools = Array.isArray(data.tools) ? data.tools : [];
        result.textContent =
          'Готов · ' + tools.length + ' ' + plural(tools.length, 'инструмент', 'инструмента', 'инструментов') +
          (data.server && data.server.name ? ' · ' + data.server.name : '') +
          (tools.length ? '\n' + tools.slice(0, 25).join(', ') + (tools.length > 25 ? ' …' : '') : '');
      } else {
        result.className = 'mcp-result bad';
        result.textContent = data.error || 'Сервер не ответил';
        if (data.needsAuth) result.textContent += '\nНужна авторизация: нажми «Подключить».';
      }
    } catch (error) {
      result.className = 'mcp-result bad';
      result.textContent = 'Не вышло: ' + error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function startOauth(server, button) {
    if (button) button.disabled = true;
    try {
      const data = await post('oauth/start', { id: server.id });
      if (!data.url) throw new Error('сервер не вернул адрес авторизации');
      // Мимикрия: браузер уйдёт на мёртвый loopback, поэтому вкладку панели не
      // трогаем — человек вернётся сюда и вставит адрес руками.
      if (data.mimic) {
        openMimicDialog(server, data);
        return;
      }
      // В чате настройки открыты iframe'ом, а authorization server обычно
      // запрещает показ в рамке (X-Frame-Options). Уводим верхнюю вкладку:
      // после callback человек попадёт на полноценную страницу MCP.
      const target = window.self !== window.top ? window.top : window;
      target.location.href = data.url;
    } catch (error) {
      // Самая частая причина отказа — белый список redirect_uri у сервера.
      // Подсказываем галочку, но только если она ещё не включена.
      const hint =
        !server.mimic && /redirect/i.test(error.message)
          ? '\n\nПохоже, сервер пускает только свои адреса возврата. Открой «Изменить» и включи «Мимикрировать под Claude».'
          : '';
      notice('Не удалось начать вход: ' + error.message + hint, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * Ручной вход для серверов с белым списком redirect_uri. Браузер вернётся на
   * http://localhost:<порт>/callback, где намеренно никто не слушает: покажет
   * ошибку соединения, но код останется в строке браузера.
   */
  function openMimicDialog(server, started) {
    const callback = started.redirectUri || MIMIC_CALLBACK;
    const minutes = Math.max(1, Math.round((started.expiresIn || 600) / 60));
    const opened = dialog(
      '<h2>Вход в «' + esc(server.name) + '»</h2>' +
      '<p class="about">Вход идёт в обход белого списка: сервер мог бы не принять адрес возврата нашей панели, ' +
        'поэтому мы зарегистрировались как локальный клиент — так же, как Claude Code. ' +
        'Дальше всё вручную, но это три шага.</p>' +
      '<ol class="mcp-steps">' +
        '<li>Нажми «Открыть страницу входа». Она откроется в новой вкладке: войди и разреши доступ.</li>' +
        '<li>В конце браузер вернётся на <code>' + esc(callback) + '</code> и покажет ошибку — ' +
          '«не удаётся получить доступ к сайту» или пустую страницу. <b>Так и должно быть</b>: ' +
          'на этом адресе никто не слушает, он нужен только чтобы код остался в адресной строке.</li>' +
        '<li>Скопируй <b>весь адрес</b> из строки браузера (он начинается с <code>' + esc(callback) + '?…</code>) ' +
          'и вставь его ниже.</li>' +
      '</ol>' +
      '<p class="mcp-note">Ссылка живёт ' + minutes + ' мин. Пароль и код остаются у тебя: ' +
        'адрес обрабатывает сам Icarus, никуда его не пересылая.</p>' +
      '<p><a class="mcp-open" id="m-open" target="_blank" rel="noopener noreferrer" href="' + esc(started.url) + '">Открыть страницу входа</a></p>' +
      '<div class="mcp-form">' +
        '<div class="field"><label for="m-paste">АДРЕС ИЗ СТРОКИ БРАУЗЕРА</label>' +
          '<div class="mcp-paste">' +
            '<input id="m-paste" type="text" spellcheck="false" autocomplete="off" placeholder="' + esc(callback) + '?code=…&amp;state=…">' +
            '<button type="button" id="m-paste-clip">Вставить</button>' +
          '</div>' +
          '<p class="hint">Хватит и части после «?» — например <code>code=…&amp;state=…</code>.</p></div>' +
        '<div class="mcp-error" id="m-error" hidden></div>' +
        '<div class="row">' +
          '<button type="button" data-close>Отмена</button>' +
          '<button type="button" data-refresh>Новая ссылка</button>' +
          '<button type="button" class="primary" id="m-done">Продолжить</button>' +
        '</div>' +
      '</div>',
    );
    const paste = opened.backdrop.querySelector('#m-paste');
    const error = opened.backdrop.querySelector('#m-error');
    const done = opened.backdrop.querySelector('#m-done');
    opened.backdrop.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', opened.close));
    opened.backdrop.querySelector('[data-refresh]').addEventListener('click', () => {
      opened.close();
      void startOauth(server);
    });
    opened.backdrop.querySelector('#m-paste-clip').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text.trim()) paste.value = text.trim();
      } catch {
        // Браузер мог не дать буфер (нет разрешения или http): тогда Ctrl+V.
      }
      paste.focus();
    });
    const submit = async () => {
      const value = paste.value.trim();
      done.disabled = true;
      error.hidden = true;
      try {
        if (!value) throw new Error('вставь адрес из строки браузера');
        await post('oauth/complete', { id: server.id, url: value });
        opened.close();
        await load();
        notice('Доступ к «' + server.name + '» получен. Включи сервер переключателем, если он ещё выключен.');
      } catch (caught) {
        error.textContent = caught.message;
        error.hidden = false;
        done.disabled = false;
      }
    };
    done.addEventListener('click', submit);
    paste.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    });
    paste.focus();
  }

  async function disconnectOauth(server) {
    if (!(await askConfirm('Отключить доступ к «' + server.name + '»?\n\nТокен удалится; сервер останется в списке, но без доступа.', 'отключить'))) return;
    try {
      await post('oauth/disconnect', { id: server.id });
      await load();
      notice('Доступ к «' + server.name + '» отключён');
    } catch (error) {
      notice('Не вышло: ' + error.message, true);
    }
  }

  async function toggleShare(server) {
    const next = !server.shared;
    const stdio = server.transport === 'stdio'
      ? '\n\nЭто stdio-сервер: команда будет запускаться в контейнере каждого, кто его включит.'
      : '';
    const message = next
      ? 'Поделиться «' + server.name + '»?\n\nОстальные увидят сервер выключенным и включат сами. Ключи и OAuth-доступ не копируются: каждый настраивает свой.' + stdio
      : 'Скрыть «' + server.name + '» от остальных?\n\nУ них пропадёт доступ к серверу, их настройки не тронутся.';
    if (!(await askConfirm(message, next ? 'поделиться' : 'скрыть'))) return;
    try {
      await post('share', { id: server.id, shared: next });
      await load();
    } catch (error) {
      notice('Не вышло: ' + error.message, true);
    }
  }

  async function removeServer(server) {
    if (!(await askConfirm('Удалить «' + server.name + '»?\n\nСервер исчезнет у всех, с кем ты им поделился. Это нельзя отменить.', 'удалить'))) return;
    try {
      await post('delete', { id: server.id });
      await load();
    } catch (error) {
      notice('Не вышло: ' + error.message, true);
    }
  }

  // ── формы ────────────────────────────────────────────────────────────────
  // Стопка окон: Escape закрывает только верхнее. Иначе confirm, открытый из
  // формы, закрывал бы вместе с собой и форму, из которой его позвали.
  const dialogStack = [];
  function dialog(html, onClose) {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.innerHTML = '<div class="mcp-dialog">' + html + '</div>';
    document.body.append(backdrop);
    const entry = { backdrop, close: null };
    const close = () => {
      const index = dialogStack.indexOf(entry);
      if (index === -1) return;
      dialogStack.splice(index, 1);
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (onClose) onClose();
    };
    entry.close = close;
    const onKey = (event) => {
      if (event.key === 'Escape' && dialogStack[dialogStack.length - 1] === entry) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    dialogStack.push(entry);
    return entry;
  }

  const linesToMap = (text) => {
    const out = {};
    for (const line of String(text || '').split('\n')) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      const name = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (name && value) out[name] = value;
    }
    return out;
  };

  // Постоянные заголовки показываем со значениями (они часть описания), а
  // секреты — только именами: значения в браузер не уезжают.
  const mapToLines = (map, withValues) =>
    Object.entries(map || {})
      .map(([name, value]) => name + ': ' + (withValues ? String(value) : ''))
      .join('\n');

  function formBody() {
    const transport = el('f-transport').value;
    const auth = el('f-auth').value;
    const stdio = transport === 'stdio';
    return {
      name: el('f-name').value.trim(),
      description: el('f-description').value.trim(),
      transport,
      url: stdio ? '' : el('f-url').value.trim(),
      command: stdio ? el('f-command').value.trim() : '',
      args: stdio ? el('f-args').value : '',
      auth,
      scopes: auth === 'oauth' ? el('f-scopes').value.trim() : '',
      clientId: auth === 'oauth' ? el('f-client-id').value.trim() : '',
      authorizationEndpoint: auth === 'oauth' ? el('f-authorization').value.trim() : '',
      tokenEndpoint: auth === 'oauth' ? el('f-token').value.trim() : '',
      registrationEndpoint: auth === 'oauth' ? el('f-registration').value.trim() : '',
      issuer: auth === 'oauth' ? el('f-issuer').value.trim() : '',
      mimic: auth === 'oauth' && el('f-mimic').checked,
      shared: el('f-shared').checked,
      // Поля скрытых веток не отправляем: иначе переключение с «ключа» на OAuth
      // утащило бы в новый сервер старый заголовок, а он там уже ни к чему.
      headers: stdio ? {} : linesToMap(el('f-headers').value),
      // Постоянные переменные stdio — часть описания, а не секрет: порты, адреса,
      // режимы. Рецепты кладут сюда то, что человеку не надо придумывать.
      env: stdio ? linesToMap(el('f-env').value) : {},
      credentialHeaders: auth === 'headers' && !stdio ? linesToMap(el('f-credential-headers').value) : {},
      credentialEnv: auth === 'headers' && stdio ? linesToMap(el('f-credential-env').value) : {},
      clientSecret: auth === 'oauth' ? el('f-client-secret').value.trim() : '',
    };
  }

  // Что человеку важно знать до сохранения: условия, порядок действий и куда
  // смотреть, если сервер не поднялся. В карточке каталога это не помещается.
  function recipeBrief(recipe) {
    const list = (items) => '<ul>' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>';
    return '<div class="recipe-brief">' +
      '<p><b>' + esc(ui.mcpRecipeWhen) + '</b> ' + esc(recipe.when) + '</p>' +
      (recipe.requires.length ? '<p><b>' + esc(ui.mcpRecipeRequires) + '</b></p>' + list(recipe.requires) : '') +
      (recipe.caveat ? '<p class="recipe-caveat">' + esc(recipe.caveat) + '</p>' : '') +
      (recipe.steps.length ? '<p><b>' + esc(ui.mcpRecipeSteps) + '</b></p>' + list(recipe.steps) : '') +
      (recipe.trouble.length ? '<details><summary>' + esc(ui.mcpRecipeTrouble) + '</summary>' + list(recipe.trouble) + '</details>' : '') +
      '<p class="hint">' + esc(fill(ui.mcpRecipeChecked, { date: recipe.checkedAt })) +
        ' · <a href="' + esc(recipe.docs) + '" target="_blank" rel="noopener">' + esc(ui.mcpRecipeDocs) + '</a></p>' +
    '</div>';
  }

  function formHtml(editor, recipe) {
    const server = editor ? editor.server : null;
    // Рецепт приезжает в форме редактора, но это не сохранённый сервер: заголовок
    // и кнопка должны говорить «добавить», иначе человек испугается, что перепишет чужое.
    const isEdit = Boolean(server) && !recipe;
    const transport = server ? server.transport : 'streamable-http';
    const auth = server ? server.auth : 'none';
    const headers = server && server.headers ? server.headers : {};
    const env = server && server.env ? server.env : {};
    const credentialHeaders = Object.fromEntries((editor && editor.credentialHeaders ? editor.credentialHeaders : []).map((name) => [name, '']));
    const credentialEnv = Object.fromEntries((editor && editor.credentialEnv ? editor.credentialEnv : []).map((name) => [name, '']));
    const args = server && Array.isArray(server.args) ? server.args.join('\n') : '';
    return '' +
      '<h2>' + esc(recipe ? fill(ui.mcpRecipeAddNamed, { name: recipe.name }) : isEdit ? ui.mcpRecipeEdit : ui.mcpAdd) + '</h2>' +
      '<p class="about">' + (recipe
        ? 'Команда, транспорт и несекретные настройки уже подставлены рецептом. Заполни ключи — если они нужны.'
        : 'Адрес и способ входа сервер обычно рассказывает сам. Ручные endpoints нужны только упрямым.') + '</p>' +
      (recipe ? recipeBrief(recipe) : '') +
      '<div class="mcp-form">' +
        '<div class="mcp-error" id="f-error" hidden></div>' +
        '<div class="field"><label for="f-name">НАЗВАНИЕ</label><input id="f-name" type="text" placeholder="Todoist" value="' + esc(server ? server.name : '') + '"></div>' +
        '<div class="field"><label for="f-description">ЧТО ЭТО И КОГДА НУЖНО</label><textarea id="f-description" rows="2" placeholder="Списки задач: добавить, закрыть, посмотреть на неделю.">' + esc(server ? server.description : '') + '</textarea></div>' +
        '<div class="two">' +
          '<div class="field"><label for="f-transport">ТРАНСПОРТ</label><select id="f-transport">' +
            '<option value="streamable-http"' + (transport === 'streamable-http' ? ' selected' : '') + '>streamable HTTP</option>' +
            '<option value="sse"' + (transport === 'sse' ? ' selected' : '') + '>SSE (старый)</option>' +
            '<option value="stdio"' + (transport === 'stdio' ? ' selected' : '') + '>stdio (команда в контейнере)</option>' +
          '</select></div>' +
          '<div class="field"><label for="f-auth">АВТОРИЗАЦИЯ</label><select id="f-auth">' +
            '<option value="none"' + (auth === 'none' ? ' selected' : '') + '>без авторизации</option>' +
            '<option value="headers"' + (auth === 'headers' ? ' selected' : '') + '>ключ / заголовки</option>' +
            '<option value="oauth"' + (auth === 'oauth' ? ' selected' : '') + '>OAuth 2.1</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="field" id="f-url-row"><label for="f-url">АДРЕС MCP</label><input id="f-url" type="text" spellcheck="false" placeholder="https://mcp.example.com/mcp" value="' + esc(server && server.url ? server.url : '') + '">' +
          '<p class="hint">Ключ в query-параметре уедет всем, с кем поделишься. Лучше положи его в «ключ доступа» ниже.</p></div>' +
        '<div class="field" id="f-command-row" hidden><label for="f-command">КОМАНДА</label><input id="f-command" type="text" spellcheck="false" placeholder="npx" value="' + esc(server && server.command ? server.command : '') + '"></div>' +
        '<div class="field" id="f-args-row" hidden><label for="f-args">АРГУМЕНТЫ — ПО ОДНОМУ В СТРОКЕ</label><textarea id="f-args" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/workspace">' + esc(args) + '</textarea></div>' +
        '<div class="field" id="f-env-row" hidden><label for="f-env">ПОСТОЯННЫЕ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ — ИМЯ: ЗНАЧЕНИЕ</label><textarea id="f-env" rows="3" spellcheck="false" placeholder="PROTONMAIL_IMAP_HOST: 127.0.0.1">' + esc(mapToLines(env, true)) + '</textarea>' +
          '<p class="hint">Не секреты: адреса, порты, режимы. Ключи — ниже, они не показываются другим.</p></div>' +
        '<div class="field" id="f-oauth-row" hidden><label for="f-scopes">SCOPES (ОПЦИОНАЛЬНО)</label><input id="f-scopes" type="text" spellcheck="false" placeholder="tasks:read tasks:write" value="' + esc(server && server.scopes ? server.scopes : '') + '"></div>' +
        '<div class="field" id="f-client-id-row" hidden><label for="f-client-id">CLIENT ID (ЕСЛИ СЕРВЕР ВЫДАЛ ЗАРАНЕЕ)</label><input id="f-client-id" type="text" spellcheck="false" placeholder="оставь пустым — зарегистрируемся сами" value="' + esc(server && server.clientId ? server.clientId : '') + '"></div>' +
        '<div class="field" id="f-client-secret-row" hidden><label for="f-client-secret">CLIENT SECRET (ЕСЛИ НУЖЕН)</label><input id="f-client-secret" type="password" autocomplete="new-password" placeholder="оставь пустым — не менять"></div>' +
        '<div class="field" id="f-mimic-row" hidden>' +
          '<label class="check"><input type="checkbox" id="f-mimic"' + (server && server.mimic ? ' checked' : '') + '> Мимикрировать под Claude — обход белого списка redirect_uri</label>' +
          '<p class="hint">Некоторые authorization servers (так делает Any.do) пускают только адреса возврата из своего списка и отвергают callback панели. ' +
            'С этой галочкой мы регистрируемся с адресом <code>' + esc(MIMIC_CALLBACK) + '</code> — тем же, что у Claude Code. ' +
            'Браузер вернётся на него, покажет ошибку соединения (это нормально), а адрес из строки браузера нужно будет вставить в панель.</p></div>' +
        '<div class="field" id="f-headers-row"><label for="f-headers">ПОСТОЯННЫЕ ЗАГОЛОВКИ — ИМЯ: ЗНАЧЕНИЕ</label><textarea id="f-headers" rows="2" spellcheck="false" placeholder="X-Client: icarus">' + esc(mapToLines(headers, true)) + '</textarea>' +
          '<p class="hint">Эти заголовки — часть описания и уезжают всем, с кем поделишься. Секретный ключ клади ниже.</p></div>' +
        '<div class="field" id="f-credential-headers-row"><label for="f-credential-headers">КЛЮЧ ДОСТУПА — ИМЯ: ЗНАЧЕНИЕ</label><textarea id="f-credential-headers" rows="2" spellcheck="false" placeholder="Authorization: Bearer ...">' + esc(mapToLines(credentialHeaders, false)) + '</textarea><p class="hint">Это личный секрет: он не показывается другим и не шарится. Строки с пустым значением не меняются; «Очистить доступ» — в карточке.</p></div>' +
        '<div class="field" id="f-credential-env-row" hidden><label for="f-credential-env">ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ — ИМЯ: ЗНАЧЕНИЕ</label><textarea id="f-credential-env" rows="2" spellcheck="false" placeholder="TODOIST_API_KEY: ...">' + esc(mapToLines(credentialEnv, false)) + '</textarea></div>' +
        '<details id="f-advanced"><summary>Ручные OAuth endpoints — если сервер ничего не рассказывает</summary>' +
          '<div class="field"><label for="f-authorization">AUTHORIZATION ENDPOINT</label><input id="f-authorization" type="text" spellcheck="false" value="' + esc(server && server.authorizationEndpoint ? server.authorizationEndpoint : '') + '"></div>' +
          '<div class="field"><label for="f-token">TOKEN ENDPOINT</label><input id="f-token" type="text" spellcheck="false" value="' + esc(server && server.tokenEndpoint ? server.tokenEndpoint : '') + '"></div>' +
          '<div class="field"><label for="f-registration">REGISTRATION ENDPOINT (ОПЦИОНАЛЬНО)</label><input id="f-registration" type="text" spellcheck="false" value="' + esc(server && server.registrationEndpoint ? server.registrationEndpoint : '') + '"></div>' +
          '<div class="field"><label for="f-issuer">ISSUER (ОПЦИОНАЛЬНО)</label><input id="f-issuer" type="text" spellcheck="false" value="' + esc(server && server.issuer ? server.issuer : '') + '"></div>' +
        '</details>' +
        '<label class="check"><input type="checkbox" id="f-shared"' + (server && server.shared ? ' checked' : '') + '> поделиться с другими — приедет им выключенным, ключи каждый настраивает сам</label>' +
        '<div class="row"><button type="button" data-close>Отмена</button><button type="button" class="primary" id="f-save">' + (isEdit ? 'Сохранить' : 'Добавить') + '</button></div>' +
      '</div>';
  }

  function syncForm() {
    const transport = el('f-transport').value;
    const auth = el('f-auth').value;
    const stdio = transport === 'stdio';
    el('f-url-row').hidden = stdio;
    el('f-command-row').hidden = !stdio;
    el('f-args-row').hidden = !stdio;
    el('f-env-row').hidden = !stdio;
    el('f-oauth-row').hidden = auth !== 'oauth';
    el('f-client-id-row').hidden = auth !== 'oauth';
    el('f-client-secret-row').hidden = auth !== 'oauth';
    el('f-mimic-row').hidden = auth !== 'oauth';
    el('f-advanced').hidden = auth !== 'oauth';
    el('f-headers-row').hidden = stdio;
    el('f-credential-headers-row').hidden = auth !== 'headers' || stdio;
    el('f-credential-env-row').hidden = auth !== 'headers' || !stdio;
  }

  async function openForm(id, preset) {
    // preset — рецепт в форме редактора: команда и настройки заполнены, ключи пустые.
    let editor = preset || null;
    if (id && !editor) {
      try {
        editor = await api('/panel/mcp/server?id=' + encodeURIComponent(id));
      } catch (error) {
        notice('Не удалось открыть сервер: ' + error.message, true);
        return;
      }
    }
    const recipe = editor && editor.recipe ? editor.recipe : null;
    // Что сервер ждёт от человека: пригодится и после сохранения, чтобы
    // «Настроить доступ» открылся с нужными именами, а не пустым полем.
    const expects = recipe
      ? { expectsEnv: editor.expectsEnv || [], expectsHeaders: editor.expectsHeaders || [] }
      : {};
    const opened = dialog(formHtml(editor, recipe));
    const dialogNode = opened.backdrop;
    dialogNode.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', opened.close));
    el('f-transport').addEventListener('change', syncForm);
    el('f-auth').addEventListener('change', syncForm);
    syncForm();

    const error = el('f-error');
    el('f-save').addEventListener('click', async () => {
      const button = el('f-save');
      button.disabled = true;
      error.hidden = true;
      try {
        const body = { ...formBody(), ...expects };
        if (!body.name) throw new Error('название не может быть пустым');
        const result = id
          ? await post('update', { id, ...body })
          : await post('add', body);
        opened.close();
        await load();
        notice(id ? 'Сервер обновлён' : 'Сервер добавлен' + (result.server && !result.server.ready ? ' · осталось настроить доступ' : ''));
      } catch (caught) {
        error.textContent = caught.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  }

  async function openCredentials(server) {
    const oauth = server.auth === 'oauth';
    const stdio = server.transport === 'stdio';
    const existing = oauth
      ? ''
      : (stdio ? (server.credentialEnv || []) : (server.credentialHeaders || [])).map((name) => name + ': ').join('\n');
    const opened = dialog(
      '<h2>Доступ к «' + esc(server.name) + '»</h2>' +
      '<p class="about">Ключ хранится только у тебя и не уезжает другим, даже если сервер расшарен.</p>' +
      '<div class="mcp-form">' +
        '<div class="mcp-error" id="c-error" hidden></div>' +
        (oauth
          ? '<div class="field"><label for="c-client-secret">CLIENT SECRET (ЕСЛИ НУЖЕН)</label><input id="c-client-secret" type="password" autocomplete="new-password" placeholder="оставь пустым — не менять"></div>'
          : '<div class="field"><label for="c-headers">' + (stdio ? 'ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ' : 'ЗАГОЛОВКИ') + ' — ИМЯ: ЗНАЧЕНИЕ</label>' +
            '<textarea id="c-headers" rows="3" spellcheck="false" placeholder="' + (stdio ? 'TODOIST_API_KEY: ...' : 'Authorization: Bearer ...') + '">' + esc(existing) + '</textarea>' +
            '<p class="hint">Строки с пустым значением не меняются. Если здесь уже были ключи, их имена показаны — впиши новое значение, чтобы заменить.</p></div>') +
        '<div class="row"><button type="button" data-close>Отмена</button>' +
          '<button type="button" data-clear>Очистить доступ</button>' +
          '<button type="button" class="primary" id="c-save">Сохранить</button></div>' +
      '</div>',
    );
    opened.backdrop.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', opened.close));
    const error = opened.backdrop.querySelector('#c-error');
    opened.backdrop.querySelector('[data-clear]').addEventListener('click', async () => {
      if (!(await askConfirm('Удалить сохранённый доступ к «' + server.name + '»?', 'очистить'))) return;
      try {
        await post('credentials', { id: server.id, clear: true });
        opened.close();
        await load();
      } catch (caught) {
        error.textContent = caught.message;
        error.hidden = false;
      }
    });
    opened.backdrop.querySelector('#c-save').addEventListener('click', async () => {
      const button = opened.backdrop.querySelector('#c-save');
      button.disabled = true;
      error.hidden = true;
      try {
        if (oauth) {
          const secret = opened.backdrop.querySelector('#c-client-secret').value.trim();
          if (!secret) throw new Error('впиши client secret или закрой окно');
          await post('credentials', { id: server.id, clientSecret: secret });
        } else {
          const map = linesToMap(opened.backdrop.querySelector('#c-headers').value);
          if (Object.keys(map).length === 0) throw new Error('впиши хотя бы одну строку «Имя: значение»');
          await post('credentials', { id: server.id, ...(stdio ? { env: map } : { headers: map }) });
        }
        opened.close();
        await load();
        notice('Доступ сохранён');
      } catch (caught) {
        error.textContent = caught.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  }

  function askConfirm(message, confirmLabel) {
    return new Promise((resolve) => {
      let answered = false;
      // Закрытие крестиком/фоном/Escape — это «нет», а не вечное ожидание.
      const opened = dialog(
        '<p style="white-space:pre-wrap">' + esc(message) + '</p>' +
        '<div class="row"><button type="button" data-no>отмена</button>' +
          '<button type="button" class="primary" data-yes>' + esc(confirmLabel || 'подтвердить') + '</button></div>',
        () => {
          if (answered) return;
          answered = true;
          resolve(false);
        },
      );
      const finish = (value) => {
        if (answered) return;
        answered = true;
        opened.close();
        resolve(value);
      };
      opened.backdrop.querySelector('[data-no]').addEventListener('click', () => finish(false));
      opened.backdrop.querySelector('[data-yes]').addEventListener('click', () => finish(true));
      opened.backdrop.querySelector('[data-yes]').focus();
    });
  }

  // ── рецепты ──────────────────────────────────────────────────────────────
  // Каталог общий и ничего не знает о человеке: карточка показывает, когда сервер
  // нужен и что понадобится снаружи. Кнопка открывает обычную форму, где пустыми
  // остаются только значения ключей.
  function recipeCard(recipe) {
    const node = document.createElement('article');
    node.className = 'recipe-card';
    node.dataset.recipe = recipe.id;
    const keys = recipe.secrets.length === 0
      ? ui.mcpRecipeNoKeys
      : recipe.secretKind === 'header'
        ? ui.mcpRecipeHeaderKey
        : fill(ui.mcpRecipeKeys, {
            n: recipe.secrets.length,
            word: plural(recipe.secrets.length, ui.keysWord),
          });
    node.innerHTML =
      '<div class="recipe-head">' + badge(recipe.category) + badge(keys, recipe.secrets.length ? 'wait' : 'on') + '</div>' +
      '<h3>' + esc(recipe.name) + '</h3>' +
      '<p class="recipe-when">' + esc(recipe.when) + '</p>' +
      (recipe.caveat ? '<p class="recipe-caveat">' + esc(recipe.caveat) + '</p>' : '') +
      '<div class="recipe-foot"><code>' + esc(transportLabel(recipe.transport)) + '</code>' +
        '<button type="button" data-recipe="' + esc(recipe.id) + '">' + esc(ui.mcpRecipeAdd) + '</button></div>';
    node.querySelector('[data-recipe]').addEventListener('click', (event) => openRecipe(recipe.id, event.currentTarget));
    return node;
  }

  async function openRecipe(id, button) {
    if (button) button.disabled = true;
    try {
      const preset = await api('/panel/mcp/recipe?id=' + encodeURIComponent(id));
      await openForm(null, preset);
    } catch (error) {
      notice('Не удалось открыть рецепт: ' + error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function loadRecipes() {
    const box = el('mcp-recipes');
    if (!box) return;
    try {
      const data = await api('/panel/mcp/recipes');
      // Правило — подпись интерфейса, а не содержимое рецепта: она уже пришла
      // из словаря страницы и переключается вместе с языком.
      if (data.checkedAt) el('mcp-checked').textContent = fill(ui.mcpChecked, { date: data.checkedAt });
      if (data.skipped) {
        el('mcp-skipped').textContent = data.skipped;
        el('mcp-skipped').hidden = false;
      }
      box.innerHTML = '';
      for (const recipe of data.recipes) box.append(recipeCard(recipe));
    } catch (error) {
      box.innerHTML = '<p class="mcp-empty">Не удалось прочитать рецепты: ' + esc(error.message) + '</p>';
    }
  }

  // ── запуск ───────────────────────────────────────────────────────────────
  el('mcp-add').addEventListener('click', () => openForm(null));
  loadRecipes();
  load();

  const params = new URLSearchParams(location.search);
  const connected = params.get('connected');
  const failed = params.get('error');
  if (connected) {
    notice('Доступ получен. Включи сервер переключателем, если он ещё выключен.');
    params.delete('connected');
  } else if (failed) {
    notice('Авторизация не удалась: ' + failed, true);
    params.delete('error');
  }
  if (connected || failed) {
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
  }
})();
