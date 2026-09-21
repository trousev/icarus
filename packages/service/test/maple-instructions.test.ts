// Инструкция про Maple живёт отдельным файлом (MAPLE.md) и читается по требованию:
// в AGENTS.md остаётся только указатель. Так символьный счёт не висит в промпте
// каждого разговора, а появляется там, где он нужен.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentsMd } from '../src/workspace.ts';
import { userVolumes } from '../src/docker/compose.ts';
import { makeConfig, probe } from './fixtures.ts';

test('без настроенного Maple в AGENTS.md нет ни слова про него', () => {
  const md = renderAgentsMd(makeConfig());
  assert.doesNotMatch(md, /mcp_maple_/);
  assert.doesNotMatch(md, /MAPLE\.md/);
});

test('с Maple в AGENTS.md только указатель, а не вся инструкция', () => {
  const md = renderAgentsMd(
    makeConfig({ mcp: { maple: { command: 'node', args: ['/opt/icarus/tools/maple-mcp/server.mjs'] } } }),
  );
  assert.match(md, /MAPLE\.md/, 'должен быть указатель на отдельный файл');
  assert.match(md, /математик/i);
  // Детали (инструменты, dsolve, таймауты, воркшиты) — в MAPLE.md, не здесь.
  assert.doesNotMatch(md, /mcp_maple_evaluate_code/);
  assert.doesNotMatch(md, /dsolve/);
  assert.doesNotMatch(md, /25 секунд/);
  assert.doesNotMatch(md, /воркшит/i);
});

test('MAPLE.md монтируется в контейнер только при настроенном сервере', () => {
  const without = userVolumes(makeConfig(), probe()).join('\n');
  assert.doesNotMatch(without, /MAPLE\.md/);
  const withMaple = userVolumes(
    makeConfig({ mcp: { maple: { command: 'node', args: ['x.mjs'] } } }),
    probe(),
  ).join('\n');
  assert.match(withMaple, /MAPLE\.md:\/workspace\/MAPLE\.md:ro/);
});

test('обычные разделы инструкции не задеты', () => {
  const md = renderAgentsMd(makeConfig({ mcp: { maple: { command: 'node' } } }));
  assert.match(md, /Как устроена память/);
  assert.match(md, /shared-memory\//);
  assert.match(md, /Границы/);
});
