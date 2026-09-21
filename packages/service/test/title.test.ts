// Заголовок разговора: LibreChat спрашивает его отдельным запросом, и этот
// запрос не должен поднимать сессию pi. Проверяем разбор промпта, вызов дешёвой
// модели, откат на эвристику и то, что сессия не трогается ни в одном случае.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { makeConfig, PANEL_SECRET } from './fixtures.ts';
import {
  buildTitlePrompt,
  cleanModelTitle,
  conversationFromTitlePrompt,
  isTitleRequest,
  titleFromPrompt,
  titleFromText,
  TITLE_MODEL_ID,
  TITLE_SENTINEL,
} from '../src/http/title.ts';
import { oneShotArgs } from '../src/sessions/one-shot.ts';

const API_KEY = 'test-token';

/** Промпт ровно в той форме, в какой его собирает LibreChat (`titlePrompt` из yaml). */
function libreChatPrompt(input: string, output = ''): string {
  return `${TITLE_SENTINEL}
Придумай короткий заголовок этого разговора: 3–6 слов, на языке разговора,
без кавычек и без точки в конце. Верни только заголовок.

Conversation:
User: ${input}
AI: ${output}`;
}

test('запрос заголовка узнаётся по модели и по метке', () => {
  const plain = [{ role: 'user', content: 'привет' }];
  assert.equal(isTitleRequest(TITLE_MODEL_ID, plain), true);
  assert.equal(isTitleRequest('icarus', [{ role: 'user', content: libreChatPrompt('привет') }]), true);
  assert.equal(isTitleRequest('icarus', plain), false);
  assert.equal(isTitleRequest(undefined, []), false);
});

test('из промпта LibreChat достаётся первая реплика человека', () => {
  const prompt = libreChatPrompt('Почему не стартует docker compose?');
  assert.equal(conversationFromTitlePrompt(prompt), 'Почему не стартует docker compose?');
});

test('короткая форма промпта — только метка и разговор — разбирается так же', () => {
  const prompt = `${TITLE_SENTINEL}\nUser: Как настроить память?\nAI: `;
  assert.equal(isTitleRequest(TITLE_MODEL_ID, [{ role: 'user', content: prompt }]), true);
  assert.equal(conversationFromTitlePrompt(prompt), 'Как настроить память?');
  assert.equal(titleFromPrompt(prompt), 'Как настроить память');
});

test('приветствие и обращение в заголовок не попадают', () => {
  assert.equal(titleFromText('Привет!'), 'Привет!');
  assert.equal(titleFromText('Привет, Икар! Помоги разобраться, как настроить память.'), 'Помоги разобраться, как настроить память');
  assert.equal(titleFromText('Икар, а как настроить память?'), 'Как настроить память');
  assert.equal(titleFromText('как настроить память?'), 'Как настроить память');
});

test('заголовок ограничен по словам и длине', () => {
  const long = titleFromText('очень длинное сообщение из многих слов которое надо обрезать');
  assert.ok(long.split(/\s+/).length <= 6, `слишком много слов: ${long}`);
  assert.ok(long.length <= 48, `слишком длинно: ${long}`);
});

test('пустая реплика даёт понятный фолбэк', () => {
  assert.equal(titleFromText('   '), 'Новый разговор');
  assert.equal(titleFromText('!!!'), '!!!');
});

test('заголовок собирается из полного промпта', () => {
  assert.equal(titleFromPrompt(libreChatPrompt('Почему не стартует docker compose')), 'Почему не стартует docker compose');
});

test('промпт для модели содержит разговор и не содержит служебной метки', () => {
  const built = buildTitlePrompt('Почему не стартует docker compose?');
  assert.match(built, /Почему не стартует docker compose\?/);
  assert.match(built, /заголовок/i);
  assert.doesNotMatch(built, /\[\[ICARUS_TITLE\]\]/);
});

