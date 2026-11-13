// Icarus subagents: tasks that go to separate pi processes.
//
// Why a separate process per task. Context is the most expensive resource of a conversation:
// six search queries of two or three result pages each will drown any context if you drag them
// into the parent whole. The child reads the pages itself and gives back only the conclusion.
// The parent pays for the result, not for the road to it.
//
// Here is what is nailed down hard, because otherwise the feature becomes dangerous:
//
//   * There is no nesting. The child is launched with ICARUS_SUBAGENT_DEPTH=1 and the tool is
//     not registered for it at all; `--exclude-tools subagent` is a second line, in case someone
//     removes the variable. Forty subagents, each of which launched another forty, is not "more
//     work", it is a token bill.
//   * The call is blocking. The tool does not return until the last task has finished: pi has no
//     background tools, and the person gets an answer only when all children have completed.
//     A half-baked answer of "launched it and ran off" is impossible here by design.
//   * Concurrency is through a queue. The model may ask for any number of tasks (up to MAX_TASKS),
//     but no more than ICARUS_SUBAGENT_CONCURRENCY work at the same time. Why four by default:
//     Anthropic's research agent has the lead launch 3–5 subagents in parallel, not fifty — they
//     write themselves that early versions "bred 50 subagents for a simple question" and that it
//     was a mistake. OpenClaw keeps the same numbers: maxConcurrent 4 for the main line and 8 for
//     subagents. The cap of 8 is already the provider's and the container CPU's limit, not taste.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Nesting depth: the child has one, and the tool is already not available to it. */
export const DEPTH_ENV = "ICARUS_SUBAGENT_DEPTH";

/** How many tasks we wait for at the same time, unless the person said otherwise. */
export const DEFAULT_CONCURRENCY = 4;
/**
 * Concurrency cap. Eight is not "a little": each task is a separate pi process, its own context
 * and its own token bill, and the provider counts parallel requests per key for all of them.
 * Beyond that there is a queue, not heroics.
 */
export const MAX_CONCURRENCY = 8;
/** How many tasks we accept per call: forty — the number of queries in the big skill. */
export const DEFAULT_MAX_TASKS = 40;
/** One task: after five minutes the child is usually no longer searching, it is suffering. */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;
/** The whole call: a quarter of an hour is already an indecently long turn. */
export const DEFAULT_BUDGET_MS = 900_000;
/**
 * How many characters of the child's output go to the parent in the report.
 *
 * Not a rubber value and not "the more the better". The rule that context-management
 * practitioners converge on (Claude Code, OpenClaw, Arize): a tool result lives in its own
 * budget — on the order of 16 KB or a third of the window, whichever is smaller. Per task that
 * is a lot (we pay for all forty), so we take an eighth of the budget, 8000. Less than three
 * thousand was not enough: a report with a table and quotes was cut in the middle, and the
 * parent seriously believed it had seen the whole answer.
 * We cannot cut silently: truncation is marked, and the parent is told — the full text existed,
 * it is at the child's, ask for a summary or rerun the task with an explicit "briefly".
 */
const OUTPUT_LIMIT = 8000;
/** How often we move progress: more often only needlessly pokes the UI and telegram. */
const PROGRESS_INTERVAL_MS = 700;
/**
 * How many child steps we remember for the nested list in the panel. The list is not a report:
 * it shows where the child went, not its whole path; the last ten are enough, and progress
 * details do not grow with every page.
 */
const ACTION_LIMIT = 10;
/** A long query or URL in an action line must not stretch the details. */
const ACTION_CHARS = 160;

/** Model for a task: the cheap one or the better one. The service hands out the tiers. */
export type SubagentTier = "fast" | "strong";

export type SubagentSpec = {
  /** Name by which the model calls the agent. */
  name: string;
  /** One line for the tool description: what this agent can do. */
  label: string;
  /** The child's tools: passed to `--tools`, so it will not get anything extra. */
  tools: string[];
  /**
   * Extensions without which the role cannot do (file names in ~/.pi/agent/extensions).
   * We do not load anything else into the child at all: persona, memory and escalation are the
   * parent's business, not the task's. At the same time, no extension can enable the subagent
   * tool for the child.
   */
  extensions: string[];
  systemPrompt: string;
  tier: SubagentTier;
};

