// Эскалация моделей: правило выбора уровня и разбор конфигурации уровней.
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

test('спецификация уровня разбирается из строки окружения', () => {
  assert.deepEqual(parseTierSpec('deepseek/deepseek-v4-pro:medium', { provider: 'x', id: 'y', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'deepseek-v4-pro',
    thinking: 'medium',
  });
  assert.deepEqual(parseTierSpec('deepseek/deepseek-v4-flash', { provider: 'x', id: 'y', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'deepseek-v4-flash',
    thinking: 'off',
  });
  assert.deepEqual(parseTierSpec('мусор', { provider: 'deepseek', id: 'fallback', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'fallback',
    thinking: 'off',
  });
  assert.equal(parseTierSpec(undefined, { provider: 'd', id: 'f', thinking: 'off' }).id, 'f');
});

test('болтовня остаётся на быстрой модели', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'привет, как дела?' }), 'fast');
  assert.equal(chooseTier({ hasImages: false, prompt: 'расскажи анекдот' }), 'fast');
});

test('картинка уводит на модель со зрением', () => {
  assert.equal(chooseTier({ hasImages: true, prompt: 'что тут?' }), 'vision');
  assert.equal(
    chooseTier({ hasImages: true, prompt: 'привет', searches: SEARCH_BUDGET + 1, heavyTool: true }),
    'vision',
    'картинка важнее тулов',
  );
});

test('работа уводит на сильную модель', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'напиши код парсера' }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'исправь тесты' }), 'strong');
  assert.equal(
    chooseTier({ hasImages: false, prompt: 'коротко', heavyTool: true }),
    'strong',
    'bash и правки файлов — это руки',
  );
});

test('поиск и чтение сами по себе не эскалируют', () => {
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

test('поисковыми считаются только разведка и чтение', () => {
  for (const name of ['web_search', 'web_fetch', 'read', 'grep', 'find', 'ls']) {
    assert.equal(isSearchTool(name), true, name);
  }
  for (const name of ['bash', 'write', 'edit', 'powershell', 'mcp_echo_echo']) {
    assert.equal(isSearchTool(name), false, name);
  }
});

test('длинная реплика считается сложной', () => {
  const long = 'а'.repeat(LONG_PROMPT + 1);
  assert.equal(chooseTier({ hasImages: false, prompt: long }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'а'.repeat(50) }), 'fast');
});

test('уровень из конфига не подменяется каталогом pi', () => {
  const pro = { id: 'deepseek-v4-pro', thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high' } };
  const unblocked = unblockThinking(pro, 'medium');
  assert.equal(unblocked.thinkingLevelMap?.medium, 'medium', 'medium уезжает провайдеру как есть');
  assert.equal(unblocked.thinkingLevelMap?.high, 'high', 'остальные уровни не трогаем');
  assert.equal(pro.thinkingLevelMap.medium, null, 'исходная модель не мутирует');
});

test('поддерживаемые уровни и выключенные размышления не трогаем', () => {
  const flash = { id: 'deepseek-v4-flash', thinkingLevelMap: { low: 'low', high: 'high' } };
  assert.equal(unblockThinking(flash, 'low'), flash, 'уровень и так поддержан');
  assert.equal(unblockThinking(flash, 'off'), flash, 'off выключается отдельной веткой pi');
  const noMap = { id: 'custom' };
  assert.equal(unblockThinking(noMap, 'medium'), noMap, 'без каталога не гадаем');
});
