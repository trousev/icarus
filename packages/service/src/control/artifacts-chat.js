// Чат правки артефакта в боковой панели раздела «Артефакты».
//
// Это тот же разговор, что и в обычном чате: сообщения уходят в /panel/api/chat/send,
// ответ приходит NDJSON-потоком. Отличие одно — сервер помечает разговор артефактом,
// и pi работает в папке /artifacts/<slug>, а не в workspace.
/* global artifactMarkdown, artEl, artApi, artEsc, artStamp, artState, artSetStatus, artHideHistory, artLoadList, artRenderView */

const artChatState = {
  chatId: null,
  busy: false,
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

function artChatUser(text) {
  const turn = document.createElement('div');
  turn.className = 'art-chat-turn user';
  const who = document.createElement('div');
  who.className = 'art-chat-who';
  who.textContent = 'ТЫ · ' + artStamp(new Date().toISOString());
  const bubble = document.createElement('div');
  bubble.className = 'art-chat-bubble';
  bubble.textContent = text;
  turn.append(who, bubble);
  artChatLog().append(turn);
  artChatScroll(true);
  return turn;
}

function artChatAssistant() {
  const turn = document.createElement('div');
  turn.className = 'art-chat-turn assistant';
  turn.innerHTML =
    '<div class="art-chat-who">ICARUS · ' + artStamp(new Date().toISOString()) + '</div>' +
    '<div class="art-chat-steps" hidden></div>' +
    '<div class="art-chat-bubble"></div>' +
    '<div class="art-chat-typing">Икар думает…</div>';
  artChatLog().append(turn);
  artChatScroll(true);
  return {
    turn,
    steps: turn.querySelector('.art-chat-steps'),
    bubble: turn.querySelector('.art-chat-bubble'),
    typing: turn.querySelector('.art-chat-typing'),
    text: '',
    trace: [],
  };
}

function artChatSteps(box) {
  box.steps.hidden = box.trace.length === 0;
  box.steps.innerHTML = box.trace
    .map((step) => {
      const mark = step.status === 'error' ? ' bad' : step.status === 'ok' ? ' done' : '';
      const label = step.label || step.tool || 'шаг';
      const detail = step.detail ? ' · ' + step.detail : '';
      return '<span class="art-chat-step' + mark + '"><b>' + artEsc(label) + '</b>' + artEsc(detail) + '</span>';
    })
    .join('');
}

function artChatRender(box) {
  box.bubble.innerHTML = artChatMarkdown(box.text);
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
    box.trace.push(event.step || {});
    artChatRender(box);
    return;
  }
  if (event.type === 'step-update') {
    const index = box.trace.findIndex((step) => step.id === event.id);
    if (index !== -1) box.trace[index] = event.step || box.trace[index];
    artChatRender(box);
    return;
  }
  if (event.type === 'step-end') {
    const step = box.trace.find((item) => item.id === event.id);
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
    card.className = 'art-chat-note bad';
    card.textContent = 'Доступ к MCP «' + (event.server || 'MCP') + '» истёк. ';
    const link = document.createElement('a');
    link.href = String(event.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Переподключить';
    card.append(link);
    box.turn.append(card);
    artChatScroll();
    return;
  }
  if (event.type === 'done') {
    artChatState.busy = false;
    artChatSetBusy(false);
    box.typing.hidden = true;
    if (!box.text.trim()) {
      box.text = box.trace.length ? 'Готово.' : '(ответ пустой)';
      box.bubble.innerHTML = artChatMarkdown(box.text);
    }
    artChatNote('Готово · артефакт обновлён');
    artChatState.liveBox = null;
    artChatRefreshArtifact();
    return;
  }
  if (event.type === 'error') {
    box.turn.classList.add('error');
    box.text = (box.text ? box.text + '\n\n' : '') + '[ошибка: ' + (event.message || 'ответ не пришёл') + ']';
    box.bubble.innerHTML = artChatMarkdown(box.text);
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
    '<div class="art-empty"><b>Скажи, что поправить</b><span>Икар изменит файлы прямо в папке артефакта: «добавь заголовок», «сделай таблицу», «поменяй цвет».</span></div>';
}

function artChatRenderHistory(messages) {
  artChatLog().innerHTML = '';
  if (!messages.length) {
    artChatClear();
    return;
  }
  for (const message of messages) {
    if (message.role === 'user') {
      if (String(message.text || '').trim()) artChatUser(message.text);
      continue;
    }
    const box = artChatAssistant();
    box.typing.hidden = true;
    box.text = String(message.text || '');
    box.trace = Array.isArray(message.trace) ? message.trace : [];
    box.bubble.innerHTML = artChatMarkdown(box.text || (box.trace.length ? 'Готово.' : ''));
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

async function artChatSend() {
  const input = artEl('art-chat-input');
  const text = String(input.value || '').trim();
  if (!text || artChatState.busy) return;
  if (!artChatState.chatId) {
    artChatNote('Разговор ещё не открылся', true);
    return;
  }

  const chatId = artChatState.chatId;
  input.value = '';
  input.style.height = 'auto';
  const empty = artChatLog().querySelector('.art-empty');
  if (empty) empty.remove();
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
      box.bubble.innerHTML = artChatMarkdown(box.text);
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
