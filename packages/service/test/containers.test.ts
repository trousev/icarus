// Container ownership: fingerprint, labels, docker compose stack and reconciliation plan.
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

/** Host facts that script/server passes to the compose generator. */
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
 * The fingerprint depends, among other things, on dataDir, and in the fixture it is new
 * every time (a fresh temp directory) — so dataDir is pinned here.
 */
function spec(overrides: Partial<IcarusConfig> = {}, user = probe()): string {
  return specFor(makeConfig({ dataDir: config.dataDir, ...overrides }), user);
}

test('model tiers and identity go into the environment, while panel keys are not there', () => {
  const env = containerEnv(config, probe());
  assert.equal(env.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low');
  assert.equal(env.ICARUS_MODEL_STRONG, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:medium');
  assert.equal(env.ICARUS_USER_ID, 'probe');
  assert.equal(env.ICARUS_URL, config.url, 'адрес панели Икар называет человеку в чате');
  // The conversation language goes in as the full name: the language extension sends it
  // as a separate system message, because inside a large Russian prompt the language
  // rule did not hold (see smoke-language.mjs and language-extension.test.ts).
  assert.equal(env.ICARUS_LANGUAGE, 'Russian', 'умолчание — русский, полным именем');
  // The panel lets users in via an SSO proxy: the container must hold nothing that could
  // open someone else's memory — neither a shared secret nor a personal key.
  assert.equal(env.ICARUS_PANEL_KEY, undefined, 'ключей панели в контейнере нет');

  const own = makeConfig({ env: { ICARUS_MODEL_FAST: 'своё' } });
  assert.equal(containerEnv(own, probe()).ICARUS_MODEL_FAST, 'своё', 'явное окружение важнее');
});

test('without thinking in the config, reasoning is not disabled: fast and vision go to low', () => {
  const bare = makeConfig({
    dataDir: '/data',
    models: [
      { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', tier: 'fast' },
      { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', tier: 'vision' },
    ],
  });

  const env = containerEnv(bare, probe());
  assert.equal(env.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low');
  assert.equal(env.ICARUS_MODEL_VISION, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low');
});

test("the language from the user's profile sets ICARUS_LANGUAGE and is part of the fingerprint", () => {
  // The "User" setting in the panel: the user's profile overrides the config default.
  const english = makeConfig({ dataDir: config.dataDir, userLanguage: 'en' });
  assert.equal(containerEnv(english, probe()).ICARUS_LANGUAGE, 'English');

  // Changing the language means different container contents: otherwise the old session
  // would keep the previous system message, and that is exactly where we stumbled.
  const base = spec();
  assert.notEqual(spec({ userLanguage: 'en' }), base, 'язык — часть отпечатка');
});

test('the fingerprint changes with the image, dataDir, Maple, environment and models', () => {
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


test('stack: the service, one container per user and a warm restart', () => {
  const compose = render();

  assert.equal(compose.name, 'icarus');
  assert.equal(compose.services.icarus.image, DEFAULT_SERVICE_IMAGE);
  // compose builds the service image: the build is separated from recreation to keep downtime shorter.
  assert.deepEqual(compose.services.icarus.build, { context: '/repo/docker/service' });
  assert.equal(compose.services.icarus.restart, 'unless-stopped');
  assert.equal(compose.services.icarus.ports[0], '8080:8080');
  // dataDir is mounted at the same path: otherwise mount paths inside the container would diverge from the host's.
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

test('an empty Maple path never reaches docker', () => {
  // Prod failure #57: an empty MAPLE_DIR produced "::ro", and `docker compose build`
  // already failed with "invalid spec: ::ro: empty section between colons". Now the path
  // is only set together with the server, but the guard in bind() remains.
  const broken = makeConfig({ dataDir: config.dataDir, mapleDir: '' });
  assert.throws(() => renderCompose(broken, composeOptions), /пустым путём/);
});

test('stack: a change in the code fingerprint recreates the service instead of leaving the old process', () => {
  const before = render(config, { revision: 'rev-1' });
  const after = render(config, { revision: 'rev-2' });

  // The fingerprint lives in the service environment: the code changed — the environment changed,
  // and `docker compose up` recreates the container instead of "Container icarus Running".
  assert.notDeepEqual(after.services.icarus.environment, before.services.icarus.environment);
  assert.equal(after.services.icarus.environment.ICARUS_REVISION, 'rev-2');
  // Users have their own fingerprint (spec); their containers do not depend on the service code.
  assert.deepEqual(after.services['icarus-user-probe'], before.services['icarus-user-probe']);
});

test('stack: the user container — image, mounts, environment and ownership labels', () => {
  const compose = render();
  const service = compose.services['icarus-user-probe'];

  assert.equal(service.image, config.docker.image);
  assert.equal(service.build, undefined, 'образ у людей общий — его собирает script/server, а не каждый сервис');
  assert.equal(service.container_name, 'icarus-user-probe');
  assert.equal(service.restart, 'unless-stopped');
  // init is required: the user's PID 1 is `sleep infinity`, it does not reap orphans, and
  // abandoned Maple kernels (`mserver`) stayed zombies forever. tini cleans them up.
  assert.equal(service.init, true, 'без init сироты (ядра Maple) копятся зомби');
  assert.deepEqual(service.labels, userLabels(config, probe()));
  assert.equal(service.labels['icarus.spec'], specFor(config, probe()));
  assert.ok(service.volumes.includes('/data/users/probe/workspaces:/workspaces'));
  assert.ok(
    service.volumes.includes('/data/users/probe/workspaces/private:/workspaces/private:ro'),
    'приватный workspace монтируется только для чтения',
  );
  assert.ok(service.volumes.includes('/data/shared:/workspaces/.icarus/shared-memory'));
  assert.ok(
    service.volumes.includes('/data/skills/shared:/workspaces/.icarus/shared-skills:ro'),
    'общие скиллы смонтированы только для чтения',
  );
  assert.equal(service.environment.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low');
  assert.equal(service.environment.ICARUS_USER_ID, 'probe');
  assert.equal(service.environment.ICARUS_SKILLS_DIR, '/home/node/.pi/agent/skills');
});

// The point of the move: work folders live in /workspaces, while service files are gathered
// in /workspaces/.icarus and do not end up in any workspace. The test guards exactly this,
// not specific names: as soon as someone mounts memory or AGENTS.md as a separate mount
// again, it will fail.
test('stack: a single /workspaces root, and only the private workspace is read-only', () => {
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

test('stack: the chat registry and conversation map are mounted read-only', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-chats-'));
  const root = path.join(dataDir, 'users', 'probe');
  fs.mkdirSync(path.join(root, 'workspaces', '.icarus'), { recursive: true });
  // prepareUser creates the files before compose generation; here we repeat its work
  // to test the mount itself, not the order of calls.
  fs.writeFileSync(path.join(root, 'chats.json'), '{"chats":[]}\n');
  fs.writeFileSync(path.join(root, 'workspaces', '.icarus', 'sessions.json'), '{"sessions":[]}\n');

  const service = render(makeConfig({ dataDir })).services['icarus-user-probe'];
  const volumes: string[] = service.volumes;

  // The agent finds the session file via the panel link — but the service writes to both
  // files, so the container sees them closed: otherwise the conversation would be left without a history.
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

test('stack: without files on the host there are no conversation mounts — docker will not create an empty directory', () => {
  // Prod trap: for a nonexistent mount path docker creates a directory, and then
  // "chats.json" inside the container is a folder, not a file. That is why the path is mounted
  // only when the file exists (prepareUser creates it, see workspace.ts).
  const bare = makeConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-bare-')) });
  const joined = render(bare).services['icarus-user-probe'].volumes.join('\n');
  assert.doesNotMatch(joined, /chats\.json/, 'нет файла — нет маунта');
  assert.doesNotMatch(joined, /sessions\.json/, 'нет карты — нет маунта');
});

test('stack: docker.dns reaches the service and the user containers', () => {
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

test('stack: .env is included as a file, not as values in YAML', () => {
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

test('stack: only the id distinguishes users, everything else is shared', () => {
  const two = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const compose = render(two);

  assert.ok(compose.services['icarus-user-probe']);
  assert.ok(compose.services['icarus-user-probe2']);
  assert.equal(Object.keys(compose.services).length, 3, 'сервис плюс двое людей');

  // Everything except identity (name, id, fingerprint) is the same across users.
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

test('stack: users are gone from the config — the services are gone too', () => {
  const compose = render(makeConfig({ users: [probe('probe')] }));
  assert.equal(compose.services['icarus-user-probe2'], undefined);
});

test('the port is published at the address from the config', () => {
  assert.equal(publishAddress('0.0.0.0', 8080), '8080:8080', 'слушаем везде — публикуем везде');
  assert.equal(publishAddress('127.0.0.1', 8080), '127.0.0.1:8080:8080');
  assert.equal(publishAddress('localhost', 8080), '127.0.0.1:8080:8080', 'docker не понимает localhost в публикации');
  assert.equal(render(makeConfig({ host: '127.0.0.1', port: 9090 })).services.icarus.ports[0], '127.0.0.1:9090:9090');
});

test('stack: we do not create the network from the config, it must already exist', () => {
  const compose = render(makeConfig({ docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null, network: 'icarus-net' } }));
  assert.deepEqual(compose.networks, { 'icarus-net': { external: true } });
  assert.deepEqual(compose.services.icarus.networks, ['icarus-net']);
});

test('plan: we keep our own container with the same fingerprint', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe()), running: true }],
  });
  assert.deepEqual(plan.keep, ['icarus-user-probe']);
  assert.equal(planIsQuiet(plan), true);
  assert.equal(describePlan(plan), 'оставляю 1');
});

test('plan: we start a stopped container', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: specFor(config, probe()), running: false }],
  });
  assert.deepEqual(plan.start, ['icarus-user-probe']);
});

test('plan: the image changed — we recreate', () => {
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: 'старый-отпечаток', running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
});

test('plan: a container without labels is recognized by name and recreated', () => {
  // This is what migration looks like: the container was created before labels appeared, the user is alive
  const plan = planReconciliation({
    config,
    users: [probe()],
    containers: [{ name: 'icarus-user-probe', user: 'probe', spec: null, running: true }],
  });
  assert.deepEqual(plan.recreate, ['icarus-user-probe']);
  assert.deepEqual(plan.stop, [], 'своего человека останавливать нельзя');
});

test('plan: the user left — we stop the container', () => {
  const plan = planReconciliation({
    config,
    users: [],
    containers: [{ name: 'icarus-user-ушедший', user: 'ушедший', spec: 'любой', running: true }],
  });
  assert.deepEqual(plan.stop, ['icarus-user-ушедший']);
});

test('plan: there is no container yet — we create it on demand', () => {
  const plan = planReconciliation({ config, users: [probe()], containers: [] });
  assert.deepEqual(plan.create, ['probe']);
});

test('plan: two users — two containers with the same fingerprint', () => {
  const two: IcarusConfig = makeConfig({ users: [probe('probe'), probe('probe2')] });
  const plan = planReconciliation({ config: two, users: two.users, containers: [] });
  assert.deepEqual(plan.create, ['probe', 'probe2']);
});

// --- reaper for orphaned pi ----------------------------------------------------

test('reaper: kills pi by process name, not by arguments', async () => {
  // pi rewrites its own cmdline, so `pkill -f --mode rpc` finds nothing.
  const calls: string[][] = [];
  const runner = async (_config: IcarusConfig, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };

  const killed = await reapStalePi(config, 'icarus-user-probe', runner);
  assert.equal(killed, true);
  assert.deepEqual(calls, [['exec', 'icarus-user-probe', 'pkill', '-x', 'pi']]);
});

test('reaper: empty inside the container is not an error', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: '' });
  assert.equal(await reapStalePi(config, 'icarus-user-probe', runner), false);
});

test('reaper: a foreign return code and a docker crash do not bring down startup', async () => {
  const notFound = async () => ({ code: 127, stdout: '', stderr: 'pkill: not found' });
  assert.equal(await reapStalePi(config, 'icarus-user-probe', notFound), false);

  const broken = async () => {
    throw new Error('docker недоступен');
  };
  assert.equal(await reapStalePi(config, 'icarus-user-probe', broken), false);
});

test('docker socket access: we add the docker group gid to the socket gid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-groups-'));
  const groupFile = path.join(dir, 'group');
  fs.writeFileSync(groupFile, 'root:x:0:\ndocker:x:125:\nnogroup:x:65534:\n');

  // Docker Desktop and rootless docker: the host sees the socket as nobody:nogroup (65534),
  // while inside the container it is root:docker (125) — otherwise the service gets permission denied.
  assert.deepEqual(socketGroups(65534, 1000, groupFile), ['65534', '125']);

  // Regular Linux: the socket is the docker group itself — no second entry appears.
  assert.deepEqual(socketGroups(125, 1000, groupFile), ['125']);

  // Rootless with the socket in the home directory: its own gid is already passed into the user's container,
  // only the docker group remains — it does no harm.
  assert.deepEqual(socketGroups(1000, 1000, groupFile), ['125']);

  // A root:root socket — gid 0 gives nothing, so we take at least the docker group.
  assert.deepEqual(socketGroups(0, 1000, groupFile), ['125']);

  // No /etc/group — only the socket gid remains, as before.
  assert.deepEqual(socketGroups(65534, 1000, path.join(dir, 'нет-такого')), ['65534']);
});
