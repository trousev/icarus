#!/usr/bin/env node
// Test of Maple "long" sessions: state lives in the journal and survives
// the end of a chat (restart of the MCP process) and a forced stop on idle.
// Plus a process leak check: the Maple kernel does not stay orphaned after shutdown.
//
// Run: node tools/maple-mcp/test-sessions.mjs
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

// ─── Maple processes: watching for leaks ──────────────────────────────────
//
// Maple is always two processes: the `cmaple` wrapper (its pid is returned by spawn) and the
// `mserver` kernel, which the wrapper spawns itself. If only the wrapper is killed, the kernel
// becomes orphaned, and in a person's container PID 1 is `sleep infinity`, which does not
// reap orphans: every abandoned `mserver` stays a zombie (`[mserver] <defunct>`) forever.
// That is why the server starts Maple in a separate process group and kills the whole group.

/** Live Maple processes: pid → { ppid, pgid, sid, comm }. */
function mapleProcs() {
  const out = execSync('ps -eo pid=,ppid=,pgid=,sid=,comm=', { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.trim().split('\n')) {
    const [pid, ppid, pgid, sid, comm] = line.trim().split(/\s+/);
    if (comm === 'cmaple' || comm === 'mserver') map.set(pid, { ppid, pgid, sid, comm });
  }
  return map;
}

/** Who else is alive in process group `pgid`. */
function procsInGroup(pgid) {
  const out = execSync('ps -eo pid=,pgid=', { encoding: 'utf8' });
  return out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, g]) => g === String(pgid))
    .map(([p]) => p);
}

