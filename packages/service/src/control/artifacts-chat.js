// Чат правки артефакта в боковой панели раздела «Артефакты».
//
// Это тот же разговор, что и в обычном чате: сообщения уходят в /panel/api/chat/send,
// ответ приходит NDJSON-потоком. Отличие одно — сервер помечает разговор артефактом,
// и pi работает в папке /artifacts/<slug>, а не в workspace.
//
// Команды с косой черты общие с основным чатом: сначала спрашиваем сервер
// (/panel/api/chat/command), и только его отказ отправляет строку в pi. Иначе
// /clear уезжал модели как текст и она бодро врала, что контекст очищен.
/* global artifactMarkdown, artEl, artApi, artEsc, artStamp, artState, artSetStatus, artHideHistory, artLoadList, artRenderView */

const artChatState = {
  chatId: null,
  busy: false,
  commandBusy: false,
  controller: null,
  historyToken: 0,
  liveBox: null,
};

function artChatLog() {
  return artEl('art-chat-log');
}

function artChatNote(text, bad = false) {
  const node = artEl('art-chat-note');
  node.textContent = text || '';
  node.className = 'art-chat-note' + (bad ? ' bad' : '');
}

function artChatScroll(force = false) {
  const box = artChatLog();
  if (!box) return;
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 140) {
    box.scrollTop = box.scrollHeight;
  }
}

function artChatSetBusy(on) {
  artChatState.busy = on;
  const send = artEl('art-chat-send');
  const stop = artEl('art-chat-stop');
  send.hidden = on;
  stop.hidden = !on;
  send.disabled = on;
  stop.disabled = false;
  if (on) artChatScroll();
}

function artChatMarkdown(text) {
  const source = String(text || '');
  const selected = artState.selected;
  const base = selected ? String(selected.urls.raw || '').replace(/[^/]*$/, '') : '';
  if (typeof artifactMarkdown === 'function') {
    try {
      return artifactMarkdown(source, base ? { fileBase: base } : {});
    } catch {
      /* разметка не должна ронять чат */
    }
  }
  return '<p>' + artEsc(source).replace(/\n/g, '<br>') + '</p>';
}

/** Реплика человека: тот же пузырь, что в основном чате, без подписи «ты». */
function artChatUser(text) {
  const turn = document.createElement('div');
  turn.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  turn.append(bubble);
  artChatLog().append(turn);
  artChatScroll(true);
  return turn;
}

/**
 * Ход ИИ. Разметка — как у addAssistant в chat-client.js: аватар, подпись,
 * карточка трассировки, ответ в .md (без пузыря) и строка «думает».
 * Пустого пузыря ответа тут нет: .md — обычный текстовый блок.
 */
function artChatAssistant(iso) {
  const turn = document.createElement('div');
  turn.className = 'turn assistant';
  turn.innerHTML =
    '<div class="avatar">I</div>' +
    '<div class="assistant-body">' +
    '<div class="who"><b>Icarus</b><time>' +
    artEsc(artStamp(iso || new Date().toISOString())) +
    '</time></div>' +
    '<div class="trace-slot"></div>' +
    '<div class="md"></div>' +
    '<div class="typing">Икар думает</div>' +
    '</div>';
  artChatLog().append(turn);
  artChatScroll(true);
  return {
    turn,
    body: turn.querySelector('.assistant-body'),
    slot: turn.querySelector('.trace-slot'),
    md: turn.querySelector('.md'),
    typing: turn.querySelector('.typing'),
    text: '',
    steps: [],
  };
}

/** Заглушка «Скажи, что поправить» уходит, как только в ленте появился ход. */
function artChatDropEmpty() {
  const empty = artChatLog().querySelector('.art-empty');
  if (empty) empty.remove();
}

/**
 * Ответ команды — плашка с её именем, как в основном чате. В историю он не
 * попадает: это не ответ модели, и после перезагрузки его не будет.
 */
function artChatCommandResult(command, text, failed = false) {
  artChatDropEmpty();
  const turn = document.createElement('div');
  turn.className = 'turn command' + (failed ? ' error' : '');
  const card = document.createElement('div');
  card.className = 'command-card';
  const head = document.createElement('div');
  head.className = 'command-head';
  head.textContent = command.trim().split(/\s+/)[0] || 'команда';
  const body = document.createElement('div');
  body.className = 'md command-text';
  body.innerHTML = artChatMarkdown(text || '');
  card.append(head, body);
  turn.append(card);
  artChatLog().append(turn);
  artChatScroll(true);
}

/** Граница контекста: /clear начинает новую сессию, но старую ленту не прячет. */
function artChatDivider(text) {
  artChatDropEmpty();
  const mark = document.createElement('div');
  mark.className = 'art-chat-divider';
  mark.textContent = text;
  artChatLog().append(mark);
  artChatScroll(true);
}

