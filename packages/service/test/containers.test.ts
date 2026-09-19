// Владение контейнерами: отпечаток, метки, стек docker compose и план реконсиляции.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { containerEnv, specFor } from '../src/docker/spec.ts';
import { describePlan, planIsQuiet, planReconciliation } from '../src/docker/reconcile.ts';
import { reapStalePi } from '../src/docker/manager.ts';
import { DEFAULT_SERVICE_IMAGE, publishAddress, renderCompose, userLabels } from '../src/docker/compose.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, PANEL_SECRET, probe } from './fixtures.ts';

const config = makeConfig({
  dataDir: '/data',
  host: '0.0.0.0',
  port: 8080,
  mounts: [{ host: '/host/scratchpad', container: '/workspace/scratchpad', mode: 'ro' }],
});

/** Хостовые факты, которые script/server передаёт генератору compose. */
const composeOptions = {
  repoRoot: '/repo',
  configPath: '/repo/config.yaml',
  runAs: '1000:1000',
  home: '/home/tester',
  dockerSocket: '/var/run/docker.sock',
  extraGroups: ['125'],
  panelSecret: PANEL_SECRET,
  revision: 'rev-1',
};

function render(input: IcarusConfig = config, extra: Record<string, unknown> = {}): any {
  return parseYaml(renderCompose(input, { ...composeOptions, ...extra }));
}

/**
 * Отпечаток зависит в том числе от dataDir, а у фикстуры он каждый раз новый
 * (свежий временный каталог) — поэтому здесь dataDir и маунты зафиксированы.
 */
function spec(overrides: Partial<IcarusConfig> = {}, user = probe()): string {
  return specFor(makeConfig({ dataDir: config.dataDir, mounts: config.mounts, ...overrides }), user, PANEL_SECRET);
}

