// Ежедневная уборка памяти: чистые функции без pi — промпт, разбор плана и его
// применение. Главное здесь — уборка переносит, переформулирует и сливает, но не
// удаляет: несовпавший или непонятный пункт пропускается, а не отменяет весь план.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applySweepPlan,
  buildSweepPrompt,
  collectJournals,
  collectMemoryFiles,
  lineNumberOf,
  parseSweepPlan,
  readSweepState,
  sweepAfterHours,
  sweepDue,
  sweepStatePath,
  writeSweepState,
  SWEEP_PROMPT_BUDGET,
  type SweepPlan,
} from '../../extensions/lib/memory-sweep.ts';

/** План для теста: то, что в нём не проверяем, — пустое. */
function planOf(parts: Partial<SweepPlan>): SweepPlan {
  return { merges: [], moves: [], rewrites: [], ...parts };
}

function tempMemory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-sweep-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  return dir;
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('уборка видит полки, но не читает журналы', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара\n');
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра\n');
  fs.writeFileSync(path.join(root, 'projects/дом.md'), '- Строит дом\n');
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '# 2026-09\n- 15.09 — разговор\n');
  fs.writeFileSync(path.join(root, 'journal/2026-08.md'), '- 01.08 — разговор\n');
  fs.writeFileSync(path.join(root, 'journal/2026-07.md'), '- 01.07 — старое\n');

  const files = collectMemoryFiles(root);
  assert.deepEqual(
    files.map((file) => file.path),
    ['identity.md', 'preferences.md', 'people/маша.md', 'projects/дом.md'],
  );
});

test('журналы отдаются наличием: имя, записи, объём', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '# 2026-09\n- 15.09 — разговор\n- 16.09 — ещё\n');
  fs.writeFileSync(path.join(root, 'journal/2025-12.md'), '- 20.12 — старое\n');

  const journals = collectJournals(root);
  assert.deepEqual(
    journals.map((journal) => journal.path),
    ['journal/2025-12.md', 'journal/2026-09.md'],
    'журналы перечисляем все: это только список, а не содержимое',
  );
  assert.equal(journals[0].entries, 1);
  assert.equal(journals[1].entries, 2);
  assert.ok(journals[1].bytes > 0);
});

test('содержимое журнала в промпт не попадает — только наличие', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '- 15.09 — секретная строка журнала\n');

  const prompt = buildSweepPrompt(collectMemoryFiles(root), new Date(2026, 8, 15), collectJournals(root));
  assert.match(prompt, /journal\/2026-09\.md — 1 записей/, 'файл назван и посчитан');
  assert.doesNotMatch(prompt, /секретная строка журнала/, 'содержимого журнала в промпте нет');
  assert.doesNotMatch(prompt, /L1: - 15\.09/, 'строк журнала в нумерации нет');
});

test('промпт уборки содержит память и запрещает удаление', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Переехал в Порту на полгода\n');
  const prompt = buildSweepPrompt(collectMemoryFiles(root), new Date(2026, 8, 15));

  assert.match(prompt, /Переехал в Порту на полгода/, 'модель должна видеть саму память');
  assert.match(prompt, /L1: - Переехал в Порту на полгода/, 'строки памяти пронумерованы');
  assert.match(prompt, /"line":12,"quote"/, 'в примере строка адресуется номером и цитатой');
  assert.match(prompt, /identity\.md/);
  assert.match(prompt, /Удалять информацию/);
  assert.match(prompt, /Не выдумывай|не выдумывай|Выдумывать факты/);
  assert.match(prompt, /projects\/zdorovie\.md/);
  assert.match(prompt, /по состоянию на 15\.09\.2026/);
  assert.match(prompt, /merges/, 'близнецов велено сливать');
  assert.match(prompt, /щенок\.md, projects\/собака\.md, projects\/дори\.md/, 'пример близнецов назван');
  assert.match(prompt, /разбей|Разросшийся файл/, 'разросшиеся файлы велено дробить по темам');
});

