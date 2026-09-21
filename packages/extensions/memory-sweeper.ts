// Ежедневная уборка памяти: расширение-планировщик.
//
// Крона в контейнере нет: pi-процесс живёт, пока идёт разговор, и гаснет по простою.
// Поэтому уборку запускаем сами — по agent_settled, выждав затишье, и не чаще раза
// в сутки. Отметка о прогоне лежит вне репозитория памяти (WORKSPACE/.sweep.json),
// иначе `git add -A` экстрактора закоммитил бы и её.
//
// Сама логика — в lib/memory-sweep.ts; здесь только расписание, вызов дешёвой модели
// и коммит. Любая ошибка оставляет память нетронутой: частично убранной памяти быть
// не должно, поэтому applySweepPlan пишет файлы лишь после полной проверки плана.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitMemory, runOneShot } from "./memory-extractor.ts";
import {
  applySweepPlan,
  buildSweepPrompt,
  collectMemoryFiles,
  parseSweepPlan,
  readSweepState,
  sweepAfterHours,
  sweepDue,
  sweepStatePath,
  writeSweepState,
} from "./lib/memory-sweep.ts";

const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";
const WORKSPACE = process.env.ICARUS_WORKSPACE ?? "/workspace";
const AFTER_HOURS = sweepAfterHours(process.env.ICARUS_SWEEP_AFTER_HOURS);
const STATE = sweepStatePath(WORKSPACE);
// Уборка идёт следом за разбором разговора: пусть сначала договорит экстрактор, иначе
// два `git commit` в одной памяти столкнутся за index.lock.
const QUIET_MS = Number(process.env.ICARUS_EXTRACT_AFTER_MS ?? 90_000) + 30_000;
const TIMEOUT_MS = 120_000;

function log(message: string): void {
  process.stderr.write(`[memory-sweeper] ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const runSweep = async (): Promise<void> => {
    if (running || AFTER_HOURS <= 0) return;
    const startedAt = new Date();
    if (!sweepDue(readSweepState(STATE), startedAt, AFTER_HOURS)) return;

    running = true;
    try {
      const files = collectMemoryFiles(MEMORY, startedAt);
      if (files.length === 0) {
        log("память пуста — убирать нечего");
        return;
      }
      const plan = parseSweepPlan(await runOneShot(buildSweepPrompt(files, startedAt), TIMEOUT_MS));
      if (!plan) {
        log("модель не вернула разбираемый план — память не трогаю");
        return;
      }
      const result = applySweepPlan(MEMORY, plan, startedAt);
      if (result.changed.length === 0) {
        log(`уборка: переносить нечего (пропущено ${result.skipped.length})`);
        return;
      }
      const committed = await commitMemory(MEMORY, `memory: уборка (${result.changed.length} файлов)`);
      log(`убрано: ${result.changed.join(", ")}${committed ? "" : " (без коммита)"}`);
    } catch (error) {
      log(`уборка сорвалась, память не тронута: ${String(error)}`);
    } finally {
      running = false;
      try {
        // Отметку ставим и после неудачи: иначе сбойная попытка повторялась бы после
        // каждого разговора, а уборка задумана раз в сутки.
        writeSweepState(STATE, { lastRunAt: startedAt.toISOString() });
      } catch (error) {
        log(`не смог записать состояние уборки: ${String(error)}`);
      }
    }
  };

  pi.on("agent_settled", () => {
    cancel();
    if (AFTER_HOURS <= 0) return;
    timer = setTimeout(() => void runSweep(), QUIET_MS);
    timer.unref?.();
  });

  pi.on("agent_start", () => cancel());

  pi.on("session_shutdown", () => cancel());
}
