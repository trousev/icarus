// Язык разговора: правило дописывается к реплике человека.
//
// Здесь охраняется ровно тот дефект, из-за которого настройка «English» не работала
// в бою. История такая: сначала правило уезжало ОТДЕЛЬНЫМ системным сообщением, и тесты
// это проверяли — а в pi сообщение тихо терялось. Агент прогоняет историю через
// convertToLlm, и тот фильтрует всё, кроме user/assistant/toolResult:
//
//   function defaultConvertToLlm(messages){
//     return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
//   }
//
// Тесты были зелёные, прод — нет: они проверяли слой расширения, а терялось слоем выше.
// Поэтому теперь проверяем не «что вернул хук», а что правило ОСТАЁТСЯ в реплике
// человека — то есть переживает фильтр pi. Для этого есть тест с настоящим фильтром.
import test from 'node:test';
import assert from 'node:assert/strict';
import registerLanguage, { appendLanguageOverride, languageOverride } from '../../extensions/language.ts';

/** Тот самый фильтр pi: всё, кроме user/assistant/toolResult, в запрос не едет. */
function convertToLlm(messages: Array<{ role?: string }>) {
  return messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
  );
}

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

test('иероглифы запрещены прямо, но перевод по просьбе не запрещён', () => {
  // Прод, 08.11.2026: «Воскресенье, день —理论上 время для подвигов». Китайское
  // слово встало вместо «теоретически»: у DeepSeek китайский родной, и на редком
  // русском слове срывается язык. Абстрактного «пиши по-русски» не хватило —
  // нужен запрет, названный тем же словом, что и дефект.
  const text = languageOverride('Russian');
  assert.match(text, /[Ии]ероглифов нет/);
  assert.match(text, /буквами/);
  // Исключение тоже должно быть в строке: иначе модель откажется переводить.
  assert.match(text, /прямой просьбы/);
});

test('правило короткое: длина ничего не покупает', () => {
  // На голом API вариант на 894 символа давал 9/10, короткий — 10/10 и 15/15.
  // Держим краткость под тестом: правило висит на КАЖДОМ запросе к модели.
  assert.ok(languageOverride('English').length < 220, 'правило должно оставаться коротким');
});

test('правило дописывается к реплике человека, а не новым сообщением', () => {
  const messages = [
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Здарова' },
    { role: 'user', content: 'как оно?' },
  ];
  const next = appendLanguageOverride(messages, 'English')!;
  assert.equal(next.length, messages.length, 'новых сообщений не добавляем');
  // Именно к последней реплике человека: правило должно быть ближе всего к ходу.
  assert.match(String(next[2]!.content), /Привет|как оно\?/);
  assert.match(String(next[2]!.content), /English/);
  assert.doesNotMatch(String(next[0]!.content), /English/, 'первая реплика не тронута');
});

test('правило переживает convertToLlm — ради этого всё и переделано', () => {
  // Главный тест. Системное сообщение тут бы не выжило, и именно на этом мы споткнулись.
  const next = appendLanguageOverride([{ role: 'user', content: 'Привет' }], 'English')!;
  const request = convertToLlm(next as Array<{ role?: string }>);
  assert.equal(request.length, 1, 'реплика человека на месте');
  assert.match(String((request[0] as { content?: unknown }).content), /English/, 'правило доехало до запроса');
});

test('блоки контента: правило едет в последний текстовый блок', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Привет' }, { type: 'image', text: '' }] },
  ];
  const next = appendLanguageOverride(messages, 'English')!;
  const content = next[0]!.content as Array<{ type?: string; text?: string }>;
  assert.match(String(content[0]?.text), /English/, 'правило в текстовом блоке, картинка не тронута');
});

test('нет реплики человека — хук молчит', () => {
  assert.equal(appendLanguageOverride([{ role: 'assistant', content: '...' }], 'English'), null);
});

test('исходные сообщения не мутируются: pi правит копию', () => {
  const messages = [{ role: 'user', content: 'Привет' }];
  const before = JSON.stringify(messages);
  appendLanguageOverride(messages, 'English');
  assert.equal(JSON.stringify(messages), before);
});

test('без настройки расширение молчит', () => {
  // Пустая переменная — правило не шлём: английский по умолчанию не навязываем.
  const previous = process.env.ICARUS_LANGUAGE;
  delete process.env.ICARUS_LANGUAGE;
  try {
    const handlers: Array<() => unknown> = [];
    const fakePi = { on: (_event: string, handler: () => unknown) => handlers.push(handler) } as never;
    registerLanguage(fakePi);
    assert.equal(handlers.length, 0, 'обработчика контекста нет вовсе');
  } finally {
    if (previous !== undefined) process.env.ICARUS_LANGUAGE = previous;
  }
});

test('с настройкой расширение правит контекст, и правило остаётся в запросе', () => {
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
    // И — то, ради чего стоит весь тест: после фильтра pi правило на месте.
    const request = convertToLlm(result!.messages as Array<{ role?: string }>);
    const text = request.map((m) => JSON.stringify(m)).join('');
    assert.match(text, /English/, 'правило доехало до запроса');
  } finally {
    if (previous !== undefined) process.env.ICARUS_LANGUAGE = previous;
    else delete process.env.ICARUS_LANGUAGE;
  }
});