test('план без цели и любое удаление отбрасываются', () => {
  // Перенос без to — это удаление строки, а не перенос.
  assert.equal(parseSweepPlan('{"moves":[{"from":"identity.md","line":"- Переехал"}]}'), null);
  assert.equal(parseSweepPlan('{"moves":[{"from":"identity.md","line":"- Переехал","to":""}]}'), null);
  // Переформулировка в пустоту — то же удаление.
  assert.equal(parseSweepPlan('{"rewrites":[{"file":"identity.md","from":"- Переехал","to":"  "}]}'), null);
  assert.equal(parseSweepPlan('{"delete":[{"file":"identity.md","line":"- Переехал"}]}'), null);
  // В журнал уборка не пишет сама через план: это не полка модели.
  assert.equal(parseSweepPlan('{"moves":[{"from":"identity.md","line":"- x","to":"journal/2026-09.md"}]}'), null);
});

test('разбор плана отбрасывает неизвестные файлы', () => {
  const raw = JSON.stringify({
    moves: [
      { from: 'shared-memory/общее.md', line: '- чужое', to: 'preferences.md' },
      { from: 'identity.md', line: '- х', to: '../../etc/passwd' },
      { from: 'identity.md', line: '- Переехал в Порту', to: 'projects/переезд.md' },
    ],
    rewrites: [{ file: 'notes.txt', from: '- a', to: '- b' }],
  });

  const plan = parseSweepPlan(raw);
  assert.ok(plan);
  assert.deepEqual(plan?.moves, [
    { from: 'identity.md', index: undefined, quote: '- Переехал в Порту', to: 'projects/переезд.md', append: undefined },
  ]);
  assert.deepEqual(plan?.rewrites, []);
});

test('номер строки принимается числом, строкой и с префиксом L', () => {
  assert.equal(lineNumberOf(12), 12);
  assert.equal(lineNumberOf('12'), 12);
  assert.equal(lineNumberOf('L12'), 12);
  assert.equal(lineNumberOf(' l3 '), 3);
  assert.equal(lineNumberOf('- текст строки'), undefined, 'текст — это цитата старого формата');
  assert.equal(lineNumberOf(0), undefined);
  assert.equal(lineNumberOf(1.5), undefined);
  assert.equal(lineNumberOf(null), undefined);
});

test('план с номерами строк разбирается, а пункт без цитаты отбрасывается', () => {
  const plan = parseSweepPlan(
    JSON.stringify({
      moves: [
        { from: 'identity.md', line: 12, quote: '- Переехал в Порту', to: 'projects/переезд.md' },
        // Номер без цитаты: вслепую по номеру память не правим.
        { from: 'identity.md', line: 3, to: 'projects/переезд.md' },
        { from: 'identity.md', line: 'L7', quote: '- Зовут Саня', to: 'people/саня.md' },
      ],
      rewrites: [{ file: 'identity.md', line: 4, quote: '- Работает в банке', to: '- Работает в банке, в IT' }],
    }),
  );

  assert.deepEqual(plan?.moves, [
    { from: 'identity.md', index: 12, quote: '- Переехал в Порту', to: 'projects/переезд.md', append: undefined },
    { from: 'identity.md', index: 7, quote: '- Зовут Саня', to: 'people/саня.md', append: undefined },
  ]);
  assert.deepEqual(plan?.rewrites, [
    { file: 'identity.md', index: 4, quote: '- Работает в банке', to: '- Работает в банке, в IT' },
  ]);
});

test('старый формат с цитатой вместо номера ещё разбирается', () => {
  const plan = parseSweepPlan(
    '{"moves":[{"from":"identity.md","line":"- Переехал в Порту","to":"projects/переезд.md"}],' +
      '"rewrites":[{"file":"identity.md","from":"- Зовут Саня","to":"- Зовут Саня, из Москвы"}]}',
  );

  assert.deepEqual(plan?.moves, [
    { from: 'identity.md', index: undefined, quote: '- Переехал в Порту', to: 'projects/переезд.md', append: undefined },
  ]);
  assert.deepEqual(plan?.rewrites, [
    { file: 'identity.md', index: undefined, quote: '- Зовут Саня', to: '- Зовут Саня, из Москвы' },
  ]);
});

