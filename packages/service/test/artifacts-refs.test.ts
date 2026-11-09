// Адреса элементов артефакта: разметка исходника, стабильность и правка текста.
//
// Здесь проверяется то, на чём держится ссылка из чата: адрес лежит в файле,
// не меняется от повторной разметки, переживает правку текста и отказывает,
// если элемент уже другой или адрес пришёл из чужого артефакта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactError } from '../src/artifacts.ts';
import { annotate, hashOf, refsOf, replaceText } from '../src/artifacts-refs.ts';

const PAGE = `<!doctype html>
<html lang="ru">
<head><title>Отчёт по «Атласу»</title></head>
<body>
<main class="page">
  <section class="hero">
    <h1 class="title">Атлас</h1>
    <p class="lead">Готовность 87%</p>
  </section>
  <section class="cards">
    <div class="card"><h3 class="card-title">Метрики</h3></div>
    <div class="card"><h3 class="card-title">Риски</h3></div>
  </section>
</main>
</body>
</html>`;

function annotated(): { html: string; refs: ReturnType<typeof annotate>['refs'] } {
  const result = annotate(PAGE);
  assert.equal(result.changed, true);
  return result;
}

test('разметка: у элементов появляются адреса из id и классов', () => {
  const { html, refs } = annotated();
  assert.match(html, /<h1 data-icarus-ref="main\.page\/section\.hero\/h1\.title" class="title">/);
  assert.match(html, /data-icarus-ref="main\.page\/section\.cards\/div\.card\[2\]\/h3\.card-title"/);
  // Служебная обвязка в head — не элемент предпросмотра: её не размечаем.
  assert.doesNotMatch(html, /<title data-icarus-ref/);

  const title = refs.find((item) => item.ref === 'main.page/section.hero/h1.title');
  assert.ok(title, 'заголовок получил адрес');
  assert.equal(title.tag, 'h1');
  assert.equal(title.quote, 'Атлас');
  assert.equal(title.editable, true);

  const container = refs.find((item) => item.ref === 'main.page/section.hero');
  assert.ok(container, 'контейнер тоже адресуем');
  assert.equal(container.editable, false, 'у контейнера править текст нельзя');
});

test('разметка идемпотентна: второй прогон не меняет файл и адреса', () => {
  const first = annotate(PAGE);
  const second = annotate(first.html);
  assert.equal(second.changed, false);
  assert.equal(second.html, first.html);
  assert.deepEqual(second.refs, first.refs);
  assert.deepEqual(refsOf(first.html), first.refs);
});

test('адрес переживает правку текста и новый блок рядом', () => {
  const first = annotate(PAGE);
  const edited = first.html
    .replace('Атлас', 'Атлас 2')
    .replace('</main>', '<section class="footer"><p class="note">Подвал</p></section>\n</main>');
  const second = annotate(edited);
  assert.equal(second.changed, true, 'у нового блока появился адрес');
  assert.match(second.html, /data-icarus-ref="main\.page\/section\.hero\/h1\.title"/);
  assert.match(second.html, /data-icarus-ref="main\.page\/section\.footer\/p\.note"/);
  assert.equal(
    second.refs.filter((item) => item.ref === 'main.page/section.hero/h1.title').length,
    1,
    'старый адрес не продублировался',
  );
});

test('правка текста: меняется только содержимое, атрибуты и разметка на месте', () => {
  const { html } = annotated();
  const result = replaceText(html, 'main.page/section.hero/h1.title', 'Атлас <новая версия>');
  assert.equal(result.before, 'Атлас');
  assert.match(
    result.html,
    /<h1 data-icarus-ref="main\.page\/section\.hero\/h1\.title" class="title">Атлас &lt;новая версия&gt;<\/h1>/,
  );
  assert.equal(hashOf(result.html) === hashOf(html), false, 'исходник действительно другой');
});

test('правка сохраняет отступы вокруг текста в многострочном исходнике', () => {
  const source = annotate(
    '<html><body><div class="box">\n  <p class="line">Старый текст</p>\n</div></body></html>',
  );
  const result = replaceText(source.html, 'div.box/p.line', 'Новый текст');
  assert.match(result.html, /<p data-icarus-ref="div\.box\/p\.line" class="line">Новый текст<\/p>/);
});

test('чужой или устаревший адрес — отказ, а не правка соседнего блока', () => {
  const { html } = annotated();
  assert.throws(
    () => replaceText(html, 'main.page/section.hero/h2.title', 'Что-то'),
    (error: unknown) =>
      error instanceof ArtifactError &&
      error.status === 409 &&
      /устарела/.test(error.message),
  );
  assert.throws(
    () => replaceText(html, 'body/div#from-another-artifact/p', 'Что-то'),
    (error: unknown) => error instanceof ArtifactError && error.status === 409,
  );
  // Исходник не переписан: неудачная попытка ничего не меняет.
  assert.match(html, /Атлас/);
});

test('неоднозначный адрес и контейнер — тоже отказ', () => {
  const duplicate =
    '<html><body><p data-icarus-ref="p.one">Раз</p><p data-icarus-ref="p.one">Два</p></body></html>';
  assert.throws(
    () => replaceText(duplicate, 'p.one', 'Три'),
    (error: unknown) => error instanceof ArtifactError && error.status === 409,
  );

  const { html } = annotated();
  assert.throws(
    () => replaceText(html, 'main.page/section.hero', 'Три'),
    (error: unknown) => error instanceof ArtifactError && error.status === 400,
  );
  assert.throws(
    () => replaceText(html, 'main.page/section.hero/h1.title', '   '),
    (error: unknown) => error instanceof ArtifactError && error.status === 400,
  );
});

test('отпечаток исходника меняется только вместе с файлом', () => {
  const first = annotate(PAGE);
  const again = annotate(first.html);
  assert.equal(hashOf(first.html), hashOf(again.html), 'отпечаток стабилен');
  assert.notEqual(hashOf(PAGE), hashOf(first.html), 'разметка — это изменение файла');
});
