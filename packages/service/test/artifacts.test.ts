// Ядро артефактов: папка, index-файл, описание для ИИ и публичная ссылка.
//
// Тест не поднимает HTTP: здесь проверяется то, что одинаково важно панели, MCP и
// публичному маршруту, — определение типа, безопасные пути, publicId и корзина.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  META_FILE,
  artifactFile,
  artifactUrls,
  clearPublicId,
  countArtifacts,
  ensurePublicId,
  inspectArtifact,
  listArtifacts,
  publicArtifact,
  trashArtifact,
} from '../src/artifacts.ts';
import { userPaths } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

function artifactRoot(config: ReturnType<typeof makeConfig>, workspace = 'talk'): string {
  return path.join(userPaths(config, probe('probe')).workspaces, workspace, 'artifacts');
}

function seed(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('артефакт — папка с index-файлом; тип определяется по нему', () => {
  const config = makeConfig();
  const root = artifactRoot(config);
  seed(root, {
    'plan/index.md': '# План на четверг\n\n1. Стендап\n',
    'plan/index.ai.md': '# План на четверг\n\nРасписание дня: стендап, демо, ревью.\n',
    'report/index.html': '<title>Отчёт</title><h1>Атлас</h1>',
    'report/index.ai.md': '# Отчёт по «Атласу»\n\nГотовность 87%.\n',
    'gift/index.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'gift/index.ai.md': '# Идеи подарка\n\nТри идеи для Анны.\n',
    // Папка без index — ещё не артефакт и в список не попадает.
    'draft/notes.txt': 'черновик',
    // Служебная корзина — тоже не артефакт.
    '.trash/old/index.md': '# Старое',
  });

  const items = listArtifacts(config, 'probe', 'talk');
  assert.deepEqual(items.map((item) => item.name).sort(), ['gift', 'plan', 'report']);

  const plan = items.find((item) => item.name === 'plan')!;
  assert.equal(plan.type, 'markdown');
  assert.equal(plan.title, 'План на четверг');
  assert.equal(plan.ai, true);
  assert.match(plan.summary, /Расписание дня/);
  assert.equal(plan.entry, 'index.md');
  assert.match(plan.urls.panel, /\/panel\/artifacts\?workspace=talk&artifact=plan/);
  assert.equal(plan.urls.public, undefined, 'без publicId публичной ссылки нет');

  const report = items.find((item) => item.name === 'report')!;
  assert.equal(report.type, 'html');
  assert.equal(report.title, 'Отчёт по «Атласу»', 'заголовок берётся из описания для ИИ, а не из <title>');

  const gift = items.find((item) => item.name === 'gift')!;
  assert.equal(gift.type, 'image', 'svg — тоже изображение');
});

test('YAML-frontmatter в index.ai.md не становится заголовком и описанием', () => {
  const config = makeConfig();
  seed(artifactRoot(config), {
    'calc/index.html': '<h1>Калькулятор</h1>',
    'calc/index.ai.md': '---\nname: "Калькулятор"\ntype: HTML-страница\n---\n\n# Калькулятор\n\nПростой калькулятор с процентами.\n',
  });
  const item = inspectArtifact(config, 'probe', 'talk', 'calc');
  assert.equal(item?.title, 'Калькулятор');
  assert.match(item?.summary ?? '', /Простой калькулятор/);
  assert.doesNotMatch(item?.summary ?? '', /name:/);
});

test('второй index-файл не ломает открытие: тип выбирается предсказуемо', () => {
  const config = makeConfig();
  seed(artifactRoot(config), {
    'double/index.md': '# Markdown',
    'double/index.html': '<h1>HTML</h1>',
    'double/index.ai.md': '# Двойной\n',
  });
  const artifact = inspectArtifact(config, 'probe', 'talk', 'double');
  assert.equal(artifact?.type, 'html', 'HTML приоритетнее markdown');
  assert.equal(artifact?.entry, 'index.html');
});

test('публичная ссылка появляется по запросу и отзывается', () => {
  const config = makeConfig();
  seed(artifactRoot(config), {
    'plan/index.md': '# План\n',
    'plan/index.ai.md': '# План\n',
  });

  const first = ensurePublicId(config, 'probe', 'talk', 'plan');
  assert.match(first.publicId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(first.artifact.urls.public ?? '', /\/a\/probe\/talk\/plan\//);
  assert.match(first.artifact.urls.bare ?? '', /\?bare=1$/);

  const meta = JSON.parse(
    fs.readFileSync(path.join(artifactRoot(config), 'plan', META_FILE), 'utf8'),
  ) as { publicId: string; version: number };
  assert.equal(meta.publicId, first.publicId);
  assert.equal(meta.version, 1);

  // Второй запрос не делает новую ссылку: она стабильна, пока её не отозвали.
  assert.equal(ensurePublicId(config, 'probe', 'talk', 'plan').publicId, first.publicId);

  const found = publicArtifact(config, 'probe', 'talk', 'plan', first.publicId);
  assert.equal(found?.artifact.name, 'plan');
  assert.equal(publicArtifact(config, 'probe', 'talk', 'plan', 'x'.repeat(24)), null, 'чужой id не подходит');
  assert.equal(publicArtifact(config, 'probe2', 'talk', 'plan', first.publicId), null, 'чужой человек не подходит');

  const revoked = clearPublicId(config, 'probe', 'talk', 'plan');
  assert.equal(revoked.publicId, undefined);
  assert.equal(publicArtifact(config, 'probe', 'talk', 'plan', first.publicId), null, 'отозванная ссылка мертва');
});

test('файл артефакта: вложенный ассет отдаётся, выход из папки — нет', () => {
  const config = makeConfig();
  seed(artifactRoot(config), {
    'site/index.html': '<link rel="stylesheet" href="css/style.css">',
    'site/css/style.css': 'body { color: red }',
    'site/index.ai.md': '# Сайт\n',
    'site/.artifact.json': '{"version":1,"publicId":"abcdefghijklmnopqrstuvwx"}',
    'secret.txt': 'чужое',
  });

  const css = artifactFile(config, 'probe', 'talk', 'site', 'css/style.css');
  assert.equal(css?.type, 'text/css; charset=utf-8');
  assert.equal(fs.readFileSync(css!.file, 'utf8'), 'body { color: red }');

  assert.equal(artifactFile(config, 'probe', 'talk', 'site', '../secret.txt'), null, 'нельзя выйти из папки');
  assert.equal(artifactFile(config, 'probe', 'talk', 'site', '/etc/passwd'), null, 'абсолютный путь не проходит');
  assert.equal(artifactFile(config, 'probe', 'talk', '../talk', 'index.md'), null, 'имя артефакта проверяется');
  assert.equal(artifactFile(config, 'probe', 'talk', 'site', 'index.html/../../secret.txt'), null);
  // index.ai.md — заметки для модели, а не часть артефакта для человека.
  assert.equal(artifactFile(config, 'probe', 'talk', 'site', 'index.ai.md'), null, 'описание для ИИ наружу не отдаём');
  assert.equal(artifactFile(config, 'probe', 'talk', 'site', '.artifact.json'), null, 'скрытые файлы не отдаём');
});

test('удаление артефакта — в корзину, а не навсегда', () => {
  const config = makeConfig();
  seed(artifactRoot(config), {
    'plan/index.md': '# План\n',
    'plan/index.ai.md': '# План\n',
  });
  const target = trashArtifact(config, 'probe', 'talk', 'plan');
  assert.match(target, /artifacts\/\.trash\/plan-/);
  assert.equal(fs.existsSync(path.join(artifactRoot(config), 'plan')), false);
  assert.equal(fs.existsSync(path.join(target, 'index.md')), true, 'файлы целы в корзине');
  assert.equal(inspectArtifact(config, 'probe', 'talk', 'plan'), null);
});

test('счётчик артефактов складывает все workspace', () => {
  const config = makeConfig();
  seed(artifactRoot(config, 'talk'), { 'a/index.md': '# A', 'a/index.ai.md': '# A' });
  seed(artifactRoot(config, 'private'), {
    'b/index.md': '# B',
    'b/index.ai.md': '# B',
    'c/index.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'c/index.ai.md': '# C',
  });
  assert.equal(countArtifacts(config, 'probe'), 3);
});

test('ссылки собираются от внешнего адреса панели, а не от локального порта', () => {
  const config = makeConfig({ url: 'https://icarus.example' });
  seed(artifactRoot(config), { 'plan/index.md': '# План', 'plan/index.ai.md': '# План' });
  const { publicId, artifact } = ensurePublicId(config, 'probe', 'talk', 'plan');
  assert.equal(artifact.urls.public, `https://icarus.example/a/probe/talk/plan/${publicId}/`);
  assert.equal(artifact.urls.bare, `${artifact.urls.public}?bare=1`);
  assert.equal(
    artifact.urls.raw,
    'https://icarus.example/panel/artifacts/raw/talk/plan/index.md',
  );
  assert.equal(artifact.urls.panel, 'https://icarus.example/panel/artifacts?workspace=talk&artifact=plan');
});

test('имя папки с переводом строки или выходом не считается артефактом', () => {
  const config = makeConfig();
  seed(artifactRoot(config), { 'ok/index.md': '# Ok', 'ok/index.ai.md': '# Ok' });
  assert.equal(inspectArtifact(config, 'probe', 'talk', '..'), null);
  assert.equal(inspectArtifact(config, 'probe', 'talk', '.hidden'), null);
  assert.equal(inspectArtifact(config, 'probe', 'talk', 'a/b'), null);
  assert.equal(inspectArtifact(config, 'probe', 'talk', 'line\nbreak'), null);

  // Симлинк-папка могла бы увести за пределы workspace: наружу не открываем.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-outside-'));
  fs.writeFileSync(path.join(outside, 'index.md'), '# Чужое');
  fs.writeFileSync(path.join(outside, 'index.ai.md'), '# Чужое');
  fs.symlinkSync(outside, path.join(artifactRoot(config), 'link'));
  assert.equal(inspectArtifact(config, 'probe', 'talk', 'link'), null);
});

test('описание для ИИ необязательно только для чтения: артефакт остаётся в списке', () => {
  const config = makeConfig();
  seed(artifactRoot(config), { 'raw/index.md': '# Без описания\n' });
  const item = inspectArtifact(config, 'probe', 'talk', 'raw');
  assert.equal(item?.ai, false);
  assert.equal(item?.title, 'Без описания');
  assert.equal(artifactUrls(config, 'probe', 'talk', 'raw', 'index.md').public, undefined);
});
