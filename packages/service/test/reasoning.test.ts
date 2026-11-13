// Tool activity is turned into human phrases for reasoning_content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { phraseForToolEnd, phraseForToolStart, subagentStatus } from '../src/reasoning.ts';

test('reading a file', () => {
  assert.equal(phraseForToolStart('read', { path: '/workspaces/.icarus/memory/identity.md' }), 'читаю memory/identity.md');
});

test('editing a file', () => {
  assert.equal(phraseForToolStart('edit', { path: '/workspaces/.icarus/memory/preferences.md' }), 'правлю memory/preferences.md');
});

test('a command is truncated', () => {
  const phrase = phraseForToolStart('bash', { command: 'x'.repeat(200) });
  assert.ok(phrase && phrase.length < 90, 'фраза должна быть короткой');
  assert.match(phrase, /^выполняю: /);
});

test('an unknown tool does not stay silent', () => {
  assert.match(String(phraseForToolStart('mystery', {})), /mystery/);
});

test('the summary distinguishes success from error', () => {
  assert.equal(phraseForToolEnd('write', false), 'записал');
  assert.match(phraseForToolEnd('write', true), /не получилось/);
});

test('subagents: the status shows how many tasks there are and what each child is doing', () => {
  assert.match(String(phraseForToolStart('subagent', { tasks: [{}, {}, {}] })), /субагентам: 3/);
  assert.equal(phraseForToolEnd('subagent', false), 'субагенты закончили');

  const details = {
    subagents: [
      { agent: 'scout', status: 'ok', ms: 1200 },
      { agent: 'researcher', status: 'running', activity: 'web_search: amazon.ie' },
      { agent: 'worker', status: 'queued' },
    ],
  };
  const line = subagentStatus(details);
  assert.match(line ?? '', /агенты 1\/3/);
  assert.match(line ?? '', /researcher: web_search: amazon\.ie/);

  assert.equal(subagentStatus(undefined), null);
  assert.equal(subagentStatus({ subagents: [{ agent: 'scout', status: 'ok' }] }), 'агенты 1/1');
});
