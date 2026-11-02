// Субагенты Икара: задачи, которые уходят отдельным процессам pi.
//
// Зачем отдельный процесс на задачу. Контекст — самый дорогой ресурс разговора:
// шесть поисковых запросов по две-три страницы выдачи утопят любой контекст, если
// тащить их в родителя целиком. Ребёнок читает страницы сам, а назад отдаёт только
// вывод. Родитель платит за результат, а не за дорогу к нему.
//
// Что здесь зашито жёстко, потому что иначе фича становится опасной:
//
//   * Вложенности нет. Ребёнок запускается с ICARUS_SUBAGENT_DEPTH=1 и инструмент
//     ему не регистрируется вовсе; `--exclude-tools subagent` — вторая линия, на
//     случай если кто-то снимет переменную. Сорок субагентов, каждый из которых
//     запустил ещё сорок, — это не «больше работы», это счёт за токены.
//   * Вызов блокирующий. Инструмент не возвращается, пока не закончилась последняя
//     задача: у pi нет фоновых инструментов, и человек получает ответ только тогда,
//     когда все дети отработали. Половинчатый ответ «запустил и побежал» здесь
//     невозможен по устройству.
//   * Параллельность — через очередь. Модель просит сколько угодно задач (до
//     MAX_TASKS), но одновременно работают не больше ICARUS_SUBAGENT_CONCURRENCY.
//     Почему четыре по умолчанию: у Anthropic в их исследовательском агенте ведущий
//     запускает 3–5 субагентов параллельно, а не пятьдесят, — они сами пишут, что
//     ранние версии «плодили 50 субагентов на простой вопрос» и это была ошибка.
//     OpenClaw держит рядом те же числа: maxConcurrent 4 на основную линию и 8 на
//     субагентов. Потолок 8 — уже предел провайдера и CPU контейнера, а не вкус.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Глубина вложенности: у ребёнка единица, и инструмент ему уже не положен. */
export const DEPTH_ENV = "ICARUS_SUBAGENT_DEPTH";

/** Сколько задач ждём одновременно, если человек не сказал иначе. */
export const DEFAULT_CONCURRENCY = 4;
/**
 * Потолок параллельности. Восемь — не «мало»: каждая задача это отдельный процесс
 * pi, свой контекст и свой счёт за токены, а провайдер считает параллельные запросы
 * по ключу на всех. Дальше очередь, а не героизм.
 */
export const MAX_CONCURRENCY = 8;
/** Сколько задач принимаем за один вызов: сорок — по числу запросов в большом скилле. */
export const DEFAULT_MAX_TASKS = 40;
/** Одна задача: дольше пяти минут ребёнок обычно уже не ищет, а страдает. */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;
/** Весь вызов целиком: четверть часа — это уже неприлично долгий ход. */
export const DEFAULT_BUDGET_MS = 900_000;
/** Сколько символов вывода ребёнка уходит родителю: остальное — в детали. */
const OUTPUT_LIMIT = 3000;
/** Как часто двигаем прогресс: чаще — только зря дёргать UI и телеграм. */
const PROGRESS_INTERVAL_MS = 700;
/**
 * Сколько шагов ребёнка помним для вложенного списка в панели. Список — не отчёт:
 * по нему видно, куда ребёнок ходил, а не весь его путь; десять последних хватает,
 * и детали прогресса не растут с каждой страницей.
 */
const ACTION_LIMIT = 10;
/** Длинный запрос или URL в строке действия не должен растягивать детали. */
const ACTION_CHARS = 160;

/** Модель для задачи: дешёвая или та, что получше. Уровни раздаёт сервис. */
export type SubagentTier = "fast" | "strong";

export type SubagentSpec = {
  /** Имя, которым агента зовёт модель. */
  name: string;
  /** Одна строка для описания инструмента: что этот агент умеет. */
  label: string;
  /** Инструменты ребёнка: передаются в `--tools`, поэтому лишнего он не получит. */
  tools: string[];
  /**
   * Расширения, без которых роли не обойтись (имена файлов в ~/.pi/agent/extensions).
   * Всё остальное ребёнку не грузим вовсе: персона, память и эскалация — это дела
   * родителя, а не задачи. Заодно ни одно расширение не может включить ребёнку
   * инструмент субагента.
   */
  extensions: string[];
  systemPrompt: string;
  tier: SubagentTier;
};

