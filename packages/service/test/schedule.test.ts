// Task schedule: the next run in the human time zone, not in UTC.
//
// This checks the most expensive place: the clock change. An error here does not
// crash and is not logged — it simply shifts the "morning" agent run by an hour, and
// the human finds out when the summary arrives at lunch.
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

test('every day at 8:00 means 8:00 by the human clock right after the clock change', () => {
  // Saturday, March 28, 2026, 9:00 Dublin time (still GMT): the next run is Sunday,
  // March 29, 8:00, but Dublin is already in BST, so in UTC it is 7:00.
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, new Date('2026-03-28T09:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-03-29T07:00:00.000Z');
  assert.equal(wallClockOf(next!, DUBLIN).hour, 8);
});

test('and in autumn it is also 8:00, even though the day got longer', () => {
  // Saturday, October 24, 2026, 8:00 Dublin time (still summer time, 7:00 UTC).
  const saturday = new Date('2026-10-24T07:00:00Z');
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, saturday, DUBLIN);
  // Sunday the 25th is the last Sunday of October: the clocks were moved back, and
  // 8:00 local is now 8:00 UTC. Between runs there are not 24 but 25 hours.
  assert.equal(next?.toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal((next!.getTime() - saturday.getTime()) / 3_600_000, 25);
  assert.equal(wallClockOf(next!, DUBLIN).hour, 8, 'по часам человека всё ещё 8:00');
});

test('clock-change days are shorter and longer: 23 and 25 hours', () => {
  // Berlin moves the clocks at 02:00 local, so a task at 03:30 lands exactly on
  // the transition: in March the day is an hour shorter, in October an hour longer.
  const spring = nextRunAt({ kind: 'daily', time: '03:30' }, new Date('2026-03-27T03:00:00Z'), 'Europe/Berlin');
  const springNext = nextRunAt({ kind: 'daily', time: '03:30' }, spring!, 'Europe/Berlin');
  assert.equal((springNext!.getTime() - spring!.getTime()) / 3_600_000, 23);

  const autumn = nextRunAt({ kind: 'daily', time: '03:30' }, new Date('2026-10-23T02:00:00Z'), 'Europe/Berlin');
  const autumnNext = nextRunAt({ kind: 'daily', time: '03:30' }, autumn!, 'Europe/Berlin');
  assert.equal((autumnNext!.getTime() - autumn!.getTime()) / 3_600_000, 25);
});

test('in a zone that changes clocks at another time, 8:00 also stays 8:00', () => {
  // New York changes clocks on March 8, 2026: 8:00 is already 12:00 UTC.
  const next = nextRunAt({ kind: 'daily', time: '08:00' }, new Date('2026-03-07T14:00:00Z'), 'America/New_York');
  assert.equal(next?.toISOString(), '2026-03-08T12:00:00.000Z');
});

test('by weekdays: the next Monday, not "in a day"', () => {
  // Friday, March 27, 2026, 12:00 UTC.
  const next = nextRunAt({ kind: 'weekly', time: '09:00', weekdays: [1] }, new Date('2026-03-27T12:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-03-30T08:00:00.000Z', 'понедельник 30-го, уже BST');
  assert.equal(wallClockOf(next!, DUBLIN).day, 30);
});

test('a one-time task in the past has no next run', () => {
  assert.equal(
    nextRunAt({ kind: 'once', date: '2026-11-08', time: '10:00' }, new Date('2026-11-08T23:00:00Z'), DUBLIN),
    null,
  );
});

test('a one-time task in the future is computed in the human time zone', () => {
  const next = nextRunAt({ kind: 'once', date: '2026-11-09', time: '12:30' }, new Date('2026-11-08T23:00:00Z'), DUBLIN);
  assert.equal(next?.toISOString(), '2026-11-09T12:30:00.000Z', 'зимой Дублин — это UTC');
});

test('February 31 is not a date, but February 29 of a leap year is', () => {
  assert.equal(nextRunAt({ kind: 'once', date: '2026-02-31', time: '10:00' }, new Date(0), DUBLIN), null);
  const leap = nextRunAt({ kind: 'once', date: '2028-02-29', time: '10:00' }, new Date('2028-01-01T00:00:00Z'), DUBLIN);
  assert.equal(leap?.toISOString(), '2028-02-29T10:00:00.000Z');
});

test('garbage in the time does not turn into midnight', () => {
  assert.equal(nextRunAt({ kind: 'daily', time: '8:00' }, new Date(), DUBLIN), null);
  assert.equal(nextRunAt({ kind: 'daily', time: '25:00' }, new Date(), DUBLIN), null);
  assert.equal(nextRunAt({ kind: 'weekly', time: '09:00', weekdays: [] }, new Date(), DUBLIN), null);
});

test('moving clocks back: take the first of the two identical hours', () => {
  // On October 25, 2026 in Dublin, 01:00–02:00 happens twice. A task at 01:30 must
  // fire the first time, not an hour after it.
  const first = instantFromWall({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, DUBLIN);
  assert.equal(first.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('the human time zone is taken from config, not from the host', () => {
  const config = makeConfig({ env: { TZ: 'Asia/Tokyo' } });
  assert.equal(taskTimeZone(config), 'Asia/Tokyo');
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  // A broken zone in config must not crash the service: the scheduler honestly falls back to UTC.
  assert.ok(taskTimeZone(makeConfig({ env: { TZ: 'Mars/Olympus' } })));
});

test('a rule is parsed only whole: half a schedule is not accepted', () => {
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
