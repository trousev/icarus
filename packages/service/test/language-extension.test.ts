// Язык разговора отдельным системным сообщением.
//
// Охраняем ровно тот дефект, ради которого расширение и появилось: правило языка
// внутри большого русского промпта не держало — при настройке English и русской
// реплике человека Икар отвечал по-русски (0/10 в
// tools/persona-flywheel/smoke-language.mjs). Отдельное системное сообщение держит:
// 20/20 там же. Тесты ниже проверяют не «красиво ли написано», а механику:
// сообщение добавляется, идёт системным и последним, несёт полное имя языка и
// называет случай-ловушку (первый ответ и чужая реплика).
import test from 'node:test';
import assert from 'node:assert/strict';
import registerLanguage, { appendLanguageOverride, languageOverride } from '../../extensions/language.ts';

test('имя языка — полное, а не код', () => {
  const text = languageOverride('English');
  assert.match(text, /язык разговора — English/);
  assert.match(text, /отвечаешь на English/);
  // Код хранения в текст не протекает: `en` и `ru` — детали config.yaml и profile.json.
  assert.doesNotMatch(text, /\ben\b/);
  assert.doesNotMatch(text, /\bru\b/);
});

test('правило называет случай-ловушку: первый ответ и чужая реплика', () => {
  const text = languageOverride('English');
  // Оба соблазна, на которых модель спотыкалась, должны быть названы прямым текстом —
  // абстрактного «игнорируй язык собеседника» не хватило.
  assert.match(text, /[Пп]ервый ответ/);
  assert.match(text, /[Нн]е зеркаль язык его реплики/);
});

test('правило короткое: длина ничего не покупает', () => {
  // На боевом промпте вариант на 894 символа давал 9/10, на 136 — 10/10 (и 15/15).
  // Держим краткость под тестом, чтобы правило не расползлось обратно в простыню:
  // оно висит в промпте на КАЖДОМ запросе к модели, и лишнее там дороже, чем кажется.
  assert.ok(languageOverride('English').length < 220, 'правило должно оставаться коротким');
});

test('сообщение добавляется системным и последним', () => {
  const messages = [
    { role: 'system', content: 'большая русская карта' },
    { role: 'user', content: 'Привет' },
  ];
  const next = appendLanguageOverride(messages, 'English');
  assert.equal(next.length, messages.length + 1, 'добавлено ровно одно сообщение');
  const added = next[next.length - 1];
  assert.equal(added.role, 'system', 'идёт системным: это констрейнт, а не реплика');
  // Последним — значит ближе всего к ходу модели, читается перед ответом.
  assert.equal(next[next.length - 1], added);
});

test('исходные сообщения не мутируются: pi правит копию', () => {
  const messages = [{ role: 'user', content: 'Привет' }];
  const before = JSON.stringify(messages);
  appendLanguageOverride(messages, 'English');
  assert.equal(JSON.stringify(messages), before);
});

test('контекст вызывается на каждом запросе хода, но сообщение не копится', () => {
  // pi зовёт хук context на КАЖДЫЙ запрос к модели — в ходе с тулами это несколько
  // раз. Сообщение при этом уезжает в копию, а не в сессию, и следующий вызов
  // получает тот же исходный список: дубликаты не накапливаются.
  let session = [{ role: 'system', content: 'большая карта' }, { role: 'user', content: 'Привет' }];
  const counts = [];
  for (let step = 0; step < 3; step++) {
    const forRequest = appendLanguageOverride(session, 'English');
    counts.push(forRequest.filter((m) => m.role === 'system').length);
    // Сессия растёт как обычно (ответ модели, тулы) — нашей реплики там не появляется.
    session = [...session, { role: 'assistant', content: `шаг ${step}` }];
  }
  assert.deepEqual(counts, [2, 2, 2], 'ровно одно системное сообщение языка на каждый запрос, без накопления');
});

test('без настройки расширение молчит', () => {
  // Пустая переменная — правило не шлём: английский по умолчанию не навязываем.
  const previous = process.env.ICARUS_LANGUAGE;
  delete process.env.ICARUS_LANGUAGE;
  try {
    const handlers: Array<() => unknown> = [];
    const fakePi = {
      on: (_event: string, handler: () => unknown) => handlers.push(handler),
    } as never;
    registerLanguage(fakePi);
    assert.equal(handlers.length, 0, 'обработчика контекста нет вовсе');
  } finally {
    if (previous !== undefined) process.env.ICARUS_LANGUAGE = previous;
  }
});

test('с настройкой расширение подписывается на контекст и правит его', () => {
  const previous = process.env.ICARUS_LANGUAGE;
  process.env.ICARUS_LANGUAGE = 'English';
  try {
    let handler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
    const fakePi = {
      on: (event: string, fn: typeof handler) => {
        if (event === 'context') handler = fn;
      },
    } as never;
    registerLanguage(fakePi);
    assert.equal(typeof handler, 'function', 'подписался на context');

    const result = handler!({ messages: [{ role: 'user', content: 'Привет' }] });
    assert.ok(result?.messages, 'вернул правленый список');
    const last = result!.messages[result!.messages.length - 1] as { role: string; content: unknown };
    assert.equal(last.role, 'system');
    const text = Array.isArray(last.content)
      ? (last.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
      : String(last.content);
    assert.match(text, /English/, 'в правленом списке есть имя языка');
  } finally {
    if (previous !== undefined) process.env.ICARUS_LANGUAGE = previous;
    else delete process.env.ICARUS_LANGUAGE;
  }
});
