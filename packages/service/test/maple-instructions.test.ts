// Инструкция про Maple живёт отдельным файлом (MAPLE.md) и читается по требованию:
// в AGENTS.md остаётся только указатель. Так символьный счёт не висит в промпте
// каждого разговора, а появляется там, где он нужен.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrateLegacyMaple, renderAgentsMd } from '../src/workspace.ts';
import { userVolumes } from '../src/docker/compose.ts';
import { REPO_ROOT, userPaths } from '../src/config.ts';
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
  // Про LaTeX — тоже деталь: человек прочитает её только вместе с MAPLE.md.
  assert.doesNotMatch(md, /latex/i);
});

// Формулы человеку — всегда в LaTeX, и в инструкции должно быть видно и само
// правило, и чем его исполнять: `latex()` в Maple и `maple_to_latex` в MCP.
test('MAPLE.md требует всегда писать формулы в LaTeX', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'MAPLE.md'), 'utf8');
  assert.match(md, /#+\s*⛔?\s*Формулы[^\n]*LaTeX/, 'нужен отдельный раздел про формулы');
  assert.match(md, /ВСЕГДА/, 'правило должно звучать безоговорочно');
  assert.match(md, /\$x\^2\$/, 'нужен пример формулы в строке');
  assert.match(md, /\$\$\.\.\.\$\$/, 'нужен пример выносной формулы');
  assert.match(md, /latex\(expr, output=string\)/, 'нужна команда Maple latex(...)');
  assert.match(md, /mcp_maple_to_latex/, 'нужен инструмент для перевода в LaTeX');
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

test('каталог математики монтируется постоянно и виден в раскладке', () => {
  const nobody = renderAgentsMd(makeConfig());
  assert.doesNotMatch(nobody, /workspace\/maple/, 'без Maple каталога математики нет');

  const md = renderAgentsMd(makeConfig({ mcp: { maple: { command: 'node' } } }));
  assert.match(md, /`\/workspace\/maple\/`/, 'агент должен знать, где лежат расчёты');

  // Каталог берётся из dataDir человека, а не из временного каталога контейнера:
  // иначе расчёт не переживёт пересоздание контейнера.
  const volumes = userVolumes(makeConfig({ mcp: { maple: { command: 'node' } } }), probe()).join('\n');
  assert.match(volumes, /maple:\/workspace\/maple/);
  assert.doesNotMatch(volumes, /\/workspace\/maple:ro/, 'математику Maple пишет сам, только ro её сломает');

  const without = userVolumes(makeConfig(), probe()).join('\n');
  assert.doesNotMatch(without, /workspace\/maple/);
});

test('старые журналы Maple из pi-agent переезжают в постоянный каталог', () => {
  const config = makeConfig({ mcp: { maple: { command: 'node' } } });
  const paths = userPaths(config, probe());
  const legacy = path.join(paths.piAgent, 'maple-mcp');
  fs.mkdirSync(path.join(legacy, 'plots'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'osc.jsonl'), '{"code":"dsolve(...):"}\n');
  fs.writeFileSync(path.join(legacy, 'plots', '0123456789abcdef.gif'), 'GIF89a');

  // Первый проход переносит журнал и график, второй — уже ничего.
  assert.equal(migrateLegacyMaple(legacy, paths.maple), 2);
  assert.equal(migrateLegacyMaple(legacy, paths.maple), 0);
  assert.equal(fs.readFileSync(path.join(paths.maple, 'osc.jsonl'), 'utf8'), '{"code":"dsolve(...):"}\n');
  assert.equal(fs.readFileSync(path.join(paths.maple, 'plots', '0123456789abcdef.gif'), 'utf8'), 'GIF89a');

  // Свежая версия в постоянном каталоге не затирается старой копией из pi-agent.
  fs.writeFileSync(path.join(paths.maple, 'osc.jsonl'), '{"code":"новое:"}\n');
  fs.writeFileSync(path.join(legacy, 'osc.jsonl'), '{"code":"старое:"}\n');
  migrateLegacyMaple(legacy, paths.maple);
  assert.equal(fs.readFileSync(path.join(paths.maple, 'osc.jsonl'), 'utf8'), '{"code":"новое:"}\n');
});
