// Владение контейнерами: отпечаток, метки и план реконсиляции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { containerEnv, labelArgs, specFor } from '../src/docker/spec.ts';
import { describePlan, planIsQuiet, planReconciliation, type ManagedContainer } from '../src/docker/reconcile.ts';
import { containerRunArgs } from '../src/workspace.ts';
import type { IcarusConfig, UserConfig } from '../src/config.ts';

const config = {
  dataDir: '/data',
  docker: { image: 'icarus-user:dev', prefix: 'icarus-user', network: null, socket: null },
} as unknown as IcarusConfig;

function user(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 'probe',
    models: [
      { provider: 'deepseek', id: 'deepseek-v4-flash', thinking: 'off', tier: 'fast' },
      { provider: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium', tier: 'strong' },
    ],
    mounts: [{ host: '/host/scratchpad', container: '/workspace/scratchpad', mode: 'ro' }],
    ...overrides,
  };
}

test('уровни моделей уезжают в окружение', () => {
  const env = containerEnv(user());
  assert.equal(env.ICARUS_MODEL_FAST, 'deepseek/deepseek-v4-flash:off');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepseek/deepseek-v4-pro:medium');
  assert.equal(containerEnv(user({ env: { ICARUS_MODEL_FAST: 'своё' } })).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('отпечаток меняется от образа, маунтов и окружения', () => {
  const base = specFor(config, user());
  assert.equal(specFor(config, user()), base, 'отпечаток детерминирован');

  const otherImage = { ...config, docker: { ...config.docker, image: 'icarus-user:v2' } } as IcarusConfig;
  assert.notEqual(specFor(otherImage, user()), base, 'новый образ — новый отпечаток');

  const otherMount = user({ mounts: [{ host: '/host/other', container: '/workspace/other' }] });
  assert.notEqual(specFor(config, otherMount), base, 'новый маунт — новый отпечаток');

  const otherEnv = user({ env: { ICARUS_EXTRACT_AFTER_MS: '1000' } });
  assert.notEqual(specFor(config, otherEnv), base, 'новое окружение — новый отпечаток');

  const otherModel = user({ models: [{ provider: 'deepseek', id: 'deepseek-v4-pro', tier: 'fast' }] });
  assert.notEqual(specFor(config, otherModel), base, 'смена модели — новый отпечаток');
});

test('порядок маунтов не влияет на отпечаток', () => {
  const many = user({
    mounts: [
      { host: '/host/a', container: '/workspace/a' },
      { host: '/host/b', container: '/workspace/b' },
    ],
  });
  const reversed = user({
    mounts: [
      { host: '/host/b', container: '/workspace/b' },
      { host: '/host/a', container: '/workspace/a' },
    ],
  });
  assert.equal(specFor(config, many), specFor(config, reversed));
});

test('контейнер получает метки владения', () => {
  const args = containerRunArgs(config, user());
  const joined = args.join(' ');
  assert.match(joined, /--label icarus\.managed=1/);
  assert.match(joined, /--label icarus\.user=probe/);
  assert.match(joined, new RegExp(`--label icarus\\.spec=${specFor(config, user())}`));
});

test('план: свой контейнер с тем же отпечатком оставляем', () => {
  const plan = planReconciliation({
    config,
    users: [user()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, user()), running: true }],
  });
  assert.deepEqual(plan.keep, ['icarus-user-probe']);
  assert.equal(planIsQuiet(plan), true);
  assert.equal(describePlan(plan), 'оставляю 1');
});

test('план: остановленный контейнер поднимаем', () => {
  const plan = planReconciliation({
    config,
    users: [user()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, user()), running: false }],
  });
  assert.deepEqual(plan.start, ['icarus-user-probe']);
});

test('план: сменился образ — пересоздаём', () => {
  const plan = planReconciliation({
    config,
    users: [user()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: 'старый-отпечаток', running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
});

test('план: контейнер без меток опознаётся по имени и пересоздаётся', () => {
  // Так выглядит миграция: контейнер создан до появления меток, пользователь жив
  const plan = planReconciliation({
    config,
    users: [user()],
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
  const plan = planReconciliation({ config, users: [user()], containers: [] });
  assert.deepEqual(plan.create, ['probe']);
});
