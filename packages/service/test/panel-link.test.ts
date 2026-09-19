// Личный пропуск в панель памяти: подпись, срок годности и то, что чужой секрет не подходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LINK_TTL_MINUTES,
  derivePanelKey,
  linkTtlMinutes,
  panelLinkUrl,
  signPanelCredential,
  verifyPanelCredential,
} from '../../extensions/lib/panel-link.ts';

const SECRET = 'секрет-сервиса';
const NOW = Date.parse('2026-09-19T12:00:00Z');

test('личный ключ выводится из секрета и id, но у разных людей разный', () => {
  const probe = derivePanelKey(SECRET, 'probe');
  assert.equal(probe, derivePanelKey(SECRET, 'probe'), 'детерминирован');
  assert.notEqual(probe, derivePanelKey(SECRET, 'probe2'));
  assert.notEqual(probe, derivePanelKey('другой-секрет', 'probe'), 'секрет сервиса влияет');
  assert.match(probe, /^[0-9a-f]{64}$/);
});

test('своя ссылка проверяется, чужой секрет — нет', () => {
  const key = derivePanelKey(SECRET, 'probe');
  const credential = signPanelCredential(key, 'probe', NOW + 60_000);

  const mine = verifyPanelCredential(SECRET, credential, NOW);
  assert.equal(mine.ok, true);
  assert.equal(mine.ok && mine.userId, 'probe');

  const alien = verifyPanelCredential('чужой-секрет', credential, NOW);
  assert.deepEqual(alien, { ok: false, reason: 'подпись' });
});

test('пропуск с чужим id не проходит: подпись привязана к человеку', () => {
  const key = derivePanelKey(SECRET, 'probe');
  const forged = signPanelCredential(key, 'probe', NOW + 60_000).replace(/^probe:/, 'probe2:');
  assert.deepEqual(verifyPanelCredential(SECRET, forged, NOW), { ok: false, reason: 'подпись' });
});

test('истёкший пропуск отвергается, даже если подпись верна', () => {
  const key = derivePanelKey(SECRET, 'probe');
  const expired = signPanelCredential(key, 'probe', NOW - 1);
  assert.deepEqual(verifyPanelCredential(SECRET, expired, NOW), { ok: false, reason: 'срок' });
});

test('мусор вместо пропуска — это «формат», а не падение', () => {
  for (const bad of ['', 'probe', 'probe:скоро:нет', 'probe:123:zz', ':1:aa', 'probe:123:' + 'a'.repeat(63)]) {
    const result = verifyPanelCredential(SECRET, bad, NOW);
    assert.equal(result.ok, false, `«${bad}» должен быть отвергнут`);
    assert.equal(result.ok === false && result.reason, 'формат');
  }
});

test('срок годности из окружения: дефолт, мусор и потолок', () => {
  assert.equal(linkTtlMinutes(undefined), DEFAULT_LINK_TTL_MINUTES);
  assert.equal(linkTtlMinutes('90'), 90);
  assert.equal(linkTtlMinutes('-5'), DEFAULT_LINK_TTL_MINUTES);
  assert.equal(linkTtlMinutes('0'), DEFAULT_LINK_TTL_MINUTES);
  assert.equal(linkTtlMinutes('0.5'), DEFAULT_LINK_TTL_MINUTES, 'меньше минуты — это уже не срок');
  assert.equal(linkTtlMinutes('скоро'), DEFAULT_LINK_TTL_MINUTES);
  assert.equal(linkTtlMinutes('999999999'), 30 * 24 * 60, 'больше месяца не даём');
});

test('URL панели склеивается без двойного слэша и кодирует пропуск', () => {
  const url = panelLinkUrl('http://icarus.example:8081/', 'probe:123:abc');
  assert.equal(url, 'http://icarus.example:8081/panel?t=probe%3A123%3Aabc');

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('t'), 'probe:123:abc', 'пропуск переживает URL');
});