/**
 * Всё, что есть у Икара: восемь встроенных инструментов pi и инструменты наших
 * расширений. Список явный, потому что `--tools` — это allowlist по точным именам
 * (шаблона `*` в 0.85.1 нет), а grep/find/ls у pi не входят в набор по умолчанию.
 *
 * MCP-инструментов здесь нарочно нет: их имена приходят от серверов динамически, и
 * субагент с доступом к дому или к Maple — это уже не «ещё руки», а чужие кнопки.
 * Понадобится — добавляется строкой сюда, но не по умолчанию.
 */
export const ALL_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "now",
  "get_control_panel_link",
];

/**
 * Три роли — это не «мало ролей», а ровно столько, сколько Икару есть чем занять.
 * Разведчик смотрит по файлам, исследователь ходит в интернет, исполнитель правит.
 * Новая роль добавляется здесь же; городить реестр из markdown-файлов незачем,
 * пока ролей три.
 */
export const AGENTS: Readonly<Record<string, SubagentSpec>> = {
  scout: {
    name: "scout",
    label: "читает файлы и смотрит каталоги",
    tools: ["read", "grep", "find", "ls", "bash"],
    extensions: [],
    systemPrompt: [
      "Ты — разведчик Икара. Твоя работа — быстро осмотреть то, что тебе поручили,",
      "и вернуть сжатый, но точный ответ: что нашёл, где именно (путь, строка, имя),",
      "и что из этого следует.",
      "Ты не правишь файлы и ничего не запускаешь надолго: только читаешь и смотришь.",
      "Пиши по-русски, без вступлений вроде «итак» и «я посмотрел» — сразу факты.",
      "Если ответа нет, так и скажи одной строкой и перечисли, что проверил.",
    ].join(" "),
    tier: "fast",
  },
  researcher: {
    name: "researcher",
    label: "ищет в интернете, читает страницы и файлы",
    tools: ["web_search", "web_fetch", "read", "find", "ls"],
    extensions: ["web-search.ts"],
    systemPrompt: [
      "Ты — исследователь Икара. Тебе дают конкретный вопрос, и ты ищешь на него ответ",
      "в интернете: несколько запросов, разные формулировки, потом чтение страниц.",
      "Верни короткую сводку и ссылки на источники (обычные URL, не markdown-лесенки).",
      "Не выдумывай цены, даты и имена: чего не видел в выдаче или на странице — того нет.",
      "Если разные источники спорят, покажи оба и скажи, какой надёжнее и почему.",
      "Пиши по-русски, без воды; подробности — в выводах, а не в пересказе процесса.",
    ].join(" "),
    tier: "fast",
  },
  worker: {
    name: "worker",
    label: "всё: файлы, правки, команды, веб-поиск, время",
    tools: ALL_TOOLS,
    // Полный набор инструментов — значит и все расширения, которые их дают.
    // Персона, память и эскалация сюда по-прежнему не входят: они про разговор,
    // а не про работу.
    extensions: ["web-search.ts", "clock.ts", "control-panel.ts"],
    systemPrompt: [
      "Ты — исполнитель Икара. Тебе дают конкретную работу, и ты её делаешь до конца:",
      "читаешь, правишь, проверяешь результат.",
      "Не трогай ничего за пределами того, что нужно для задачи, и не удаляй чужое.",
      "Верни, что сделал: какие файлы изменил, что проверил, что осталось незакрытым.",
      "Пиши по-русски и коротко.",
    ].join(" "),
    tier: "strong",
  },
};

export type SubagentStatus = "queued" | "running" | "ok" | "error" | "aborted" | "skipped";