/**
 * Everything Icarus has: eight built-in pi tools and the tools of our extensions. The list is
 * explicit, because `--tools` is an allowlist by exact names (there is no `*` pattern in
 * 0.85.1), and grep/find/ls in pi are not in the default set.
 *
 * There are deliberately no MCP tools here: their names come from servers dynamically, and a
 * subagent with access to the home or to MCP is no longer "extra hands" but someone else's
 * buttons. If needed, it is added by a line here, but not by default.
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
 * Three roles are not "few roles", but exactly as many as Icarus has work for. The scout looks
 * through files, the researcher goes to the internet, the worker edits. A new role is added right
 * here; there is no point in building a registry of markdown files while there are three roles.
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
      "Отвечай сжато: родитель видит только первый блок текста, \u0430 всё, что длиннее нескольких тысяч знаков, будет обрезано без спроса.",
      "Если данных много — не вываливай их в ответ: сложи подробности в файл в текущем каталоге",
      "(например, subagent-notes/<тема>.md), а в ответе дай путь и главное в пяти-десяти строках.",
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
    // The full tool set means all the extensions that provide them too.
    // Persona, memory and escalation still do not enter here: they are about the conversation,
    // not about the work.
    extensions: ["web-search.ts", "clock.ts", "control-panel.ts"],
    systemPrompt: [
      "Ты — исполнитель Икара. Тебе дают конкретную работу, и ты её делаешь до конца:",
      "читаешь, правишь, проверяешь результат.",
      "Не трогай ничего за пределами того, что нужно для задачи, и не удаляй чужое.",
      "Отвечай коротко: родитель видит лишь начало ответа, всё длинное обрежется.",
      "Много данных или длинные выкладки — пиши их в файл в текущем каталоге и в ответе давай путь,",
      "а не весь текст; аналогично для сканов и логов — файл плюс выжимка.",
      "Верни, что сделал: какие файлы изменил, что проверил, что осталось незакрытым.",
      "Пиши по-русски и коротко.",
    ].join(" "),
    tier: "strong",
  },
};

export type SubagentStatus = "queued" | "running" | "ok" | "error" | "aborted" | "skipped";

/** What is visible about one task: both in progress, and in the result, and in the web panel. */
export type SubagentState = {
  index: number;
  agent: string;
  task: string;
  status: SubagentStatus;
  /** What it is busy with right now: "web_search: amazon.co.uk". Only for running ones. */
  activity?: string;
  /**
   * The child's last steps ("web_search: amazon.ie", "read: SKILL.md"...). The panel draws them
   * as a nested list under the subagent itself: expanded — you see where it went; collapsed — it
   * does not interfere with reading the answer.
   */
  actions?: string[];
  /**
   * How many steps there were in total. The list stores only the last ones, and without this
   * number the panel would say "10 actions" even if the child went out fifty times.
   */
  actionsTotal?: number;
  startedAt?: number;
  ms?: number;
  output?: string;
  error?: string;
};

/** Call limits. Extracted into a type: visible both in tests and in the tool description. */
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
 * Limits from the container environment (`env:` in config.yaml). We clamp instead of crashing:
 * a typo in the config must not leave the person without subagents at all.
 */
export function resolveLimits(env: Record<string, string | undefined> = process.env): Limits {
  return {
    concurrency: clamp(numberFrom(env.ICARUS_SUBAGENT_CONCURRENCY, DEFAULT_CONCURRENCY), 1, MAX_CONCURRENCY),
    maxTasks: clamp(numberFrom(env.ICARUS_SUBAGENT_MAX_TASKS, DEFAULT_MAX_TASKS), 1, DEFAULT_MAX_TASKS),
    taskTimeoutMs: numberFrom(env.ICARUS_SUBAGENT_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS),
    budgetMs: numberFrom(env.ICARUS_SUBAGENT_BUDGET_MS, DEFAULT_BUDGET_MS),
  };
}

/** Are we inside a subagent? Then there is no tool to register. */
export function isSubagentProcess(env: Record<string, string | undefined> = process.env): boolean {
  return numberFrom(env[DEPTH_ENV], 0) > 0;
}

/** Agent name case-insensitively: "Scout" and "scout" are the same. */
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
 * The child's arguments. We keep skills — that is what tasks like "go by this skill" work with;
 * we drop context files (AGENTS.md, persona): the child gets its own role hint, and the memory
 * rules are none of its business — it does not write to memory.
 */
