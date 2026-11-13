// Model escalation: the tier-selection rule and parsing of the tier configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseTier,
  isSearchTool,
  parseTierSpec,
  unblockThinking,
  LONG_PROMPT,
  SEARCH_BUDGET,
} from '../../extensions/escalation.ts';

test('a tier spec is parsed from an environment string', () => {
  // A DeepInfra model id itself contains «/», so the provider is split off only by the first one.
  assert.deepEqual(
    parseTierSpec('deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:medium', { provider: 'x', id: 'y', thinking: 'off' }),
    { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', thinking: 'medium' },
  );
  assert.deepEqual(
    parseTierSpec('deepinfra/deepseek-ai/DeepSeek-V4.1-Flash', { provider: 'x', id: 'y', thinking: 'off' }),
    { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', thinking: 'low' },
    'без явного уровня размышления не выключаем: off — корень DSML-бага',
  );
  assert.deepEqual(parseTierSpec('мусор', { provider: 'deepinfra', id: 'fallback', thinking: 'off' }), {
    provider: 'deepinfra',
    id: 'fallback',
    thinking: 'off',
  });
  assert.equal(parseTierSpec(undefined, { provider: 'd', id: 'f', thinking: 'off' }).id, 'f');
});

test('small talk stays on the fast model', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'привет, как дела?' }), 'fast');
  assert.equal(chooseTier({ hasImages: false, prompt: 'расскажи анекдот' }), 'fast');
});

test('an image diverts to the vision model', () => {
  assert.equal(chooseTier({ hasImages: true, prompt: 'что тут?' }), 'vision');
  assert.equal(
    chooseTier({ hasImages: true, prompt: 'привет', searches: SEARCH_BUDGET + 1, heavyTool: true }),
    'vision',
    'картинка важнее тулов',
  );
});

test('work diverts to the strong model', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'напиши код парсера' }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'исправь тесты' }), 'strong');
  assert.equal(
    chooseTier({ hasImages: false, prompt: 'коротко', heavyTool: true }),
    'strong',
    'bash и правки файлов — это руки',
  );
});

test('search and reading by themselves do not escalate', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'найди, как голосовать из Дублина', searches: 1 }), 'fast');
  assert.equal(
    chooseTier({ hasImages: false, prompt: 'погугли', searches: SEARCH_BUDGET }),
    'fast',
    'пара поисков — ещё не повод',
  );
  assert.equal(
    chooseTier({ hasImages: false, prompt: 'погугли', searches: SEARCH_BUDGET + 1 }),
    'strong',
    'затянувшийся поиск — уже работа',
  );
});

test('only reconnaissance and reading count as search tools', () => {
  for (const name of ['web_search', 'web_fetch', 'read', 'grep', 'find', 'ls']) {
    assert.equal(isSearchTool(name), true, name);
  }
  for (const name of ['bash', 'write', 'edit', 'powershell', 'mcp_echo_echo']) {
    assert.equal(isSearchTool(name), false, name);
  }
});

test('a long utterance counts as complex', () => {
  const long = 'а'.repeat(LONG_PROMPT + 1);
  assert.equal(chooseTier({ hasImages: false, prompt: long }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'а'.repeat(50) }), 'fast');
});

test('the tier from the config is not substituted by the pi catalog', () => {
  const strong = { id: 'сильная', thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high' } };
  const unblocked = unblockThinking(strong, 'medium');
  assert.equal(unblocked.thinkingLevelMap?.medium, 'medium', 'medium уезжает провайдеру как есть');
  assert.equal(unblocked.thinkingLevelMap?.high, 'high', 'остальные уровни не трогаем');
  assert.equal(strong.thinkingLevelMap.medium, null, 'исходная модель не мутирует');
});

test('supported levels and disabled thinking are not touched', () => {
  const fast = { id: 'быстрая', thinkingLevelMap: { low: 'low', high: 'high' } };
  assert.equal(unblockThinking(fast, 'low'), fast, 'уровень и так поддержан');
  assert.equal(unblockThinking(fast, 'off'), fast, 'off выключается отдельной веткой pi');
  const noMap = { id: 'custom' };
  assert.equal(unblockThinking(noMap, 'medium'), noMap, 'без каталога не гадаем');
});
