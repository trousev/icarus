// Владение контейнерами: отпечаток, метки и план реконсиляции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { containerEnv, specFor } from '../src/docker/spec.ts';
import { describePlan, planIsQuiet, planReconciliation } from '../src/docker/reconcile.ts';
import { reapStalePi } from '../src/docker/manager.ts';
import { containerRunArgs } from '../src/workspace.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = makeConfig({
  dataDir: '/data',
  mounts: [{ host: '/host/scratchpad', container: '/workspace/scratchpad', mode: 'ro' }],
});

/**
 * Отпечаток зависит в том числе от dataDir, а у фикстуры он каждый раз новый
 * (свежий временный каталог) — поэтому здесь dataDir и маунты зафиксированы.
 */
function spec(overrides: Partial<IcarusConfig> = {}): string {
  return specFor(makeConfig({ dataDir: config.dataDir, mounts: config.mounts, ...overrides }));
}

test('уровни моделей уезжают в окружение', () => {
  const env = containerEnv(config);
  assert.equal(env.ICARUS_MODEL_FAST, 'deepseek/deepseek-v4-flash:off');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepseek/deepseek-v4-pro:medium');

  const own = makeConfig({ env: { ICARUS_MODEL_FAST: 'своё' } });
  assert.equal(containerEnv(own).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('отпечаток меняется от образа, dataDir, маунтов, окружения и моделей', () => {
  const base = spec();
  assert.equal(spec(), base, 'отпечаток детерминирован');

  assert.notEqual(spec({ docker: { ...config.docker, image: 'icarus-user:v2' } }), base, 'новый образ');
  assert.notEqual(spec({ dataDir: '/other' }), base, 'другой dataDir — другие пути памяти в контейнере');
  assert.notEqual(spec({ mounts: [{ host: '/host/other', container: '/workspace/other' }] }), base, 'новый маунт');
  assert.notEqual(spec({ env: { ICARUS_EXTRACT_AFTER_MS: '1000' } }), base, 'новое окружение');
  assert.notEqual(
    spec({ models: [{ provider: 'deepseek', id: 'deepseek-v4-pro', tier: 'fast' }] }),
    base,
    'смена модели',
  );
});

test('порядок маунтов не влияет на отпечаток', () => {
  const many = [
    { host: '/host/a', container: '/workspace/a' },
    { host: '/host/b', container: '/workspace/b' },
  ];
  assert.equal(spec({ mounts: many }), spec({ mounts: [...many].reverse() }));
});

test('людей различает только имя: отпечаток и окружение у всех одни', () => {
  const first = containerRunArgs(config, probe('probe'));
  const second = containerRunArgs(config, probe('probe2'));

  assert.match(first.join(' '), /--name icarus-user-probe /);
  assert.match(second.join(' '), /--name icarus-user-probe2 /);
  assert.match(first.join(' '), /\/data\/users\/probe\/memory:\/workspace\/memory/);
  assert.match(second.join(' '), /\/data\/users\/probe2\/memory:\/workspace\/memory/);

  // Если подставить один id вместо другого, команды обязаны совпасть: всё остальное
  // (образ, маунты, окружение, отпечаток) у людей общее.
  const withId = (args: string[], id: string): string =>
    args.map((arg) => arg.replace(new RegExp(`${id}\\b`, 'g'), '<id>')).join(' ');
  assert.equal(withId(first, 'probe'), withId(second, 'probe2'));
});

test('контейнер получает метки владения', () => {
  const args = containerRunArgs(config, probe());
  const joined = args.join(' ');
  assert.match(joined, /--label icarus\.managed=1/);
  assert.match(joined, /--label icarus\.user=probe/);
  assert.match(joined, new RegExp(`--label icarus\\.spec=${specFor(config)}`));
});

test('план: свой контейнер с тем же отпечатком оставляем', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config), running: true }],
  });
  assert.deepEqual(plan.keep, ['icarus-user-probe']);
  assert.equal(planIsQuiet(plan), true);
  assert.equal(describePlan(plan), 'оставляю 1');
});

test('план: остановленный контейнер поднимаем', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config), running: false }],
  });
  assert.deepEqual(plan.start, ['icarus-user-probe']);
});

test('план: сменился образ — пересоздаём', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: 'старый-отпечаток', running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
});

test('план: контейнер без меток опознаётся по имени и пересоздаётся', () => {
  // Так выглядит миграция: контейнер создан до появления меток, пользователь жив
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: null, running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
  assert.deepEqual(plan.stop, [], 'своего человека останавливать нельзя');
});

test('план: человек выбыл — контейнер останавливаем', () => {
  const plan = planReconciliation({
    config,
    users: [],
    containers: [{ name: 'icarus-user-ушедший', user: 'ушедший', spec: 'любой', running: true }],
  });
  assert.deepEqual(plan.stop, ['icarus-user-ушедший']);
});

test('план: контейнера ещё нет — создадим по запросу', () => {
  const plan = planReconciliation({ config, users: [probe()], containers: [] });
  assert.deepEqual(plan.create, ['probe']);
});

test('план: двое людей — два контейнера с одним отпечатком', () => {
  const two: IcarusConfig = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const plan = planReconciliation({ config: two, users: two.users, containers: [] });
  assert.deepEqual(plan.create, ['probe', 'probe2']);
});

// --- reaper осиротевших pi ----------------------------------------------------

test('reaper: гасит pi по имени процесса, а не по аргументам', async () => {
  // pi переписывает себе cmdline, поэтому `pkill -f --mode rpc` не находит ничего.
  const calls: string[][] = [];
  const runner = async (_config: IcarusConfig, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };

  const killed = await reapStalePi(config, 'icarus-user-probe', runner);
  assert.equal(killed, true);
  assert.deepEqual(calls, [['exec', 'icarus-user-probe', 'pkill', '-x', 'pi']]);
});

test('reaper: пусто внутри контейнера — это не ошибка', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: '' });
  assert.equal(await reapStalePi(config, 'icarus-user-probe', runner), false);
});

test('reaper: чужой код возврата и падение docker не роняют старт', async () => {
  const notFound = async () => ({ code: 127, stdout: '', stderr: 'pkill: not found' });
  assert.equal(await reapStalePi(config, 'icarus-user-probe', notFound), false);

  const broken = async () => {
    throw new Error('docker недоступен');
  };
  assert.equal(await reapStalePi(config, 'icarus-user-probe', broken), false);
});
