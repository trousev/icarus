#!/usr/bin/env node
// Самотест Maple MCP: поднимает сервер по stdio и прогоняет сценарии.
// Запуск: node tools/maple-mcp/test.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'server.mjs');

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MAPLE_MCP_DEBUG: process.env.MAPLE_MCP_DEBUG ?? '0' },
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('NON-JSON:', line);
      continue;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let nextId = 1;
function call(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`таймаут ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, args) {
  const r = await call('tools/call', { name, arguments: args });
  const res = r.result ?? r.error ?? r;
  const text = (res.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : `<${c.type} ${c.mimeType ?? ''} ${c.data?.length ?? 0}b64>`))
    .join('\n');
  return { isError: Boolean(res.isError), text };
}

let pass = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
  }
}

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
console.log(`server: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version} protocol=${init.result?.protocolVersion}`);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await call('tools/list', {});
console.log(`tools: ${list.result.tools.length}\n`);

const work = await mkdtemp(path.join(tmpdir(), 'maple-mcp-test-'));
const mw = path.join(work, 'test.mw');

console.log('1) health');
{
  const r = await tool('maple_health', {});
  console.log(r.text.split('\n').map((l) => `   ${l}`).join('\n'));
  check('health ok', !r.isError, r.text);
  check('версия Maple 18', /Maple 18/.test(r.text), r.text);
}

console.log('\n2) вычисления и состояние сессии');
{
  const a = await tool('maple_evaluate_code', { code: 'a:=41:' });
  check('присваивание', !a.isError, a.text);
  const f = await tool('maple_evaluate_code', { code: 'f:=proc(x) x^2 end proc:' });
  check('определение функции', !f.isError, f.text);
  const r = await tool('maple_evaluate_code', { code: 'f(a)+1;' });
  check('состояние сохранилось (f(a)+1 = 1682)', !r.isError && r.text.includes('1682'), r.text);
  const l = await tool('maple_evaluate_code', { code: 'for i from 1 to 3 do printf("i=%d\\n", i): end do:' });
  check('многострочный цикл', !l.isError && /i=3/.test(l.text), l.text);
}

console.log('\n3) ошибки: синтаксис и runtime');
{
  const bad = await tool('maple_evaluate_code', { code: 'x := ;' });
  check('синтаксическая ошибка поймана', bad.isError && /syntax error/i.test(bad.text), bad.text);
  const after = await tool('maple_evaluate_code', { code: 'printf("ALIVE\\n"):' });
  check('сессия жива после синтаксической ошибки', !after.isError && after.text.includes('ALIVE'), after.text);
  const rt = await tool('maple_evaluate_code', { code: '1/0;' });
  check('runtime-ошибка поймана', rt.isError && /division by zero/i.test(rt.text), rt.text);
  const after2 = await tool('maple_evaluate_code', { code: 'a+1;' });
  check('сессия жива после runtime-ошибки', !after2.isError && after2.text.includes('42'), after2.text);
  const chk = await tool('maple_check_code', { code: 'sin(' });
  check('check_code видит ошибку', chk.isError, chk.text);

  const guard = await tool('maple_evaluate_code', { code: 'quit:' });
  check('верхнеуровневый quit заблокирован', guard.isError && /quit/.test(guard.text), guard.text);

  const to = await tool('maple_evaluate_code', { code: 'while true do end do:', timeout_seconds: 2 });
  check('таймаут ловится', to.isError && /таймаут/i.test(to.text), to.text);
  const back = await tool('maple_evaluate_code', { code: 'printf("BACK\\n"):' });
  check('сессия поднялась после таймаута', !back.isError && /BACK/.test(back.text), back.text);
}

console.log('\n4) LaTeX');
{
  const r = await tool('maple_to_latex', { expression: 'int(x^2, x)' });
  check('latex получен', !r.isError && /x/.test(r.text) && r.text.includes('{'), r.text);
  console.log(`   → ${r.text.split('\n').pop()}`);
}

console.log('\n5) график');
{
  const r = await tool('maple_plot', { expression: 'plot(sin(x), x=-Pi..Pi)', format: 'gif' });
  check('график gif получен', !r.isError && /image/.test(r.text), r.text);
  const png = await tool('maple_plot', { expression: 'plot(cos(x), x=-Pi..Pi)', format: 'png' });
  console.log(`   png: ${png.isError ? 'не поддержан' : 'ок'} — ${png.text.split('\n')[0]}`);
}

console.log('\n6) воркшиты');
{
  const created = await tool('maple_worksheet_create', {
    path: mw,
    cells: ['restart:', 'f := proc(x) x^3 end proc:', 'f(5);', 'plot(f(x), x=-2..2);'],
    overwrite: true,
  });
  check('создание .mw + проверка Maple', !created.isError, created.text);

  const read = await tool('maple_worksheet_read', { path: mw });
  check('чтение .mw', !read.isError && /групп: 4/.test(read.text), read.text.slice(0, 400));
  console.log(read.text.split('\n').slice(0, 10).map((l) => `   ${l}`).join('\n'));

  const run = await tool('maple_worksheet_run_cell', { path: mw, index: 1 });
  check('выполнение ячейки #1', !run.isError, run.text);
  const run2 = await tool('maple_worksheet_run_cell', { path: mw, index: 2 });
  check('ячейка #2 → 125', !run2.isError && run2.text.includes('125'), run2.text);

  const edited = await tool('maple_worksheet_edit_cell', { path: mw, index: 2, code: 'f(6);' });
  check('правка ячейки', !edited.isError, edited.text);
  const run3 = await tool('maple_worksheet_run_cell', { path: mw, index: 2 });
  check('после правки → 216', !run3.isError && run3.text.includes('216'), run3.text);

  const missing = await tool('maple_worksheet_run_cell', { path: mw, index: 99 });
  check('несуществующая ячейка — ошибка', missing.isError, missing.text);
}

console.log('\n7) сессии');
{
  const other = await tool('maple_evaluate_code', { code: 'q:=7:', session: 'other' });
  check('вторая сессия', !other.isError, other.text);
  const isolated = await tool('maple_evaluate_code', { code: 'assigned(q);', session: 'default' });
  check('сессии изолированы (в default q не assigned)', !isolated.isError && /false/i.test(isolated.text), isolated.text);
  const listS = await tool('maple_session_list', {});
  check('список сессий', !listS.isError && /other/.test(listS.text), listS.text);
  const reset = await tool('maple_session_reset', { session: 'other' });
  check('сброс сессии', !reset.isError, reset.text);
}

console.log(`\nи т о г о: ${pass} ok, ${failCount} fail`);
await rm(work, { recursive: true, force: true }).catch(() => {});
child.kill('SIGTERM');
setTimeout(() => process.exit(failCount ? 1 : 0), 500);