/** Что видно про одну задачу: и в прогрессе, и в итоге, и в веб-панели. */
export type SubagentState = {
  index: number;
  agent: string;
  task: string;
  status: SubagentStatus;
  /** Чем занят прямо сейчас: «web_search: amazon.co.uk». Только у работающих. */
  activity?: string;
  /**
   * Последние шаги ребёнка («web_search: amazon.ie», «read: SKILL.md»…). Панель
   * рисует их вложенным списком под самим субагентом: раскрыл — видно, куда он
   * ходил; закрыл — не мешает читать ответ.
   */
  actions?: string[];
  /**
   * Сколько шагов было всего. Список хранит только последние, и без этого числа
   * панель писала бы «10 действий», хотя ребёнок сходил пятьдесят раз.
   */
  actionsTotal?: number;
  startedAt?: number;
  ms?: number;
  output?: string;
  error?: string;
};

/** Пределы вызова. Вынесены в тип: их видно и в тестах, и в описании инструмента. */
export type Limits = {
  concurrency: number;
  maxTasks: number;
  taskTimeoutMs: number;
  budgetMs: number;
};

function numberFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Пределы из окружения контейнера (`env:` в config.yaml). Клампим, а не падаем:
 * опечатка в конфиге не должна оставить человека без субагентов вовсе.
 */
export function resolveLimits(env: Record<string, string | undefined> = process.env): Limits {
  return {
    concurrency: clamp(numberFrom(env.ICARUS_SUBAGENT_CONCURRENCY, DEFAULT_CONCURRENCY), 1, MAX_CONCURRENCY),
    maxTasks: clamp(numberFrom(env.ICARUS_SUBAGENT_MAX_TASKS, DEFAULT_MAX_TASKS), 1, DEFAULT_MAX_TASKS),
    taskTimeoutMs: numberFrom(env.ICARUS_SUBAGENT_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS),
    budgetMs: numberFrom(env.ICARUS_SUBAGENT_BUDGET_MS, DEFAULT_BUDGET_MS),
  };
}

/** Мы внутри субагента? Тогда инструмент регистрировать нечего. */
export function isSubagentProcess(env: Record<string, string | undefined> = process.env): boolean {
  return numberFrom(env[DEPTH_ENV], 0) > 0;
}

/** Имя агента без учёта регистра: «Scout» и «scout» — одно и то же. */
export function agentNameOf(name: string): string | null {
  const wanted = name.trim().toLowerCase();
  return Object.hasOwn(AGENTS, wanted) ? wanted : null;
}

export function agentsLine(): string {
  return Object.values(AGENTS)
    .map((agent) => `${agent.name} — ${agent.label}`)
    .join("; ");
}

/**
 * Аргументы ребёнка. Скиллы оставляем — ими и работают задачи вроде «пройди по
 * этому скиллу»; контекстные файлы (AGENTS.md, персона) убираем: подсказку роли
 * ребёнок получает свою, а правила памяти ему ни к чему — он не пишет в память.
 */
export function buildChildArgs(options: {
  spec: SubagentSpec;
  model?: string;
  systemPromptFile: string;
  extensionFiles: string[];
}): string[] {
  const { spec, model, systemPromptFile, extensionFiles } = options;
  const args = ["--mode", "json", "-p", "--no-session", "--no-context-files", "--no-extensions"];
  // Свои расширения роли подключаем поимённо: остальные (персона, память, эскалация)
  // в ребёнке не нужны, а память в чужих руках ещё и вредна.
  for (const file of extensionFiles) args.push("--extension", file);
  args.push("--tools", spec.tools.join(","));
  // Третий замок от вложенности: даже если инструмент откуда-то возьмётся.
  args.push("--exclude-tools", "subagent");
  if (model) args.push("--model", model);
  args.push("--append-system-prompt", systemPromptFile);
  return args;
}

/** Пути к расширениям роли: чего нет в контейнере, то молча не подключаем. */
export function extensionFilesOf(spec: SubagentSpec, home = os.homedir()): string[] {
  return spec.extensions
    .map((name) => path.join(home, ".pi", "agent", "extensions", name))
    .filter((file) => fs.existsSync(file));
}