test('мусор вместо JSON — это отсутствие плана', () => {
  assert.equal(parseSweepPlan('никакого json'), null);
  assert.equal(parseSweepPlan('{"moves":[]}'), null);
  assert.equal(parseSweepPlan('{"moves":[{}],"rewrites":[{"file":"identity.md"}]}'), null);
});

test('перенос уносит строку из источника и сохраняет текст в цели', () => {
  const root = tempMemory();
  fs.writeFileSync(
    path.join(root, 'identity.md'),
    '# Кто это\n- Переехал в Порту на полгода\n- Зовут Саня\n',
  );
  fs.writeFileSync(path.join(root, 'projects/переезд.md'), '# Переезд\n- Старое дело\n');

  const result = applySweepPlan(
    root,
    planOf({
      moves: [
        {
          from: 'identity.md',
          quote: '- Переехал в Порту на полгода',
          to: 'projects/переезд.md',
          append: '- По состоянию на 15.09.2026: переехал в Порту на полгода',
        },
      ],
      rewrites: [],
    }),
    new Date(2026, 8, 15),
  );

  assert.deepEqual(result.changed.sort(), ['identity.md', 'projects/переезд.md']);
  assert.doesNotMatch(read(root, 'identity.md'), /Переехал/, 'закрытое состояние ушло из identity');
  assert.match(read(root, 'identity.md'), /Зовут Саня/, 'остальное в identity не тронуто');
  assert.match(read(root, 'projects/переезд.md'), /- По состоянию на 15\.09\.2026: переехал в Порту/);
  assert.match(read(root, 'projects/переезд.md'), /- Старое дело/, 'старые пункты цели живы');
});

test('перенос без append сохраняет строку дословно, вместе с цитатой', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Пьёт сенчу (его слова: «пью сенчу»)\n');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара\n');

  applySweepPlan(root, planOf({
    moves: [
      { from: 'identity.md', quote: '- Пьёт сенчу (его слова: «пью сенчу»)', to: 'preferences.md' },
    ],
    rewrites: [],
  }));

  assert.match(read(root, 'preferences.md'), /- Пьёт сенчу \(его слова: «пью сенчу»\)/);
  assert.doesNotMatch(read(root, 'identity.md'), /сенчу/);
});

test('перенос создаёт целевой файл, если его ещё нет', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Болел ангиной в марте\n');

  const result = applySweepPlan(root, planOf({
    moves: [
      {
        from: 'identity.md',
        quote: '- Болел ангиной в марте',
        to: 'projects/здоровье.md',
        append: '- По состоянию на 15.09.2026: ангина в марте, уже закрыто',
      },
    ],
    rewrites: [],
  }));

  assert.deepEqual(result.changed.sort(), ['identity.md', 'projects/здоровье.md']);
  assert.match(read(root, 'projects/здоровье.md'), /ангина в марте/);
});

test('эквивалентная строка в цели не дублируется', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Кофе без сахара\n');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара\n');

  const result = applySweepPlan(root, planOf({
    moves: [{ from: 'identity.md', quote: '- Кофе без сахара', to: 'preferences.md' }],
    rewrites: [],
  }));

  assert.deepEqual(result.changed, [], 'трогать нечего: факт уже на месте');
  assert.deepEqual(result.skipped, ['preferences.md']);
  assert.equal(read(root, 'preferences.md').split('\n').filter((line) => /Кофе без сахара/.test(line)).length, 1);
});

