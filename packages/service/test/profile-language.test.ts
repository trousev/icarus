// Answer language: a person's setting that lives in the profile, not in the config.
//
// Here we protect one property that everything was done for: the language from the settings
// is senior to the language of the prompt. The persona, AGENTS.md and memory are written in Russian, and the model
// must survive that — otherwise an English-speaking person gets a Russian Icarus.
//
// We check three levels: where it is stored (profile), what goes into the container (AGENTS.md)
// and what the person sees (panel).
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

test('without a profile the language comes from the config, and without a config — Russian', () => {
  const config = makeConfig();
  assert.equal(languageOf(config, probe()), DEFAULT_LANGUAGE);

  const english = makeConfig({ userLanguage: 'en' });
  assert.equal(languageOf(english, probe()), 'en');
});

test('a person\'s profile is senior to the config default', () => {
  const config = makeConfig({ userLanguage: 'ru' });
  writeProfile(config, probe(), { language: 'en', uiLanguage: 'ru' });
  assert.equal(languageOf(config, probe()), 'en');

  // And vice versa: the config is English, the person chose Russian.
  const english = makeConfig({ userLanguage: 'en' });
  writeProfile(english, probe(), { language: 'ru', uiLanguage: 'ru' });
  assert.equal(languageOf(english, probe()), 'ru');
});

test('the profile lies next to the person\'s memory, not in the shared config', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  assert.match(file, /users\/probe\/workspaces\/\.icarus\/profile\.json$/);

  writeProfile(config, probe(), { language: 'en', uiLanguage: 'ru' });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(readProfile(config, probe()), { language: 'en', uiLanguage: 'ru' });

  // Rights are closed: the profile may contain something personal, and it must not be
  // open for reading for the same reason as auth.json and mcp.json.
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'профиль пишется закрытым на чтение');
});

test('a broken or foreign profile does not break the conversation', () => {
  const config = makeConfig({ userLanguage: 'en' });
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, 'language: [это не язык\n');
  assert.equal(languageOf(config, probe()), 'en', 'битый файл — берём умолчание конфига');

  fs.writeFileSync(file, 'language: klingon\n');
  assert.equal(languageOf(config, probe()), 'en', 'неизвестный язык — тоже умолчание');
});

test('the language requirement holds the configured language, not the language of the message', () => {
  const en = languageRule('en');
  const ru = languageRule('ru');

  // Form matters more than wording, and this was discovered in production. The soft rule ("the person
  // writes not in your language — answer in your own") did not hold: with the `en` setting and
  // Russian speech, Icarus answered in Russian. What holds is an imperative with the language name in the first
  // line plus a direct "setting, not the language of the message".
  //
  // The ordinary case is held by a short line next to the message (language.ts, `languageOverride`):
  // 136 characters gave 10/10 where 894 gave 9/10 (PR #114). The section in the prompt is about
  // exceptions (one-off/regime), which the message line does not have.
  assert.match(en, /Отвечай на языке: \*\*English\*\*/);
  assert.match(en, /настройка человека, а не язык его реплики/);
  assert.match(ru, /Отвечай на языке: \*\*Russian\*\*/);

  // The full language name goes into the prompt, not the code: "English", not "en".
  // The code is a storage detail (config.yaml, profile.json), it has nothing to do in the text.
  for (const [code, text] of [['en', en], ['ru', ru]] as const) {
    assert.doesNotMatch(text, new RegExp(`\\b${code}\\b`), `код «${code}» не должен попадать в промпт`);
  }
  assert.doesNotMatch(en, /английск(ий|ого)\.|English\. English/, 'имя языка не рассыпано по прозе');
});

test('the language section is short: it goes into every conversation', () => {
  // The section is a rarely needed exception (translation/regime), not a daily rule.
  // When it grew to 2.2k characters, it was the largest item of the prompt,
  // and every conversation paid for it, including ones where there was no request at all.
  // The ordinary case is held by the line next to the message, so here we keep a ceiling: if it grew,
  // then the prose we had already cleaned up has come back.
  const en = languageRule('en');
  assert.ok(en.length < 1200, `раздел про язык разросся: ${en.length} символов`);
});

test('the exception is described and bounded by a request', () => {
  const en = languageRule('en');

  // A request is the only exception, and it comes in two kinds.
  assert.match(en, /Прямая просьба человека важнее настройки/);
  assert.match(en, /\*\*Разово\*\*/);
  assert.match(en, /\*\*Режим\*\*/);

  // Both ends are held in the short text: you fulfilled the request — you returned to the setting;
  // the regime ends when the person removes it.
  assert.match(en, /возвращаешься к English/);
  assert.match(en, /пока человек его не снимет/);
});

test('in the language section hieroglyphs are called a defect', () => {
  // 08.11.2026 the model inserted 理论上 instead of "теоретически" in the middle of a Russian phrase.
  // The rule must call the defect by its name: "write in Russian" did not catch this.
  for (const code of LANGUAGES) {
    const text = languageRule(code);
    assert.match(text, /иероглифов в ответе нет, даже в цитате/i, `у «${code}» нет запрета иероглифов`);
    assert.match(text, /китайское\s+имя пишешь буквами/);
  }
  // The exception remains lower in the text: a request to translate is stronger than the prohibition.
  assert.match(languageRule('ru'), /Прямая просьба человека важнее настройки/);
});

test('language forms do not diverge: one code, one name', () => {
  // One dictionary per language instead of four parallel maps: added a language — one line.
  for (const code of LANGUAGES) {
    assert.ok(languageName(code).length > 0, `у «${code}» нет полного имени`);
    assert.ok(LANGUAGE_LABELS[code].length > 0, `у «${code}» нет подписи для панели`);
    assert.ok(languageForms(code).adjective.length > 0, `у «${code}» нет прилагательного`);
    // The name is not the code: "English", not "en".
    assert.notEqual(languageName(code), code);
  }
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('ru'), 'Russian');
});

test('the language from the config is parsed, a typo does not bring the service down', () => {
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

test('in the panel the language has labels, and both are human', () => {
  assert.deepEqual(Object.keys(LANGUAGE_LABELS).sort(), ['en', 'ru']);
  for (const label of Object.values(LANGUAGE_LABELS)) {
    assert.ok(label.length > 0 && /[А-Яа-яA-Za-z]/.test(label));
  }
});
