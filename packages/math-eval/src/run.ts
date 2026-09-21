// Прогон набора задач и отчёт по нему.
//
// Две руки:
//   icarus — агент как он есть (память, тулы, Maple), адрес сервиса;
//   model  — провайдер напрямую, «чистая» модель без тулов: контрольная рука,
//            только ею можно сверяться с опубликованными числами бенчмарков.
//
//   node packages/math-eval/src/run.ts --target model \
//     --provider-url https://api.deepseek.com/v1 --provider-model deepseek-flash \
//     --suite runtime/math-eval/suites/asymob-400.jsonl --concurrency 6 \
//     --grader maple --maple-bin /opt/maple18/bin/maple --arm deepseek-flash
//
// Каждая задача идёт в своём разговоре (свой `x-icarus-conversation-id`), поэтому
// история предыдущих задач агенту не видна. Результаты пишутся потоком: долгий
// прогон можно прервать, и уже отвеченное не потеряется.
import fs from 'node:fs';
import path from 'node:path';
import { ask, health, type ChatReply } from './client.ts';
import { askDirect, providerModels } from './direct.ts';
import { gradeProblem, type AnswerOracle } from './grade.ts';
import { journalDelta, journalEntryCounts } from './maple-journal.ts';
import { mapleOracle } from './maple-oracle.ts';
import { accuracy, renderReport } from './report.ts';
import { loadSuite, selectProblems } from './suite.ts';
import type { Outcome, Problem, RunMeta, Usage } from './types.ts';

export type Target = 'icarus' | 'model';

export type RunOptions = {
  suite: string;
  problems: Problem[];
  target: Target;
  /** icarus — адрес сервиса; model — адрес провайдера. */
  baseUrl: string;
  apiKey: string;
  /** Нужен только руке icarus. */
  user: string;
  model: string;
  arm: string;
  repeat: number;
  timeoutMs: number;
  concurrency: number;
  temperature?: number;
  maxTokens?: number;
  outDir: string;
  mapleDir: string | null;
  grader: 'strict' | 'maple';
  oracle?: AnswerOracle;
  log?: (line: string) => void;
};

/** Пул из `limit` воркеров: задачи идут внахлёст, но не всей толпой. */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

