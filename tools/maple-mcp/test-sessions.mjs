#!/usr/bin/env node
// Тест «длинных» сессий Maple: состояние живёт в журнале и переживает
// конец чата (перезапуск MCP-процесса) и принудительную остановку по простою.
// Плюс проверка утечки процессов: ядро Maple не остаётся сиротой после остановки.
//
// Запуск: node tools/maple-mcp/test-sessions.mjs
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'server.mjs');
const sessionDir = await mkdtemp(path.join(tmpdir(), 'maple-sessions-test-'));

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

// ─── процессы Maple: следим за утечкой ──────────────────────────────────
//
// Maple — это всегда два процесса: обёртка `cmaple` (её pid возвращает spawn) и ядро
// `mserver`, которое обёртка порождает сама. Если погасить только обёртку, ядро
// осиротеет, а в контейнере человека PID 1 — `sleep infinity`, который сирот не
// подбирает: каждый брошенный `mserver` остаётся зомби (`[mserver] <defunct>`) навсегда.
// Поэтому сервер запускает Maple в отдельной группе процессов и гасит группу целиком.

/** Живые процессы Maple: pid → { ppid, pgid, sid, comm }. */
function mapleProcs() {
  const out = execSync('ps -eo pid=,ppid=,pgid=,sid=,comm=', { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.trim().split('\n')) {
    const [pid, ppid, pgid, sid, comm] = line.trim().split(/\s+/);
    if (comm === 'cmaple' || comm === 'mserver') map.set(pid, { ppid, pgid, sid, comm });
  }
  return map;
}

/** Кто ещё жив в группе процессов `pgid`. */
function procsInGroup(pgid) {
  const out = execSync('ps -eo pid=,pgid=', { encoding: 'utf8' });
  return out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, g]) => g === String(pgid))
    .map(([p]) => p);
}

/** Ждём, пока группа опустеет: возвращаем тех, кто остался (пусто — хорошо). */
async function waitGroupGone(pgid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pgid ? procsInGroup(pgid) : [];
    if (left.length === 0) return [];
    if (Date.now() > deadline) return left;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Поднимает MCP-сервер и отдаёт клиента — как это делает pi в начале чата. */
function makeClient(env = {}) {
  const child = spawn(process.execPath, [server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MAPLE_BIN: process.env.MAPLE_BIN ?? '/opt/maple18/bin/maple',
      MAPLE_SESSION_DIR: sessionDir,
      MAPLE_TIMEOUT_SECONDS: '25',
      ...env,
    },
  });
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
        continue;
      }
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    }
  });
  let id = 1;
  const call = (method, params, timeoutMs = 180_000) =>
    new Promise((resolve, reject) => {
      const i = id++;
      const t = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`таймаут ${method}`));
      }, timeoutMs);
      pending.set(i, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    const c = r.result?.content ?? [];
    return { err: Boolean(r.result?.isError), text: c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') };
  };
  return { child, call, tool, kill: () => child.kill('SIGKILL') };
}

const init = (c) => c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } });

