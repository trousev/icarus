// Artifact element refs: source annotation, stability and text edits.
//
// This checks what a chat link rests on: the ref lives in the file,
// does not change on re-annotation, survives a text edit and fails
// if the element is already different or the ref came from another artifact.
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

test('annotation: elements get refs from id and classes', () => {
  const { html, refs } = annotated();
  assert.match(html, /<h1 data-icarus-ref="main\.page\/section\.hero\/h1\.title" class="title">/);
  assert.match(html, /data-icarus-ref="main\.page\/section\.cards\/div\.card\[2\]\/h3\.card-title"/);
  // Service scaffolding in head is not a preview element: we do not annotate it.
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

test('annotation is idempotent: a second pass does not change the file or refs', () => {
  const first = annotate(PAGE);
  const second = annotate(first.html);
  assert.equal(second.changed, false);
  assert.equal(second.html, first.html);
  assert.deepEqual(second.refs, first.refs);
  assert.deepEqual(refsOf(first.html), first.refs);
});

test('a ref survives a text edit and a new block next to it', () => {
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

test('text edit: only the content changes, attributes and annotation stay', () => {
  const { html } = annotated();
  const result = replaceText(html, 'main.page/section.hero/h1.title', 'Атлас <новая версия>');
  assert.equal(result.before, 'Атлас');
  assert.match(
    result.html,
    /<h1 data-icarus-ref="main\.page\/section\.hero\/h1\.title" class="title">Атлас &lt;новая версия&gt;<\/h1>/,
  );
  assert.equal(hashOf(result.html) === hashOf(html), false, 'исходник действительно другой');
});

test('an edit preserves indentation around text in a multiline source', () => {
  const source = annotate(
    '<html><body><div class="box">\n  <p class="line">Старый текст</p>\n</div></body></html>',
  );
  const result = replaceText(source.html, 'div.box/p.line', 'Новый текст');
  assert.match(result.html, /<p data-icarus-ref="div\.box\/p\.line" class="line">Новый текст<\/p>/);
});

test('a foreign or stale ref is a failure, not an edit of a neighboring block', () => {
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
  // The source is not rewritten: a failed attempt changes nothing.
  assert.match(html, /Атлас/);
});

test('an ambiguous ref and a container are also failures', () => {
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

test('the source hash changes only together with the file', () => {
  const first = annotate(PAGE);
  const again = annotate(first.html);
  assert.equal(hashOf(first.html), hashOf(again.html), 'отпечаток стабилен');
  assert.notEqual(hashOf(PAGE), hashOf(first.html), 'разметка — это изменение файла');
});