test('похожая строка в цели: перенос пропущен, источник не тронут', () => {
  // isDuplicate ловит перефраз с порогом 0.7 — источник терять из-за него нельзя.
  const root = tempMemory();
  const source = '- Не будить раньше 09:00.\n';
  const target = '- Не будить раньше 9 утра\n';
  fs.writeFileSync(path.join(root, 'identity.md'), source);
  fs.writeFileSync(path.join(root, 'preferences.md'), target);

  const result = applySweepPlan(root, planOf({
    moves: [{ from: 'identity.md', quote: '- Не будить раньше 09:00.', to: 'preferences.md' }],
    rewrites: [],
  }));

  assert.deepEqual(result.changed, [], 'ничего не переписываем');
  assert.deepEqual(result.skipped, ['preferences.md']);
  assert.equal(read(root, 'identity.md'), source, 'исходная строка осталась нетронутой');
  assert.equal(read(root, 'preferences.md'), target, 'цель не изменилась');
});

test('перенос в тот же файл — это переформулировка на месте', () => {
  const root = tempMemory();
  const source = '- Работает в банке\n- Зовут Саня\n';
  fs.writeFileSync(path.join(root, 'identity.md'), source);

  const result = applySweepPlan(
    root,
    planOf({
      moves: [{ from: 'identity.md', quote: '- Работает в банке', to: 'identity.md', append: '- Работает в банке, в IT' }],
      rewrites: [],
    }),
    new Date(2026, 8, 15),
  );

  assert.deepEqual(result.changed, ['identity.md']);
  assert.match(read(root, 'identity.md'), /- Работает в банке, в IT/);
  assert.match(read(root, 'identity.md'), /- Зовут Саня/);
});

test('переформулировка меняет строку, а соседние не трогает', () => {
  const root = tempMemory();
  fs.writeFileSync(
    path.join(root, 'identity.md'),
    '- Работает в банке\n- Переехал в Порту на полгода\n',
  );

  const result = applySweepPlan(
    root,
    planOf({
      moves: [],
      rewrites: [
        {
          file: 'identity.md',
          quote: '- Переехал в Порту на полгода',
          to: '- По состоянию на 15.09.2026: живёт в Порту',
        },
      ],
    }),
    new Date(2026, 8, 15),
  );

  assert.deepEqual(result.changed, ['identity.md']);
  const saved = read(root, 'identity.md');
  assert.match(saved, /- Работает в банке/);
  assert.match(saved, /- По состоянию на 15\.09\.2026: живёт в Порту/);
  assert.doesNotMatch(saved, /Переехал/);
});

test('несовпавший пункт пропускается, остальной план применяется', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Работает в банке\n- Зовут Саня\n');

  const result = applySweepPlan(root, planOf({
    moves: [
      { from: 'identity.md', index: 1, quote: '- Работает в банке', to: 'preferences.md' },
      // Как в жизни: цитата с задвоенным хвостом, такой строки в файле нет.
      { from: 'identity.md', quote: '- Зовут Саня (его слова: «Зовут Саня») (его слова: «Зовут Саня»)', to: 'preferences.md' },
    ],
    rewrites: [],
  }));

  assert.deepEqual(result.changed.sort(), ['identity.md', 'preferences.md']);
  assert.deepEqual(result.skipped, ['identity.md']);
  assert.match(read(root, 'preferences.md'), /- Работает в банке/);
  assert.match(read(root, 'identity.md'), /- Зовут Саня/, 'несовпавший пункт ничего не тронул');
});

test('номер находит строку, даже если цитата отличается вёрсткой', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Работает в банке\n-   Зовут   Саня\n');

  const result = applySweepPlan(root, planOf({
    moves: [{ from: 'identity.md', index: 2, quote: '- Зовут Саня', to: 'preferences.md' }],
    rewrites: [],
  }));

  assert.deepEqual(result.changed.sort(), ['identity.md', 'preferences.md']);
  assert.deepEqual(result.skipped, []);
  assert.match(read(root, 'preferences.md'), /- {3}Зовут {3}Саня/, 'переносится строка как в файле');
  assert.doesNotMatch(read(root, 'identity.md'), /Саня/);
});

