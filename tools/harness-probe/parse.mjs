// Перевод потока Claude Code (stream-json) в события хода Икара.
//
// Панель не знает, кто отвечает: chat.ts слушает pi и складывает в hub события
// text / step / step-update / step-end / notice / done (см. control/chat-live.ts).
// Здесь ровно один слой перевода — из строк Claude Code в эти же события, чтобы
// второй движок не потребовал второго рендерера.
//
// Файл ничего не запускает и в сеть не ходит: его гоняют тесты на сохранённых
// фикстурах (packages/service/test/harness-probe.test.ts) и пробник probe.mjs.
//
// Главное, что не сходится с pi (подробно — specs/harness-choice.md):
//   * у pi есть tool_execution_update (прогресс bash), у Claude Code его нет;
//   * ход заканчивается result, а не agent_settled;
//   * ошибка приходит result c is_error/subtype, а не событием error;
//   * system:init — единственное место, где видно список инструментов и модель.

/** Имя движка в наших событиях: по нему история отличает, кто отвечал. */
export const ENGINE = 'claude-code';

/** Имена инструментов Claude Code → имена pi: панель и трассировка ждут строчные. */
const TOOL_NAMES = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'find',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  Task: 'subagent',
  NotebookEdit: 'notebook_edit',
};

/** Ярлыки шагов: в сервисе это traceLabel из control/chat.ts, здесь короткая копия. */
const TOOL_LABELS = {
  bash: 'ТЕРМИНАЛ',
  read: 'ЧТЕНИЕ',
  write: 'ПРАВКА',
  edit: 'ПРАВКА',
  find: 'ЧТЕНИЕ',
  grep: 'ЧТЕНИЕ',
  web_fetch: 'СТРАНИЦА',
  web_search: 'ПОИСК',
  subagent: 'СУБАГЕНТЫ',
};

const DETAIL_LIMIT = 140;
const RESULT_LIMIT = 500;

/** Строка под ярлыком: путь, команда, запрос. Как traceDetail, но без затей. */
function detailOf(tool, input) {
  const args = input && typeof input === 'object' ? input : {};
  const first = (value) => (typeof value === 'string' ? (value.split('\n')[0] ?? '') : '');
  // У Claude Code имена полей свои: file_path вместо path, pattern вместо query.
  const direct =
    first(args.file_path) ||
    first(args.path) ||
    first(args.command) ||
    first(args.pattern) ||
    first(args.query) ||
    first(args.url) ||
    first(args.description) ||
    first(args.prompt);
  if (direct) return direct.slice(0, DETAIL_LIMIT);
  for (const value of Object.values(args)) {
    const text = first(value);
    if (text) return text.slice(0, DETAIL_LIMIT);
  }
  return '';
}

