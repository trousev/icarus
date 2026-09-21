// Часы Икара: пояс, часть суток, метка к реплике и тул now.
//
// Главное, что здесь стережём: дата НЕ попадает в системный промпт — иначе он менялся
// бы от смены суток и рвал кэш. Время приезжает меткой к реплике человека.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import clockExtension, { appendMoment, NOW_TOOL, type ChatMessage } from '../../extensions/clock.ts';
import personaExtension from '../../extensions/persona.ts';
import {
  dayPart,
  exactMoment,
  isValidZone,
  localDate,
  localParts,
  momentLine,
  offsetLabel,
  resolveZone,
  TIME_INSTRUCTION,
  unknownZone,
} from '../../extensions/lib/time-core.ts';

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Tool = {
  name?: string;
  description?: string;
  execute?: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
};

/** Заглушка pi: запоминаем обработчики и тулы, чтобы дёргать их руками. */
function fakePi() {
  const handlers = new Map<string, Handler>();
  const tools: Tool[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: Tool) {
      tools.push(tool);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, tools };
}

test('пояс берётся из ICARUS_TZ, потом из TZ, битый — не ломает часы', () => {
  assert.equal(resolveZone({ ICARUS_TZ: 'Europe/Dublin', TZ: 'UTC' }), 'Europe/Dublin');
  assert.equal(resolveZone({ TZ: 'Europe/Dublin' }), 'Europe/Dublin');
  assert.ok(isValidZone(resolveZone({ TZ: 'Mars/Olympus' })));
  assert.notEqual(resolveZone({ TZ: 'Mars/Olympus' }), 'Mars/Olympus');
  assert.equal(unknownZone({ TZ: 'Mars/Olympus' }), 'Mars/Olympus');
  assert.equal(unknownZone({ TZ: 'UTC' }), null);
});

test('часть суток считается по локальному часу', () => {
  const at = (iso: string) => dayPart(new Date(iso), 'UTC');
  assert.equal(at('2026-09-18T00:30:00Z'), 'ночь');
  assert.equal(at('2026-09-18T05:59:00Z'), 'ночь');
  assert.equal(at('2026-09-18T06:00:00Z'), 'утро');
  assert.equal(at('2026-09-18T11:59:00Z'), 'утро');
  assert.equal(at('2026-09-18T12:00:00Z'), 'день');
  assert.equal(at('2026-09-18T17:59:00Z'), 'день');
  assert.equal(at('2026-09-18T18:00:00Z'), 'вечер');
  assert.equal(at('2026-09-18T23:59:00Z'), 'вечер');
});

test('дата считается по поясу человека, а не по UTC', () => {
  const late = new Date('2026-09-18T23:30:00Z');
  assert.deepEqual(localParts(late, 'UTC'), { year: 2026, month: 9, day: 18 });
  assert.deepEqual(localParts(late, 'Europe/Dublin'), { year: 2026, month: 9, day: 19 });
  assert.equal(localDate(late, 'Europe/Dublin'), '2026-09-19');
});

test('метка «Сейчас» — дата и часть суток, без часов', () => {
  const line = momentLine(new Date('2026-09-18T22:00:00Z'), 'Europe/Dublin');
  assert.match(line, /^\[Сейчас: .*18 сентября 2026, вечер\]$/);
  assert.doesNotMatch(line, /\d{2}:\d{2}/, 'часы в метку не едут: ход не должен ломать кэш');
});

test('тул отдаёт точное время, пояс и смещение', () => {
  const exact = exactMoment(new Date('2026-09-18T10:00:00Z'), 'Europe/Dublin');
  assert.match(exact, /18 сентября 2026, 11:00/);
  assert.match(exact, /\(Europe\/Dublin, UTC\+01:00\)/);
  assert.equal(offsetLabel(new Date('2026-09-18T10:00:00Z'), 'UTC'), '+00:00');
});

test('метка дописывается к последней реплике человека', () => {
  const line = '[Сейчас: пятница, 18 сентября 2026, вечер]';

  const plain: ChatMessage[] = [
    { role: 'assistant', content: 'ну' },
    { role: 'user', content: 'сколько времени?' },
  ];
  const withText = appendMoment(plain, line);
  assert.equal(withText?.[1]?.content, `сколько времени?\n\n${line}`);
  assert.equal(plain[1]?.content, 'сколько времени?', 'исходные сообщения не трогаем');

  const blocks: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'привет' }, { type: 'image', text: '' }] },
  ];
  const withBlocks = appendMoment(blocks, line);
  const content = withBlocks?.[0]?.content as Array<{ text?: string }>;
  assert.match(String(content[0]?.text), /^привет\n\n\[Сейчас: /);

  assert.equal(appendMoment([{ role: 'assistant', content: 'ага' }], line), null);
});

test('часы пропускают метку к реплике, а системный промпт оставляют без даты', async () => {
  const clock = fakePi();
  clockExtension(clock.pi);

  await clock.handlers.get('before_agent_start')?.({});
  const messages: ChatMessage[] = [{ role: 'user', content: 'я поел' }];
  const result = (await clock.handlers.get('context')?.({ messages })) as { messages: ChatMessage[] };
  assert.match(String(result.messages[0]?.content), /\[Сейчас: /);

  const tool = clock.tools.find((item) => item.name === NOW_TOOL);
  assert.ok(tool, 'тул now зарегистрирован');
  const answer = await tool.execute?.('id', {});
  assert.match(String(answer?.content[0]?.text), /^Сейчас: .*UTC[+-]\d{2}:\d{2}\)$/);

  const persona = fakePi();
  personaExtension(persona.pi);
  const built = (await persona.handlers.get('before_agent_start')?.({
    systemPromptOptions: { contextFiles: [] },
  })) as { systemPrompt?: string };
  const prompt = String(built.systemPrompt ?? '');
  assert.ok(prompt.includes(TIME_INSTRUCTION), 'стабильная инструкция про время в промпте');
  const timeSection = prompt.slice(prompt.indexOf('# Время'));
  assert.doesNotMatch(timeSection, /\d{4}/, 'в секции времени нет даты — промпт не меняется от суток');
});