test('уровни моделей и личность уезжают в окружение', () => {
  const env = containerEnv(config, probe(), PANEL_SECRET);
  assert.equal(env.ICARUS_MODEL_FAST, 'deepseek/deepseek-v4-flash:off');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepseek/deepseek-v4-pro:medium');
  assert.equal(env.ICARUS_USER_ID, 'probe');
  assert.equal(env.ICARUS_URL, config.url);
  assert.match(env.ICARUS_PANEL_KEY, /^[0-9a-f]{64}$/, 'ключ ссылки — HMAC, а не открытый секрет');

  const own = makeConfig({ env: { ICARUS_MODEL_FAST: 'своё' } });
  assert.equal(containerEnv(own, probe(), PANEL_SECRET).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('ключ ссылки у каждого свой, а секрет сервиса его меняет', () => {
  assert.notEqual(
    containerEnv(config, probe('probe'), PANEL_SECRET).ICARUS_PANEL_KEY,
    containerEnv(config, probe('probe2'), PANEL_SECRET).ICARUS_PANEL_KEY,
    'по чужому ключу чужую ссылку не подписать',
  );
  assert.notEqual(
    specFor(config, probe(), 'один-секрет'),
    specFor(config, probe(), 'другой-секрет'),
    'смена секрета обесценивает старые ссылки — контейнеры пересоздаются',
  );
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

test('стек: сервис, контейнер на человека и тёплый restart', () => {
  const compose = render();

  assert.equal(compose.name, 'icarus');
  assert.equal(compose.services.icarus.image, DEFAULT_SERVICE_IMAGE);
  // Образ сервиса собирает compose: сборка отделена от пересоздания, чтобы простой был короче.
  assert.deepEqual(compose.services.icarus.build, { context: '/repo/docker/service' });
  assert.equal(compose.services.icarus.restart, 'unless-stopped');
  assert.equal(compose.services.icarus.ports[0], '8080:8080');
  // dataDir монтируется тем же путём: иначе пути маунтов внутри контейнера разъедутся с хостовыми.
  assert.ok(compose.services.icarus.volumes.includes('/data:/data'));
  assert.ok(compose.services.icarus.volumes.includes('/repo:/repo'));
  assert.ok(compose.services.icarus.volumes.includes('/repo/config.yaml:/repo/config.yaml:ro'));
  assert.ok(compose.services.icarus.volumes.includes('/var/run/docker.sock:/var/run/docker.sock'));
  assert.equal(compose.services.icarus.environment.HOME, '/home/tester');
  assert.equal(compose.services.icarus.environment.ICARUS_REVISION, 'rev-1');
  assert.equal(compose.services.icarus.user, '1000:1000');
  assert.deepEqual(compose.services.icarus.group_add, ['125']);
  assert.deepEqual(compose.services.icarus.depends_on, { 'icarus-user-probe': { condition: 'service_started' } });
});

test('стек: смена отпечатка кода пересоздаёт сервис, а не оставляет старый процесс', () => {
  const before = render(config, { revision: 'rev-1' });
  const after = render(config, { revision: 'rev-2' });

  // Отпечаток лежит в окружении сервиса: изменился код — изменилось окружение,
  // и `docker compose up` пересоздаёт контейнер вместо «Container icarus Running».
  assert.notDeepEqual(after.services.icarus.environment, before.services.icarus.environment);
  assert.equal(after.services.icarus.environment.ICARUS_REVISION, 'rev-2');
  // У людей свой отпечаток (spec), от кода сервиса их контейнеры не зависят.
  assert.deepEqual(after.services['icarus-user-probe'], before.services['icarus-user-probe']);
});

test('стек: контейнер человека — образ, маунты, окружение и метки владения', () => {
  const compose = render();
  const service = compose.services['icarus-user-probe'];

  assert.equal(service.image, config.docker.image);
  assert.equal(service.build, undefined, 'образ у людей общий — его собирает script/server, а не каждый сервис');
  assert.equal(service.container_name, 'icarus-user-probe');
  assert.equal(service.restart, 'unless-stopped');
  assert.deepEqual(service.labels, userLabels(config, probe(), PANEL_SECRET));
  assert.equal(service.labels['icarus.spec'], specFor(config, probe(), PANEL_SECRET));
  assert.ok(service.volumes.includes('/data/users/probe/memory:/workspace/memory'));
  assert.ok(service.volumes.includes('/data/users/probe/sessions:/workspace/.sessions'));
  assert.ok(service.volumes.includes('/host/scratchpad:/workspace/scratchpad:ro'));
  assert.equal(service.environment.ICARUS_MODEL_FAST, 'deepseek/deepseek-v4-flash:off');
  assert.equal(service.environment.ICARUS_USER_ID, 'probe');
});

test('стек: docker.dns доезжает до сервиса и до контейнеров людей', () => {
  const withDns = makeConfig({
    docker: { ...config.docker, dns: ['1.1.1.1', '8.8.8.8'] },
    dataDir: config.dataDir,
    mounts: config.mounts,
  });
  const compose = render(withDns);

  assert.deepEqual(compose.services.icarus.dns, ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(compose.services['icarus-user-probe'].dns, ['1.1.1.1', '8.8.8.8']);

  assert.equal(render().services.icarus.dns, undefined, 'без docker.dns контейнеры берут резолвер хоста');
  assert.equal(render().services['icarus-user-probe'].dns, undefined);

  assert.notEqual(
    specFor(withDns, probe(), PANEL_SECRET),
    specFor(makeConfig({ dataDir: config.dataDir, mounts: config.mounts }), probe(), PANEL_SECRET),
    'смена DNS меняет отпечаток: старые контейнеры должны пересоздаться',
  );
});

test('стек: .env подключается файлом, а не значениями в YAML', () => {
  const compose = render(config, { envFile: '/repo/.env' });
  assert.deepEqual(compose.services.icarus.env_file, ['/repo/.env'], 'сервису ключи нужны для auth.json');
  assert.deepEqual(
    compose.services['icarus-user-probe'].env_file,
    ['/repo/.env'],
    'человеку ключи нужны для расширений',
  );

  assert.equal(render().services.icarus.env_file, undefined, 'нет .env — нет env_file');
  assert.equal(render().services['icarus-user-probe'].env_file, undefined);
});

test('стек: людей различают id и личный ключ панели, остальное общее', () => {
  const two = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const compose = render(two);

  assert.ok(compose.services['icarus-user-probe']);
  assert.ok(compose.services['icarus-user-probe2']);
  assert.equal(Object.keys(compose.services).length, 3, 'сервис плюс двое людей');

  // Всё, кроме личности (имя, id, личный ключ, отпечаток), у людей одинаково.
  const shape = (name: string, userId: string) => {
    const service = compose.services[name];
    const environment = { ...service.environment };
    const labels = { ...service.labels };
    delete environment.ICARUS_USER_ID;
    delete environment.ICARUS_PANEL_KEY;
    delete labels['icarus.spec'];
    delete labels['icarus.user'];
    return JSON.stringify({ ...service, environment, labels }).replaceAll(userId, '<id>');
  };
  assert.equal(shape('icarus-user-probe', 'probe'), shape('icarus-user-probe2', 'probe2'));

  assert.notEqual(
    compose.services['icarus-user-probe'].environment.ICARUS_PANEL_KEY,
    compose.services['icarus-user-probe2'].environment.ICARUS_PANEL_KEY,
    'ключ ссылки на память у каждого свой',
  );
});

test('стек: людей больше нет в конфиге — сервисов тоже нет', () => {
  const compose = render(makeConfig({ users: [probe('probe')] }));
  assert.equal(compose.services['icarus-user-probe2'], undefined);
});

test('стек: стенд LibreChat появляется только по флагу', () => {
  assert.equal(render().services.librechat, undefined);

  const compose = render(config, { librechat: { dir: '/repo/docker/librechat', port: 3090 } });
  assert.equal(compose.services.librechat.ports[0], '3090:3090');
  assert.equal(compose.services.librechat.container_name, 'icarus-librechat');
  assert.equal(compose.services.librechat.environment.MONGO_URI, 'mongodb://icarus-librechat-mongo:27017/LibreChat');
  assert.ok(compose.services['icarus-librechat-mongo']);
  assert.ok(compose.volumes['mongo-data']);
});

test('порт публикуется по адресу из конфига', () => {
  assert.equal(publishAddress('0.0.0.0', 8080), '8080:8080', 'слушаем везде — публикуем везде');
  assert.equal(publishAddress('127.0.0.1', 8080), '127.0.0.1:8080:8080');
  assert.equal(publishAddress('localhost', 8080), '127.0.0.1:8080:8080', 'docker не понимает localhost в публикации');
  assert.equal(render(makeConfig({ host: '127.0.0.1', port: 9090 })).services.icarus.ports[0], '127.0.0.1:9090:9090');
});

test('стек: сеть из конфига не создаём, она должна существовать', () => {
  const compose = render(makeConfig({ docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null, network: 'icarus-net' } }));
  assert.deepEqual(compose.networks, { 'icarus-net': { external: true } });
  assert.deepEqual(compose.services.icarus.networks, ['icarus-net']);
});

test('план: свой контейнер с тем же отпечатком оставляем', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    panelSecret: PANEL_SECRET,
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe(), PANEL_SECRET), running: true }],
  });
  assert.deepEqual(plan.keep, ['icarus-user-probe']);
  assert.equal(planIsQuiet(plan), true);
  assert.equal(describePlan(plan), 'оставляю 1');
});

