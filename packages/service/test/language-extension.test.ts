// Conversation language: the rule is appended to the person's utterance.
//
// What is guarded here is exactly the defect because of which the «English» setting did not work
// in production. The story is this: at first the rule went as a SEPARATE system message, and the tests
// checked that — but in pi the message was silently lost. The agent runs the history through
// convertToLlm, and it filters out everything except user/assistant/toolResult:
//
//   function defaultConvertToLlm(messages){
//     return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
//   }
//
// The tests were green, production was not: they checked the extension layer, but the loss happened a layer above.
// So now we check not «what the hook returned» but that the rule REMAINS in the person's
// utterance — that is, survives the pi filter. For this there is a test with the real filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import registerLanguage, { appendLanguageOverride, languageOverride } from '../../extensions/language.ts';

/** That very pi filter: everything except user/assistant/toolResult does not go into the request. */
function convertToLlm(messages: Array<{ role?: string }>) {
  return messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
  );
}

test('the language name is full, not a code', () => {
  const text = languageOverride('English');
  assert.match(text, /язык разговора — English/);
  assert.match(text, /отвечаешь на English/);
  // The storage code does not leak into the text: `en` and `ru` are details of config.yaml and profile.json.
  assert.doesNotMatch(text, /\ben\b/);
  assert.doesNotMatch(text, /\bru\b/);
});

test('the rule names the trap case: the first answer and a foreign utterance', () => {
  const text = languageOverride('English');
  // Both temptations on which the model stumbled must be named in plain text —
  // an abstract «ignore the interlocutor's language» was not enough.
  assert.match(text, /[Пп]ервый ответ/);
  assert.match(text, /[Нн]е зеркаль язык его реплики/);
});

test('hieroglyphs are forbidden directly, but translation on request is not forbidden', () => {
  // Prod, 08.11.2026: «Воскресенье, день —理论上 время для подвигов». A Chinese
  // word took the place of «теоретически»: DeepSeek's native language is Chinese, and it slips
  // on a rare Russian word. An abstract «write in Russian» was not enough —
  // a ban named with the same word as the defect is needed.
  const text = languageOverride('Russian');
  assert.match(text, /[Ии]ероглифов нет/);
  assert.match(text, /буквами/);
  // The exception must also be in the line: otherwise the model will refuse to translate.
  assert.match(text, /прямой просьбы/);
});

test('the rule is short: length buys nothing', () => {
  // On the bare API the 894-character variant gave 9/10, the short one — 10/10 and 15/15.
  // We keep brevity under test: the rule hangs on EVERY request to the model.
  assert.ok(languageOverride('English').length < 220, 'правило должно оставаться коротким');
});

test('the rule is appended to the person\'s utterance, not as a new message', () => {
  const messages = [
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Здарова' },
    { role: 'user', content: 'как оно?' },
  ];
  const next = appendLanguageOverride(messages, 'English')!;
  assert.equal(next.length, messages.length, 'новых сообщений не добавляем');
  // Precisely to the last person's utterance: the rule must be closest to the turn.
  assert.match(String(next[2]!.content), /Привет|как оно\?/);
  assert.match(String(next[2]!.content), /English/);
  assert.doesNotMatch(String(next[0]!.content), /English/, 'первая реплика не тронута');
});

test('the rule survives convertToLlm — that is what all this was reworked for', () => {
  // The main test. A system message would not have survived here, and that is exactly what we stumbled on.
  const next = appendLanguageOverride([{ role: 'user', content: 'Привет' }], 'English')!;
  const request = convertToLlm(next as Array<{ role?: string }>);
  assert.equal(request.length, 1, 'реплика человека на месте');
  assert.match(String((request[0] as { content?: unknown }).content), /English/, 'правило доехало до запроса');
});

test('content blocks: the rule goes into the last text block', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Привет' }, { type: 'image', text: '' }] },
  ];
  const next = appendLanguageOverride(messages, 'English')!;
  const content = next[0]!.content as Array<{ type?: string; text?: string }>;
  assert.match(String(content[0]?.text), /English/, 'правило в текстовом блоке, картинка не тронута');
});

test('no person utterance — the hook stays silent', () => {
  assert.equal(appendLanguageOverride([{ role: 'assistant', content: '...' }], 'English'), null);
});

test('source messages are not mutated: pi edits a copy', () => {
  const messages = [{ role: 'user', content: 'Привет' }];
  const before = JSON.stringify(messages);
  appendLanguageOverride(messages, 'English');
  assert.equal(JSON.stringify(messages), before);
});

test('without the setting the extension stays silent', () => {
  // An empty variable — we do not send the rule: we do not impose English by default.
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

test('with the setting the extension edits the context, and the rule stays in the request', () => {
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
    // And — what the whole test is worth it for: after the pi filter the rule is in place.
    const request = convertToLlm(result!.messages as Array<{ role?: string }>);
    const text = request.map((m) => JSON.stringify(m)).join('');
    assert.match(text, /English/, 'правило доехало до запроса');
  } finally {
    if (previous !== undefined) process.env.ICARUS_LANGUAGE = previous;
    else delete process.env.ICARUS_LANGUAGE;
  }
});