function artChatStepWord(count) {
  const ten = count % 10;
  const hundred = count % 100;
  if (ten === 1 && hundred !== 11) return 'шаг';
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'шага';
  return 'шагов';
}

/** Трассировка — карточка-пузырь, как в основном чате: шаги видны сразу. */
function artChatSteps(box) {
  if (!box.steps.length) {
    box.slot.innerHTML = '';
    return;
  }
  // Перерисовка не должна схлопывать карточку, которую человек уже раскрыл
  // или свернул: каждый дельта-текст приходит сюда заново.
  const opened = box.slot.querySelector('details.trace');
  const open = opened ? opened.open : true;
  box.slot.innerHTML =
    '<details class="trace" open><summary>' +
    box.steps.length +
    ' ' +
    artChatStepWord(box.steps.length) +
    ' · трассировка</summary><div class="trace-list">' +
    box.steps
      .map((step) => {
        const status = String(step.status || 'running').replace(/[^a-z]/gi, '');
        const tool = String(step.tool || 'tool').replace(/[^a-z0-9_]/gi, '_');
        return (
          '<div class="trace-step ' +
          status +
          ' tool-' +
          tool +
          '" title="' +
          artEsc(step.result || '') +
          '"><span class="trace-label">' +
          artEsc(step.label || step.tool || 'шаг') +
          '</span><span class="trace-detail">' +
          artEsc(step.detail || step.tool || '') +
          '</span><span class="trace-dot"></span></div>'
        );
      })
      .join('') +
    '</div></details>';
  const next = box.slot.querySelector('details.trace');
  if (next) next.open = open;
}

function artChatRender(box) {
  box.md.innerHTML = artChatMarkdown(box.text);
  box.typing.hidden = Boolean(box.text) || !artChatState.busy;
  artChatSteps(box);
  artChatScroll();
}

function artChatDrop(box) {
  if (box && box.turn.isConnected) box.turn.remove();
  if (artChatState.liveBox === box) artChatState.liveBox = null;
}

function artChatEvent(box, event) {
  if (event.type === 'text') {
    box.text += event.text || '';
    artChatRender(box);
    return;
  }
  if (event.type === 'step') {
    box.steps.push(event.step || {});
    artChatRender(box);
    return;
  }
  if (event.type === 'step-update') {
    const index = box.steps.findIndex((step) => step.id === event.id);
    if (index !== -1) box.steps[index] = event.step || box.steps[index];
    artChatRender(box);
    return;
  }
  if (event.type === 'step-end') {
    const step = box.steps.find((item) => item.id === event.id);
    if (step) {
      step.status = event.status || step.status;
      step.result = event.result;
      if (event.detail !== undefined) step.detail = event.detail;
      artChatSteps(box);
    }
    return;
  }
  if (event.type === 'notice') {
    artChatNote(event.message || '');
    return;
  }
  if (event.type === 'reauth') {
    if (!event.url) return;
    const card = document.createElement('div');
    card.className = 'reauth-card';
    card.textContent = 'Доступ к MCP «' + (event.server || 'MCP') + '» истёк. ';
    const link = document.createElement('a');
    link.href = String(event.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Переподключить';
    card.append(link);
    box.body.append(card);
    artChatScroll();
    return;
  }
  if (event.type === 'done') {
    artChatState.busy = false;
    artChatSetBusy(false);
    box.typing.hidden = true;
    if (!box.text.trim()) {
      box.text = box.steps.length ? 'Готово.' : '(ответ пустой)';
      box.md.innerHTML = artChatMarkdown(box.text);
    }
    artChatNote('Готово · артефакт обновлён');
    artChatState.liveBox = null;
    artChatRefreshArtifact();
    return;
  }
  if (event.type === 'error') {
    box.turn.classList.add('error');
    box.text = (box.text ? box.text + '\n\n' : '') + '[ошибка: ' + (event.message || 'ответ не пришёл') + ']';
    box.md.innerHTML = artChatMarkdown(box.text);
    box.typing.hidden = true;
    artChatState.busy = false;
    artChatSetBusy(false);
    artChatNote('');
  }
}

async function artChatReadStream(response, box) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (artChatState.controller && artChatState.controller.signal.aborted) return;
      throw error;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) {
        try {
          artChatEvent(box, JSON.parse(line));
        } catch {
          /* одна битая строка не рвёт ответ */
        }
      }
      cut = buffer.indexOf('\n');
    }
  }
}

