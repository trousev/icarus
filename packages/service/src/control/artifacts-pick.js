// Выбор элемента в предпросмотре артефакта.
//
// Сервер вставляет этот скрипт в HTML-артефакт при `?pick=1` — только в
// предпросмотре панели, файл на диске не меняется. Скрипт живёт в песочнице
// iframe (без allow-same-origin) и разговаривает с панелью через postMessage:
// клик по элементу отправляет адрес и цитату, правка текста — новый текст.
//
// Адреса уже лежат в разметке (`data-icarus-ref`), поэтому здесь их не считаем:
// один источник правды — исходник.
(() => {
  const ATTR = 'data-icarus-ref';
  const SOURCE = 'icarus-artifacts-pick';
  const Z = '2147483647';

  const style = document.createElement('style');
  style.textContent = [
    '.icarus-pick-hover{position:fixed;pointer-events:none;border:2px solid #7aa2f7;',
    'background:rgba(122,162,247,.12);border-radius:3px;z-index:' + Z + ';display:none}',
    '.icarus-pick-selected{position:fixed;pointer-events:none;border:2px solid #e0af68;',
    'box-shadow:0 0 0 2px rgba(224,175,104,.25);border-radius:3px;z-index:' + Z + ';display:none}',
    '.icarus-pick-ui{position:fixed;z-index:' + Z + ';font:13px/1.4 ui-sans-serif,system-ui,sans-serif;',
    'color:#e6e8ec;background:#1b1f28;border:1px solid #39404f;border-radius:9px;',
    'box-shadow:0 12px 30px rgba(0,0,0,.45);padding:8px;display:none;max-width:420px}',
    '.icarus-pick-ui code{display:block;font:12px/1.4 ui-monospace,monospace;color:#9ecbff;',
    'margin:0 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.icarus-pick-ui .icarus-pick-quote{display:block;color:#aab2c0;margin:0 0 8px;',
    'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.icarus-pick-ui .icarus-pick-row{display:flex;gap:6px;align-items:center}',
    '.icarus-pick-ui button{font:inherit;color:#e6e8ec;background:#262b36;border:1px solid #39404f;',
    'border-radius:6px;padding:4px 9px;cursor:pointer}',
    '.icarus-pick-ui button:hover{background:#303646}',
    '.icarus-pick-ui button.primary{background:#3d59a1;border-color:#4a6bc0}',
    '.icarus-pick-ui button:disabled{opacity:.45;cursor:default}',
    '.icarus-pick-ui .icarus-pick-close{margin-left:auto;padding:2px 7px}',
    '.icarus-pick-toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:' + Z + ';',
    'font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#0f1116;background:#e0af68;',
    'border-radius:8px;padding:8px 14px;box-shadow:0 8px 22px rgba(0,0,0,.4);display:none}',
    '.icarus-pick-editing{outline:2px dashed #e0af68 !important;outline-offset:2px}',
  ].join('');

  const hoverBox = document.createElement('div');
  hoverBox.className = 'icarus-pick-hover';
  const selectedBox = document.createElement('div');
  selectedBox.className = 'icarus-pick-selected';
  const toastBox = document.createElement('div');
  toastBox.className = 'icarus-pick-toast';

  const toolbar = document.createElement('div');
  toolbar.className = 'icarus-pick-ui';
  const refLine = document.createElement('code');
  const quoteLine = document.createElement('span');
  quoteLine.className = 'icarus-pick-quote';
  const row = document.createElement('div');
  row.className = 'icarus-pick-row';
  const chatButton = document.createElement('button');
  chatButton.type = 'button';
  chatButton.className = 'primary';
  chatButton.textContent = '→ в чат';
  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = '✎ текст';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icarus-pick-close';
  closeButton.textContent = '×';
  closeButton.title = 'Снять выбор';
  row.append(chatButton, editButton, closeButton);
  toolbar.append(refLine, quoteLine, row);

  let selected = null;
  let hovered = null;
  let editing = null;
  let toastTimer = null;

  function mount() {
    const parent = document.body || document.documentElement;
    if (!parent) return;
    parent.append(style, hoverBox, selectedBox, toolbar, toastBox);
  }

  function toast(message) {
    toastBox.textContent = message;
    toastBox.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBox.style.display = 'none';
    }, 2600);
  }

  function post(payload) {
    try {
      window.parent.postMessage({ source: SOURCE, ...payload }, '*');
    } catch {
      /* родитель исчез — показывать это человеку незачем */
    }
  }

  function clamp(text, limit) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? value.slice(0, limit - 1).trimEnd() + '…' : value;
  }

  function closest(node) {
    let element = node instanceof Element ? node : node && node.parentElement;
    while (element) {
      if (element.hasAttribute && element.hasAttribute(ATTR)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function describe(element) {
    const tag = String(element.tagName || '').toLowerCase();
    const quote =
      clamp(element.textContent, 120) ||
      clamp(element.getAttribute('alt'), 120) ||
      clamp(element.getAttribute('aria-label'), 120);
    return { ref: element.getAttribute(ATTR), tag, quote };
  }

  function place(box, element) {
    const rect = element.getBoundingClientRect();
    box.style.left = Math.max(0, rect.left) + 'px';
    box.style.top = Math.max(0, rect.top) + 'px';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';
    box.style.display = 'block';
  }

  function placeToolbar() {
    if (!selected) return;
    const rect = selected.getBoundingClientRect();
    const width = toolbar.offsetWidth || 280;
    const height = toolbar.offsetHeight || 90;
    let left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
    toolbar.style.display = 'block';
  }

  function refresh() {
    if (hovered && hovered !== selected) place(hoverBox, hovered);
    else hoverBox.style.display = 'none';
    if (selected) {
      place(selectedBox, selected);
      if (!editing) placeToolbar();
    } else {
      selectedBox.style.display = 'none';
      toolbar.style.display = 'none';
    }
  }

  function select(element) {
    selected = element;
    const info = describe(element);
    refLine.textContent = info.ref;
    refLine.title = info.ref;
    quoteLine.textContent = info.quote ? '«' + info.quote + '»' : '<' + info.tag + '>';
    editButton.disabled = element.children.length > 0 || !info.quote;
    editButton.title = editButton.disabled
      ? 'У этого элемента есть вложенные блоки — правь через чат'
      : 'Править текст прямо здесь';
    toolbar.style.display = 'block';
    refresh();
  }

  function clearSelection() {
    if (editing) cancelEdit();
    selected = null;
    hoverBox.style.display = 'none';
    selectedBox.style.display = 'none';
    toolbar.style.display = 'none';
  }

  function startEdit() {
    if (!selected || selected.children.length > 0) return;
    editing = { element: selected, html: selected.innerHTML, ref: selected.getAttribute(ATTR) };
    selected.setAttribute('contenteditable', 'true');
    selected.classList.add('icarus-pick-editing');
    selected.focus();
    const range = document.createRange();
    range.selectNodeContents(selected);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    toolbar.style.display = 'none';
    toast('Enter — сохранить, Esc — отменить');
  }

  function endEdit() {
    if (!editing) return;
    const { element, ref } = editing;
    editing = null;
    element.removeAttribute('contenteditable');
    element.classList.remove('icarus-pick-editing');
    const text = String(element.textContent || '').trim();
    if (!text) {
      cancelEdit();
      toast('Пустой текст не сохраняем — вернул как было');
      return;
    }
    post({ type: 'text', ref, text, quote: clamp(text, 120) });
    toast('Сохраняю…');
  }

  function cancelEdit() {
    if (!editing) return;
    const { element, html } = editing;
    editing = null;
    element.innerHTML = html;
    element.removeAttribute('contenteditable');
    element.classList.remove('icarus-pick-editing');
    if (selected) refresh();
  }

  function restoreAfterError() {
    if (editing) cancelEdit();
    toast('Панель не сохранила правку — текст вернул');
  }

  function bind() {
    document.addEventListener(
      'mouseover',
      (event) => {
        if (toolbar.contains(event.target)) return;
        hovered = closest(event.target);
        refresh();
      },
      true,
    );
    document.addEventListener(
      'mouseleave',
      () => {
        hovered = null;
        refresh();
      },
      true,
    );
    document.addEventListener(
      'click',
      (event) => {
        if (toolbar.contains(event.target)) return;
        const element = closest(event.target);
        // В режиме выбора ссылки не должны уводить со страницы: клик — это выбор.
        event.preventDefault();
        event.stopPropagation();
        if (!element) {
          hovered = null;
          refresh();
          toast('У этого элемента нет адреса — нажми «Разметить» в панели');
          return;
        }
        select(element);
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (editing) {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            endEdit();
            return;
          }
        }
        if (event.key === 'Escape') clearSelection();
      },
      true,
    );
    document.addEventListener(
      'blur',
      () => {
        if (editing) endEdit();
      },
      true,
    );
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);

    chatButton.addEventListener('click', () => {
      if (!selected) return;
      post({ type: 'ref', ...describe(selected) });
      toolbar.style.display = 'none';
    });
    editButton.addEventListener('click', startEdit);
    closeButton.addEventListener('click', clearSelection);

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const data = event.data || {};
      if (data.source !== 'icarus-artifacts-panel') return;
      if (data.type === 'restore') restoreAfterError();
      if (data.type === 'toast' && typeof data.message === 'string') toast(data.message);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mount();
      bind();
    });
  } else {
    mount();
    bind();
  }
})();
