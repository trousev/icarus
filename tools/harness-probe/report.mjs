// HTML-стенд пробника: терминальная страница из реального прогона.
//
// Отдельный файл, чтобы probe.mjs не тащил вёрстку, а стенд можно было открыть
// без сети и снять скриншотом (.scratch/lib/shot.mjs). Никаких зависимостей:
// только экранирование и шаблон.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function formatMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} мс`;
  return `${(value / 1000).toFixed(2)} с`;
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—';
}

/** Короткая подпись события Икара для колонки «наше событие». */
function mappedSummary(events) {
  if (!events || events.length === 0) return '—';
  return events
    .map((event) => {
      switch (event.type) {
        case 'engine':
          return `engine · ${event.model} · ${event.tools?.length ?? 0} инстр.`;
        case 'text':
          return `text · ${JSON.stringify(event.text)}`;
        case 'thinking':
          return `thinking · ${event.text.length} симв.`;
        case 'step':
          return `step · ${event.step.tool} ${event.step.detail || ''}`.trim();
        case 'step-update':
          return `step-update · ${event.step.tool}`;
        case 'step-end':
          return `step-end · ${event.status} · ${event.result.length} симв.`;
        case 'done':
          return `done · ${formatMs(event.durationMs)} · ${formatNumber(event.usage?.output_tokens)} ток.`;
        case 'error':
          return `error · ${event.message}`;
        default:
          return event.type;
      }
    })
    .join(' | ')
    .slice(0, 180);
}

function commandLine(summary) {
  const args = summary.command ?? [];
  return args
    .map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))
    .join(' ')
    .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)=)\S+/g, '$1***');
}

function rowClass(events) {
  if (!events || events.length === 0) return 'muted';
  if (events.some((event) => event.type === 'error')) return 'bad';
  if (events.some((event) => event.type === 'done')) return 'good';
  if (events.some((event) => event.type === 'step' || event.type === 'step-end')) return 'tool';
  return '';
}

/**
 * Соседние строки одного типа без события — это шум (дельты размышлений,
 * счётчики токенов). Схлопываем в «×N», иначе лента закрывает полезное.
 */
/** Служебные строки Claude Code: в ленте они ничего не объясняют. */
const NOISE = /^system:(thinking_tokens|ui_invalidate|status)(?::|$)/;

function collapseRows(rows) {
  const out = [];
  for (const row of rows) {
    if (NOISE.test(row.rawType)) continue;
    const prev = out[out.length - 1];
    if (prev && row.events.length === 0 && prev.events.length === 0 && prev.rawType === row.rawType) {
      prev.count += 1;
      prev.lastMs = row.atMs;
      continue;
    }
    out.push({ ...row, count: 1, lastMs: row.atMs });
  }
  return out;
}

function timelineRows(rows) {
  // mapped — массив { atMs, rawType, events } по одному на строку потока.
  return rows
    .map((row) => {
      const index = row.index + 1;
      const events = row.events;
      const suffix = row.count > 1 ? ` <span class="muted">×${row.count}</span>` : '';
      return `<tr class="${rowClass(events)}">
        <td class="num">${index}</td>
        <td class="num">${formatMs(row.atMs)}</td>
        <td class="raw">${escapeHtml(row.rawType)}${suffix}</td>
        <td class="ours">${escapeHtml(mappedSummary(events))}</td>
      </tr>`;
    })
    .join('\n');
}

function noiseCount(rows) {
  return rows.filter((row) => NOISE.test(row.rawType)).length;
}


