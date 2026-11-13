// Control panel: memory entries and file history.
//
// An entry is a bullet line that has a number in the file (used to delete it) and
// the date of the commit that touched it (shown by the panel). Headings and text
// are not considered entries: they have no checkbox, and they cannot be deleted — together with
// a heading the whole section would go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntries, readEntries, ENTRIES_LIMIT } from '../src/control/entries.ts';
import { blameLines, ensureRepo, fileHistory } from '../src/control/git.ts';
import { removeLines } from '../src/control/memory.ts';

function tempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-entries-'));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

/** A commit with a given date: otherwise entry dates in the test would depend on the machine clock. */
function commitAt(root: string, when: string, message: string): void {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

test('the file is parsed into entries: headings and text are not entries', () => {
  const content = ['# Предпочтения', '', '- Кофе без сахара', '- Тишина после 23:00', '', 'Просто строка'].join('\n');
  const { entries, total } = parseEntries(content);

  assert.deepEqual(
    entries.map((entry) => [entry.line, entry.kind, entry.text]),
    [
      [1, 'heading', '# Предпочтения'],
      [3, 'note', '- Кофе без сахара'],
      [4, 'note', '- Тишина после 23:00'],
      [6, 'text', 'Просто строка'],
    ],
    'пустые строки не записи, а номера строк — как в файле',
  );
  assert.equal(total, 2, 'всего записей с галочкой — две');

  // The heading is not consumed a second time, and a trailing newline does not add an entry.
  assert.equal(parseEntries('- одна\n').entries.length, 1);
  assert.deepEqual(parseEntries('').entries, []);
});

test('entry dates come from git: a new line gets a fresh commit', async () => {
  const root = tempRepo({ 'identity.md': '- Живёт в Москве\n- Кофе без сахара\n' });
  await ensureRepo(root);
  commitAt(root, '2026-02-08T10:00:00+03:00', 'memory: первый разбор');

  // The line was edited later: its date must become the new one.
  fs.writeFileSync(path.join(root, 'identity.md'), '- Живёт в Порту\n- Кофе без сахара\n- Тишина после 23:00\n');
  commitAt(root, '2026-03-02T09:00:00+03:00', 'memory: второй разбор');

  const dates = await blameLines(root, 'identity.md');
  assert.deepEqual(dates, ['2026-03-02', '2026-02-08', '2026-03-02']);

  const data = await readEntries(root, 'identity.md', String(fs.readFileSync(path.join(root, 'identity.md'))));
  assert.equal(data.total, 3);
  assert.deepEqual(
    data.entries.filter((entry) => entry.kind === 'note').map((entry) => entry.date),
    ['2026-03-02', '2026-02-08', '2026-03-02'],
  );

  // The file is not in history — there are no dates, and the panel must not lie with a zero date.
  assert.deepEqual(await blameLines(root, 'нет-такого.md'), []);
});

test('entries are served in pages, and the total count is the truth', async () => {
  const many = Array.from({ length: ENTRIES_LIMIT + 20 }, (_, index) => `- запись ${index + 1}`).join('\n');
  const root = tempRepo({ 'journal.md': `${many}\n` });
  await ensureRepo(root);

  const data = await readEntries(root, 'journal.md', String(fs.readFileSync(path.join(root, 'journal.md'))));
  assert.equal(data.entries.length, ENTRIES_LIMIT, 'за раз отдаём не больше лимита');
  assert.equal(data.total, ENTRIES_LIMIT + 20, 'а всего записей в файле — все');
  assert.equal(data.capped, true, 'в панели надо сказать, что показано не всё');
});

test('a batch of lines is removed in one pass, foreign numbers cancel everything', () => {
  const root = tempRepo({ 'preferences.md': '# Предпочтения\n- Кофе без сахара\n- Тишина после 23:00\n- Не будить до 09:00\n' });

  // One number missed — we delete nothing: half a batch is worse than nothing.
  const refused = removeLines(root, 'preferences.md', [2, 9]);
  assert.equal(refused.ok, false);
  assert.match(String(fs.readFileSync(path.join(root, 'preferences.md'))), /Кофе без сахара/, 'файл не тронут');

  assert.equal(removeLines(root, 'preferences.md', []).ok, false, 'пустой выбор — не удаление');
  assert.equal(removeLines(root, 'preferences.md', [0]).ok, false, 'нумерация строк с единицы');
  assert.equal(removeLines(root, '../../etc/passwd.md', [1]).ok, false, 'за пределы памяти нельзя');

  const result = removeLines(root, 'preferences.md', [2, 4]);
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.equal(
    String(fs.readFileSync(path.join(root, 'preferences.md'))),
    '# Предпочтения\n- Тишина после 23:00\n',
    'убраны ровно выбранные строки, остальное на месте',
  );
});

test('file history: commits with the number of added and removed lines', async () => {
  const root = tempRepo({ 'identity.md': '- Живёт в Москве\n' });
  await ensureRepo(root);
  commitAt(root, '2026-02-08T10:00:00+03:00', 'memory: первый разбор');

  fs.writeFileSync(path.join(root, 'identity.md'), '- Живёт в Порту\n- Кофе без сахара\n');
  commitAt(root, '2026-03-02T09:00:00+03:00', 'memory: второй разбор');

  // A foreign file does not get into the file history: in the panel, next to the entries, what matters
  // is what happened to them.
  fs.writeFileSync(path.join(root, 'other.md'), '- Что-то ещё\n');
  commitAt(root, '2026-03-03T09:00:00+03:00', 'memory: другой файл');

  const commits = await fileHistory(root, 'identity.md');
  assert.equal(commits.length, 2, 'третий коммит файла не касался');
  assert.equal(commits[0].subject, 'memory: второй разбор');
  assert.equal(commits[0].date, '2026-03-02');
  assert.equal(commits[0].added, 2, 'вторая версия добавила две строки');
  assert.equal(commits[0].removed, 1, 'и убрала одну');
  assert.ok(commits[0].hash.length >= 40, 'хеш нужен целиком: по нему открывают дифф');

  assert.deepEqual(await fileHistory(root, 'нет-такого.md'), []);
  assert.deepEqual(await fileHistory(root, '--help'), [], 'аргументы git из пути не собираем');
});