test('цитата, скопированная вместе с номером из промпта, — тот же якорь', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Работает в банке\n- Зовут Саня\n');

  const result = applySweepPlan(root, planOf({
    moves: [{ from: 'identity.md', index: 2, quote: 'L2: - Зовут Саня', to: 'preferences.md' }],
    rewrites: [],
  }));

  assert.deepEqual(result.changed.sort(), ['identity.md', 'preferences.md']);
  assert.match(read(root, 'preferences.md'), /- Зовут Саня/);
  assert.doesNotMatch(read(root, 'identity.md'), /Саня/);
});

test('чужой номер не мешает: точная цитата ищется по тексту', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Работает в банке\n- Зовут Саня\n');

  const result = applySweepPlan(root, planOf({
    moves: [],
    // Номер указывает на первую строку, цитата — на вторую. Цитата точная и одна такая.
    rewrites: [{ file: 'identity.md', index: 1, quote: '- Зовут Саня', to: '- Зовут Саня, из Москвы' }],
  }));

  assert.deepEqual(result.changed, ['identity.md']);
  const saved = read(root, 'identity.md');
  assert.match(saved, /- Зовут Саня, из Москвы/);
  assert.match(saved, /- Работает в банке/, 'строка под неверным номером не тронута');
});

test('дубль строки без верного якоря не правим', () => {
  const root = tempMemory();
  const before = '- Кофе без сахара\n- Кофе без сахара\n';
  fs.writeFileSync(path.join(root, 'identity.md'), before);

  const result = applySweepPlan(root, planOf({
    moves: [],
    rewrites: [{ file: 'identity.md', quote: '- Кофе без сахара', to: '- Кофе без сахара и молока' }],
  }));

  assert.deepEqual(result.changed, [], 'непонятно, какую из двух строк править');
  assert.deepEqual(result.skipped, ['identity.md']);
  assert.equal(read(root, 'identity.md'), before);
});

test('неизвестная полка в применении пропускается, память не тронута', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');

  const result = applySweepPlan(root, planOf({
    moves: [{ from: 'identity.md', quote: '- Зовут Саня', to: 'shared-memory/общее.md' }],
    rewrites: [],
  }));

  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.skipped, ['shared-memory/общее.md']);
  assert.equal(read(root, 'identity.md'), '- Зовут Саня\n');
});

test('журнал уборки дописывается отдельной строкой', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '# 2026-09\n- 15.09 — разговор\n');

  const result = applySweepPlan(
    root,
    planOf({ moves: [], rewrites: [], journal: 'перенёс переезд в проекты' }),
    new Date(2026, 8, 15),
  );

  assert.deepEqual(result.changed, ['journal/2026-09.md']);
  assert.match(read(root, 'journal/2026-09.md'), /- 15\.09 — уборка: перенёс переезд в проекты/);
});

test('слияние близнецов: содержимое переезжает, источники исчезают', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), '- Забрали щенка 28.09.2026\n');
  fs.writeFileSync(path.join(root, 'projects/собака.md'), '- Завели бассет-хаунда\n');
  fs.writeFileSync(path.join(root, 'projects/дори.md'), '- Зовут Дори\n');

  const result = applySweepPlan(root, planOf({
    merges: [{ into: 'projects/дори.md', files: ['projects/щенок.md', 'projects/собака.md'] }],
  }));

  assert.deepEqual(result.changed.sort(), ['projects/дори.md', 'projects/собака.md', 'projects/щенок.md']);
  assert.deepEqual(result.skipped, []);
  const merged = read(root, 'projects/дори.md');
  assert.match(merged, /- Зовут Дори/, 'свои строки цели живы');
  assert.match(merged, /- Забрали щенка 28\.09\.2026/, 'уникальное из первого источника переехало');
  assert.match(merged, /- Завели бассет-хаунда/, 'уникальное из второго источника переехало');
  assert.equal(fs.existsSync(path.join(root, 'projects/щенок.md')), false, 'источник исчез');
  assert.equal(fs.existsSync(path.join(root, 'projects/собака.md')), false, 'и второй тоже');
});

