// Владение контейнерами: отпечаток, метки, стек docker compose и план реконсиляции.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { containerEnv, specFor } from '../src/docker/spec.ts';
import { describePlan, planIsQuiet, planReconciliation } from '../src/docker/reconcile.ts';
import { reapStalePi } from '../src/docker/manager.ts';
import { DEFAULT_SERVICE_IMAGE, publishAddress, renderCompose, userLabels } from '../src/docker/compose.ts';
import { socketGroups } from '../src/docker/compose-write.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = makeConfig({
  dataDir: '/data',
  host: '0.0.0.0',
  port: 8080,
});

/** Хостовые факты, которые script/server передаёт генератору compose. */
const composeOptions = {
  repoRoot: '/repo',
  configPath: '/repo/config.yaml',
  runAs: '1000:1000',
  home: '/home/tester',
  dockerSocket: '/var/run/docker.sock',
  extraGroups: ['125'],
  revision: 'rev-1',
};

function render(input: IcarusConfig = config, extra: Record<string, unknown> = {}): any {
  return parseYaml(renderCompose(input, { ...composeOptions, ...extra }));
}

/**
 * Отпечаток зависит в том числе от dataDir, а у фикстуры он каждый раз новый
 * (свежий временный каталог) — поэтому здесь dataDir зафиксирован.
 */
function spec(overrides: Partial<IcarusConfig> = {}, user = probe()): string {
  return specFor(makeConfig({ dataDir: config.dataDir, ...overrides }), user);
}

