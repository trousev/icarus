// Инструкция про Maple в AGENTS.md появляется только тогда, когда сервер настроен:
// обещать агенту инструменты, которых у него нет, — хуже, чем молчать.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentsMd } from '../src/workspace.ts';
import { makeConfig } from './fixtures.ts';

test('без настроенного Maple в AGENTS.md нет ни слова про mcp_maple', () => {
  const md = renderAgentsMd(makeConfig());
  assert.doesNotMatch(md, /mcp_maple_/);
  assert.doesNotMatch(md, /Maple/);
});

test('с настроенным Maple агент получает инструкцию', () => {
  const md = renderAgentsMd(
    makeConfig({
      mcp: { maple: { command: 'node', args: ['/opt/icarus/tools/maple-mcp/server.mjs'] } },
    }),
  );
  assert.match(md, /mcp_maple_evaluate_code/);
  assert.match(md, /dsolve/);
  assert.match(md, /продолжает работу в новом чате/i, 'агент должен знать про восстановление сессии');
  assert.match(md, /mcp_maple_session_list/);
  assert.match(md, /воркшиты|\.mw/);
  assert.match(md, /25 секунд/, 'про клиентский таймаут надо предупредить');
  assert.match(md, /не взялось/i, 'неудачный интеграл нельзя выдавать за ответ');
  // Обычные разделы никуда не делись.
  assert.match(md, /Как устроена память/);
  assert.match(md, /shared-memory\//);
});