test('слияние выбрасывает повторы, но не теряет уникальное', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), '- Щенку 3 месяца\n- Забрали 28.09.2026\n');
  fs.writeFileSync(path.join(root, 'projects/дори.md'), '- По состоянию на 27.09.2026 — щенку 3 месяца.\n');

  applySweepPlan(root, planOf({
    merges: [{ into: 'projects/дори.md', files: ['projects/щенок.md'] }],
  }));

  const merged = read(root, 'projects/дори.md');
  assert.equal(merged.match(/3 месяца/g)?.length, 1, 'тот же факт не задвоился');
  assert.match(merged, /Забрали 28\.09\.2026/, 'уникальная строка не потерялась');
});

test('слияние с нечитаемым источником пропускается целиком', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/дори.md'), '- Зовут Дори\n');

  const result = applySweepPlan(root, planOf({
    merges: [{ into: 'projects/дори.md', files: ['projects/щенок.md'] }],
  }));

  assert.deepEqual(result.changed, [], 'ничего не тронуто');
  assert.deepEqual(result.skipped, ['projects/дори.md']);
  assert.equal(read(root, 'projects/дори.md'), '- Зовут Дори\n');
});

test('разбор слияний: только файлы-темы, без себя и повторов', () => {
  const plan = parseSweepPlan(
    JSON.stringify({
      merges: [
        {
          into: 'projects/дори.md',
          files: ['projects/щенок.md', 'projects/щенок.md', 'projects/дори.md', 'identity.md', 'shared-memory/общее.md'],
        },
        // Полку слить нельзя: identity.md — место, а не тема.
        { into: 'identity.md', files: ['projects/щенок.md'] },
        { into: 'projects/дом.md', files: [] },
      ],
    }),
  );

  assert.deepEqual(plan?.merges, [{ into: 'projects/дори.md', files: ['projects/щенок.md'] }]);
  assert.deepEqual(plan?.moves, []);
});

test('цепочка слияний не теряет факты: щенок → дори → собаки', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), '- Щенку 3 месяца\n');
  fs.writeFileSync(path.join(root, 'projects/дори.md'), '- Зовут Дори\n');
  fs.writeFileSync(path.join(root, 'projects/собаки.md'), '- Собака живёт в доме\n');

  const result = applySweepPlan(root, planOf({
    merges: [
      { into: 'projects/дори.md', files: ['projects/щенок.md'] },
      { into: 'projects/собаки.md', files: ['projects/дори.md'] },
    ],
  }));

  assert.deepEqual(result.skipped, []);
  const merged = read(root, 'projects/собаки.md');
  assert.match(merged, /Собака живёт в доме/);
  assert.match(merged, /Зовут Дори/, 'промежуточная цель доехала до конца цепочки');
  assert.match(merged, /Щенку 3 месяца/, 'и дальний источник тоже');
  assert.equal(fs.existsSync(path.join(root, 'projects/щенок.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'projects/дори.md')), false);
});

test('кольцо слияний пропускается: непонятно, кто кого поглощает', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/а.md'), '- Факт А\n');
  fs.writeFileSync(path.join(root, 'projects/б.md'), '- Факт Б\n');

  const result = applySweepPlan(root, planOf({
    merges: [
      { into: 'projects/а.md', files: ['projects/б.md'] },
      { into: 'projects/б.md', files: ['projects/а.md'] },
    ],
  }));

  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.skipped, ['projects/а.md', 'projects/б.md']);
  assert.equal(read(root, 'projects/а.md'), '- Факт А\n');
  assert.equal(read(root, 'projects/б.md'), '- Факт Б\n');
});

test('перенос из слитого файла пропускается: файла в памяти уже нет', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), '- Щенку 3 месяца\n');
  fs.writeFileSync(path.join(root, 'projects/дори.md'), '- Зовут Дори\n');

  const result = applySweepPlan(root, planOf({
    merges: [{ into: 'projects/дори.md', files: ['projects/щенок.md'] }],
    moves: [{ from: 'projects/щенок.md', quote: '- Щенку 3 месяца', to: 'preferences.md' }],
  }));

  assert.deepEqual(result.skipped, ['projects/щенок.md']);
  assert.match(read(root, 'projects/дори.md'), /Щенку 3 месяца/, 'строка осталась в слитом файле');
  assert.equal(fs.existsSync(path.join(root, 'preferences.md')), false, 'в чужую полку не уехала');
});

