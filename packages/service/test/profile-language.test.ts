// Язык ответов: настройка человека, которая живёт в профиле, а не в конфиге.
//
// Тут охраняется одно свойство, ради которого всё и делалось: язык из настроек
// старше языка промпта. Персона, AGENTS.md и память написаны по-русски, и модель
// обязана это пережить — иначе англоязычный человек получает русского Икара.
//
// Проверяем три уровня: где хранится (профиль), что уезжает в контейнер (AGENTS.md)
// и что видит человек (панель).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig, probe } from './fixtures.ts';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_LABELS,
  languageOf,
  profilePath,
  readProfile,
  writeProfile,
} from '../src/profile.ts';
import { renderAgentsMd } from '../src/workspace.ts';
import { loadConfig } from '../src/config.ts';

test('без профиля язык берётся из конфига, а без конфига — русский', () => {
  const config = makeConfig();
  assert.equal(languageOf(config, probe()), DEFAULT_LANGUAGE);

  const english = makeConfig({ userLanguage: 'en' });
  assert.equal(languageOf(english, probe()), 'en');
});

test('профиль человека старше умолчания конфига', () => {
  const config = makeConfig({ userLanguage: 'ru' });
  writeProfile(config, probe(), { language: 'en' });
  assert.equal(languageOf(config, probe()), 'en');

  // И обратно: конфиг английский, человек выбрал русский.
  const english = makeConfig({ userLanguage: 'en' });
  writeProfile(english, probe(), { language: 'ru' });
  assert.equal(languageOf(english, probe()), 'ru');
});

test('профиль лежит рядом с памятью человека, а не в общем конфиге', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  assert.match(file, /users\/probe\/workspaces\/\.icarus\/profile\.json$/);

  writeProfile(config, probe(), { language: 'en' });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(readProfile(config, probe()), { language: 'en' });

  // Права закрытые: в профиле может появиться что-то личное, и открытым на чтение
  // он быть не должен по той же причине, что auth.json и mcp.json.
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'профиль пишется закрытым на чтение');
});

test('битый или чужой профиль не ломает разговор', () => {
  const config = makeConfig({ userLanguage: 'en' });
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, 'language: [это не язык\n');
  assert.equal(languageOf(config, probe()), 'en', 'битый файл — берём умолчание конфига');

  fs.writeFileSync(file, 'language: klingon\n');
  assert.equal(languageOf(config, probe()), 'en', 'неизвестный язык — тоже умолчание');
});

test('AGENTS.md требует отвечать строго на выбранном языке', () => {
  const ru = renderAgentsMd(makeConfig({ userLanguage: 'ru' }));
  const en = renderAgentsMd(makeConfig({ userLanguage: 'en' }));

  assert.match(ru, /## Язык/);
  assert.match(ru, /строго по-русски/);
  assert.match(en, /строго in English/);

  // Главное, ради чего раздел написан: промпт русский, и модель не должна решать
  // язык по нему. Требование это называет прямым текстом.
  assert.match(en, /написаны по-русски — это язык \*файлов\*, а не разговора/);
  assert.match(en, /Не переходи на русский из-за того, что промпт русский/);

  // Настройка старше языка собеседника — на этом мы уже обожглись: при `en`
  // и русской речи Икар отвечал по-русски, потому что правило этого не запрещало.
  assert.match(en, /Человек пишет не на твоём языке — это не причина ответить на его/);
  assert.match(en, /Язык собеседника не перебивает настройку/);

  // Просьба — единственное исключение, и она бывает двух видов.
  assert.match(en, /### Просьба говорить на другом языке/);
  assert.match(en, /\*\*Разовая просьба\*\*/);
  assert.match(en, /\*\*Режим\*\*/);
  assert.match(en, /пока человек его не отменит/);

  // И отдельно — ловушка, найденная стендом: просили грузинский, ответил по-русски.
  assert.match(en, /отвечай \*\*на нём\*\*, а не на русском/);

  assert.match(en, /Никогда не переспрашивай про язык/);
  assert.match(en, /Характер тот же/);
});

test('язык из конфига разбирается, опечатка не роняет сервис', () => {
  const dir = fs.mkdtempSync(path.join(makeConfig().dataDir, 'cfg-'));
  const file = path.join(dir, 'config.yaml');
  const base = `
apiKey: token
dataDir: ${dir}
models:
  - provider: deepinfra
    id: deepseek-ai/DeepSeek-V4.1-Flash
    tier: fast
users: [probe]
`;
  fs.writeFileSync(file, base + 'userLanguage: en\n');
  assert.equal(loadConfig(file, {}).userLanguage, 'en');

  fs.writeFileSync(file, base + 'userLanguage: de\n');
  assert.equal(loadConfig(file, {}).userLanguage, undefined, 'неизвестный язык — как если бы его не было');

  fs.writeFileSync(file, base);
  assert.equal(loadConfig(file, {}).userLanguage, undefined);
});

test('в панели у языка есть подписи, и обе — человеческие', () => {
  assert.deepEqual(Object.keys(LANGUAGE_LABELS).sort(), ['en', 'ru']);
  for (const label of Object.values(LANGUAGE_LABELS)) {
    assert.ok(label.length > 0 && /[А-Яа-яA-Za-z]/.test(label));
  }
});
