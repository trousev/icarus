// Владение контейнерами: отпечаток, метки и план реконсиляции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { containerEnv, specFor } from '../src/docker/spec.ts';
import { describePlan, planIsQuiet, planReconciliation } from '../src/docker/reconcile.ts';
import { containerRunArgs } from '../src/workspace.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = makeConfig({
  dataDir: '/data',
  mounts: [{ host: '/host/scratchpad', container: '/workspace/scratchpad', mode: 'ro' }],
});

test('уровни моделей уезжают в окружение', () => {
  const env = containerEnv(config);
  assert.equal(env.ICARUS_MODEL_FAST, 'deepseek/deepseek-v4-flash:off');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepseek/deepseek-v4-pro:medium');

  const own = makeConfig({ env: { ICARUS_MODEL_FAST: 'своё' } });
  assert.equal(containerEnv(own).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('отпечаток меняется от образа, маунтов, окружения и моделей', () => {
  const base = specFor(config);
  assert.equal(specFor(makeConfig({ mounts: config.mounts })), base, 'отпечаток детерминирован');

  const otherImage = makeConfig({ mounts: config.mounts, docker: { ...config.docker, image: 'icarus-user:v2' } });
  assert.notEqual(specFor(otherImage), base, 'новый образ — новый отпечаток');

  const otherMount = makeConfig({ mounts: [{ host: '/host/other', container: '/workspace/other' }] });
  assert.notEqual(specFor(otherMount), base, 'новый маунт — новый отпечаток');

  const otherEnv = makeConfig({ mounts: config.mounts, env: { ICARUS_EXTRACT_AFTER_MS: '1000' } });
  assert.notEqual(specFor(otherEnv), base, 'новое окружение — новый отпечаток');

  const otherModel = makeConfig({
    mounts: config.mounts,
    models: [{ provider: 'deepseek', id: 'deepseek-v4-pro', tier: 'fast' }],
  });
  assert.notEqual(specFor(otherModel), base, 'смена модели — новый отпечаток');
});

test('порядок маунтов не влияет на отпечаток', () => {
  const many = makeConfig({
    mounts: [
      { host: '/host/a', container: '/workspace/a' },
      { host: '/host/b', container: '/workspace/b' },
    ],
  });
  const reversed = makeConfig({
    mounts: [
      { host: '/host/b', container: '/workspace/b' },
      { host: '/host/a', container: '/workspace/a' },
    ],
  });
  assert.equal(specFor(many), specFor(reversed));
});

test('людей различает только имя: отпечаток и окружение у всех одни', () => {
  const first = containerRunArgs(config, probe('probe'));
  const second = containerRunArgs(config, probe('probe2'));

  assert.match(first.join(' '), /--name icarus-user-probe /);
  assert.match(second.join(' '), /--name icarus-user-probe2 /);
  assert.match(first.join(' '), /\/data\/users\/probe\/memory:\/workspace\/memory/);
  assert.match(second.join(' '), /\/data\/users\/probe2\/memory:\/workspace\/memory/);
  assert.equal(specFor(config), specFor(makeConfig({ mounts: config.mounts })), 'отпечаток не зависит от человека');
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