/**
 * Как запустить pi: тем же рантаймом, если это не node/bun, иначе — по имени.
 * ICARUS_SUBAGENT_PI перекрывает всё: в образе команда может называться иначе,
 * и тогда это дело конфига, а не догадки по имени рантайма.
 */
function piInvocation(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const explicit = env.ICARUS_SUBAGENT_PI?.trim();
  if (explicit) return { command: explicit, args: [] };
  const script = process.argv[1];
  if (script && fs.existsSync(script)) return { command: process.execPath, args: [script] };
  const name = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(name)) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

/**
 * Копит шаги ребёнка для вложенного списка: без повторов и не длиннее предела.
 * Возвращает, был ли это новый шаг: по нему считается общее число действий, даже
 * когда в списке остались только последние.
 */
export function rememberAction(actions: string[], action: string): boolean {
  const text = action.trim();
  if (!text || actions[actions.length - 1] === text) return false;
  actions.push(text);
  if (actions.length > ACTION_LIMIT) actions.splice(0, actions.length - ACTION_LIMIT);
  return true;
}

/** Строка «чем занят» из аргументов инструмента: первое осмысленное поле. */
export function activityOf(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const first = ["query", "url", "path", "file", "command", "name"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const detail = first ? first.split("\n")[0] : "";
  const clipped = detail.length > 90 ? `${detail.slice(0, 89)}…` : detail;
  return clipped ? `${toolName}: ${clipped}` : toolName;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

type ChildEvent = {
  type?: string;
  toolName?: string;
  args?: unknown;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
};

/** Итог одного ребёнка. Ошибку не бросаем: родитель должен увидеть её в отчёте. */
type ChildResult = { status: "ok" | "error" | "timeout"; output: string; error?: string };

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  timer.unref?.();
}

/**
 * Один ребёнок: файл с подсказкой роли, процесс pi в JSON-режиме, разбор строк.
 * Возвращает последний текст ассистента — всё, что ребёнок наработал, короче
 * собственного контекста.
 */
async function runChild(options: {
  spec: SubagentSpec;
  task: string;
  model?: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  extensionFiles: string[];
  onActivity: (activity: string) => void;
}): Promise<ChildResult> {
  const { spec, task, model, cwd, signal, timeoutMs, extensionFiles, onActivity } = options;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "icarus-subagent-"));
  const promptFile = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptFile, spec.systemPrompt, { encoding: "utf8", mode: 0o600 });

  return await new Promise<ChildResult>((resolve) => {
    let answer = "";
    let stderr = "";
    let stopReason = "";
    let errorMessage = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let buffer = "";
    let child: ChildProcess;

    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve(result);
    };

    const onAbort = (): void => {
      aborted = true;
      killChild(child);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    timeout.unref?.();

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: ChildEvent;
      try {
        event = JSON.parse(line) as ChildEvent;
      } catch {
        return;
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        onActivity(activityOf(event.toolName, event.args));
        return;
      }
      if (event.type !== "message_end" || !event.message) return;
      const message = event.message;
      if (message.role !== "assistant") return;
      if (message.stopReason) stopReason = message.stopReason;
      if (message.errorMessage) errorMessage = message.errorMessage;
      const text = textOfContent(message.content).trim();
      if (text) answer = text;
    };

    try {
      const invocation = piInvocation();
      const args = buildChildArgs({ spec, model, systemPromptFile: promptFile, extensionFiles });
      child = spawn(invocation.command, [...invocation.args, ...args, task], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [DEPTH_ENV]: "1" },
      });
    } catch (error) {
      finish({ status: "error", output: "", error: `не запустился: ${String(error)}` });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Хвост stderr: в начало обычно уезжает шум запуска, а причина — в конце.
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => {
      finish({ status: "error", output: answer, error: `процесс не поднялся: ${error.message}` });
    });
    child.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      if (timedOut) {
        finish({ status: "timeout", output: answer, error: `не уложился в ${Math.round(timeoutMs / 1000)} с` });
        return;
      }
      if (aborted) {
        finish({ status: "error", output: answer, error: "остановлен" });
        return;
      }
      if (stopReason === "error" || stopReason === "aborted") {
        finish({ status: "error", output: answer, error: errorMessage || stopReason });
        return;
      }
      if (code !== 0 && code !== null) {
        const reason = stderr.trim().split("\n").slice(-3).join(" ");
        finish({ status: "error", output: answer, error: reason || `pi завершился с кодом ${code}` });
        return;
      }
      if (!answer.trim()) {
        finish({ status: "error", output: "", error: stderr.trim().split("\n").slice(-3).join(" ") || "пустой ответ" });
        return;
      }
      finish({ status: "ok", output: answer });
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Слоты на весь процесс. Модель может позвать инструмент дважды в одном сообщении
 * (pi запускает вызовы батчем), и тогда лимит на вызов превратился бы в лимит на
 * вызов² — восемь детей на каждую копию. Держим общий потолок, а `concurrency`
 * остаётся обещанием «не больше» для одного вызова.
 */
