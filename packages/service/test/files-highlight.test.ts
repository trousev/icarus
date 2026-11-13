// Code highlighting in the file preview: a client-side file without a build step, so
// we take the source as is and extract the function — the test checks exactly the code
// that will ship to the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/control/files-highlight.js', import.meta.url), 'utf8');

type Highlighter = { highlightCode: (text: string, type: string) => string | null };

const { highlightCode } = new Function(`${SOURCE}\nreturn { highlightCode };`)() as Highlighter;

test('keywords, strings and numbers get their classes', () => {
  const html = highlightCode('const answer = 42; // смысл', 'TS') ?? '';
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-number">42<\/span>/);
  assert.match(html, /<span class="tok-comment">\/\/ смысл<\/span>/);

  const strings = highlightCode('const name = "Икар";', 'JS') ?? '';
  assert.match(strings, /<span class="tok-string">&quot;Икар&quot;<\/span>/);
});

test('HTML from a file does not pass through: everything that is not a token is escaped', () => {
  const html = highlightCode('const x = "<img src=x onerror=alert(1)>";', 'JS') ?? '';
  assert.ok(!html.includes('<img'), 'тег из файла не стал разметкой');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a string wins over a comment: // inside an address is not a comment', () => {
  const html = highlightCode('const url = "https://example.com";', 'JS') ?? '';
  assert.doesNotMatch(html, /tok-comment/);
  assert.match(html, /tok-string/);
});

test('CSS: `#fff` is a color, not a comment; properties are highlighted', () => {
  const html = highlightCode('.x { color: #fff; }', 'CSS') ?? '';
  assert.doesNotMatch(html, /tok-comment/);
  assert.match(html, /<span class="tok-key">color<\/span>/);
});

test('json, python, yaml and shell are recognized by the type from the tree', () => {
  const json = highlightCode('{"on": true, "n": null}', 'JSON') ?? '';
  assert.match(json, /tok-keyword">true</);

  const python = highlightCode('def f(x):\n    return None  # нет', 'PYTHON') ?? '';
  assert.match(python, /tok-keyword">def</);
  assert.match(python, /tok-comment"># нет</);

  const yaml = highlightCode('name: Икар\nenabled: true', 'YAML') ?? '';
  assert.match(yaml, /tok-key">name</, 'поле yaml — ключ');

  const shell = highlightCode('if [ -f "$x" ]; then echo ok; fi', 'SHELL') ?? '';
  assert.match(shell, /tok-keyword">if</);
});

test('an unknown language is null: the panel shows the text as is', () => {
  assert.equal(highlightCode('hello', 'FILE'), null);
  assert.equal(highlightCode('hello', ''), null);
  assert.equal(highlightCode('', 'TS'), '', 'знакомый язык с пустым файлом — пустая подсветка');
});
