// Отчёт по прогону: markdown для чтения и JSON для сравнения прогонов.
import type { Outcome, RunMeta } from './types.ts';

export function accuracy(outcomes: Outcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.filter((outcome) => outcome.ok).length / outcomes.length;
}

function share(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${Math.round((100 * numerator) / denominator)}%`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const bucket = groups.get(name);
    if (bucket) bucket.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

function table(rows: string[][], header: string[]): string {
  const head = `| ${header.join(' | ')} |`;
  const rule = `| ${header.map(() => '---').join(' | ')} |`;
  return [head, rule, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

export function renderReport(outcomes: Outcome[], meta: RunMeta): string {
  const lines: string[] = [];
  const total = outcomes.length;
  const solved = outcomes.filter((outcome) => outcome.ok).length;
  const withMaple = outcomes.filter((outcome) => outcome.mapleSteps > 0).length;
  const errors = outcomes.filter((outcome) => outcome.error !== null).length;

  lines.push(`# math-eval: ${meta.arm}`);
  lines.push('');
  lines.push(`- набор: \`${meta.suite}\``);
  lines.push(`- эндпоинт: ${meta.baseUrl} (модель \`${meta.model}\`, человек \`${meta.user}\`)`);
  lines.push(`- сверка ответов: ${meta.grader === 'maple' ? 'Maple (simplify(разность) = 0) + числа' : 'строки + числа'}`);
  lines.push(`- задач: ${meta.problems}, попыток: ${total}, повторов: ${meta.repeat}`);
  lines.push(`- старт: ${meta.startedAt}, конец: ${meta.finishedAt}`);
  lines.push('');
  lines.push(`**Точность: ${solved}/${total} (${share(solved, total)})**`);
  lines.push('');
  lines.push(
    `Maple трогали в ${withMaple}/${total} задач (${share(withMaple, total)}), ошибок вызова: ${errors},` +
      ` медиана ответа: ${median(outcomes.map((outcome) => outcome.ms))} мс.`,
  );
  lines.push('');

  lines.push('## По категориям');
  lines.push('');
  const categories = [...groupBy(outcomes, (outcome) => outcome.category)].sort(([a], [b]) => a.localeCompare(b));
  lines.push(
    table(
      categories.map(([category, bucket]) => {
        const bucketSolved = bucket.filter((outcome) => outcome.ok).length;
        const bucketMaple = bucket.filter((outcome) => outcome.mapleSteps > 0).length;
        return [
          category,
          String(bucket.length),
          `${bucketSolved} (${share(bucketSolved, bucket.length)})`,
          share(bucketMaple, bucket.length),
          String(median(bucket.map((outcome) => outcome.ms))),
        ];
      }),
      ['категория', 'задач', 'верно', 'с Maple', 'медиана, мс'],
    ),
  );
  lines.push('');

  const failures = outcomes.filter((outcome) => !outcome.ok);
  lines.push(`## Не сошлось (${failures.length})`);
  lines.push('');
  if (failures.length === 0) {
    lines.push('Все задачи сошлись с эталоном.');
  } else {
    for (const failure of failures) {
      lines.push(`### ${failure.id} (${failure.category}, попытка ${failure.repeat})`);
      lines.push('');
      lines.push(`- почему: ${failure.reason}`);
      if (failure.expected.length > 0) lines.push(`- эталон: \`${failure.expected.join(' | ')}\``);
      lines.push(`- извлечено: ${failure.extracted === null ? '—' : `\`${failure.extracted}\``}`);
      if (failure.error) lines.push(`- ошибка: \`${failure.error}\``);
      lines.push(`- шагов Maple: ${failure.mapleSteps}`);
      lines.push('');
      lines.push('<details><summary>ответ агента</summary>');
      lines.push('');
      lines.push('```');
      lines.push(failure.content.trim().slice(0, 4000) || '(пусто)');
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('## Стоимость');
  lines.push('');
  const tokens = outcomes.reduce((sum, outcome) => sum + (outcome.usage?.total_tokens ?? 0), 0);
  const known = outcomes.filter((outcome) => outcome.usage !== null).length;
  lines.push(
    known === 0
      ? 'Эндпоинт не отдал usage.'
      : `Токенов всего: ${tokens} (по ${known} попыткам, где usage пришёл).`,
  );
  lines.push('');
  return lines.join('\n');
}