test('ответ модели чистится до заголовка', () => {
  assert.equal(cleanModelTitle('Docker Compose не стартует после обновления'), 'Docker Compose не стартует после обновления');
  assert.equal(cleanModelTitle('  "Docker Compose не стартует."  '), 'Docker Compose не стартует');
  assert.equal(cleanModelTitle('Заголовок: Настройка памяти'), 'Настройка памяти');
  assert.equal(cleanModelTitle('**Как настроить память**'), 'Как настроить память');
  assert.equal(cleanModelTitle('<think>думаю</think>\nРазбор памяти Икара'), 'Разбор памяти Икара');
  assert.equal(cleanModelTitle(''), '');
  assert.equal(cleanModelTitle('   \n  '), '');
  assert.ok(cleanModelTitle('очень длинный заголовок из многих слов который модель не сжала').split(/\s+/).length <= 8);
});

test('разовый вопрос к модели идёт без тулов, сессии и контекста', () => {
  const args = oneShotArgs(
    { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', thinking: 'off' },
    'вопрос',
    'системная подсказка',
  );
  assert.deepEqual(args.slice(0, 2), ['-p', 'вопрос']);
  assert.ok(args.includes('deepinfra/deepseek-ai/DeepSeek-V4.1-Flash'));
  for (const flag of ['--no-tools', '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates']) {
    assert.ok(args.includes(flag), `нет флага ${flag}`);
  }
  assert.equal(args[args.indexOf('--thinking') + 1], 'off');
});

/** Заголовочный запрос к серверу с подставным реестром. */
async function askTitle(options: {
  oneShot?: (prompt: string) => Promise<string>;
  headers?: Record<string, string>;
}): Promise<{ status: number; content: string; acquire: number; oneShotPrompts: string[] }> {
  const config = makeConfig();

  const oneShotPrompts: string[] = [];
  let acquire = 0;
  const registry = {
    acquire: async () => {
      acquire += 1;
      throw new Error('сессию поднимать нельзя');
    },
    oneShot: async (_user: unknown, prompt: string) => {
      oneShotPrompts.push(prompt);
      if (!options.oneShot) throw new Error('модель не настроена');
      return options.oneShot(prompt);
    },
    list: () => [],
  };

  const server = createServer(config, registry as never, PANEL_SECRET);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        'x-icarus-user-id': 'probe',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify({
        model: TITLE_MODEL_ID,
        stream: false,
        messages: [{ role: 'user', content: libreChatPrompt('Привет, Икар! Почему не стартует docker compose?') }],
      }),
    });
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return { status: response.status, content: payload.choices[0].message.content, acquire, oneShotPrompts };
  } finally {
    server.close();
  }
}

test('заголовок берётся у модели, если она ответила', async () => {
  const result = await askTitle({ oneShot: async () => 'Docker Compose не стартует\n' });
  assert.equal(result.status, 200);
  assert.equal(result.content, 'Docker Compose не стартует');
  assert.equal(result.acquire, 0, 'заголовок не должен трогать реестр сессий');
  assert.equal(result.oneShotPrompts.length, 1);
  assert.match(result.oneShotPrompts[0], /Почему не стартует docker compose\?/);
});

test('сбой модели откатывает на эвристику', async () => {
  const result = await askTitle({
    oneShot: async () => {
      throw new Error('модель не ответила за 12000 мс');
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.content, 'Почему не стартует docker compose');
  assert.equal(result.acquire, 0);
});

test('пустой ответ модели откатывает на эвристику', async () => {
  const result = await askTitle({ oneShot: async () => '   \n' });
  assert.equal(result.status, 200);
  assert.equal(result.content, 'Почему не стартует docker compose');
});

test('неизвестный человек получает эвристику и не дёргает модель', async () => {
  const result = await askTitle({ headers: { 'x-icarus-user-id': 'stranger' } });
  assert.equal(result.status, 200);
  assert.equal(result.content, 'Почему не стартует docker compose');
  assert.equal(result.oneShotPrompts.length, 0);
  assert.equal(result.acquire, 0);
});