test('план: остановленный контейнер поднимаем', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    panelSecret: PANEL_SECRET,
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe(), PANEL_SECRET), running: false }],
  });
  assert.deepEqual(plan.start, ['icarus-user-probe']);
});

test('план: сменился образ — пересоздаём', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    panelSecret: PANEL_SECRET,
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: 'старый-отпечаток', running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
});

test('план: контейнер без меток опознаётся по имени и пересоздаётся', () => {
  // Так выглядит миграция: контейнер создан до появления меток, пользователь жив
  const plan = planReconciliation({
    config,
    users: [probe()],
    panelSecret: PANEL_SECRET,
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: null, running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
  assert.deepEqual(plan.stop, [], 'своего человека останавливать нельзя');
});

test('план: человек выбыл — контейнер останавливаем', () => {
  const plan = planReconciliation({
    config,
    users: [],
    panelSecret: PANEL_SECRET,
    containers: [{ name: 'icarus-user-ушедший', user: 'ушедший', spec: 'любой', running: true }],
  });
  assert.deepEqual(plan.stop, ['icarus-user-ушедший']);
});

test('план: контейнера ещё нет — создадим по запросу', () => {
  const plan = planReconciliation({ config, users: [probe()], panelSecret: PANEL_SECRET, containers: [] });
  assert.deepEqual(plan.create, ['probe']);
});

test('план: двое людей — два контейнера с одним отпечатком', () => {
  const two: IcarusConfig = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const plan = planReconciliation({ config: two, users: two.users, panelSecret: PANEL_SECRET, containers: [] });
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
