// Прогон набора задач против живого Икара и отчёт по нему.
//
//   node packages/math-eval/src/run.ts --tier smoke \
//     --key "$(grep -oP '(?<=^apiKey: ).*' ../../../config.yaml)" \
//     --grader maple --maple-bin /opt/maple18/bin/maple
//
// Каждая задача идёт в своём разговоре (свой `x-icarus-conversation-id`), поэтому
// история предыдущих задач агенту не видна. Результаты пишутся потоком: долгий
// прогон можно прервать, и уже отвеченное не потеряется.
import fs from 'node:fs';
import path from 'node:path';
import { ask, health } from './client.ts';
import { gradeProblem, type AnswerOracle } from './grade.ts';
import { journalDelta, journalEntryCounts } from './maple-journal.ts';
import { mapleOracle } from './maple-oracle.ts';
import { accuracy, renderReport } from './report.ts';
import { loadSuite, selectProblems } from './suite.ts';
import type { Outcome, Problem, RunMeta, Usage } from './types.ts';

export type RunOptions = {
  suite: string;
  problems: Problem[];
  baseUrl: string;
  apiKey: string;
  user: string;
  model: string;
  arm: string;
  repeat: number;
  timeoutMs: number;
  outDir: string;
  mapleDir: string | null;
  grader: 'strict' | 'maple';
  oracle?: AnswerOracle;
  log?: (line: string) => void;
};

export async function runSuite(options: RunOptions): Promise<{ outcomes: Outcome[]; meta: RunMeta }> {
  const startedAt = new Date().toISOString();
  fs.mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, 'results.jsonl');
  fs.writeFileSync(resultsFile, '');

  const log = options.log ?? (() => {});
  const stamp = Date.now().toString(36);
  const outcomes: Outcome[] = [];
  const total = options.problems.length * options.repeat;
  let index = 0;

  for (const problem of options.problems) {
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      index += 1;
      const conversationId = `${options.arm}-${problem.id}-${stamp}-r${repeat}`;
      const before = journalEntryCounts(options.mapleDir);
      const startedMs = Date.now();

      let content = '';
      let reasoning = '';
      let usage: Usage | null = null;
      let error: string | null = null;
      let verdict: { ok: boolean; reason: string; extracted: string | null };

      try {
        const reply = await ask(problem.question, {
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          user: options.user,
          conversationId,
          model: options.model,
          timeoutMs: options.timeoutMs,
        });
        content = reply.content;
        reasoning = reply.reasoning;
        usage = reply.usage;
        verdict = await gradeProblem(problem, content, options.oracle);
      } catch (caught) {
        error = String(caught);
        verdict = { ok: false, reason: 'ошибка вызова эндпоинта', extracted: null };
      }

      const outcome: Outcome = {
        id: problem.id,
        category: problem.category,
        arm: options.arm,
        repeat,
        ok: verdict.ok,
        reason: verdict.reason,
        extracted: verdict.extracted,
        expected: problem.answers,
        content,
        reasoning,
        ms: Date.now() - startedMs,
        mapleSteps: journalDelta(before, journalEntryCounts(options.mapleDir)),
        usage,
        error,
      };
      outcomes.push(outcome);
      fs.appendFileSync(resultsFile, `${JSON.stringify(outcome)}\n`);
      log(
        `[${index}/${total}] ${problem.id} — ${outcome.ok ? 'ок' : 'нет'} ` +
          `(${outcome.ms} мс, Maple ${outcome.mapleSteps}) — ${outcome.reason}`,
      );
    }
  }

  const meta: RunMeta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    model: options.model,
    user: options.user,
    arm: options.arm,
    suite: options.suite,
    grader: options.grader,
    repeat: options.repeat,
    problems: options.problems.length,
  };
  fs.writeFileSync(path.join(options.outDir, 'summary.json'), JSON.stringify({ meta, outcomes }, null, 2));
  fs.writeFileSync(path.join(options.outDir, 'summary.md'), renderReport(outcomes, meta));
  return { outcomes, meta };
}

// ---------------------------------------------------------------------------
// Командная строка

type CliOptions = {
  suite: string;
  baseUrl: string;
  apiKey: string;
  user: string;
  model: string;
  arm: string;
  repeat: number;
  timeoutMs: number;
  outDir: string;
  tier: 'smoke' | 'full' | 'all';
  category: string | null;
  ids: string[] | null;
  mapleDir: string | null;
  mapleBin: string | null;
  grader: 'strict' | 'maple' | null;
  dryRun: boolean;
  skipHealth: boolean;
  requireAll: boolean;
};

const USAGE = `math-eval — прогон набора математических задач против Икара.

  node packages/math-eval/src/run.ts [флаги]

  --suite <файл>       набор задач в JSONL (по умолчанию смоук-набор math-eval)
  --tier <smoke|full|all>  какие задачи брать (по умолчанию smoke)
  --category <имя>     только одна категория (integral, ode, honesty, …)
  --ids a,b,c          только перечисленные задачи
  --base-url <url>     адрес Икара (по умолчанию http://127.0.0.1:8081)
  --key <токен>        apiKey Икара (по умолчанию $ICARUS_API_KEY)
  --user <id>          человек из config.yaml (по умолчанию probe)
  --model <id>         id модели в запросе (по умолчанию icarus)
  --arm <имя>          метка прогона: maple-on / maple-off / любая (в отчёте)
  --repeat <n>         повторов на задачу (по умолчанию 1)
  --timeout-ms <n>     таймаут одного хода (по умолчанию 600000)
  --out <каталог>      куда писать results.jsonl и summary.md (по умолчанию runtime/math-eval/<штамп>)
  --maple-dir <путь>   каталог журналов Maple человека (для подсчёта шагов)
  --maple-bin <путь>   бинарь Maple для сверки ответов (включает --grader maple)
  --grader <strict|maple>  strict — строки и числа, maple — simplify(разность)=0
  --dry-run            показать задачи и выйти, ничего не спрашивая
  --skip-health        не проверять /healthz перед прогоном
  --require-all        выйти с кодом 1, если хоть одна задача не сошлась
  --help               эта справка
`;