const slots = { active: 0, waiting: [] as Array<() => void> };

async function acquireSlot(): Promise<() => void> {
  return await new Promise<() => void>((resolve) => {
    const grant = (): void => {
      slots.active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        slots.active -= 1;
        slots.waiting.shift()?.();
      });
    };
    if (slots.active < MAX_CONCURRENCY) grant();
    else slots.waiting.push(grant);
  });
}

/**
 * Очередь с ограничением параллельности: ровно `limit` работников разбирают общий
 * список по порядку. Порядок важен — первый запрос скилла должен уехать первым,
 * иначе очередь превращается в лотерею.
 */
export async function runPool(total: number, limit: number, worker: (index: number) => Promise<void>): Promise<void> {
  const lanes = Math.max(1, Math.min(limit, total));
  let next = 0;
  const runners = Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      await worker(index);
    }
  });
  await Promise.all(runners);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} с`;
}

/** «1 задача», «2 задачи», «5 задач»: отчёт читает человек, а не только модель. */
function taskCount(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? "задач" : ones === 1 ? "задача" : ones >= 2 && ones <= 4 ? "задачи" : "задач";
  return `${count} ${word}`;
}

const STATUS_WORD: Record<SubagentStatus, string> = {
  queued: "в очереди",
  running: "работает",
  ok: "готово",
  error: "ошибка",
  aborted: "остановлен",
  skipped: "пропущен",
};

/** Прогресс: строка для телеграма и подробности для панели. */
export function renderProgress(states: SubagentState[], limits: Limits, elapsedMs: number): string {
  const done = states.filter((state) => state.status === "ok").length;
  const failed = states.filter((state) => state.status === "error").length;
  const running = states.filter((state) => state.status === "running").length;
  const queued = states.filter((state) => state.status === "queued").length;
  const head = `Субагенты: ${done} из ${states.length}, параллельно до ${limits.concurrency}, ${formatSeconds(elapsedMs)}.`;
  const tail = [
    running > 0 ? `${running} работают` : "",
    queued > 0 ? `${queued} в очереди` : "",
    failed > 0 ? `${failed} с ошибкой` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = states.map((state) => {
    const where = state.status === "running" && state.activity ? ` · ${state.activity}` : "";
    const ms = state.ms === undefined ? "" : ` · ${formatSeconds(state.ms)}`;
    return `${state.index + 1}. ${state.agent} · ${STATUS_WORD[state.status]}${ms}${where}`;
  });
  return [`${head}${tail ? ` ${tail[0].toUpperCase()}${tail.slice(1)}` : ""}`, ...lines].join("\n");
}

/** Итог для модели: то, что она прочитает вместо страниц, которые излазили дети. */
export function renderReport(states: SubagentState[], limits: Limits, elapsedMs: number): string {
  const ok = states.filter((state) => state.status === "ok").length;
  const failed = states.length - ok;
  const head = [
    `Субагенты: ${taskCount(states.length)}, параллельно до ${limits.concurrency}, ${formatSeconds(elapsedMs)}.`,
    ok === states.length ? "Все дошли." : `Готово ${ok}, без результата ${failed}.`,
  ].join(" ");
  const body = states.map((state) => {
    const heading = `${state.index + 1}. ${state.agent} · ${STATUS_WORD[state.status]}${state.ms === undefined ? "" : ` · ${formatSeconds(state.ms)}`}`;
    const text = state.status === "ok" ? (state.output ?? "") : (state.error ?? state.output ?? "");
    const clipped = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (обрезано)` : text;
    return `### ${heading}\n${clipped || "(пусто)"}`;
  });
  return [head, ...body].join("\n\n");
}

