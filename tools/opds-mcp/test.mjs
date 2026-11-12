#!/usr/bin/env node
// Быстрый самотест разбора OPDS на фикстурах: без сети и без pi.
//
//   node tools/opds-mcp/test.mjs
//
// Полный сценарий (stdio-протокол, ошибки, скачивание) живёт в
// packages/service/test/opds-mcp.test.ts и гоняется через ./script/test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { annotationOf, formatOf, parseFeed, preferredFormat } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
const read = (name) => parseFeed(fixture(name), `https://example.invalid/${name}`, 'application/atom+xml');

test('корень: название каталога и разделы', () => {
  const feed = read('root.opds');
  assert.equal(feed.title, 'Project Gutenberg');
  assert.ok(feed.entries.length >= 3);
  assert.equal(feed.entries[0].title, 'Popular');
  assert.equal(feed.entries[0].acquisitions.length, 0, 'раздел — не книга');
  assert.match(feed.entries[0].detail, /search\.opds/);
  assert.ok(feed.links.some((link) => /search/.test(link.rel)), 'ссылка поиска в корне есть');
});

test('поиск: книги, авторы и ссылки на карточки', () => {
  const feed = read('search-dickens.opds');
  const book = feed.entries.find((entry) => entry.detail.includes('/ebooks/98.opds'));
  assert.ok(book, 'A Tale of Two Cities есть в выдаче');
  assert.equal(book.title, 'A Tale of Two Cities');
  assert.equal(book.content, 'Charles Dickens', 'в выдаче автор лежит в content');
  assert.ok(feed.entries.some((entry) => entry.title === 'Authors'), 'разделы каталога не потерялись');
});

test('карточка: автор, год, языки, форматы и аннотация без служебных полей', () => {
  const feed = read('book-98.opds');
  const entry = feed.entries.find((item) => item.acquisitions.length > 0);
  assert.ok(entry, 'в карточке есть ссылки на скачивание');
  assert.deepEqual(entry.authors, ['Dickens, Charles']);
  assert.deepEqual(entry.languages, ['en']);
  assert.equal(/\d{4}/.exec(entry.published)?.[0], '1994');
  const formats = entry.acquisitions.map(formatOf);
  assert.deepEqual(formats, ['epub', 'mobi']);
  assert.equal(entry.acquisitions[0].length, 487766, 'размер из length');
  const annotation = annotationOf(entry.content);
  assert.match(annotation, /historical novel published in 1859/);
  assert.doesNotMatch(annotation, /Reading Level:/, 'служебное поле не часть аннотации');
});

test('форматы и предпочтение', () => {
  assert.equal(formatOf({ type: 'application/epub+zip', href: '/b/1' }), 'epub');
  assert.equal(formatOf({ type: 'application/x-mobipocket-ebook', href: '/b/1' }), 'mobi');
  assert.equal(formatOf({ type: 'application/octet-stream', href: '/b/1.fb2' }), 'fb2');
  assert.equal(formatOf({ type: 'application/octet-stream', href: '/b/1.fb2.zip' }), 'zip');
  assert.equal(preferredFormat([{ format: 'mobi' }, { format: 'epub' }]), 'epub');
});
