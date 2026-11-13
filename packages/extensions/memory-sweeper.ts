// Daily memory cleanup: a scheduler extension.
//
// There is no cron in the container: the pi process lives while a conversation goes on and
// shuts down when idle. So we start the cleanup ourselves — on agent_settled, after waiting
// for quiet, and no more than once a day. The run marker lives outside the memory repository
// (.icarus/.sweep.json), otherwise the extractor's `git add -A` would commit it too.
//
// The logic itself is in lib/memory-sweep.ts; here there is only the schedule, the call to the
// cheap model and the commit. Any error leaves the memory untouched: there must be no
// partially swept memory, so applySweepPlan writes files only after fully validating the plan.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitMemory, runOneShot } from "./memory-extractor.ts";
import {
  applySweepPlan,
  buildSweepPrompt,
  collectJournals,
  collectMemoryFiles,
  parseSweepPlan,
  readSweepState,
  sweepAfterHours,
  sweepDue,
  sweepStatePath,
  writeSweepState,
} from "./lib/memory-sweep.ts";

const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`;
const AFTER_HOURS = sweepAfterHours(process.env.ICARUS_SWEEP_AFTER_HOURS);
const STATE = sweepStatePath(ICARUS);
// The cleanup follows the conversation extraction: let the extractor finish first, otherwise
// two `git commit`s in one memory will collide over index.lock.
const QUIET_MS = Number(process.env.ICARUS_EXTRACT_AFTER_MS ?? 90_000) + 30_000;
// The cleanup is one model call with the whole memory at once. The request is cheap (~8.4k input
// and ~1.5k output tokens), but DeepInfra has huge variance: the same call in production answered
// in both 16 s and 234 s. 120 s cut the slow tail, so the timeout is generous.
const TIMEOUT_MS = 600_000;

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
      const files = collectMemoryFiles(MEMORY);
      if (files.length === 0) {
        log("память пуста — убирать нечего");
        return;
      }
      // We do not put the journals in the prompt: only their presence. The cleanup does not
      // touch them anyway.
      const plan = parseSweepPlan(
        await runOneShot(buildSweepPrompt(files, startedAt, collectJournals(MEMORY)), TIMEOUT_MS),
      );
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
      const merged = plan.merges.length > 0 ? `, слияний ${plan.merges.length}` : "";
      log(`убрано: ${result.changed.join(", ")}${merged}${committed ? "" : " (без коммита)"}`);
    } catch (error) {
      log(`уборка сорвалась, память не тронута: ${String(error)}`);
    } finally {
      running = false;
      try {
        // We set the marker even after a failure: otherwise a failed attempt would repeat after
        // every conversation, and the cleanup is meant to run once a day.
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
