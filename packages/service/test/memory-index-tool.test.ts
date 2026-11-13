// Memory index tool: a list of files with descriptions and description updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-index-'));
const MEMORY = path.join(ROOT, 'memory');
fs.mkdirSync(path.join(MEMORY, 'projects'), { recursive: true });
fs.writeFileSync(path.join(MEMORY, 'identity.md'), '---\ndescription: кто он\n---\n- Зовут Саня\n');
fs.writeFileSync(path.join(MEMORY, 'projects/arduino.md'), '---\nпро Arduino и диоды\n---\n- Мигает диод\n');

// The variables are read when the module loads, so we set them before import().
process.env.ICARUS_HOME = ROOT;
process.env.ICARUS_MEMORY_DIR = MEMORY;

const { default: register } = await import('../../extensions/memory-index.ts');

type Tool = {
  name?: string;
  description?: string;
  execute?: (id: string, params: Record<string, string | undefined>) => Promise<{ content: Array<{ text: string }> }>;
};
type Hook = (event: { toolName?: string; input?: { path?: string } }) => unknown;

function setup(): { tool: Tool; hooks: Map<string, Hook[]> } {
  let captured: Tool | undefined;
  const hooks = new Map<string, Hook[]>();
  const fakePi = {
    registerTool: (definition: Tool) => {
      captured = definition;
    },
    on: (event: string, handler: Hook) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
  };
  register(fakePi as never);
  assert.ok(captured);
  return { tool: captured, hooks };
}

function tool(): Tool {
  return setup().tool;
}

test('the tool returns an index with descriptions, not file contents', async () => {
  const index = tool();
  assert.equal(index.name, 'memory_index');
  assert.match(String(index.description), /читай выбранные инструментом read/);
  assert.match(String(index.description), /советуешь место, покупку или план/, 'зовёт за ответом, а не только за списком');

  const result = await index.execute!('call-1', {});
  const text = result.content[0]?.text ?? '';
  assert.match(text, /identity\.md — кто он/);
  assert.match(text, /projects\/arduino\.md — про Arduino и диоды/);
  assert.doesNotMatch(text, /Мигает диод/, 'содержимое файла читается отдельно');
});

test('update_description writes the description into frontmatter', async () => {
  const index = tool();
  const result = await index.execute!('call-2', {
    action: 'update_description',
    file: 'projects/arduino.md',
    description: 'Arduino и мигающие диоды',
  });
  assert.match(result.content[0]?.text ?? '', /Описание обновлено/);
  assert.match(fs.readFileSync(path.join(MEMORY, 'projects/arduino.md'), 'utf8'), /description: Arduino и мигающие диоды/);
});

test('one index and three memory reads per turn — then stop', () => {
  const { hooks } = setup();
  const reset = hooks.get('before_agent_start')?.[0];
  const call = hooks.get('tool_call')?.[0];
  assert.ok(reset && call);

  reset({});
  assert.equal(call({ toolName: 'memory_index', input: {} }), undefined, 'первый индекс можно');
  const again = call({ toolName: 'memory_index', input: {} }) as { block?: boolean };
  assert.equal(again.block, true, 'второй индекс уже перебор');

  reset({});
  for (let index = 0; index < 3; index += 1) {
    assert.equal(call({ toolName: 'read', input: { path: path.join(MEMORY, 'identity.md') } }), undefined);
  }
  const blocked = call({ toolName: 'read', input: { path: path.join(MEMORY, 'identity.md') } }) as {
    block?: boolean;
  };
  assert.equal(blocked.block, true, 'четвёртое чтение памяти заблокировано');
  assert.equal(call({ toolName: 'read', input: { path: '/tmp/outside.md' } }), undefined, 'чужие файлы не считаем');
});

test('in private mode the description does not change', async () => {
  const previous = process.env.ICARUS_PRIVATE;
  process.env.ICARUS_PRIVATE = '1';
  try {
    const index = tool();
    const result = await index.execute!('call-3', {
      action: 'update_description',
      file: 'identity.md',
      description: 'нельзя',
    });
    assert.match(result.content[0]?.text ?? '', /Приватный режим/);
    assert.doesNotMatch(fs.readFileSync(path.join(MEMORY, 'identity.md'), 'utf8'), /description: нельзя/);
  } finally {
    if (previous === undefined) delete process.env.ICARUS_PRIVATE;
    else process.env.ICARUS_PRIVATE = previous;
  }
});