/** Текст результата инструмента: строка, блоки content или JSON-строка с блоками. */
export function resultTextOf(content) {
  if (typeof content === 'string') {
    const text = content.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        return resultTextOf(JSON.parse(text));
      } catch {
        // это просто текст, а не JSON с блоками
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function stepFor(toolName, input, id) {
  const tool = TOOL_NAMES[toolName] ?? String(toolName ?? 'tool').toLowerCase();
  return {
    id,
    tool,
    label: TOOL_LABELS[tool] ?? 'ТУЛ',
    detail: detailOf(tool, input),
    status: 'running',
  };
}

/**
 * Состояние одного хода: копит текст, шаги и служебные флаги.
 *
 * push(event) отдаёт массив событий Икара — их можно слать в hub по одному,
 * не дожидаясь конца хода. finish() добивает ход ошибкой, если result так и
 * не пришёл (оборванный поток, таймаут): молчаливое «наверное, всё» хуже.
 */
export function createTurnStream(options = {}) {
  const includeThinking = options.includeThinking === true;
  const steps = new Map();
  const emitted = new Map();
  const textMessageIds = new Set();
  const thinkingMessageIds = new Set();
  const counts = Object.create(null);
  const unknown = Object.create(null);
  let engine = null;
  let done = false;

  const stat = (key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  /** Один и тот же шаг приходит дважды (content_block_stop и assistant):
   * второй раз не шлём, иначе панель дважды перерисует строку. */
  function stepUpdate(step) {
    const snapshot = JSON.stringify(step);
    if (emitted.get(step.id) === snapshot) return null;
    emitted.set(step.id, snapshot);
    return { type: 'step-update', id: step.id, step: { ...step } };
  }

  function push(event) {
    if (!event || typeof event !== 'object') return [];
    const type = String(event.type ?? '');
    stat(type);
    if (type === 'system') return systemEvent(event);
    if (type === 'stream_event') return streamEvent(event);
    if (type === 'assistant') return assistantEvent(event);
    if (type === 'user') return userEvent(event);
    if (type === 'result') return resultEvent(event);
    // Неизвестное не выдумываем: probe.mjs посчитает unmapped и честно напишет,
    // что протокол не сошёлся. Панель такие события тоже игнорирует.
    stat('unmapped');
    unknown[type || 'без типа'] = (unknown[type || 'без типа'] ?? 0) + 1;
    return [];
  }

  function systemEvent(event) {
    if (event.subtype !== 'init') return [];
    engine = {
      engine: ENGINE,
      model: typeof event.model === 'string' ? event.model : null,
      sessionId: typeof event.session_id === 'string' ? event.session_id : null,
      cwd: typeof event.cwd === 'string' ? event.cwd : null,
      tools: Array.isArray(event.tools) ? event.tools : [],
      mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
      permissionMode: typeof event.permissionMode === 'string' ? event.permissionMode : null,
    };
    return [{ type: 'engine', ...engine }];
  }

  function streamEvent(event) {
    const inner = event.event;
    if (!inner || typeof inner !== 'object') return [];
    const messageId = typeof event.api_message_id === 'string' ? event.api_message_id : '';

    switch (inner.type) {
      case 'message_start': {
        // Счётчик токенов из message_start нужен OpenAI-фасаду; в панель не едет.
        return [];
      }
      case 'content_block_start': {
        const block = inner.content_block;
        if (block?.type !== 'tool_use') return [];
        const id = String(block.id ?? `tool-${inner.index}`);
        const step = stepFor(block.name, {}, id);
        steps.set(id, step);
        emitted.set(id, JSON.stringify(step));
        // Шаг показываем сразу, как pi на tool_execution_start: человек видит,
        // что агент начал что-то делать, ещё пока аргументы досылаются.
        return [{ type: 'step', step: { ...step } }];
      }
      case 'content_block_delta': {
        const delta = inner.delta;
        if (!delta || typeof delta !== 'object') return [];
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          if (messageId) textMessageIds.add(messageId);
          return [{ type: 'text', text: delta.text }];
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          if (messageId) thinkingMessageIds.add(messageId);
          return includeThinking ? [{ type: 'thinking', text: delta.thinking }] : [];
        }
        // input_json_delta — это куски аргументов инструмента. Подпись шага
        // обновим, когда аргументы доедут целиком в assistant: собирать JSON из
        // дельт ради строки под ярлыком незачем.
        return [];
      }
      case 'content_block_stop':
        return [];
      default:
        return [];
    }
  }

  function assistantEvent(event) {
    const message = event.message;
    if (!message || !Array.isArray(message.content)) return [];
    const messageId = typeof message.id === 'string' ? message.id : '';
    const out = [];
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        const id = String(block.id ?? 'tool');
        const known = steps.get(id);
        const step = known ?? stepFor(block.name, block.input, id);
        step.detail = detailOf(step.tool, block.input);
        step.status = known?.status ?? 'running';
        steps.set(id, step);
        if (known) {
          const update = stepUpdate(step);
          if (update) out.push(update);
        } else {
          emitted.set(id, JSON.stringify(step));
          out.push({ type: 'step', step: { ...step } });
        }
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        // С partial messages текст уже ушёл дельтами; без них assistant —
        // единственное место, где он есть.
        if (!(messageId && textMessageIds.has(messageId))) out.push({ type: 'text', text: block.text });
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        if (includeThinking && !(messageId && thinkingMessageIds.has(messageId))) {
          out.push({ type: 'thinking', text: block.thinking });
        }
      }
    }
    return out;
  }

  function userEvent(event) {
    const message = event.message;
    if (!message || !Array.isArray(message.content)) return [];
    const out = [];
    for (const block of message.content) {
      if (!block || block.type !== 'tool_result') continue;
      const id = String(block.tool_use_id ?? '');
      const step = steps.get(id);
      if (step) {
        step.status = block.is_error === true ? 'error' : 'ok';
        const text = clip(resultTextOf(block.content), RESULT_LIMIT);
        if (text) step.result = text;
      }
      if (step) emitted.set(id, JSON.stringify(step));
      out.push({
        type: 'step-end',
        id,
        status: block.is_error === true ? 'error' : 'ok',
        result: clip(resultTextOf(block.content), RESULT_LIMIT),
      });
    }
    return out;
  }

  function resultEvent(event) {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    const failed = event.is_error === true || (subtype !== '' && subtype !== 'success');
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    if (failed) {
      // У pi ошибка — отдельное событие; у Claude Code она приезжает финальным
      // result. Приводим к нашему error, иначе панель покажет пустой ход.
      done = true;
      return [
        {
          type: 'error',
          message: String(event.result ?? subtype ?? 'Claude Code завершил ход с ошибкой'),
          engine: ENGINE,
          subtype,
          permissionDenials: denials,
        },
      ];
    }
    done = true;
    return [
      {
        type: 'done',
        engine: ENGINE,
        result: typeof event.result === 'string' ? event.result : '',
        sessionId: typeof event.session_id === 'string' ? event.session_id : null,
        usage: event.usage ?? null,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
        permissionDenials: denials,
        steps: [...steps.values()].map((step) => ({ ...step })),
      },
    ];
  }

  /** Ход кончился, а result не пришёл: поток оборвали или протокол не тот. */
  function finish() {
    if (done) return [];
    done = true;
    return [
      {
        type: 'error',
        engine: ENGINE,
        message: 'поток Claude Code закончился без result: ход оборван или протокол не сошёлся',
        truncated: true,
      },
    ];
  }

  return {
    push,
    finish,
    get engine() {
      return engine;
    },
    get counts() {
      return { ...counts };
    },
    get unmapped() {
      return counts.unmapped ?? 0;
    },
    /** Типы строк, которых парсер не знает: по ним видно, что протокол разъехался. */
    get unknownTypes() {
      return { ...unknown };
    },
  };
}

/** Весь поток разом: удобно в тестах и при разборе сохранённого прогона. */
export function translateEvents(events, options = {}) {
  const stream = createTurnStream(options);
  const out = [];
  for (const event of events) out.push(...stream.push(event));
  out.push(...stream.finish());
  return out;
}