export function buildChildArgs(options: {
  spec: SubagentSpec;
  model?: string;
  systemPromptFile: string;
  extensionFiles: string[];
}): string[] {
  const { spec, model, systemPromptFile, extensionFiles } = options;
  const args = ["--mode", "json", "-p", "--no-session", "--no-context-files", "--no-extensions"];
  // We connect the role's own extensions by name: the rest (persona, memory, escalation)
  // are not needed in the child, and memory in someone else's hands is also harmful.
  for (const file of extensionFiles) args.push("--extension", file);
  args.push("--tools", spec.tools.join(","));
  // The third lock against nesting: even if the tool appears from somewhere.
  args.push("--exclude-tools", "subagent");
  if (model) args.push("--model", model);
  args.push("--append-system-prompt", systemPromptFile);
  return args;
}

/** Paths to the role's extensions: whatever is missing in the container is silently not connected. */
export function extensionFilesOf(spec: SubagentSpec, home = os.homedir()): string[] {
  return spec.extensions
    .map((name) => path.join(home, ".pi", "agent", "extensions", name))
    .filter((file) => fs.existsSync(file));
}

/**
 * How to launch pi: with the same runtime, if it is not node/bun, otherwise by name.
 * ICARUS_SUBAGENT_PI overrides everything: in the image the command may be named differently,
 * and then it is a matter of config, not a guess by runtime name.
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
 * Accumulates the child's steps for the nested list: without repeats and no longer than the
 * limit. Returns whether it was a new step: it is used to count the total number of actions,
 * even when only the last ones remain in the list.
 */
export function rememberAction(actions: string[], action: string): boolean {
  const text = action.trim();
  if (!text || actions[actions.length - 1] === text) return false;
  actions.push(text);
  if (actions.length > ACTION_LIMIT) actions.splice(0, actions.length - ACTION_LIMIT);
  return true;
}

/** The "busy with" line from the tool arguments: the first meaningful field. */
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

/** Result of one child. We do not throw the error: the parent must see it in the report. */
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
 * One child: a file with the role hint, a pi process in JSON mode, line parsing.
 * Returns the assistant's last text — everything the child produced, shorter than
 * its own context.
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
      // Tail of stderr: startup noise usually goes to the beginning, and the reason is at the end.
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
 * Slots for the whole process. The model may call the tool twice in one message (pi launches
 * calls in a batch), and then the per-call limit would turn into a per-call² limit — eight
 * children per copy. We keep a global cap, and `concurrency` remains a "no more than" promise
 * for a single call.
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
 * A queue with a concurrency limit: exactly `limit` workers go through a shared list in order.
 * Order matters — the first skill request must go first, otherwise the queue turns into a lottery.
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

/** "1 task", "2 tasks", "5 tasks": the report is read by a human, not only by the model. */
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

/** Progress: a line for telegram and details for the panel. */
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

/** How many characters we give from the beginning of an overflowing output before marking truncation. */
const OUTPUT_HEAD = OUTPUT_LIMIT;

/** Hint to the parent on truncation: what happened and what to do about it. */
const CLIPPED_HINT =
  `\n\n… (обрезано на ${OUTPUT_LIMIT} символах: ребёнок написал больше. ` +
  "Полного текста здесь нет — или попроси у него сжатую выжимку, или повтори задачу с явным пределом в задании.)";

/** Result for the model: what it will read instead of the pages the children crawled. */
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
    const clipped = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_HEAD)}${CLIPPED_HINT}` : text;
    return `### ${heading}\n${clipped || "(пусто)"}`;
  });
  return [head, ...body].join("\n\n");
}

/**
 * Snapshot for tool details: the panel draws a live list from it.
 *
 * We truncate the text: the details go into every progress update, and forty tasks with full
 * outputs would push hundreds of kilobytes over stdio every half second. The panel is satisfied
 * with the beginning of the task and the beginning of the answer; the full text is in the report
 * anyway.
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
  // There is no tool inside a subagent: the only reliable way to forbid nesting is not to give
  // the child anything to launch it with.
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
      `Ответ каждой задачи родителю урезан до ${OUTPUT_LIMIT} знаков: всё, что сверх, теряется. ` +
        "Поэтому в задании проси выжимку, а не весь материал, и предупреди: много данных — в файл, в ответ путь.",
      "Обрезанное в отчёте помечено — увидел такую пометку, значит ответа целиком нет:",
      "либо перезапускай задачу с явным «коротко», либо проси малый кусок отдельной задачей.",
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
        // Not set in the container — we take the parent's model, it works for sure.
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

        // We take the slot before starting: until it is granted, the task is honestly "queued".
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
