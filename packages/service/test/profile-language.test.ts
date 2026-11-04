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
  LANGUAGES,
  LANGUAGE_LABELS,
  languageForms,
  languageName,
  languageOf,
  profilePath,
  readProfile,
  writeProfile,
} from '../src/profile.ts';
import { languageRule } from '../src/workspace.ts';
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

test('требование языка держит настроенный язык, а не язык реплики', () => {
  const en = languageRule('en');
  const ru = languageRule('ru');

  // Форма важнее формулировок, и это выяснилось на проде. Мягкое правило («человек
  // пишет не на твоём языке — отвечай на своём») не держало: при настройке `en` и
  // русской речи Икар отвечал по-русски. Держит императив с именем языка в первой
  // строке плюс прямое «настройка, а не язык реплики».
  //
  // Обычный случай держит короткая строка у реплики (language.ts, `languageOverride`):
  // 136 символов давали 10/10 там, где 894 — 9/10 (PR #114). Раздел в промпте — про
  // исключения (разово/режим), которых у реплики нет.
  assert.match(en, /Отвечай на языке: \*\*English\*\*/);
  assert.match(en, /настройка человека, а не язык его реплики/);
  assert.match(ru, /Отвечай на языке: \*\*Russian\*\*/);

  // В промпт идёт полное имя языка, а не код: «English», не «en».
  // Код — деталь хранения (config.yaml, profile.json), в тексте ему делать нечего.
  for (const [code, text] of [['en', en], ['ru', ru]] as const) {
    assert.doesNotMatch(text, new RegExp(`\\b${code}\\b`), `код «${code}» не должен попадать в промпт`);
  }
  assert.doesNotMatch(en, /английск(ий|ого)\.|English\. English/, 'имя языка не рассыпано по прозе');
});

test('раздел про язык короткий: он едет в каждый разговор', () => {
  // Раздел — редко нужное исключение (перевод/режим), а не ежедневное правило.
  // Когда он разросся до 2.2k символов, это была самая крупная статья промпта,
  // и платил за неё каждый разговор, включая тот, где просьбы не было вовсе.
  // Обычный случай держит строка у реплики, поэтому тут держим потолок: разрослось —
  // значит обратно вернули прозу, которую уже вычищали.
  const en = languageRule('en');
  assert.ok(en.length < 1200, `раздел про язык разросся: ${en.length} символов`);
});

test('исключение описано и ограничено просьбой', () => {
  const en = languageRule('en');

  // Просьба — единственное исключение, и она бывает двух видов.
  assert.match(en, /Прямая просьба человека важнее настройки/);
  assert.match(en, /\*\*Разово\*\*/);
  assert.match(en, /\*\*Режим\*\*/);

  // Оба конца держатся в коротком тексте: выполнил просьбу — вернулся к настройке;
  // режим кончается, когда человек его снимает.
  assert.match(en, /возвращаешься к English/);
  assert.match(en, /пока человек его не снимет/);
});

test('формы языка не разъезжаются: код один, имя одно', () => {
  // Один словарь на язык вместо четырёх параллельных карт: добавили язык — одна строка.
  for (const code of LANGUAGES) {
    assert.ok(languageName(code).length > 0, `у «${code}» нет полного имени`);
    assert.ok(LANGUAGE_LABELS[code].length > 0, `у «${code}» нет подписи для панели`);
    assert.ok(languageForms(code).adjective.length > 0, `у «${code}» нет прилагательного`);
    // Имя — не код: «English», а не «en».
    assert.notEqual(languageName(code), code);
  }
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('ru'), 'Russian');
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
