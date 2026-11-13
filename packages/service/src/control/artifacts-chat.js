// Artifact editing chat in the side panel of the "Artifacts" section.
//
// It is the same conversation as in the regular chat: messages go to /panel/api/chat/send,
// the reply comes as an NDJSON stream. The only difference is that the server tags the
// conversation with an artifact, and pi works in the /artifacts/<slug> folder, not in the workspace.
//
// Slash commands are shared with the main chat: first we ask the server
// (/panel/api/chat/command), and only its refusal sends the line to pi. Otherwise
// /clear would go to the model as text and it would cheerfully lie that the context was cleared.
/* global artifactMarkdown, artEl, artApi, artEsc, artStamp, artState, artSetStatus, artHideHistory, artLoadList, artRefresh */

const artChatState = {
  chatId: null,
  busy: false,
  commandBusy: false,
  controller: null,
  historyToken: 0,
  liveBox: null,
  // Reference to an element from the preview: it goes into the message along with the text.
  ref: null,
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
      /* markup must not crash the chat */
    }
  }
  return '<p>' + artEsc(source).replace(/\n/g, '<br>') + '</p>';
}

/** Human turn: the same bubble as in the main chat, without a "you" label. */
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
 * AI turn. The markup is like addAssistant in chat-client.js: avatar, label,
 * trace card, reply in .md (no bubble) and a "thinking" line.
 * There is no empty reply bubble here: .md is a regular text block.
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

/** Element reference: the preview sets it, and the human then adds the task. */
function artChatSetRef(selection) {
  if (!selection || !selection.ref) return;
  artChatState.ref = {
    ref: selection.ref,
    quote: selection.quote || '',
    tag: selection.tag || '',
  };
  artEl('art-chat-ref').hidden = false;
  artEl('art-chat-ref-path').textContent = selection.ref;
  artEl('art-chat-ref-path').title = selection.ref;
  artEl('art-chat-ref-quote').textContent = selection.quote ? '«' + selection.quote + '»' : '';
  artEl('art-chat-input').placeholder = 'Что сделать с этим элементом?';
}

/** "Remove from reference": the typed text stays, the address leaves the message. */
function artChatClearRef() {
  artChatState.ref = null;
  const chip = artEl('art-chat-ref');
  if (chip) chip.hidden = true;
  const input = artEl('art-chat-input');
  if (input) input.placeholder = 'Что поправить в артефакте?';
}

/**
 * Message text with a reference: quote in a blockquote, address in `code`. The model
 * sees that this is `data-icarus-ref` in the source and edits exactly this block,
 * not a similar neighboring one.
 */
function artChatCompose(text, ref) {
  const message = String(text || '').trim();
  if (!ref || !ref.ref) return message;
  const quote = String(ref.quote || '').replace(/\s+/g, ' ').trim();
  const line =
    '> Элемент артефакта `' + ref.ref + '` (data-icarus-ref в исходнике)' +
    (quote ? ' — «' + quote + '»' : '');
  return line + '\n\n' + message;
}

/** Click on an element: show the reference in the chat and open it if closed. */
async function artChatAttachRef(selection) {
  artChatSetRef(selection);
  if (artEl('art-chat-panel').hidden) await artChatOpen();
  else artEl('art-chat-input').focus();
}

// The script is a classic one: the functions are global anyway. Explicit names are needed
// by the section client (it loads earlier) and by tests: this is the only entry point of the reference into the chat.
window.artChatCompose = artChatCompose;
window.artChatAttachRef = artChatAttachRef;

/** The "Tell me what to fix" placeholder goes away as soon as a turn appears in the feed. */
function artChatDropEmpty() {
  const empty = artChatLog().querySelector('.art-empty');
  if (empty) empty.remove();
}

/**
 * Command result is a card with its name, like in the main chat. It does not go
 * into history: it is not a model reply, and it will not be there after a reload.
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

/** Context boundary: /clear starts a new session but does not hide the old feed. */
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

/** Trace is a card bubble, like in the main chat: the steps are visible right away. */
function artChatSteps(box) {
  if (!box.steps.length) {
    box.slot.innerHTML = '';
    return;
  }
  // A redraw must not collapse the card that a person has already expanded
  // or collapsed: every delta text arrives here anew.
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
          /* one broken line does not break the reply */
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
  artChatClearRef();
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

/** Command name as the server parses it: up to the space and without "/". */
function artChatCommandName(text) {
  const match = /^\/([a-zA-Z0-9_]+)/.exec(String(text || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * A slash line: first we ask the server whether it is its command.
 * `/clear`, `/compact`, `/stats` are chat commands and have their own route; `/skill:name`
 * and pi templates are not handled by the server and go as a regular turn. false means
 * "send to the conversation as text".
 */
async function artChatRunCommand(text) {
  if (!artChatState.chatId) return false;
  // We do not start a second command on top of the first: the reply would go to the wrong turn.
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
    // While the command was running, the panel could be closed or another artifact opened:
    // the reply must not land in the wrong feed.
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

  // We parse the command before the busy check: /stop and /stats are needed even during
  // a turn. The server itself will say whether it is its command; others will go to pi as text.
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
  const message = artChatCompose(text, artChatState.ref);
  input.value = '';
  input.style.height = 'auto';
  artChatDropEmpty();
  artChatUser(message);
  // The reference is one-time: once it has gone with the message, we remove the chip, otherwise
  // the next turn would silently go about the same element.
  artChatClearRef();
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
      body: JSON.stringify({ chatId, text: message }),
      signal: abort.signal,
    });
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
      // A turn is already running (the tab was reloaded or the same chat is open twice):
      // this is not an error but a reason to attach to the live stream.
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

/** After an edit we re-read both the list and the open artifact: the files are different now. */
async function artChatRefreshArtifact() {
  const name = artState.artifact;
  if (!name) return;
  try {
    await artLoadList();
    await artRefresh();
  } catch (error) {
    artChatNote('Артефакт изменился, но панель не обновилась: ' + (error && error.message ? error.message : error), true);
  }
}

function artChatStart() {
  artEl('art-chat').addEventListener('click', artChatToggle);
  artEl('art-chat-close').addEventListener('click', artChatClose);
  artEl('art-chat-send').addEventListener('click', () => void artChatSend());
  artEl('art-chat-ref-clear').addEventListener('click', artChatClearRef);
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