/**
 * Снимок для деталей инструмента: панель рисует по нему живой список.
 *
 * Обрезаем текст: детали уезжают в каждое обновление прогресса, и сорок задач с
 * полными выводами гоняли бы по stdio сотни килобайт каждые полсекунды. Панели
 * хватает начала задания и начала ответа, полный текст и так есть в отчёте.
 */
export function snapshot(states: SubagentState[]): SubagentState[] {
  const clip = (text: string | undefined, limit: number): string | undefined =>
    text === undefined ? undefined : text.length > limit ? `${text.slice(0, limit)}…` : text;
  return states.map((state) => ({
    ...state,
    task: clip(state.task, 400) ?? '',
    ...(state.output === undefined ? {} : { output: clip(state.output, 400) }),
    ...(state.error === undefined ? {} : { error: clip(state.error, 400) }),
    ...(state.actions === undefined
      ? {}
      : { actions: state.actions.slice(-ACTION_LIMIT).map((action) => clip(action, ACTION_CHARS) ?? '') }),
  }));
}

export default function (pi: ExtensionAPI) {
  // Внутри субагента инструмента нет: единственный надёжный способ запретить
  // вложенность — не давать ребёнку чем её запускать.
  if (isSubagentProcess()) return;

  const limits = resolveLimits();

  pi.registerTool({
    name: "subagent",
    label: "Субагенты",
    description: [
      "Отдать задачи субагентам: каждый работает в своём процессе pi со своим контекстом",
      "и возвращает только вывод, поэтому страницы и переписка не занимают твой контекст.",
      "Вызов блокирующий: пока задачи не закончились, ответа человеку не будет.",
      `Задачи выполняются очередью, одновременно не больше ${limits.concurrency}` +
        " (настраивается ICARUS_SUBAGENT_CONCURRENCY, потолок 8).",
      `Агенты: ${agentsLine()}.`,
      "Субагент не может запустить субагента: вложенности нет.",
      "Каждая задача должна быть самодостаточной: ребёнок не видит ваш разговор и не знает",
      "контекста, поэтому пиши в task всё, что ему нужно (что искать, где, в каком виде вернуть).",
      "Не дроби на мелкое: каждая задача — это отдельная модель, отдельные токены и время.",
    ].join(" "),
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: `Имя агента: ${Object.keys(AGENTS).join(", ")}` }),
          task: Type.String({
            description: "Самодостаточное задание: что сделать и в каком виде вернуть результат",
          }),
        }),
        { description: `Задачи (до ${limits.maxTasks}); порядок сохраняется, лишние ждут в очереди` },
      ),
      concurrency: Type.Optional(
        Type.Number({
          description: `Сколько задач вести одновременно (1–${MAX_CONCURRENCY}, по умолчанию ${limits.concurrency})`,
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requested = (params.tasks ?? []).map((task) => ({
        agent: String(task.agent ?? ""),
        task: String(task.task ?? "").trim(),
      }));

      const problems: string[] = [];
      if (requested.length === 0) problems.push("не передано ни одной задачи");
      if (requested.length > limits.maxTasks) {
        problems.push(`задач ${requested.length}, а за вызов принимаю не больше ${limits.maxTasks}`);
      }
      requested.forEach((task, index) => {
        if (!agentNameOf(task.agent)) problems.push(`задача ${index + 1}: нет агента «${task.agent}»`);
        if (!task.task) problems.push(`задача ${index + 1}: пустое задание`);
      });
      if (problems.length > 0) {
        return {
          content: [{ type: "text", text: `Субагенты не запущены: ${problems.join("; ")}. Агенты: ${agentsLine()}.` }],
          details: { error: problems.join("; ") },
        };
      }

      const concurrency = clamp(
        Number.isFinite(Number(params.concurrency)) ? Math.floor(Number(params.concurrency)) : limits.concurrency,
        1,
        MAX_CONCURRENCY,
      );
      const effective: Limits = { ...limits, concurrency };
      const startedAt = Date.now();
      const deadline = startedAt + limits.budgetMs;

      const states: SubagentState[] = requested.map((task, index) => ({
        index,
        agent: agentNameOf(task.agent) ?? task.agent,
        task: task.task,
        status: "queued",
      }));

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      let lastProgress = 0;
      const pushProgress = (force = false): void => {
        const now = Date.now();
        if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
        lastProgress = now;
        onUpdate?.({
          content: [{ type: "text", text: renderProgress(states, effective, now - startedAt) }],
          details: { subagents: snapshot(states), concurrency: effective.concurrency, total: states.length },
        });
      };

      const modelFor = (spec: SubagentSpec): string | undefined => {
        const key = spec.tier === "strong" ? "ICARUS_MODEL_STRONG" : "ICARUS_MODEL_FAST";
        const fromEnv = process.env[key]?.trim();
        if (fromEnv) return fromEnv;
        // Не задали в контейнере — берём модель родителя, она заведомо работает.
        return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      };

      pushProgress(true);
      await runPool(states.length, effective.concurrency, async (index) => {
        const state = states[index];
        const spec = AGENTS[state.agent];
        if (controller.signal.aborted) {
          state.status = "aborted";
          return;
        }
        if (Date.now() > deadline) {
          state.status = "skipped";
          state.error = `не успел до общего предела ${Math.round(limits.budgetMs / 1000)} с`;
          return;
        }

        // Слот берём перед стартом: пока он не дался, задача честно «в очереди».
        const release = await acquireSlot();
        if (controller.signal.aborted) {
          release();
          state.status = "aborted";
          return;
        }
        state.status = "running";
        state.startedAt = Date.now();
        pushProgress(true);

        let result: ChildResult;
        try {
          result = await runChild({
            spec,
            task: state.task,
            model: modelFor(spec),
            cwd: ctx.cwd,
            signal: controller.signal,
            timeoutMs: limits.taskTimeoutMs,
            extensionFiles: extensionFilesOf(spec),
            onActivity: (activity) => {
              state.activity = activity;
              if (rememberAction((state.actions ??= []), activity)) {
                state.actionsTotal = (state.actionsTotal ?? 0) + 1;
              }
              pushProgress();
            },
          });
        } finally {
          release();
        }

        state.ms = Date.now() - (state.startedAt ?? Date.now());
        state.activity = undefined;
        if (controller.signal.aborted) state.status = "aborted";
        else if (result.status === "timeout") {
          state.status = "error";
          state.error = `таймаут: ${result.error ?? ""}`.trim();
          state.output = result.output.slice(0, OUTPUT_LIMIT);
        } else if (result.status === "error") {
          state.status = "error";
          state.error = result.error;
          state.output = result.output.slice(0, OUTPUT_LIMIT);
        } else {
          state.status = "ok";
          state.output = result.output;
        }
        pushProgress(true);
      });

      signal?.removeEventListener("abort", onAbort);
      for (const state of states) if (state.status === "queued") state.status = "skipped";

      const elapsedMs = Date.now() - startedAt;
      const stopped = states.some((state) => state.status === "aborted");
      const text = renderReport(states, effective, elapsedMs);
      if (stopped) {
        throw new Error(`Субагенты остановлены на ${states.filter((s) => s.status === "ok").length} из ${states.length}.`);
      }
      return {
        content: [{ type: "text", text }],
        details: { subagents: snapshot(states), concurrency: effective.concurrency, total: states.length, elapsedMs },
      };
    },
  });
}