test('уровни моделей и личность уезжают в окружение, а ключей панели там нет', () => {
  const env = containerEnv(config, probe());
  assert.equal(env.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:off');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:medium');
  assert.equal(env.ICARUS_USER_ID, 'probe');
  assert.equal(env.ICARUS_URL, config.url, 'адрес панели Икар называет человеку в чате');
  // Язык разговора уезжает полным именем: расширение language шлёт его отдельным
  // системным сообщением, потому что внутри большого русского промпта правило
  // языка не держало (см. smoke-language.mjs и language-extension.test.ts).
  assert.equal(env.ICARUS_LANGUAGE, 'Russian', 'умолчание — русский, полным именем');
  // Панель пускает по SSO-прокси: в контейнере не должно быть ничего, чем можно
  // открыть чужую память, — ни общего секрета, ни личного ключа.
  assert.equal(env.ICARUS_PANEL_KEY, undefined, 'ключей панели в контейнере нет');

  const own = makeConfig({ env: { ICARUS_MODEL_FAST: 'своё' } });
  assert.equal(containerEnv(own, probe()).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('язык из профиля человека задаёт ICARUS_LANGUAGE, и он входит в отпечаток', () => {
  // Настройка «Пользователь» в панели: профиль человека перекрывает умолчание конфига.
  const english = makeConfig({ dataDir: config.dataDir, userLanguage: 'en' });
  assert.equal(containerEnv(english, probe()).ICARUS_LANGUAGE, 'English');

  // Смена языка — другое содержимое контейнера: иначе старая сессия осталась бы
  // с прежним системным сообщением, а именно на этом мы и спотыкались.
  const base = spec();
  assert.notEqual(spec({ userLanguage: 'en' }), base, 'язык — часть отпечатка');
});

test('отпечаток меняется от образа, dataDir, Maple, окружения и моделей', () => {
  const base = spec();
  assert.equal(spec(), base, 'отпечаток детерминирован');

  assert.notEqual(spec({ docker: { ...config.docker, image: 'icarus-user:v2' } }), base, 'новый образ');
  assert.notEqual(spec({ dataDir: '/other' }), base, 'другой dataDir — другие пути памяти в контейнере');
  assert.notEqual(spec({ mapleDir: '/opt/maple18' }), base, 'включили Maple — другое содержимое');
  assert.notEqual(spec({ env: { ICARUS_EXTRACT_AFTER_MS: '1000' } }), base, 'новое окружение');
  assert.notEqual(
    spec({ models: [{ provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', tier: 'fast' }] }),
    base,
    'смена модели',
  );
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

test('пустой путь Maple до docker не доезжает', () => {
  // Прод-сбой #57: пустой MAPLE_DIR давал «::ro», и падал уже `docker compose build`
  // с «invalid spec: ::ro: empty section between colons». Теперь путь заводится
  // только вместе с сервером, но страховка в bind() остаётся.
  const broken = makeConfig({ dataDir: config.dataDir, mapleDir: '' });
  assert.throws(() => renderCompose(broken, composeOptions), /пустым путём/);
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
  // init обязателен: PID 1 у человека — `sleep infinity`, он не подбирает сирот, и
  // брошенные ядра Maple (`mserver`) оставались зомби навсегда. tini их подчищает.
  assert.equal(service.init, true, 'без init сироты (ядра Maple) копятся зомби');
  assert.deepEqual(service.labels, userLabels(config, probe()));
  assert.equal(service.labels['icarus.spec'], specFor(config, probe()));
  assert.ok(service.volumes.includes('/data/users/probe/workspaces:/workspaces'));
  assert.ok(
    service.volumes.includes('/data/users/probe/workspaces/private:/workspaces/private:ro'),
    'приватный workspace монтируется только для чтения',
  );
  assert.ok(service.volumes.includes('/data/shared:/workspaces/.icarus/shared-memory'));
  assert.equal(service.environment.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:off');
  assert.equal(service.environment.ICARUS_USER_ID, 'probe');
});

// Смысл переезда: рабочие папки — в /workspaces, а служебное собрано в
// /workspaces/.icarus и не попадает ни в один workspace. Тест сторожит именно это,
// а не конкретные имена: как только кто-то снова смонтирует память или AGENTS.md
// отдельным маунтом, он упадёт.
test('стек: один корень /workspaces и только приватный workspace — только для чтения', () => {
  const bare = makeConfig({ dataDir: config.dataDir });
  const volumes: string[] = render(bare).services['icarus-user-probe'].volumes;
  const targets = volumes.map((volume) => volume.split(':')[1] ?? '').filter((target) => target.startsWith('/workspace'));

  assert.ok(targets.includes('/workspaces'), 'корень рабочих папок смонтирован');
  assert.ok(targets.includes('/workspaces/private'), 'приватный workspace смонтирован');
  for (const target of targets) {
    assert.ok(target === '/workspaces' || target.startsWith('/workspaces/'), `маунт «${target}» мимо /workspaces`);
  }

  const joined = volumes.join('\n');
  assert.match(joined, /:\/workspaces$/m, 'корень смонтирован ровно один раз');
  assert.match(joined, /:\/workspaces\/private:ro$/m, 'и только он закрыт на запись');
  assert.doesNotMatch(joined, /:\/workspace\//, 'старых маунтов в /workspace больше нет');
  assert.doesNotMatch(joined, /:\/workspaces\/\.icarus\/memory/, 'память — просто папка внутри корня');
});

test('стек: реестр и карта разговоров смонтированы только для чтения', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-chats-'));
  const root = path.join(dataDir, 'users', 'probe');
  fs.mkdirSync(path.join(root, 'workspaces', '.icarus'), { recursive: true });
  // Файлы заводит prepareUser до генерации compose; здесь повторяем его работу,
  // чтобы проверить именно маунт, а не порядок вызовов.
  fs.writeFileSync(path.join(root, 'chats.json'), '{"chats":[]}\n');
  fs.writeFileSync(path.join(root, 'workspaces', '.icarus', 'sessions.json'), '{"sessions":[]}\n');

  const service = render(makeConfig({ dataDir })).services['icarus-user-probe'];
  const volumes: string[] = service.volumes;

  // Агент по ссылке из панели находит файл сессии — но пишет в оба файла сервис,
  // поэтому контейнер видит их закрытыми: иначе разговор остался бы без истории.
  assert.ok(
    volumes.includes(`${path.join(root, 'chats.json')}:/workspaces/.icarus/chats.json:ro`),
    'реестр разговоров едет только для чтения',
  );
  assert.ok(
    volumes.includes(
      `${path.join(root, 'workspaces', '.icarus', 'sessions.json')}:/workspaces/.icarus/sessions.json:ro`,
    ),
    'карта разговоров едет только для чтения',
  );
});

test('стек: без файлов на хосте маунтов разговоров нет — docker не создаст пустой каталог', () => {
  // Прод-ловушка: docker на несуществующий путь маунта создаёт каталог, и тогда
  // «chats.json» внутри контейнера — папка, а не файл. Поэтому путь монтируется
  // только когда файл есть (его заводит prepareUser, см. workspace.ts).
  const bare = makeConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-bare-')) });
  const joined = render(bare).services['icarus-user-probe'].volumes.join('\n');
  assert.doesNotMatch(joined, /chats\.json/, 'нет файла — нет маунта');
  assert.doesNotMatch(joined, /sessions\.json/, 'нет карты — нет маунта');
});

test('стек: docker.dns доезжает до сервиса и до контейнеров людей', () => {
  const withDns = makeConfig({
    docker: { ...config.docker, dns: ['1.1.1.1', '8.8.8.8'] },
    dataDir: config.dataDir,
  });
  const compose = render(withDns);

  assert.deepEqual(compose.services.icarus.dns, ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(compose.services['icarus-user-probe'].dns, ['1.1.1.1', '8.8.8.8']);

  assert.equal(render().services.icarus.dns, undefined, 'без docker.dns контейнеры берут резолвер хоста');
  assert.equal(render().services['icarus-user-probe'].dns, undefined);

  assert.notEqual(
    specFor(withDns, probe()),
    specFor(makeConfig({ dataDir: config.dataDir }), probe()),
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

test('стек: людей различает только id, остальное общее', () => {
  const two = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const compose = render(two);

  assert.ok(compose.services['icarus-user-probe']);
  assert.ok(compose.services['icarus-user-probe2']);
  assert.equal(Object.keys(compose.services).length, 3, 'сервис плюс двое людей');

  // Всё, кроме личности (имя, id, отпечаток), у людей одинаково.
  const shape = (name: string, userId: string) => {
    const service = compose.services[name];
    const environment = { ...service.environment };
    const labels = { ...service.labels };
    delete environment.ICARUS_USER_ID;
    delete labels['icarus.spec'];
    delete labels['icarus.user'];
    return JSON.stringify({ ...service, environment, labels }).replaceAll(userId, '<id>');
  };
  assert.equal(shape('icarus-user-probe', 'probe'), shape('icarus-user-probe2', 'probe2'));
});

test('стек: людей больше нет в конфиге — сервисов тоже нет', () => {
  const compose = render(makeConfig({ users: [probe('probe')] }));
  assert.equal(compose.services['icarus-user-probe2'], undefined);
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
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe()), running: true }],
  });
  assert.deepEqual(plan.keep, ['icarus-user-probe']);
  assert.equal(planIsQuiet(plan), true);
  assert.equal(describePlan(plan), 'оставляю 1');
});

test('план: остановленный контейнер поднимаем', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe()), running: false }],
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

test('доступ к сокету docker: к gid сокета добавляем gid группы docker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-groups-'));
  const groupFile = path.join(dir, 'group');
  fs.writeFileSync(groupFile, 'root:x:0:\ndocker:x:125:\nnogroup:x:65534:\n');

  // Docker Desktop и rootless-докер: хост видит сокет как nobody:nogroup (65534),
  // а внутри контейнера он root:docker (125) — иначе сервис получает permission denied.
  assert.deepEqual(socketGroups(65534, 1000, groupFile), ['65534', '125']);

  // Обычный Linux: сокет и есть группа docker — второй записи не появляется.
  assert.deepEqual(socketGroups(125, 1000, groupFile), ['125']);

  // Rootless с сокетом в домашнем каталоге: свой gid и так уезжает в user контейнера,
  // остаётся только группа docker — вреда от неё нет.
  assert.deepEqual(socketGroups(1000, 1000, groupFile), ['125']);

  // Сокет root:root — gid 0 ничего не даёт, берём хотя бы группу docker.
  assert.deepEqual(socketGroups(0, 1000, groupFile), ['125']);

  // Нет /etc/group — остаётся только gid сокета, как было раньше.
  assert.deepEqual(socketGroups(65534, 1000, path.join(dir, 'нет-такого')), ['65534']);
});