async function callTarget(prompt: string, options: RunOptions, conversationId: string): Promise<ChatReply> {
  if (options.target === 'icarus') {
    return ask(prompt, {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      user: options.user,
      conversationId,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
  }
  return askDirect(prompt, {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: options.timeoutMs,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
}

export async function runSuite(options: RunOptions): Promise<{ outcomes: Outcome[]; meta: RunMeta }> {
  const startedAt = new Date().toISOString();
  fs.mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, 'results.jsonl');
  fs.writeFileSync(resultsFile, '');

  const log = options.log ?? (() => {});
  const stamp = Date.now().toString(36);
  const outcomes: Outcome[] = [];
  const tasks: Array<{ problem: Problem; repeat: number }> = [];
  for (const problem of options.problems) {
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) tasks.push({ problem, repeat });
  }
  const total = tasks.length;
  let done = 0;

  await mapWithConcurrency(tasks, options.concurrency, async ({ problem, repeat }) => {
    const conversationId = `${options.arm}-${problem.id}-${stamp}-r${repeat}`;
    const before = journalEntryCounts(options.mapleDir);
    const startedMs = Date.now();

    let content = '';
    let reasoning = '';
    let usage: Usage | null = null;
    let error: string | null = null;
    let verdict: { ok: boolean; reason: string; extracted: string | null };

    try {
      const reply = await callTarget(problem.question, options, conversationId);
      content = reply.content;
      reasoning = reply.reasoning;
      usage = reply.usage;
      verdict = await gradeProblem(problem, content, options.oracle);
    } catch (caught) {
      error = String(caught);
      verdict = { ok: false, reason: 'ошибка вызова', extracted: null };
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
    done += 1;
    log(
      `[${done}/${total}] ${problem.id} — ${outcome.ok ? 'ок' : 'нет'} ` +
        `(${outcome.ms} мс, Maple ${outcome.mapleSteps}) — ${outcome.reason}`,
    );
  });

  // Порядок завершения не должен влиять на отчёт: сортируем по задаче и попытке.
  outcomes.sort((a, b) => a.id.localeCompare(b.id) || a.repeat - b.repeat);

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
    target: options.target,
    concurrency: options.concurrency,
  };
  fs.writeFileSync(path.join(options.outDir, 'summary.json'), JSON.stringify({ meta, outcomes }, null, 2));
  fs.writeFileSync(path.join(options.outDir, 'summary.md'), renderReport(outcomes, meta));
  return { outcomes, meta };
}

// ---------------------------------------------------------------------------
// Командная строка

type CliOptions = {
  suite: string;
  target: Target;
  baseUrl: string;
  apiKey: string;
  user: string;
  model: string;
  arm: string;
  repeat: number;
  timeoutMs: number;
  concurrency: number;
  temperature: number | undefined;
  maxTokens: number | undefined;
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

const USAGE = `math-eval — прогон набора математических задач против Икара или провайдера.

  node packages/math-eval/src/run.ts [флаги]

  --target <icarus|model>  icarus — агент; model — провайдер напрямую, без тулов (по умолчанию icarus)
  --suite <файл>       набор задач в JSONL (по умолчанию смоук-набор math-eval)
  --tier <smoke|full|all>  какие задачи брать (по умолчанию smoke; у сэмпла ASyMOB все задачи full)
  --category <имя>     только одна категория (Integrals, Differential Equations, …)
  --ids a,b,c          только перечисленные задачи
  --concurrency <n>    сколько задач вести одновременно (по умолчанию 1)

  Рука icarus:
  --base-url <url>     адрес Икара (по умолчанию http://127.0.0.1:8081)
  --key <токен>        apiKey Икара (по умолчанию $ICARUS_API_KEY)
  --user <id>          человек из config.yaml (по умолчанию probe)
  --model <id>         id модели в запросе (по умолчанию icarus)

  Рука model (провайдер напрямую):
  --provider-url <url>    базовый адрес OpenAI-совместимого API (по умолчанию https://api.deepseek.com/v1)
  --provider-model <id>   id модели (по умолчанию deepseek-flash)
  --provider-key <key>    ключ провайдера (по умолчанию $DEEPSEEK_API_KEY)
  --temperature <t>       температура запроса
  --max-tokens <n>        ограничение длины ответа

  --arm <имя>          метка прогона: maple-on / deepseek-flash / любая (в отчёте)
  --repeat <n>         повторов на задачу (по умолчанию 1)
  --timeout-ms <n>     таймаут одного хода (по умолчанию 600000)
  --out <каталог>      куда писать results.jsonl и summary.md (по умолчанию runtime/math-eval/<штамп>)
  --maple-dir <путь>   каталог журналов Maple человека (для подсчёта шагов; только рука icarus)
  --maple-bin <путь>   бинарь Maple для сверки ответов (включает --grader maple)
  --grader <strict|maple>  strict — строки и числа, maple — simplify(разность)=0
  --dry-run            показать задачи и выйти, ничего не спрашивая
  --skip-health        не проверять, жив ли эндпоинт
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
  const optionalNumber = (name: string): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${name}: ожидаю число, а не «${raw}»`);
    return parsed;
  };

  const tier = (flags.get('tier') ?? 'smoke') as CliOptions['tier'];
  if (tier !== 'smoke' && tier !== 'full' && tier !== 'all') throw new Error(`--tier: ожидаю smoke, full или all, а не «${tier}»`);

  const target = (flags.get('target') ?? 'icarus') as Target;
  if (target !== 'icarus' && target !== 'model') throw new Error(`--target: ожидаю icarus или model, а не «${target}»`);

  const mapleBin = flags.get('maple-bin') ?? null;
  const graderFlag = flags.get('grader') ?? null;
  if (graderFlag !== null && graderFlag !== 'strict' && graderFlag !== 'maple') {
    throw new Error(`--grader: ожидаю strict или maple, а не «${graderFlag}»`);
  }
  if (graderFlag === 'maple' && mapleBin === null) throw new Error('--grader maple требует --maple-bin');

  const providerUrl = flags.get('provider-url') ?? 'https://api.deepseek.com/v1';

  return {
    suite: flags.get('suite') ?? defaultSuite(),
    target,
    baseUrl: target === 'model' ? providerUrl : flags.get('base-url') ?? 'http://127.0.0.1:8081',
    apiKey:
      target === 'model'
        ? flags.get('provider-key') ?? process.env.DEEPSEEK_API_KEY ?? ''
        : flags.get('key') ?? process.env.ICARUS_API_KEY ?? '',
    user: flags.get('user') ?? 'probe',
    model: target === 'model' ? flags.get('provider-model') ?? 'deepseek-flash' : flags.get('model') ?? 'icarus',
    arm: flags.get('arm') ?? 'default',
    repeat: number('repeat', 1),
    timeoutMs: number('timeout-ms', 600_000),
    concurrency: number('concurrency', 1),
    temperature: optionalNumber('temperature'),
    maxTokens: optionalNumber('max-tokens'),
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
    for (const problem of problems.slice(0, 10)) {
      process.stdout.write(`${problem.id} [${problem.category}/${problem.tier}/${problem.kind}]\n  ${problem.question}\n`);
    }
    if (problems.length > 10) process.stdout.write(`… и ещё ${problems.length - 10}\n`);
    return 0;
  }

  if (parsed.apiKey.length === 0) {
    process.stderr.write(
      parsed.target === 'model'
        ? 'нет ключа провайдера: передай --provider-key или задай DEEPSEEK_API_KEY\n'
        : 'нет ключа: передай --key или задай ICARUS_API_KEY\n',
    );
    return 2;
  }

  if (!parsed.skipHealth) {
    if (parsed.target === 'icarus') {
      const status = await health(parsed.baseUrl);
      if (status === null) {
        process.stderr.write(
          `Икар не отвечает на ${parsed.baseUrl}/healthz — подними стек (./script/server -d) или укажи --base-url\n`,
        );
        return 2;
      }
      process.stdout.write(`Икар жив: ${JSON.stringify(status)}\n`);
    } else {
      const models = await providerModels({ baseUrl: parsed.baseUrl, apiKey: parsed.apiKey });
      if (models === null) {
        process.stderr.write(`провайдер ${parsed.baseUrl} не ответил на /models — проверь адрес и ключ\n`);
        return 2;
      }
      process.stdout.write(`провайдер жив, модели: ${models.join(', ')}\n`);
      if (!models.includes(parsed.model)) {
        process.stderr.write(`[!] модели «${parsed.model}» нет в списке — провайдер может ответить ошибкой\n`);
      }
    }
  }

  const grader: 'strict' | 'maple' = parsed.grader ?? (parsed.mapleBin ? 'maple' : 'strict');
  const oracle = grader === 'maple' && parsed.mapleBin ? mapleOracle(parsed.mapleBin) : undefined;

  process.stdout.write(
    `набор: ${parsed.suite}\nзадач: ${problems.length}, повторов: ${parsed.repeat}, arm: ${parsed.arm}, target: ${parsed.target}\n` +
      `модель: ${parsed.model} @ ${parsed.baseUrl}\nпараллельно: ${parsed.concurrency}\n` +
      `сверка: ${grader}${parsed.mapleBin ? ` (${parsed.mapleBin})` : ''}\n` +
      `журналы Maple: ${parsed.mapleDir ?? '— (шаги Maple не считаются)'}\nотчёт: ${parsed.outDir}\n\n`,
  );

  const { outcomes } = await runSuite({
    suite: parsed.suite,
    problems,
    target: parsed.target,
    baseUrl: parsed.baseUrl,
    apiKey: parsed.apiKey,
    user: parsed.user,
    model: parsed.model,
    arm: parsed.arm,
    repeat: parsed.repeat,
    timeoutMs: parsed.timeoutMs,
    concurrency: parsed.concurrency,
    ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
    ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
    outDir: parsed.outDir,
    mapleDir: parsed.mapleDir,
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