test('опустевший файл-тема исчезает, а полка остаётся', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Единственная строка\n');
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), '- Щенку 3 месяца\n');

  const result = applySweepPlan(root, planOf({
    moves: [
      { from: 'identity.md', quote: '- Единственная строка', to: 'preferences.md' },
      { from: 'projects/щенок.md', quote: '- Щенку 3 месяца', to: 'projects/дори.md' },
    ],
  }));

  assert.ok(result.changed.includes('projects/щенок.md'));
  assert.equal(fs.existsSync(path.join(root, 'identity.md')), true, 'полка живёт всегда');
  assert.equal(fs.existsSync(path.join(root, 'projects/щенок.md')), false, 'тема без строк исчезла');
  assert.match(read(root, 'projects/дори.md'), /Щенку 3 месяца/);
});

test('файл показывается целиком, обрезки «показано начало» больше нет', () => {
  const root = tempMemory();
  const content = `${Array.from({ length: 500 }, (_, index) => `- факт ${index}`).join('\n')}\n`;
  fs.writeFileSync(path.join(root, 'preferences.md'), content);

  const prompt = buildSweepPrompt(collectMemoryFiles(root), new Date(2026, 8, 15));
  assert.match(prompt, /L500: - факт 499/, 'виден последний пункт файла');
  assert.doesNotMatch(prompt, /показано начало/);
});

test('файл, не влезший в бюджет, не показывается, но назван', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  const huge = '- оченьдлиннаястрока\n'.repeat(Math.ceil(SWEEP_PROMPT_BUDGET / 10) + 10);
  fs.writeFileSync(path.join(root, 'projects/огромный.md'), huge);

  const prompt = buildSweepPrompt(collectMemoryFiles(root), new Date(2026, 8, 15));
  assert.match(prompt, /L1: - Зовут Саня/, 'маленький файл на месте');
  assert.doesNotMatch(prompt, /оченьдлиннаястрока/, 'огрызок большого файла не показываем');
  assert.match(prompt, /Не показаны/);
  assert.match(prompt, /projects\/огромный\.md — \d+ символов/);
});

test('интервал уборки читается из окружения, 0 — выключено', () => {
  assert.equal(sweepAfterHours(undefined), 24);
  assert.equal(sweepAfterHours(''), 24);
  assert.equal(sweepAfterHours('мусор'), 24);
  assert.equal(sweepAfterHours('-3'), 24);
  assert.equal(sweepAfterHours('6'), 6);
  assert.equal(sweepAfterHours('0'), 0);
});

test('состояние уборки: dot-файл вне памяти и проверка интервала', () => {
  assert.equal(sweepStatePath('/workspace'), path.join('/workspace', '.sweep.json'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-sweep-state-'));
  const file = sweepStatePath(dir);
  assert.deepEqual(readSweepState(file), {}, 'нет файла — нет отметки');
  writeSweepState(file, { lastRunAt: '2026-09-15T00:00:00.000Z' });
  assert.deepEqual(readSweepState(file), { lastRunAt: '2026-09-15T00:00:00.000Z' });

  fs.writeFileSync(file, 'не json');
  assert.deepEqual(readSweepState(file), {});

  const now = new Date('2026-09-15T12:00:00.000Z');
  assert.equal(sweepDue({}, now, 24), true);
  assert.equal(sweepDue({ lastRunAt: '2026-09-15T11:00:00.000Z' }, now, 24), false);
  assert.equal(sweepDue({ lastRunAt: '2026-09-14T11:00:00.000Z' }, now, 24), true);
  assert.equal(sweepDue({}, now, 0), false, '0 часов — уборка выключена');
});