// ─── Чат 1: длинная работа ────────────────────────────────────────────────
console.log('1) ЧАТ 1 — вводим данные, решаем дифур, считаем');
let chat1 = makeClient();
await init(chat1);
{
  const tools = await chat1.call('tools/list', {});
  check('инструментов 14', tools.result.tools.length === 14, String(tools.result.tools.length));

  const a = await chat1.tool('maple_evaluate_code', {
    code: 'm := 2: k := 3: ic := {y(0)=1, D(y)(0)=0}:',
    session: 'osc',
  });
  check('данные заданы', !a.err, a.text);

  const b = await chat1.tool('maple_evaluate_code', {
    code: 'sol := dsolve({diff(y(x),x,x)+k^2*y(x)=0} union ic, y(x));',
    session: 'osc',
  });
  check('дифур решён', !b.err && /cos|sin/.test(b.text), b.text);

  const c = await chat1.tool('maple_evaluate_code', { code: 'y_at_1 := eval(rhs(sol), x=1):', session: 'osc' });
  check('промежуточный результат посчитан', !c.err, c.text);

  const l = await chat1.tool('maple_session_list', {});
  check('сессия видна как живая', /osc\s+жива/.test(l.text), l.text);
}
console.log('   (имитируем конец чата: убиваем MCP-процесс)');
chat1.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Чат 2: продолжаем с того же места ───────────────────────────────────
console.log('\n2) ЧАТ 2 — новый процесс MCP, продолжаем работу');
const chat2 = makeClient();
await init(chat2);
{
  const l = await chat2.tool('maple_session_list', {});
  check('журнал прошлого чата виден', /osc/.test(l.text) && /журнал: \d+ шагов/.test(l.text), l.text);

  const cont = await chat2.tool('maple_evaluate_code', {
    code: 'printf("m=%a k=%a y(1)=%a\\n", m, k, y_at_1);',
    session: 'osc',
  });
  check('состояние восстановилось автоматически', !cont.err && /m=2 k=3/.test(cont.text), cont.text);
  check('было сказано, что сессия восстановлена', /восстановлена из журнала/.test(cont.text), cont.text);

  const more = await chat2.tool('maple_evaluate_code', { code: 'y_at_2 := eval(rhs(sol), x=2):', session: 'osc' });
  check('дописали в ту же сессию', !more.err, more.text);

  const hist = await chat2.tool('maple_session_history', { session: 'osc' });
  check('история показывает шаги', !hist.err && /dsolve/.test(hist.text), hist.text.slice(0, 200));

  const resume = await chat2.tool('maple_session_resume', { session: 'osc' });
  check('явный resume идемпотентен', !resume.err, resume.text);
}
chat2.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Чат 3: третья жизнь той же сессии + забывание ────────────────────────
console.log('\n3) ЧАТ 3 — ещё один процесс, состояние на месте');
const chat3 = makeClient();
await init(chat3);
{
  const v = await chat3.tool('maple_evaluate_code', { code: 'y_at_2;', session: 'osc' });
  check('третье восстановление работает (y(2)=cos 6)', !v.err && /cos\(6\)/.test(v.text), v.text);

  const forgotten = await chat3.tool('maple_session_forget', { session: 'osc' });
  check('forget стирает журнал', !forgotten.err && /удалён/.test(forgotten.text), forgotten.text);

  const after = await chat3.tool('maple_session_list', {});
  check('после forget сессии нет', !/osc/.test(after.text), after.text);
}
chat3.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Остановка по простою (5 минут в проде, 2 секунды в тесте) ────────────
console.log('\n4) Простой: ядро гасится, состояние остаётся в журнале');
const chat4 = makeClient({ MAPLE_IDLE_SECONDS: '2' });
await init(chat4);
{
  await chat4.tool('maple_evaluate_code', { code: 'zz := 777:', session: 'idle' });
  const before = await chat4.tool('maple_session_list', {});
  check('сессия жива до простоя', /idle\s+жива/.test(before.text), before.text);

  await new Promise((r) => setTimeout(r, 5000));
  const after = await chat4.tool('maple_session_list', {});
  check('через простой ядро остановлено', /idle\s+остановлена/.test(after.text), after.text);
  check('журнал при этом цел', /idle[\s\S]*журнал: \d+ шагов/.test(after.text), after.text);

  const back = await chat4.tool('maple_evaluate_code', { code: 'zz;', session: 'idle' });
  check('после простоя состояние вернулось', !back.err && /777/.test(back.text), back.text);
}
chat4.kill();

console.log('\n5) Файлы журналов');
{
  const f = path.join(sessionDir, 'osc.jsonl');
  const exists = await readFile(f, 'utf8').then(() => true).catch(() => false);
  check('журнал osc удалён после forget', !exists, f);
  const idle = await readFile(path.join(sessionDir, 'idle.jsonl'), 'utf8').then((t) => t.trim().split('\n').length).catch(() => 0);
  check('журнал idle на диске', idle >= 1, `${idle} записей`);
}

// ─── Утечка процессов: ядро Maple не остаётся сиротой ─────────────────────
console.log('\n6) Утечка процессов: ядро не осиротеет после остановки');
const baseline = new Set(mapleProcs().keys()); // чужой Maple на машине не наш
const chat5 = makeClient({ MAPLE_TIMEOUT_SECONDS: '3' });
await init(chat5);
{
  await chat5.tool('maple_evaluate_code', { code: 'leak := 1:', session: 'leak' });
  const mine = [...mapleProcs()].filter(([pid]) => !baseline.has(pid));
  const wrapper = mine.find(([, p]) => p.comm === 'cmaple');
  check(
    'ядро Maple работает в отдельной группе процессов',
    Boolean(wrapper) && wrapper[1].pgid === wrapper[0] && wrapper[1].sid === wrapper[0],
    `процессы: ${JSON.stringify(mine)}`,
  );
  const pgid = wrapper?.[1].pgid;

  const timedOut = await chat5.tool('maple_evaluate_code', { code: 'while true do end do:', session: 'leak' });
  check('зависший счёт убит по таймауту', timedOut.err && /timeout/.test(timedOut.text), timedOut.text);
  const afterTimeout = await waitGroupGone(pgid, 6000);
  check('после таймаута в группе не осталось ядра', afterTimeout.length === 0, `живы pid: ${afterTimeout.join(', ')}`);

  // Новое ядро — и штатное завершение MCP (SIGTERM: так мост гасит процесс в конце чата).
  const again = await chat5.tool('maple_evaluate_code', { code: 'leak2 := 2:', session: 'leak' });
  check('сессия поднялась заново', !again.err, again.text);
  const next = [...mapleProcs()].filter(([pid]) => !baseline.has(pid));
  const pgid2 = next.find(([, p]) => p.comm === 'cmaple')?.[1].pgid;
  chat5.child.kill('SIGTERM');
  const afterBye = await waitGroupGone(pgid2, 6000);
  check('штатное завершение MCP не оставляет живых ядер', afterBye.length === 0, `живы pid: ${afterBye.join(', ')}`);
}

console.log(`\nи т о г о: ${pass} ok, ${failCount} fail`);
await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
process.exit(failCount ? 1 : 0);