/** Wait until the group is empty: return those left (empty — good). */
async function waitGroupGone(pgid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pgid ? procsInGroup(pgid) : [];
    if (left.length === 0) return [];
    if (Date.now() > deadline) return left;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Starts the MCP server and returns a client — the way pi does at the start of a chat. */
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

// ─── Chat 1: long work ────────────────────────────────────────────────
console.log('1) CHAT 1 — enter data, solve the ODE, compute');
let chat1 = makeClient();
await init(chat1);
{
  const tools = await chat1.call('tools/list', {});
  check('14 tools', tools.result.tools.length === 14, String(tools.result.tools.length));

  const a = await chat1.tool('maple_evaluate_code', {
    code: 'm := 2: k := 3: ic := {y(0)=1, D(y)(0)=0}:',
    session: 'osc',
  });
  check('data is set', !a.err, a.text);

  const b = await chat1.tool('maple_evaluate_code', {
    code: 'sol := dsolve({diff(y(x),x,x)+k^2*y(x)=0} union ic, y(x));',
    session: 'osc',
  });
  check('ODE solved', !b.err && /cos|sin/.test(b.text), b.text);

  const c = await chat1.tool('maple_evaluate_code', { code: 'y_at_1 := eval(rhs(sol), x=1):', session: 'osc' });
  check('intermediate result computed', !c.err, c.text);

  const l = await chat1.tool('maple_session_list', {});
  check('session shows as alive', /osc\s+жива/.test(l.text), l.text);
}
console.log('   (simulate end of chat: kill the MCP process)');
chat1.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Chat 2: continue from the same place ───────────────────────────────────
console.log('\n2) CHAT 2 — new MCP process, continue the work');
const chat2 = makeClient();
await init(chat2);
{
  const l = await chat2.tool('maple_session_list', {});
  check('previous chat journal is visible', /osc/.test(l.text) && /журнал: \d+ шагов/.test(l.text), l.text);

  const cont = await chat2.tool('maple_evaluate_code', {
    code: 'printf("m=%a k=%a y(1)=%a\\n", m, k, y_at_1);',
    session: 'osc',
  });
  check('state was restored automatically', !cont.err && /m=2 k=3/.test(cont.text), cont.text);
  check('it was said that the session was restored', /восстановлена из журнала/.test(cont.text), cont.text);

  const more = await chat2.tool('maple_evaluate_code', { code: 'y_at_2 := eval(rhs(sol), x=2):', session: 'osc' });
  check('appended to the same session', !more.err, more.text);

  const hist = await chat2.tool('maple_session_history', { session: 'osc' });
  check('history shows the steps', !hist.err && /dsolve/.test(hist.text), hist.text.slice(0, 200));

  const resume = await chat2.tool('maple_session_resume', { session: 'osc' });
  check('explicit resume is idempotent', !resume.err, resume.text);
}
chat2.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Chat 3: third life of the same session + forgetting ────────────────────────
console.log('\n3) CHAT 3 — one more process, state is in place');
const chat3 = makeClient();
await init(chat3);
{
  const v = await chat3.tool('maple_evaluate_code', { code: 'y_at_2;', session: 'osc' });
  check('third restore works (y(2)=cos 6)', !v.err && /cos\(6\)/.test(v.text), v.text);

  const forgotten = await chat3.tool('maple_session_forget', { session: 'osc' });
  check('forget erases the journal', !forgotten.err && /удалён/.test(forgotten.text), forgotten.text);

  const after = await chat3.tool('maple_session_list', {});
  check('after forget the session is gone', !/osc/.test(after.text), after.text);
}
chat3.kill();
await new Promise((r) => setTimeout(r, 300));

// ─── Idle stop (5 minutes in prod, 2 seconds in the test) ────────────
console.log('\n4) Idle: the kernel is shut down, state stays in the journal');
const chat4 = makeClient({ MAPLE_IDLE_SECONDS: '2' });
await init(chat4);
{
  await chat4.tool('maple_evaluate_code', { code: 'zz := 777:', session: 'idle' });
  const before = await chat4.tool('maple_session_list', {});
  check('session is alive before idle', /idle\s+жива/.test(before.text), before.text);

  await new Promise((r) => setTimeout(r, 5000));
  const after = await chat4.tool('maple_session_list', {});
  check('after idle the kernel is stopped', /idle\s+остановлена/.test(after.text), after.text);
  check('the journal is intact meanwhile', /idle[\s\S]*журнал: \d+ шагов/.test(after.text), after.text);

  const back = await chat4.tool('maple_evaluate_code', { code: 'zz;', session: 'idle' });
  check('after idle the state came back', !back.err && /777/.test(back.text), back.text);
}
chat4.kill();

console.log('\n5) Journal files');
{
  const f = path.join(sessionDir, 'osc.jsonl');
  const exists = await readFile(f, 'utf8').then(() => true).catch(() => false);
  check('osc journal deleted after forget', !exists, f);
  const idle = await readFile(path.join(sessionDir, 'idle.jsonl'), 'utf8').then((t) => t.trim().split('\n').length).catch(() => 0);
  check('idle journal on disk', idle >= 1, `${idle} записей`);
}

// ─── Process leak: the Maple kernel does not stay orphaned ─────────────────────
console.log('\n6) Process leak: the kernel does not stay orphaned after shutdown');
const baseline = new Set(mapleProcs().keys()); // someone else's Maple on the machine is not ours
const chat5 = makeClient({ MAPLE_TIMEOUT_SECONDS: '3' });
await init(chat5);
{
  await chat5.tool('maple_evaluate_code', { code: 'leak := 1:', session: 'leak' });
  const mine = [...mapleProcs()].filter(([pid]) => !baseline.has(pid));
  const wrapper = mine.find(([, p]) => p.comm === 'cmaple');
  check(
    'the Maple kernel runs in a separate process group',
    Boolean(wrapper) && wrapper[1].pgid === wrapper[0] && wrapper[1].sid === wrapper[0],
    `процессы: ${JSON.stringify(mine)}`,
  );
  const pgid = wrapper?.[1].pgid;

  const timedOut = await chat5.tool('maple_evaluate_code', { code: 'while true do end do:', session: 'leak' });
  check('a hung computation is killed by the timeout', timedOut.err && /timeout/.test(timedOut.text), timedOut.text);
  const afterTimeout = await waitGroupGone(pgid, 6000);
  check('after the timeout no kernel remains in the group', afterTimeout.length === 0, `живы pid: ${afterTimeout.join(', ')}`);

  // A new kernel — and a normal MCP shutdown (SIGTERM: that is how the bridge kills the process at the end of a chat).
  const again = await chat5.tool('maple_evaluate_code', { code: 'leak2 := 2:', session: 'leak' });
  check('the session came up again', !again.err, again.text);
  const next = [...mapleProcs()].filter(([pid]) => !baseline.has(pid));
  const pgid2 = next.find(([, p]) => p.comm === 'cmaple')?.[1].pgid;
  chat5.child.kill('SIGTERM');
  const afterBye = await waitGroupGone(pgid2, 6000);
  check('a normal MCP shutdown leaves no live kernels', afterBye.length === 0, `живы pid: ${afterBye.join(', ')}`);
}

console.log(`\nTOTAL: ${pass} ok, ${failCount} fail`);
await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
process.exit(failCount ? 1 : 0);