function artChatClear() {
  artChatLog().innerHTML =
    '<div class="art-empty"><b>Скажи, что поправить</b><span>Икар изменит файлы прямо в папке артефакта: «добавь заголовок», «сделай таблицу», «поменяй цвет».</span><span>Команды — как в большом чате: /clear начнёт заново, /compact сожмёт, /stats покажет токены.</span></div>';
}

function artChatRenderHistory(messages) {
  artChatLog().innerHTML = '';
  if (!messages.length) {
    artChatClear();
    return;
  }
  for (const message of messages) {
    if (message.divider === 'clear') {
      artChatDivider('Контекст очищен');
      continue;
    }
    if (message.role === 'user') {
      if (String(message.text || '').trim()) artChatUser(message.text);
      continue;
    }
    const box = artChatAssistant(message.timestamp);
    box.typing.hidden = true;
    box.text = String(message.text || '');
    box.steps = Array.isArray(message.trace) ? message.trace : [];
    box.md.innerHTML = artChatMarkdown(box.text || (box.steps.length ? 'Готово.' : ''));
    artChatSteps(box);
  }
  artChatScroll(true);
}

async function artChatAttach() {
  if (!artChatState.chatId || artChatState.busy) return;
  const chatId = artChatState.chatId;
  const box = artChatAssistant();
  artChatState.liveBox = box;
  artChatSetBusy(true);
  const controller = new AbortController();
  artChatState.controller = controller;
  try {
    const response = await fetch('/panel/api/chat/stream?id=' + encodeURIComponent(chatId), {
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('ndjson')) {
      artChatDrop(box);
      await artChatLoadHistory();
      return;
    }
    await artChatReadStream(response, box);
  } catch (error) {
    if (!controller.signal.aborted) {
      artChatDrop(box);
      artChatNote('догнать ответ не вышло: ' + (error && error.message ? error.message : error), true);
    }
  } finally {
    if (artChatState.controller === controller) artChatState.controller = null;
    artChatState.busy = false;
    artChatSetBusy(false);
    box.typing.hidden = true;
  }
}

async function artChatLoadHistory() {
  const token = ++artChatState.historyToken;
  const data = await artApi('/panel/api/chat/history?id=' + encodeURIComponent(artChatState.chatId));
  if (token !== artChatState.historyToken) return;
  artChatRenderHistory(data.messages || []);
  artChatNote('');
  if (data.live) await artChatAttach();
}

async function artChatOpen() {
  const selected = artState.selected;
  if (!selected) return;
  if (!selected.canWrite) {
    artSetStatus('Править артефакт может тот, у кого есть право записи', true);
    return;
  }
  artHideHistory();
  const panel = artEl('art-chat-panel');
  panel.hidden = false;
  artEl('art-chat').setAttribute('aria-expanded', 'true');
  artEl('art-chat-input').disabled = true;
  artEl('art-chat-send').disabled = true;
  artEl('art-chat-sub').textContent = 'Папка · /artifacts/' + selected.name;
  artChatNote('Открываю разговор…');
  artChatLog().innerHTML = '<p class="art-empty">Открываю разговор…</p>';

  try {
    const data = await artApi('/panel/artifacts/api/chat', {
      method: 'POST',
      body: JSON.stringify({ artifact: selected.name }),
    });
    artChatState.chatId = data.chatId;
    artEl('art-chat-sub').textContent = 'Папка · /artifacts/' + selected.name;
    artEl('art-chat-input').disabled = false;
    artEl('art-chat-send').disabled = false;
    await artChatLoadHistory();
    artEl('art-chat-input').focus();
  } catch (error) {
    artChatNote('Чат не открылся: ' + (error && error.message ? error.message : error), true);
    artChatLog().innerHTML =
      '<div class="art-empty bad"><b>Чат не открылся</b><span>' +
      artEsc(error && error.message ? error.message : error) +
      '</span></div>';
  }
}

function artChatClose() {
  const panel = artEl('art-chat-panel');
  if (panel.hidden) return;
  panel.hidden = true;
  artEl('art-chat').setAttribute('aria-expanded', 'false');
  if (artChatState.controller) {
    artChatState.controller.abort();
    artChatState.controller = null;
  }
  artChatState.busy = false;
  artChatSetBusy(false);
  artChatNote('');
}

function artChatToggle() {
  if (artEl('art-chat-panel').hidden) void artChatOpen();
  else artChatClose();
}

/** Имя команды так, как его разбирает сервер: до пробела и без «/». */
function artChatCommandName(text) {
  const match = /^\/([a-zA-Z0-9_]+)/.exec(String(text || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Строка с косой черты: сначала спрашиваем сервер, его ли это команда.
 * `/clear`, `/compact`, `/stats` — команды чата, у них свой маршрут; `/skill:имя`
 * и шаблоны pi сервер не берёт, и они уходят обычной репликой. false значит
 * «отправляй в разговор как текст».
 */
async function artChatRunCommand(text) {
  if (!artChatState.chatId) return false;
  // Вторую команду поверх первой не запускаем: ответ придёт не тому ходу.
  if (artChatState.commandBusy) {
    artChatNote('предыдущая команда ещё выполняется');
    return true;
  }
  const chatId = artChatState.chatId;
  artChatState.commandBusy = true;
  artChatNote('выполняю ' + text.trim().split(/\s+/)[0] + '…');
  try {
    const result = await artApi('/panel/api/chat/command', {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    });
    // Пока команда шла, панель могли закрыть или открыть другой артефакт:
    // ответ не должен упасть в чужую ленту.
    if (!result || !result.handled || artChatState.chatId !== chatId) {
      artChatNote('');
      return Boolean(result && result.handled);
    }
    if (result.cleared) {
      artChatDivider('Контекст очищен');
      artChatNote('Контекст чистый, артефакт на месте — говорим заново');
    } else {
      artChatCommandResult(text, result.text || '', Boolean(result.failed));
      artChatNote('');
    }
    return true;
  } catch (error) {
    if (artChatState.chatId === chatId) {
      artChatCommandResult(text, 'не получилось: ' + (error && error.message ? error.message : error), true);
      artChatNote('');
    }
    return true;
  } finally {
    artChatState.commandBusy = false;
  }
}

async function artChatSend() {
  const input = artEl('art-chat-input');
  const text = String(input.value || '').trim();
  if (!text) return;
  if (!artChatState.chatId) {
    artChatNote('Разговор ещё не открылся', true);
    return;
  }

  // Команду разбираем до проверки занятости: /stop и /stats нужны и во время
  // хода. Сервер сам скажет, его ли это команда; чужие уедут в pi текстом.
  if (artChatCommandName(text)) {
    const handled = await artChatRunCommand(text);
    if (handled) {
      if (input.value.trim() === text) {
        input.value = '';
        input.style.height = 'auto';
      }
      input.focus();
      return;
    }
  }
  if (artChatState.busy) return;

  const chatId = artChatState.chatId;
  input.value = '';
  input.style.height = 'auto';
  artChatDropEmpty();
  artChatUser(text);
  const box = artChatAssistant();
  artChatState.liveBox = box;
  artChatSetBusy(true);
  artChatNote('Икар правит артефакт…');

  const abort = new AbortController();
  artChatState.controller = abort;
  try {
    const response = await fetch('/panel/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, text }),
      signal: abort.signal,
    });
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
      // Ход уже идёт (вкладку перезагрузили или тот же чат открыт дважды):
      // это не ошибка, а повод прицепиться к живому потоку.
      if (data.live) {
        artChatDrop(box);
        artChatState.busy = false;
        artChatSetBusy(false);
        await artChatAttach();
        return;
      }
      throw new Error((data.error || {}).message || response.statusText || 'ответ не начался');
    }
    await artChatReadStream(response, box);
  } catch (error) {
    if (!abort.signal.aborted) {
      box.turn.classList.add('error');
      box.text = (box.text ? box.text + '\n\n' : '') + '[ошибка: ' + (error && error.message ? error.message : error) + ']';
      box.md.innerHTML = artChatMarkdown(box.text);
      box.typing.hidden = true;
      artChatNote('');
    }
  } finally {
    if (artChatState.controller === abort) artChatState.controller = null;
    box.typing.hidden = true;
    artChatSetBusy(false);
    input.focus();
  }
}

async function artChatStop() {
  if (!artChatState.chatId) return;
  try {
    await artApi('/panel/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ chatId: artChatState.chatId }),
    });
    artChatNote('Остановил');
  } catch (error) {
    artChatNote('Не остановилось: ' + (error && error.message ? error.message : error), true);
  }
}

/** После правки перечитываем и список, и открытый артефакт: файлы уже другие. */
async function artChatRefreshArtifact() {
  const name = artState.artifact;
  if (!name) return;
  try {
    await artLoadList();
    const data = await artApi('/panel/artifacts/api/read?artifact=' + encodeURIComponent(name));
    artRenderView(data);
  } catch (error) {
    artChatNote('Артефакт изменился, но панель не обновилась: ' + (error && error.message ? error.message : error), true);
  }
}

function artChatStart() {
  artEl('art-chat').addEventListener('click', artChatToggle);
  artEl('art-chat-close').addEventListener('click', artChatClose);
  artEl('art-chat-send').addEventListener('click', () => void artChatSend());
  artEl('art-chat-stop').addEventListener('click', () => void artChatStop());
  const input = artEl('art-chat-input');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void artChatSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!artEl('art-chat-panel').hidden) artChatClose();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', artChatStart);
else artChatStart();
