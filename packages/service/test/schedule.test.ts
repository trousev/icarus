// Расписание задачи: следующий запуск в поясе человека, а не по UTC.
//
// Здесь проверяется самое дорогое место: перевод часов. Ошибка тут не падает и не
// логируется — она просто сдвигает «утренний» запуск агента на час, и человек узнаёт
// об этом, когда сводка приходит в обед.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  instantFromWall,
  isValidTimeZone,
  nextRunAt,
  parseRepeat,
  taskTimeZone,
  wallClockOf,
} from '../src/sessions/schedule.ts';
import { makeConfig } from './fixtures.ts';

const DUBLIN = 'Europe/Dublin';

test('каждый день в 8:00 — это 8:00 по часам человека сразу после перевода часов', () => {
  // Суббота 28 марта 2026, 9:00 по Дублину (ещё GMT): следующий запуск — воскресенье
  // 29 марта 8:00, но Дублин уже в BST, поэтому по UTC это 7:00.
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, new Date('2026-03-28T09:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-03-29T07:00:00.000Z');
  assert.equal(wallClockOf(next!, DUBLIN).hour, 8);
});

test('и осенью тоже 8:00, хотя сутки стали длиннее', () => {
  // Суббота 24 октября 2026, 8:00 по Дублину (ещё летнее время, 7:00 UTC).
  const saturday = new Date('2026-10-24T07:00:00Z');
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, saturday, DUBLIN);
  // Воскресенье 25-го — последнее воскресенье октября: часы перевели назад, и
  // 8:00 местного — это уже 8:00 UTC. Между запусками не 24, а 25 часов.
  assert.equal(next?.toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal((next!.getTime() - saturday.getTime()) / 3_600_000, 25);
  assert.equal(wallClockOf(next!, DUBLIN).hour, 8, 'по часам человека всё ещё 8:00');
});

test('сутки перевода часов короче и длиннее: 23 и 25 часов', () => {
  // Берлин переводит часы в 02:00 местного, поэтому задача на 03:30 попадает ровно
  // в переход: в марте день короче на час, в октябре — длиннее.
  const spring = nextRunAt({ kind: 'daily', time: '03:30' }, new Date('2026-03-27T03:00:00Z'), 'Europe/Berlin');
  const springNext = nextRunAt({ kind: 'daily', time: '03:30' }, spring!, 'Europe/Berlin');
  assert.equal((springNext!.getTime() - spring!.getTime()) / 3_600_000, 23);

  const autumn = nextRunAt({ kind: 'daily', time: '03:30' }, new Date('2026-10-23T02:00:00Z'), 'Europe/Berlin');
  const autumnNext = nextRunAt({ kind: 'daily', time: '03:30' }, autumn!, 'Europe/Berlin');
  assert.equal((autumnNext!.getTime() - autumn!.getTime()) / 3_600_000, 25);
});

test('в поясе, где перевод часов в другое время, 8:00 тоже остаётся 8:00', () => {
  // Нью-Йорк переводит часы 8 марта 2026: 8:00 — это уже 12:00 UTC.
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, new Date('2026-03-07T14:00:00Z'), 'America/New_York');
  assert.equal(next?.toISOString(), '2026-03-08T12:00:00.000Z');
});

test('по дням недели: следующий понедельник, а не «через сутки»', () => {
  // Пятница 27 марта 2026, 12:00 UTC.
  const next = nextRunAt({ kind: 'weekly', time: '09:00', weekdays: [1] }, new Date('2026-03-27T12:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-03-30T08:00:00.000Z', 'понедельник 30-го, уже BST');
  assert.equal(wallClockOf(next!, DUBLIN).day, 30);
});

test('одноразовая задача в прошлом не имеет следующего запуска', () => {
  assert.equal(
    nextRunAt({ kind: 'once', date: '2026-11-08', time: '10:00' }, new Date('2026-11-08T23:00:00Z'), DUBLIN),
    null,
  );
});

test('одноразовая задача в будущем считается в поясе человека', () => {
  const next = nextRunAt({ kind: 'once', date: '2026-11-09', time: '12:30' }, new Date('2026-11-08T23:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-11-09T12:30:00.000Z', 'зимой Дублин — это UTC');
});

test('31 февраля не дата, а 29 февраля високосного года — дата', () => {
  assert.equal(nextRunAt({ kind: 'once', date: '2026-02-31', time: '10:00' }, new Date(0), DUBLIN), null);
  const leap = nextRunAt({ kind: 'once', date: '2028-02-29', time: '10:00' }, new Date('2028-01-01T00:00:00Z'), DUBLIN);
  assert.equal(leap?.toISOString(), '2028-02-29T10:00:00.000Z');
});

test('мусор во времени не превращается в полночь', () => {
  assert.equal(nextRunAt({ kind: 'daily', time: '8:00' }, new Date(), DUBLIN), null);
  assert.equal(nextRunAt({ kind: 'daily', time: '25:00' }, new Date(), DUBLIN), null);
  assert.equal(nextRunAt({ kind: 'weekly', time: '09:00', weekdays: [] }, new Date(), DUBLIN), null);
});

test('перевод часов назад: берём первый из двух одинаковых часов', () => {
  // 25 октября 2026 в Дублине 01:00–02:00 случается дважды. Задача на 01:30 должна
  // сработать в первый раз, а не через час после него.
  const first = instantFromWall({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, DUBLIN);
  assert.equal(first.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('часовой пояс человека берётся из конфига, а не с хоста', () => {
  const config = makeConfig({ env: { TZ: 'Asia/Tokyo' } });
  assert.equal(taskTimeZone(config), 'Asia/Tokyo');
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  // Битый пояс в конфиге не должен ронять сервис: планировщик честно уходит в UTC.
  assert.ok(taskTimeZone(makeConfig({ env: { TZ: 'Mars/Olympus' } })));
});

test('правило разбирается только целиком: половину расписания не принимаем', () => {
  assert.deepEqual(parseRepeat({ kind: 'daily', time: '08:00' }), { kind: 'daily', time: '08:00' });
  assert.deepEqual(parseRepeat({ kind: 'weekly', time: '09:30', weekdays: [3, 1, 3] }), {
    kind: 'weekly',
    time: '09:30',
    weekdays: [1, 3],
  });
  assert.equal(parseRepeat({ kind: 'weekly', time: '09:30', weekdays: [] }), null);
  assert.equal(parseRepeat({ kind: 'daily' }), null);
  assert.equal(parseRepeat({ kind: 'hourly', time: '09:30' }), null);
  assert.equal(parseRepeat(null), null);
});