function parseArgv(argv: string[]): CliOptions | 'help' {
  const flags = new Map<string, string>();
  const booleans = new Set(['dry-run', 'skip-health', 'require-all', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`не понимаю аргумент «${arg}»`);
    const name = arg.slice(2);
    if (booleans.has(name)) {
      flags.set(name, 'true');
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`у флага --${name} нет значения`);
    flags.set(name, value);
    i += 1;
  }
  if (flags.has('help')) return 'help';

  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name}: ожидаю положительное число, а не «${raw}»`);
    return parsed;
  };

  const tier = (flags.get('tier') ?? 'smoke') as CliOptions['tier'];
  if (tier !== 'smoke' && tier !== 'full' && tier !== 'all') throw new Error(`--tier: ожидаю smoke, full или all, а не «${tier}»`);

  const mapleBin = flags.get('maple-bin') ?? null;
  const graderFlag = flags.get('grader') ?? null;
  if (graderFlag !== null && graderFlag !== 'strict' && graderFlag !== 'maple') {
    throw new Error(`--grader: ожидаю strict или maple, а не «${graderFlag}»`);
  }
  if (graderFlag === 'maple' && mapleBin === null) throw new Error('--grader maple требует --maple-bin');

  return {
    suite: flags.get('suite') ?? defaultSuite(),
    baseUrl: flags.get('base-url') ?? 'http://127.0.0.1:8081',
    apiKey: flags.get('key') ?? process.env.ICARUS_API_KEY ?? '',
    user: flags.get('user') ?? 'probe',
    model: flags.get('model') ?? 'icarus',
    arm: flags.get('arm') ?? 'default',
    repeat: number('repeat', 1),
    timeoutMs: number('timeout-ms', 600_000),
    outDir: flags.get('out') ?? path.join('runtime', 'math-eval', new Date().toISOString().replace(/[:.]/g, '-')),
    tier,
    category: flags.get('category') ?? null,
    ids: flags.get('ids') ? (flags.get('ids') as string).split(',').map((id) => id.trim()).filter((id) => id.length > 0) : null,
    mapleDir: flags.get('maple-dir') ?? null,
    mapleBin,
    grader: graderFlag as CliOptions['grader'],
    dryRun: flags.has('dry-run'),
    skipHealth: flags.has('skip-health'),
    requireAll: flags.has('require-all'),
  };
}

/** Набор по умолчанию — рядом с исходниками, а не относительно текущего каталога. */
function defaultSuite(): string {
  return path.join(import.meta.dirname, '..', 'suites', 'maple-smoke.jsonl');
}

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const problems = selectProblems(loadSuite(parsed.suite), {
    tier: parsed.tier,
    ...(parsed.category ? { category: parsed.category } : {}),
    ...(parsed.ids ? { ids: parsed.ids } : {}),
  });

  if (parsed.dryRun) {
    process.stdout.write(`набор ${parsed.suite}: ${problems.length} задач(и)\n\n`);
    for (const problem of problems) {
      process.stdout.write(`${problem.id} [${problem.category}/${problem.tier}/${problem.kind}]\n  ${problem.question}\n`);
    }
    return 0;
  }

  if (parsed.apiKey.length === 0) {
    process.stderr.write('нет ключа: передай --key или задай ICARUS_API_KEY\n');
    return 2;
  }

  if (!parsed.skipHealth) {
    const status = await health(parsed.baseUrl);
    if (status === null) {
      process.stderr.write(
        `Икар не отвечает на ${parsed.baseUrl}/healthz — подними стек (./script/server -d) или укажи --base-url\n`,
      );
      return 2;
    }
    process.stdout.write(`Икар жив: ${JSON.stringify(status)}\n`);
  }

  const mapleDir = parsed.mapleDir;
  const grader: 'strict' | 'maple' = parsed.grader ?? (parsed.mapleBin ? 'maple' : 'strict');
  const oracle = grader === 'maple' && parsed.mapleBin ? mapleOracle(parsed.mapleBin) : undefined;

  process.stdout.write(
    `набор: ${parsed.suite}\nзадач: ${problems.length}, повторов: ${parsed.repeat}, arm: ${parsed.arm}\n` +
      `сверка: ${grader}${parsed.mapleBin ? ` (${parsed.mapleBin})` : ''}\n` +
      `журналы Maple: ${mapleDir ?? '— (шаги Maple не считаются)'}\nотчёт: ${parsed.outDir}\n\n`,
  );

  const { outcomes } = await runSuite({
    suite: parsed.suite,
    problems,
    baseUrl: parsed.baseUrl,
    apiKey: parsed.apiKey,
    user: parsed.user,
    model: parsed.model,
    arm: parsed.arm,
    repeat: parsed.repeat,
    timeoutMs: parsed.timeoutMs,
    outDir: parsed.outDir,
    mapleDir,
    grader,
    ...(oracle ? { oracle } : {}),
    log: (line) => process.stdout.write(`${line}\n`),
  });

  const solved = outcomes.filter((outcome) => outcome.ok).length;
  process.stdout.write(`\nточность: ${solved}/${outcomes.length} (${Math.round(100 * accuracy(outcomes))}%)\n`);
  return parsed.requireAll && solved !== outcomes.length ? 1 : 0;
}

const direct =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (direct) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`прогон сорвался: ${String(error)}\n`);
      process.exitCode = 2;
    });
}