function stepRows(steps) {
  if (!steps || steps.length === 0) return '<p class="muted">инструменты не вызывались</p>';
  return `<table class="steps">
    <thead><tr><th>инструмент</th><th>что делал</th><th>итог</th></tr></thead>
    <tbody>${steps
      .map(
        (step) => `<tr>
          <td><span class="chip">${escapeHtml(step.label)}</span> ${escapeHtml(step.tool)}</td>
          <td class="raw">${escapeHtml(step.detail || '—')}</td>
          <td class="${step.status === 'error' ? 'bad' : 'good'}">${escapeHtml(step.status)}${step.result ? ` · ${escapeHtml(step.result.slice(0, 120))}` : ''}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function unmappedBlock(summary) {
  const unmapped = summary.unmappedTypes ?? {};
  const list = Object.entries(unmapped).filter(([, count]) => count > 0);
  if (list.length === 0 && summary.status === 'ok') {
    return '<p class="good">Все строки потока разобраны: протокол сошёлся.</p>';
  }
  const rows = list
    .map(([type, count]) => `<li><code>${escapeHtml(type)}</code> × ${count}</li>`)
    .join('');
  return `<p class="${summary.status === 'ok' ? 'muted' : 'bad'}">
      статус: <b>${escapeHtml(summary.status)}</b>${summary.error ? ` · ${escapeHtml(summary.error)}` : ''}
    </p>${rows ? `<ul class="plain">${rows}</ul>` : ''}`;
}

const COMPARISON = [
  ['старт хода', 'agent_start', 'system:init', 'engine (новое)'],
  ['текст', 'message_update · text_delta', 'stream_event · content_block_delta text_delta', 'text'],
  ['шаг инструмента', 'tool_execution_start', 'stream_event · content_block_start tool_use', 'step'],
  ['прогресс инструмента', 'tool_execution_update (есть)', 'нет (только input_json_delta)', 'step-update'],
  ['итог инструмента', 'tool_execution_end', 'user · tool_result', 'step-end'],
  ['конец хода', 'agent_settled', 'result subtype=success', 'done'],
  ['ошибка', 'error / extension_error', 'result is_error=true', 'error'],
  ['размышления', 'thinking_delta', 'thinking_delta (если включены)', 'thinking'],
];

function comparisonTable() {
  return `<table class="compare">
    <thead><tr><th>что</th><th>pi (сейчас)</th><th>Claude Code (stream-json)</th><th>наше событие</th></tr></thead>
    <tbody>${COMPARISON.map(
      ([what, pi, claude, ours]) =>
        `<tr><td>${escapeHtml(what)}</td><td class="raw">${escapeHtml(pi)}</td><td class="raw">${escapeHtml(claude)}</td><td><span class="chip">${escapeHtml(ours)}</span></td></tr>`,
    ).join('')}</tbody>
  </table>`;
}

/**
 * Собирает страницу стенда.
 * @param {{summary: object, rows: Array<{index:number,atMs:number,rawType:string,events:object[]}>}} data
 */
export function renderReport({ summary, rows }) {
  const ok = summary.status === 'ok';
  const verdict = ok ? 'ПРОТОКОЛ СХОДИТСЯ' : `ПРОТОКОЛ НЕ СОШЁЛСЯ: ${summary.status.toUpperCase()}`;
  const usage = summary.result?.usage ?? {};
  const engineInfo = summary.engineInfo ?? {};
  const tools = engineInfo.tools ?? [];
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>icarus · пробник второго движка · ${escapeHtml(summary.model)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f14; --panel:#111820; --line:#1e2a36; --text:#d7e2ea; --dim:#7d8b98;
          --green:#5dd39e; --amber:#f2c14e; --red:#ff6b6b; --blue:#7cc4ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .wrap { max-width:1320px; margin:0 auto; padding:28px 32px 48px; }
  header { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line); padding-bottom:14px; }
  header h1 { font-size:19px; margin:0; font-weight:600; letter-spacing:.02em; }
  header .sub { color:var(--dim); }
  .badge { margin-left:auto; border:1px solid var(--green); color:var(--green); border-radius:999px; padding:4px 12px; font-size:12px; }
  .badge.bad { border-color:var(--red); color:var(--red); }
  .grid { display:grid; grid-template-columns: 1.35fr 1fr; gap:18px; margin-top:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px 18px; }
  .card h2 { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--dim); margin:0 0 12px; }
  .kv { display:grid; grid-template-columns: 170px 1fr; gap:6px 14px; }
  .kv dt { color:var(--dim); }
  .kv dd { margin:0; }
  .cmd { background:#070a0e; border:1px solid var(--line); border-radius:6px; padding:10px 12px; color:var(--blue); overflow-wrap:anywhere; }
  .prompt { color:var(--amber); }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; color:var(--dim); font-weight:500; font-size:12px; border-bottom:1px solid var(--line); padding:6px 8px; }
  td { border-bottom:1px solid #16202a; padding:6px 8px; vertical-align:top; }
  td.num { color:var(--dim); width:74px; white-space:nowrap; }
  td.raw { color:var(--blue); }
  tr.good td { background:rgba(93,211,158,.05); }
  tr.bad td { background:rgba(255,107,107,.07); }
  tr.tool td.ours { color:var(--amber); }
  tr.muted { opacity:.62; }
  .good { color:var(--green); } .bad { color:var(--red); } .muted { color:var(--dim); }
  .chip { display:inline-block; border:1px solid var(--line); border-radius:4px; padding:0 6px; color:var(--green); font-size:12px; }
  .steps td { font-size:13px; }
  .plain { margin:6px 0 0; padding-left:18px; }
  section { margin-top:18px; }
  section h2 { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--dim); margin:0 0 10px; }
  .tools { color:var(--dim); font-size:12px; overflow-wrap:anywhere; }
  .footer { margin-top:22px; color:var(--dim); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
  .compare td { font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>icarus · пробник второго движка</h1>
    <span class="sub">Claude Code headless → события хода Икара</span>
    <span class="badge ${ok ? '' : 'bad'}">${escapeHtml(verdict)}</span>
  </header>

  <div class="grid">
    <div class="card">
      <h2>прогон</h2>
      <dl class="kv">
        <dt>движок</dt><dd>${escapeHtml(summary.engine)} · ${escapeHtml(summary.claudeVersion ?? 'версия неизвестна')}</dd>
        <dt>модель</dt><dd>${escapeHtml(summary.model)}</dd>
        <dt>эндпоинт</dt><dd>${escapeHtml(summary.baseUrl)}</dd>
        <dt>изоляция</dt><dd>${escapeHtml(summary.isolation ?? '—')}</dd>
        <dt>ход</dt><dd>${formatMs(summary.wallMs)} · первый event ${formatMs(summary.firstEventMs)} · result ${formatMs(summary.resultMs)}</dd>
        <dt>строк потока</dt><dd>${summary.rawEvents} → событий Икара ${summary.mappedEvents}</dd>
        <dt>инструменты</dt><dd>${tools.length} доступно${summary.allowedTools ? ` · разрешено: ${escapeHtml(summary.allowedTools)}` : ''}</dd>
      </dl>
      <p class="tools">${escapeHtml(tools.slice(0, 18).join(', '))}${tools.length > 18 ? ' …' : ''}</p>
    </div>
    <div class="card">
      <h2>команда</h2>
      <p class="cmd">${escapeHtml(commandLine(summary))}</p>
      <p class="prompt">prompt: ${escapeHtml(summary.prompt)}</p>
      <p class="muted">ключ берётся из окружения и в стенд не попадает; HOME прогона изолирован, чтобы чужие ~/.claude/plugins не влияли на результат.</p>
    </div>
  </div>

  <section class="card">
    <h2>ответ и расход</h2>
    <dl class="kv">
      <dt>текст ответа</dt><dd class="good">${escapeHtml(summary.result?.text ?? '—')}</dd>
      <dt>токены</dt><dd>вход ${formatNumber(usage.input_tokens)} · выход ${formatNumber(usage.output_tokens)} · кэш ${formatNumber(usage.cache_read_input_tokens)}</dd>
      <dt>ходов модели</dt><dd>${formatNumber(summary.result?.numTurns)}</dd>
      <dt>цена</dt><dd>${typeof summary.result?.costUsd === 'number' ? `$${summary.result.costUsd.toFixed(4)} · считает Claude Code по прайсу Anthropic, для DeepSeek это не наши деньги` : '—'}</dd>
      <dt>шаги</dt><dd>${stepRows(summary.result?.steps)}</dd>
    </dl>
  </section>

  <section class="card">
    <h2>лента событий · что пришло и во что превратилось</h2>
    <table>
      <thead><tr><th>#</th><th>t</th><th>строка Claude Code</th><th>наше событие</th></tr></thead>
      <tbody>${timelineRows(collapseRows(rows))}</tbody>
    </table>
    <p class="muted" style="margin:10px 0 0">служебных строк (thinking_tokens, status, ui_invalidate) не показано: ${noiseCount(rows)}; соседние строки одного типа схлопнуты в «×N». Полностью — raw.jsonl и turn.jsonl.</p>
  </section>

  <section class="card">
    <h2>чего не хватает протоколу</h2>
    ${unmappedBlock(summary)}
  </section>

  <section class="card">
    <h2>сопоставление протоколов</h2>
    ${comparisonTable()}
  </section>

  <p class="footer">Стенд собран из реального вывода probe.mjs: строки потока и тайминги не нарисованы. Полные данные — summary.json и raw.jsonl рядом со стендом.</p>
</div>
</body>
</html>
`;
}
