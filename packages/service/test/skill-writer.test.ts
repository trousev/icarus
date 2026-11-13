// skill_writer: a skill is created as a directory, not a lone SKILL.md anywhere.
//
// We check the core separately from pi: it is pure and decides what counts as a name,
// a shelf and a bundle file. The extension only chooses the root (personal or
// project) and refuses in private mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import register, { SKILL_WRITER_TOOL } from '../../extensions/skill-writer.ts';
import {
  normalizeFolder,
  personalSkillsRoot,
  safeBundlePath,
  workspaceSkillsRoot,
  writeSkill,
} from '../../extensions/lib/skill-writer-core.ts';

function tempRoot(prefix = 'icarus-skill-writer-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type ToolDefinition = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<ToolResult>;
};

function loadTool(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  const api = { registerTool: (tool: unknown) => tools.push(tool as ToolDefinition), on: () => undefined };
  register(api as unknown as ExtensionAPI);
  const tool = tools.find((item) => item.name === SKILL_WRITER_TOOL);
  assert.ok(tool, 'инструмент skill_writer должен регистрироваться');
  return tool;
}

test('a skill lands as a canonical directory and is visible to the pi loader', () => {
  const root = tempRoot();
  const result = writeSkill(root, {
    name: 'pirate-mode',
    description: 'говорить как пират',
    body: '# Йо-хо-хо',
    files: [{ path: 'scripts/run.sh', content: '#!/bin/sh\n' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.id, 'pirate-mode/SKILL.md');
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode', 'scripts', 'run.sh')), true);

  const seen = loadSkillsFromDir({ dir: root, source: 'user' });
  assert.deepEqual(seen.skills.map((skill) => skill.name), ['pirate-mode']);
  assert.equal(seen.skills[0].description, 'говорить как пират');
  assert.deepEqual(seen.diagnostics, []);
});

test('a shelf places the skill inside, without pulling it to the top', () => {
  const root = tempRoot();
  const result = writeSkill(root, {
    name: 'sea-wolf',
    description: 'ок',
    body: 'тело',
    folder: 'sea',
  });
  assert.equal(result.ok && result.id, 'sea/sea-wolf/SKILL.md');
  assert.equal(fs.existsSync(path.join(root, 'sea', 'sea-wolf', 'SKILL.md')), true);
});

test('name, description and paths are validated before writing', () => {
  const root = tempRoot();
  assert.equal(writeSkill(root, { name: 'Pirate Mode', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'pirate-mode', description: '  ', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'pirate-mode', description: 'ок', body: '' }).ok, false);
  assert.equal(
    writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'x', folder: '../evil' }).ok,
    false,
  );
  assert.equal(
    writeSkill(root, {
      name: 'pirate-mode',
      description: 'ок',
      body: 'x',
      files: [{ path: '../evil.sh', content: 'x' }],
    }).ok,
    false,
  );
  assert.deepEqual(fs.readdirSync(root), [], 'после отказов ничего не создано');
});

test('an existing skill is not overwritten without overwrite', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'старое', body: 'старое' });
  const refused = writeSkill(root, { name: 'pirate-mode', description: 'новое', body: 'новое' });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /уже есть/);

  const overwritten = writeSkill(root, {
    name: 'pirate-mode',
    description: 'новое',
    body: 'новое',
    overwrite: true,
  });
  assert.equal(overwritten.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), 'utf8'), /новое/);
});

test('a disabled skill with the same name also counts as a taken name', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.disabled', 'pirate-mode'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.disabled', 'pirate-mode', 'SKILL.md'),
    '---\nname: pirate-mode\ndescription: выключен\n---\n',
  );

  const result = writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /выключен/);
});

test('shelves and bundle files do not escape the directory', () => {
  assert.equal(normalizeFolder(undefined), '');
  assert.equal(normalizeFolder('sea/north'), 'sea/north');
  assert.equal(normalizeFolder('../evil'), null);
  assert.equal(normalizeFolder('.disabled'), null, 'служебный каталог — не полка');
  assert.equal(normalizeFolder('/tmp'), null);
  assert.equal(safeBundlePath('scripts/run.sh'), 'scripts/run.sh');
  assert.equal(safeBundlePath('../run.sh'), null);
  assert.equal(safeBundlePath('/run.sh'), null);
  assert.equal(safeBundlePath('SKILL.md'), null);
});

test('the environment suggests the personal and project roots', () => {
  assert.equal(personalSkillsRoot({ HOME: '/home/x' }), '/home/x/.pi/agent/skills');
  assert.equal(
    personalSkillsRoot({ HOME: '/home/x', ICARUS_SKILLS_DIR: '/custom/skills' }),
    '/custom/skills',
  );
  assert.equal(workspaceSkillsRoot('/workspaces/talk'), '/workspaces/talk/.pi/skills');
});

test('the tool writes to the personal directory and says where the skill is', async () => {
  const root = tempRoot('icarus-skill-writer-tool-');
  const previous = process.env.ICARUS_SKILLS_DIR;
  process.env.ICARUS_SKILLS_DIR = root;
  try {
    const tool = loadTool();
    const result = await tool.execute(
      'call-1',
      { name: 'pirate-mode', description: 'говорить как пират', body: '# Йо-хо-хо' },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(result.content[0]?.text ?? '', /создан/);
    assert.equal(fs.existsSync(path.join(root, 'pirate-mode', 'SKILL.md')), true);
    assert.equal(result.details.ok, true);
  } finally {
    if (previous === undefined) delete process.env.ICARUS_SKILLS_DIR;
    else process.env.ICARUS_SKILLS_DIR = previous;
  }
});

test('workspace puts the skill into .pi/skills of the current folder', async () => {
  const cwd = tempRoot('icarus-skill-writer-ws-');
  const tool = loadTool();
  const result = await tool.execute(
    'call-2',
    { name: 'local-helper', description: 'помогает в этой папке', body: 'тело', scope: 'workspace' },
    undefined,
    undefined,
    { cwd },
  );
  assert.equal(result.details.scope, 'workspace');
  assert.equal(fs.existsSync(path.join(cwd, '.pi', 'skills', 'local-helper', 'SKILL.md')), true);
});

test('in private mode skills are not created', async () => {
  const root = tempRoot('icarus-skill-writer-private-');
  const previous = process.env.ICARUS_PRIVATE;
  process.env.ICARUS_PRIVATE = '1';
  try {
    const tool = loadTool();
    const result = await tool.execute(
      'call-3',
      { name: 'pirate-mode', description: 'ок', body: 'тело' },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(result.content[0]?.text ?? '', /Приватный режим/);
    assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false);
  } finally {
    if (previous === undefined) delete process.env.ICARUS_PRIVATE;
    else process.env.ICARUS_PRIVATE = previous;
  }
});
