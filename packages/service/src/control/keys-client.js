// Клиент раздела «Ключи». Живёт отдельным файлом, как MCP: в TypeScript не нужно
// экранировать бэктики и скобки, а браузер получает тот же JS и локально, и на проде.
(function () {
  'use strict';
  const cfg = window.__KEYS_CFG__ || {};
  const el = (id) => document.getElementById(id);

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('application/json')) {
      const message = type.includes('application/json')
        ? (await response.json().catch(() => ({}))).error?.message || response.statusText
        : 'сессия входа истекла — обнови страницу';
      throw new Error(message);
    }
    return response.json();
  };

  let data = null;
  let notice = null;
  let editing = null;
  let adding = false;
  let pendingRemove = null;

  const APPLY_LABELS = {
    session: 'со следующего ответа',
    restart: 'после перезапуска сервиса',
    compose: 'после пересборки стека',
  };

  function showNotice(text, kind) {
    notice = { text, kind: kind || 'ok' };
    renderNotice();
  }

  function renderNotice() {
    const box = el('keys-notice');
    if (!box) return;
    if (!notice) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.className = 'keys-notice ' + notice.kind;
    box.textContent = notice.text;
  }

  function statusPill(key) {
    const cls = key.present ? (key.source === 'settings' ? 'own' : 'env') : key.source === 'removed' ? 'off' : 'none';
    const text = key.present ? (key.source === 'settings' ? 'задан в панели' : 'из .env') : key.source === 'removed' ? 'убран' : 'не задан';
    return '<span class="pill ' + cls + '">' + esc(text) + '</span>';
  }

  // --- поисковый роутер -------------------------------------------------------
  // Над списком ключей — короткая сводка: кто сейчас отвечает, кто в карантине
  // и у кого «ключ сломан». Кнопка «Проверить» делает настоящий поиск: успех
  // снимает карантин, отказ ставит заново.

  function untilText(iso) {
    const stamp = new Date(iso).getTime();
    if (!isFinite(stamp)) return '';
    const minutes = Math.round((stamp - Date.now()) / 60000);
    if (minutes <= 90) return 'ещё ' + Math.max(1, minutes) + ' мин';
    const hours = Math.round(minutes / 60);
    if (hours <= 48) return 'ещё ' + hours + ' ч';
    return 'до ' + new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  function searchPill(provider) {
    // Бесплатный провайдер: «без ключа» уже написано в колонке ключа, статус
    // должен говорить о работе, а не повторять это же слово.
    if (provider.keyless) {
      return provider.present
        ? '<span class="pill own">работает</span>'
        : '<span class="pill none">выключен</span>';
    }
    // Ключа нет, но его отсутствие ничего не ломает — есть бесплатный двойник.
    if (provider.optional) return '<span class="pill env">необязателен</span>';
    if (!provider.present) return '<span class="pill none">нет ключа</span>';
    if (provider.broken) return '<span class="pill off">ключ сломан</span>';
    if (provider.bannedUntil) return '<span class="pill warn">карантин ' + esc(untilText(provider.bannedUntil)) + '</span>';
    return '<span class="pill own">работает</span>';
  }

  function providerRow(provider, capability) {
    const current = provider.current ? '<span class="pill env">текущий</span>' : '';
    const why = provider.lastError
      ? '<div class="keys-desc search-error">последний отказ: ' + esc(provider.lastError) + '</div>'
      : '';
    const note = provider.note ? '<div class="keys-desc">' + esc(provider.note) + '</div>' : '';
    const fails = provider.fails > 0
      ? '<span class="keys-apply">отказов подряд: ' + provider.fails + '</span>'
      : '';
    // Провайдеру без ключа нечего задавать: вместо кнопки — только проверка.
    const edit = provider.keyless
      ? ''
      : '<button class="btn primary" data-edit-key="' + esc(provider.keyName) + '">' +
          (provider.present ? 'Изменить' : 'Задать') +
        '</button>';
    return (
      '<div class="keys-row search-row">' +
        '<div class="keys-main">' +
          '<div class="keys-top"><code>' + esc(provider.keyless ? 'без ключа' : provider.keyName) + '</code>' +
            searchPill(provider) + current + fails + '</div>' +
          '<div class="keys-label">' + esc(provider.label) + '</div>' +
          note +
          why +
        '</div>' +
        '<div class="keys-actions">' +
          edit +
          '<button class="btn" data-check="' + esc(provider.id) + '" data-capability="' + esc(capability) + '"' +
            (provider.present ? '' : ' disabled') + '>Проверить</button>' +
        '</div>' +
      '</div>'
    );
  }

  /**
   * Сводка роутера: заголовок, вступление и строки провайдеров.
   * Одна и та же разметка для поиска и для извлечения страниц: отличаются
   * только набор провайдеров, рейтинг и текст вступления.
   */
  function routingSection(title, intro, status, capability) {
    if (!status || !status.providers || status.providers.length === 0) return '';
    const broken = status.providers.filter((provider) => provider.broken).length;
    const banned = status.providers.filter((provider) => provider.bannedUntil).length;
    const configured = status.providers.filter((provider) => provider.present).length;
    const what = capability === 'fetch' ? 'извлечении' : 'поиске';
    const summary = configured === 0
      ? capability === 'fetch'
        ? 'Ключей для извлечения нет — подойдёт любой из Exa, Tavily, Linkup и You.com.'
        : 'Ключей поиска нет — задай хотя бы один, иначе роутеру некуда идти.'
      : !status.current
        ? 'Текущий ещё не выбран: им станет первый по рейтингу при первом ' + what + '.'
        : broken > 0
          ? 'Есть сломанный ключ — проверь его.'
          : banned > 0
            ? 'Часть провайдеров в карантине, роутер обходит их сам.'
            : 'Карантинов нет: ' + what + ' роутер работает штатно.';
    return (
      '<section class="keys-group search-health">' +
        '<h2>' + esc(title) + '<span>' + status.providers.length + '</span></h2>' +
        '<p class="keys-intro small">' + esc(intro) + ' ' + esc(summary) + '</p>' +
        status.providers.map((provider) => providerRow(provider, capability)).join('') +
      '</section>'
    );
  }

  function searchSection() {
    const search = data && data.search;
    if (!search) return '';
    return routingSection(
      'ПОИСК: МАРШРУТИЗАЦИЯ',
      'Роутер пробует провайдеров по рейтингу и обходит упавших. 50 отказов подряд — «ключ сломан».',
      search,
      'search',
    );
  }

  function fetchSection() {
    const fetchStatus = data && data.search && data.search.fetch;
    if (!fetchStatus) return '';
    return routingSection(
      'СТРАНИЦЫ: ИЗВЛЕЧЕНИЕ',
      'Cloudflare идёт первым, пока не в карантине; дальше Linkup и You.com, а Exa и Tavily бережём для поиска.',
      fetchStatus,
      'fetch',
    );
  }

  function row(key) {
    const open = editing === key.name;
    const hint = key.present
      ? '<span class="keys-hint">' + esc(key.hint) + '</span>'
      : key.plain
        ? '<span class="keys-hint dim">не задано</span>'
        : '';
    const where = key.where
      ? '<a class="keys-where" href="' + esc(key.where.startsWith('http') ? key.where : '#') + '" target="_blank" rel="noreferrer noopener">' + esc(key.where) + '</a>'
      : '';
    const apply = key.present && key.apply && APPLY_LABELS[key.apply]
      ? '<span class="keys-apply">' + esc(APPLY_LABELS[key.apply]) + '</span>'
      : '';
    const remove = key.present
      ? '<button class="btn danger" data-remove="' + esc(key.name) + '">' +
          (pendingRemove === key.name ? 'Точно убрать?' : 'Убрать') +
        '</button>'
      : '';

    return (
      '<div class="keys-row' + (open ? ' open' : '') + '" data-key="' + esc(key.name) + '">' +
        '<div class="keys-main">' +
          '<div class="keys-top"><code>' + esc(key.name) + '</code>' + statusPill(key) + apply + '</div>' +
          '<div class="keys-label">' + esc(key.label) + '</div>' +
          '<div class="keys-desc">' + esc(key.description) + ' ' + where + '</div>' +
          (hint ? '<div class="keys-value">' + hint + '</div>' : '') +
        '</div>' +
        '<div class="keys-actions">' +
          '<button class="btn" data-edit="' + esc(key.name) + '">' + (key.present ? 'Изменить' : 'Задать') + '</button>' +
          remove +
        '</div>' +
        (open ? editForm(key) : '') +
      '</div>'
    );
  }

  function editForm(key) {
    return (
      '<form class="keys-form" data-form="' + esc(key.name) + '">' +
        '<label for="value-' + esc(key.name) + '">НОВОЕ ЗНАЧЕНИЕ' +
          (key.plain ? '' : ' — оно не показывается и не уходит из панели обратно') +
        '</label>' +
        '<div class="keys-line">' +
          '<input id="value-' + esc(key.name) + '" name="value" type="' + (key.plain ? 'text' : 'password') + '"' +
            ' autocomplete="off" spellcheck="false" placeholder="' + (key.plain ? '' : 'вставь ключ') + '" required>' +
          (key.plain ? '' : '<label class="keys-show"><input type="checkbox" data-show> показать</label>') +
          '<button class="btn primary" type="submit">Сохранить</button>' +
          '<button class="btn" type="button" data-cancel>Отмена</button>' +
        '</div>' +
      '</form>'
    );
  }

  function renderList() {
    const box = el('keys-list');
    if (!data) {
      box.innerHTML = '<p class="keys-empty">Читаю…</p>';
      return;
    }
    const groups = data.groups || [];
    box.innerHTML = searchSection() + fetchSection() + groups
      .map((group) => {
        const keys = data.keys.filter((key) => key.group === group.id);
        if (keys.length === 0) return '';
        return (
          '<section class="keys-group">' +
            '<h2>' + esc(group.label) + '<span>' + keys.length + '</span></h2>' +
            keys.map(row).join('') +
          '</section>'
        );
      })
      .join('');

    box.querySelectorAll('[data-edit-key]').forEach((button) => {
      button.onclick = () => {
        // Форма живёт в строке ключа ниже: открываем её и подводим к ней экран,
        // чтобы «Задать» из сводки не выглядел кнопкой в пустоту.
        editing = button.dataset.editKey;
        pendingRemove = null;
        renderList();
        const input = el('value-' + editing);
        if (input) input.focus();
        const row = box.querySelector('[data-key="' + editing + '"]');
        if (row && typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    });

    box.querySelectorAll('[data-check]').forEach((button) => {
      button.onclick = async () => {
        const id = button.dataset.check;
        const capability = button.dataset.capability || 'search';
        button.disabled = true;
        button.textContent = 'Проверяю…';
        try {
          const result = await api('/panel/keys/api', {
            method: 'POST',
            body: JSON.stringify({ action: 'check', provider: id, capability }),
          });
          data = result;
          renderList();
          showNotice(result.message || 'Проверено.', result.check && result.check.ok ? 'ok' : 'bad');
        } catch (error) {
          showNotice('Проверка не удалась: ' + error.message, 'bad');
          button.disabled = false;
          button.textContent = 'Проверить';
        }
      };
    });

    box.querySelectorAll('[data-edit]').forEach((button) => {
      button.onclick = () => {
        editing = button.dataset.edit;
        pendingRemove = null;
        renderList();
        const input = el('value-' + editing);
        if (input) input.focus();
      };
    });
    box.querySelectorAll('[data-cancel]').forEach((button) => {
      button.onclick = () => {
        editing = null;
        renderList();
      };
    });
    box.querySelectorAll('[data-show]').forEach((checkbox) => {
      checkbox.onchange = () => {
        const input = checkbox.closest('.keys-form').querySelector('input[name=value]');
        input.type = checkbox.checked ? 'text' : 'password';
      };
    });
    box.querySelectorAll('form[data-form]').forEach((form) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        await save(form.dataset.form, form.querySelector('input[name=value]').value);
      };
    });
    box.querySelectorAll('[data-remove]').forEach((button) => {
      button.onclick = async () => {
        const name = button.dataset.remove;
        if (pendingRemove !== name) {
          pendingRemove = name;
          renderList();
          return;
        }
        pendingRemove = null;
        await save(name, null, 'remove');
      };
    });
  }

  async function save(name, value, action) {
    try {
      const result = await api('/panel/keys/api', {
        method: 'POST',
        body: JSON.stringify({ name, value, action }),
      });
      data = result;
      editing = null;
      pendingRemove = null;
      renderList();
      const warning = result.warning ? ' ' + result.warning : '';
      const warnings = result.reloaded && result.reloaded.warnings && result.reloaded.warnings.length
        ? ' Не доехало до: ' + result.reloaded.warnings.join('; ')
        : '';
      showNotice((result.message || 'Сохранено.') + warnings + warning, warning || warnings ? 'warn' : 'ok');
    } catch (error) {
      showNotice('Не сохранилось: ' + error.message, 'bad');
    }
  }

  function renderAdd() {
    const box = el('keys-add');
    if (!adding) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const suggestions = (data ? data.keys : []).filter((key) => !key.present).map((key) => key.name);
    box.hidden = false;
    box.innerHTML =
      '<form class="keys-form add" id="add-form">' +
        '<label for="add-name">ИМЯ ПЕРЕМЕННОЙ</label>' +
        '<div class="keys-line">' +
          '<input id="add-name" name="name" list="key-names" placeholder="НАПРИМЕР, OPENAI_API_KEY" autocomplete="off" spellcheck="false" required>' +
          '<datalist id="key-names">' + [...new Set(suggestions)].map((name) => '<option value="' + esc(name) + '">').join('') + '</datalist>' +
        '</div>' +
        '<label for="add-value">ЗНАЧЕНИЕ</label>' +
        '<div class="keys-line">' +
          '<input id="add-value" name="value" type="password" autocomplete="off" spellcheck="false" placeholder="вставь ключ" required>' +
          '<label class="keys-show"><input type="checkbox" id="add-show"> показать</label>' +
          '<button class="btn primary" type="submit">Добавить</button>' +
          '<button class="btn" type="button" id="add-cancel">Отмена</button>' +
        '</div>' +
      '</form>';
    el('add-form').onsubmit = async (event) => {
      event.preventDefault();
      const name = el('add-name').value.trim().toUpperCase();
      await save(name, el('add-value').value);
      if (!notice || notice.kind !== 'bad') adding = false;
      renderAdd();
    };
    el('add-cancel').onclick = () => {
      adding = false;
      renderAdd();
    };
    el('add-show').onchange = () => {
      el('add-value').type = el('add-show').checked ? 'text' : 'password';
    };
    el('add-name').focus();
  }

  async function load() {
    try {
      data = await api('/panel/keys/api');
      el('keys-meta').textContent =
        (data.secrets || 0) + ' ' + ((data.secrets || 0) === 1 ? 'ключ' : 'ключей') +
        (data.updatedBy ? ' · последняя правка: ' + data.updatedBy : '');
      renderList();
      renderAdd();
    } catch (error) {
      el('keys-list').innerHTML = '<p class="keys-empty bad">' + esc(error.message) + '</p>';
    }
  }

  const addButton = el('keys-add-button');
  if (addButton) {
    addButton.onclick = () => {
      adding = !adding;
      renderAdd();
    };
  }

  // «Перечитать» — для правок .env руками: файл мог поменять человек или деплой.
  const reloadButton = el('keys-reload-button');
  if (reloadButton) {
    reloadButton.onclick = async () => {
      reloadButton.disabled = true;
      try {
        const result = await api('/panel/keys/api', { method: 'POST', body: JSON.stringify({ action: 'reload' }) });
        data = result;
        renderList();
        showNotice(result.message || 'Перечитано.', 'ok');
      } catch (error) {
        showNotice('Не перечиталось: ' + error.message, 'bad');
      } finally {
        reloadButton.disabled = false;
      }
    };
  }

  document.title = 'Icarus Control Panel · Ключи · ' + (cfg.user || '');
  load();
})();
