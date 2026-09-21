#!/usr/bin/env node
// Maple MCP — MCP-сервер по stdio, который водит локально установленный Maple.
//
// Проверено на Maple 18.00 (X86 64 LINUX, Build ID 922027), CLI:
//   /opt/maple18/bin/maple
//
// Идея: держим один (или несколько) долгоживущий консольный Maple
// (`maple -q -s -t`), пишем ему код в stdin, читаем stdout до sentinel-маркера.
// Синтаксис проверяем ОТДЕЛЬНЫМ процессом (`-P`, parse only): сырая
// синтаксическая ошибка в живой сессии вешает разбор потока, а так сессия
// остаётся целой и сохраняет состояние.
//
// Без внешних зависимостей: только Node.js >= 18.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// ─────────────────────────── конфигурация ───────────────────────────

const MAPLE_BIN = process.env.MAPLE_BIN ?? '/opt/maple18/bin/maple';
const MAPLE_EXTRA_ARGS = (process.env.MAPLE_ARGS ?? '').split(/\s+/).filter(Boolean);
/** -q тихо, -s без init-файлов, -t тестовый режим (без prompt и «bytes used»). */
const MAPLE_ARGS = ['-q', '-s', '-t', ...MAPLE_EXTRA_ARGS];
const MAPLE_TIMEOUT_SECONDS = Number(process.env.MAPLE_TIMEOUT_SECONDS ?? 60);
/** Простой сессии (сек), после которого ядро прибивается. Состояние — в журнале. */
const MAPLE_IDLE_SECONDS = Number(process.env.MAPLE_IDLE_SECONDS ?? 300);
const MAPLE_MAX_SESSIONS = Number(process.env.MAPLE_MAX_SESSIONS ?? 4);
const MAPLE_ROOT = process.env.MAPLE_WORKSPACE_ROOT ?? process.cwd();
const JOURNAL_MAX_BYTES = Number(process.env.MAPLE_JOURNAL_MAX_BYTES ?? 512 * 1024);
const JOURNAL_KEEP_ENTRIES = Number(process.env.MAPLE_JOURNAL_KEEP ?? 400);
const DEBUG = process.env.MAPLE_MCP_DEBUG === '1';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'maple-mcp', version: '1.0.0' };

const log = (...a) => {
  if (DEBUG) process.stderr.write(`[maple-mcp] ${a.join(' ')}\n`);
};

// ─────────────────────────── рабочий каталог ───────────────────────────

let TMP = null;
async function tmpDir() {
  if (!TMP) TMP = await mkdtemp(path.join(tmpdir(), 'maple-mcp-'));
  return TMP;
}
let tmpCounter = 0;
async function tmpFile(ext = '.mpl') {
  const dir = await tmpDir();
  return path.join(dir, `job-${process.pid}-${++tmpCounter}${ext}`);
}
async function cleanupTmp() {
  if (TMP) await rm(TMP, { recursive: true, force: true }).catch(() => {});
  TMP = null;
}

function resolveUserPath(p) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(MAPLE_ROOT, p);
}

// ─────────────────────────── журнал сессий ───────────────────────────
//
// Мост pi → MCP поднимает наш процесс на время чата и убивает в конце
// (`session_shutdown` → `shutdownAll`). Плюс мы сами гасим ядро после
// MAPLE_IDLE_SECONDS простоя. Чтобы «продолжить в другом чате», мы пишем
// журнал выполненного кода и при первом обращении к сессии проигрываем его
// в свежее ядро — состояние (переменные, функции, assume) возвращается.

const SESSION_DIR = (() => {
  if (process.env.MAPLE_SESSION_DIR) return process.env.MAPLE_SESSION_DIR;
  const home = process.env.HOME || homedir();
  const piAgent = path.join(home, '.pi', 'agent'); // в контейнере Икара это персистентный маунт
  if (existsSync(piAgent)) return path.join(piAgent, 'maple-mcp');
  return path.join(MAPLE_ROOT, '.maple-mcp');
})();

const PLOT_DIR = process.env.MAPLE_PLOT_DIR ?? path.join(SESSION_DIR, 'plots');

const safeName = (name) => String(name).replace(/[^\w.-]+/g, '_').slice(0, 64) || 'default';
const journalPath = (name) => path.join(SESSION_DIR, `${safeName(name)}.jsonl`);

function journalRead(name) {
  const file = journalPath(name);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function journalAppend(name, code, extra = {}) {
  const file = journalPath(name);
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), code, ...extra }) + '\n');
    if (statSync(file).size > JOURNAL_MAX_BYTES) {
      const kept = journalRead(name).slice(-JOURNAL_KEEP_ENTRIES);
      writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
      log('журнал обрезан', name, kept.length);
    }
  } catch (e) {
    log('не удалось записать журнал', e?.message ?? e);
  }
}

function journalClear(name) {
  try {
    const f = journalPath(name);
    if (existsSync(f)) unlinkSync(f);
  } catch {}
}

function journalInfo(name) {
  const file = journalPath(name);
  if (!existsSync(file)) return null;
  const entries = journalRead(name);
  return {
    file,
    entries: entries.length,
    lastUsed: entries.length ? entries[entries.length - 1].t : null,
    bytes: statSync(file).size,
  };
}

const isRestart = (code) => /(^|\n)[ \t]*restart[ \t]*[:;]?[ \t]*(\n|$)/.test(code);

// ─────────────────────────── запуск Maple ───────────────────────────

class MapleError extends Error {}

/** Одноразовый запуск Maple: файл со скриптом → stdout/stderr/код выхода. */
function runMapleOnce(args, { timeoutMs = 30_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(MAPLE_BIN, args, { cwd: MAPLE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const dec = new StringDecoder('utf8');
    let out = '';
    let err = '';
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, ...extra });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, code: null, signal: 'SIGKILL' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += dec.write(d)));
    child.stderr.on('data', (d) => (err += dec.write(d)));
    child.on('error', (e) => finish({ spawnError: String(e?.message ?? e), code: null }));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Только разбор синтаксиса, без выполнения (`-P`). */
async function syntaxCheck(code) {
  const file = await tmpFile();
  await writeFile(file, code.endsWith('\n') ? code : code + '\n', 'utf8');
  const r = await runMapleOnce(['-q', '-s', '-P', file], { timeoutMs: 30_000 });
  if (r.spawnError) return { ok: false, raw: `не удалось запустить Maple: ${r.spawnError}` };
  const text = (r.stdout + r.stderr).trim();
  const bad = /syntax error|unexpected|unterminated|missing|invalid\b/i.test(text);
  if (bad) return { ok: false, raw: text };
  return { ok: true, raw: text };
}

/**
 * Выполнить код отдельным процессом через файл-скрипт.
 * Важно: через `-c` передавать нельзя — launcher `maple` делает `eval`
 * аргумента, и путь/кавычки ломаются.
 */
async function runMapleScript(code, { timeoutMs = 60_000, errorbreak = 2 } = {}) {
  const file = await tmpFile();
  await writeFile(file, code.endsWith('\n') ? code : code + '\n', 'utf8');
  const r = await runMapleOnce(['-q', '-s', `-e${errorbreak}`, file], { timeoutMs });
  return { ...r, text: `${r.stdout}${r.stderr}`.trim(), file };
}

function mapleString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Верхнеуровневые quit/done/stop убивают сессию — такое лучше не пропускать. */
function killsSession(code) {
  return /(^|\n)[ \t]*(quit|done|stop)[ \t]*[;:]?[ \t]*(\n|$)/.test(code);
}

// ─────────────────────────── сессия ───────────────────────────

class MapleSession {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.queue = Promise.resolve();
    this.lastUsed = Date.now();
    this.everStarted = false;
    this.dead = true;
    /** false → при следующем вызове состояние надо проиграть из журнала. */
    this.restored = false;
  }

  async start() {
    if (!this.dead && this.proc) return;
    if (!existsSync(MAPLE_BIN)) throw new MapleError(`Maple не найден: ${MAPLE_BIN} (задайте MAPLE_BIN)`);
    log('start session', this.id);
    const child = spawn(MAPLE_BIN, MAPLE_ARGS, {
      cwd: MAPLE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.proc = child;
    this.buf = '';
    this.decoder = new StringDecoder('utf8');
    this.exit = null;
    child.stdout.on('data', (d) => (this.buf += this.decoder.write(d)));
    child.stderr.on('data', (d) => (this.buf += this.decoder.write(d)));
    child.on('error', (e) => {
      this.buf += `\n[maple-mcp] ошибка процесса: ${e?.message ?? e}\n`;
      this.exit = { code: null, error: true };
      this.dead = true;
    });
    child.on('close', (code, signal) => {
      this.exit = { code, signal };
      this.dead = true;
      log('session exit', this.id, code, signal);
    });
    this.dead = false;
    this.everStarted = true;
    this.restored = false; // новое ядро — состояние пустое, журнал проиграем при вызове
    this.lastUsed = Date.now();
  }

  async stop() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.stdin.end();
      } catch {}
      p.kill('SIGTERM');
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
      }, 1500).unref?.();
    }
    this.dead = true;
    this.restored = false;
  }

  /** Ждём появления маркера в буфере либо таймаута. */
  waitFor(token, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const idx = this.buf.indexOf(token);
        if (idx >= 0) {
          const text = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + token.length);
          return resolve({ ok: true, text });
        }
        if (this.dead) {
          const text = this.buf;
          this.buf = '';
          return resolve({ ok: false, dead: true, text });
        }
        if (Date.now() > deadline) return resolve({ ok: false, timeout: true, text: '' });
        setTimeout(tick, 15);
      };
      tick();
    });
  }

  /** Выполнить код в живой сессии (с авто-восстановлением состояния из журнала). */
  async evaluate(code, opts = {}) {
    this.queue = this.queue.then(
      () => this.#evaluate(code, opts),
      () => this.#evaluate(code, opts),
    );
    return this.queue;
  }

  /** Явно поднять ядро и проиграть журнал (инструмент maple_session_resume). */
  async restore(timeoutMs = MAPLE_TIMEOUT_SECONDS * 1000) {
    await this.start();
    if (this.dead || !this.proc) return { ok: false, output: 'не удалось запустить процесс Maple' };
    const entries = journalRead(this.id).length;
    if (this.restored) return { ok: true, output: `сессия «${this.id}» уже содержит состояние`, entries };
    const note = await this.#restoreState(timeoutMs);
    return { ok: this.restored, output: note ?? `у сессии «${this.id}» пустой журнал`, entries };
  }

  /** Проиграть журнал в свежее ядро. Возвращает заметку или null. */
  async #restoreState(timeoutMs) {
    const entries = journalRead(this.id);
    this.restored = true;
    if (entries.length === 0) return null;
    const res = await this.#run(entries.map((e) => e.code).join('\n'), timeoutMs);
    this.restored = res.ok;
    return res.ok
      ? `[сессия «${this.id}» восстановлена из журнала: ${entries.length} шагов]`
      : `[не удалось восстановить сессию «${this.id}»: ${res.output.slice(0, 300)}]`;
  }

  /** Отправить код в ядро и дождаться маркера. */
  async #run(code, timeoutMs) {
    const token = `__MAPLE_MCP_${randomBytes(8).toString('hex')}__`;
    this.buf = '';
    const payload = `${code.endsWith('\n') ? code : code + '\n'}printf("${token}\\n"):\n`;
    try {
      this.proc.stdin.write(payload);
    } catch (e) {
      return { ok: false, phase: 'write', output: `не удалось записать в Maple: ${e?.message ?? e}`, session: this.id };
    }

    const res = await this.waitFor(token, timeoutMs);
    this.lastUsed = Date.now();

    if (res.timeout) {
      await this.stop();
      return {
        ok: false,
        phase: 'timeout',
        output: `превышен таймаут ${Math.round(timeoutMs / 1000)} с; сессия «${this.id}» перезапущена (журнал сохранён)`,
        session: this.id,
      };
    }
    if (res.dead) {
      return {
        ok: false,
        phase: 'exit',
        output: `процесс Maple завершился (код ${this.exit?.code ?? '?'}). Возможно, код содержал quit/stop/done или упал.\n${res.text}`.trim(),
        session: this.id,
      };
    }

    const output = res.text;
    const failed = /(^|\n)\s*(Error,|.*\bsyntax error\b)/i.test(output);
    return { ok: !failed, phase: failed ? 'maple' : 'done', output: output.trim(), session: this.id };
  }

  async #evaluate(code, { timeoutMs = MAPLE_TIMEOUT_SECONDS * 1000, resume = true } = {}) {
    if (killsSession(code)) {
      return {
        ok: false,
        phase: 'guard',
        output:
          'код содержит верхнеуровневый quit/done/stop — он завершит сессию и потеряет состояние. ' +
          'Если нужно закончить сессию, используйте инструмент maple_session_reset.',
        session: this.id,
      };
    }
    const check = await syntaxCheck(code);
    if (!check.ok) {
      return { ok: false, phase: 'syntax', output: check.raw, session: this.id };
    }

    await this.start();
    this.lastUsed = Date.now();
    if (this.dead || !this.proc) {
      await this.start();
      if (this.dead || !this.proc) {
        return { ok: false, phase: 'spawn', output: 'не удалось запустить процесс Maple', session: this.id };
      }
    }

    let prefix = '';
    if (!this.restored && resume) {
      const note = await this.#restoreState(timeoutMs);
      if (note) prefix = note + '\n';
    }

    const res = await this.#run(code, timeoutMs);

    if (res.ok) {
      if (isRestart(code)) journalClear(this.id);
      journalAppend(this.id, code);
    }
    return { ...res, output: `${prefix}${res.output}`.trim() };
  }
}

const sessions = new Map();

async function getSession(id = 'default') {
  let s = sessions.get(id);
  if (s) return s;
  if (sessions.size >= MAPLE_MAX_SESSIONS) {
    // вытесняем самую давнюю простаивающую
    const victim = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (victim) {
      await victim.stop();
      sessions.delete(victim.id);
    }
  }
  s = new MapleSession(id);
  sessions.set(id, s);
  return s;
}

async function resetSession(id = 'default') {
  const s = sessions.get(id);
  if (!s) return false;
  await s.stop();
  sessions.delete(id);
  return true;
}

async function stopAllSessions() {
  await Promise.all([...sessions.values()].map((s) => s.stop()));
  sessions.clear();
}

setInterval(() => {
  const limit = Date.now() - MAPLE_IDLE_SECONDS * 1000;
  for (const s of [...sessions.values()]) {
    if (s.lastUsed < limit) {
      log('простой, гасим', s.id, `${MAPLE_IDLE_SECONDS} с`);
      s.stop().then(() => sessions.delete(s.id));
    }
  }
  // интервал подстраиваем под таймаут: при 300 с хватает 30 с, в тестах — чаще
}, Math.max(1000, Math.min(30_000, (MAPLE_IDLE_SECONDS * 1000) / 4))).unref();

function journalNames() {
  try {
    if (!existsSync(SESSION_DIR)) return [];
    return readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

// ─────────────────────────── разбор .mw (XML) ───────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function encodeAttr(s) {
  return encodeText(s).replace(/"/g, '&quot;');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/** Терпимый XML-сканер: строит дерево и запоминает смещения. */
function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, children: [], text: '', start: 0, end: xml.length };
  const stack = [root];
  const addText = (t) => {
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      addText(xml.slice(i));
      break;
    }
    if (lt > i) addText(xml.slice(i, lt));
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const close = xml.startsWith('<!--', lt) ? '-->' : '>';
      const e = xml.indexOf(close, lt);
      i = e < 0 ? n : e + close.length;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const raw = xml.slice(lt + 1, j);
    if (raw.startsWith('/')) {
      const node = stack.pop();
      if (node && node.tag !== '#root') node.end = j + 1;
      i = j + 1;
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_:][-\w:.]*)([\s\S]*)$/.exec(body);
    const tag = m ? m[1] : body.trim();
    const node = {
      tag,
      attrs: parseAttrs(m ? m[2] : ''),
      children: [],
      text: '',
      start: lt,
      end: selfClose ? j + 1 : null,
    };
    stack[stack.length - 1].children.push(node);
    if (selfClose) node.end = j + 1;
    else stack.push(node);
    i = j + 1;
  }
  for (const node of stack) if (node.end == null) node.end = n;
  return root;
}

function* walk(node) {
  for (const c of node.children) {
    yield c;
    yield* walk(c);
  }
}

function findOne(node, tag) {
  for (const c of walk(node)) if (c.tag === tag) return c;
  return null;
}

function textOf(node) {
  return decodeEntities(node.text ?? '').replace(/\s+/g, ' ').trim();
}

function sectionPath(group, root) {
  // путь секций: ищем предков-секций, но у нас дерево без parent — обходим от root.
  const out = [];
  const visit = (node, trail) => {
    if (node === group) {
      out.push(...trail);
      return true;
    }
    for (const c of node.children) {
      let nextTrail = trail;
      if (c.tag === 'Section') {
        const titleNode = c.children.find((x) => x.tag === 'Title');
        const tf = titleNode ? findOne(titleNode, 'Text-field') : null;
        const title = tf ? textOf(tf) : '';
        nextTrail = [...trail, title || '(без названия)'];
      }
      if (visit(c, nextTrail)) return true;
    }
    return false;
  };
  visit(root, []);
  return out;
}

/** Разбирает .mw в список групп. */
function parseWorksheet(xml) {
  const root = parseXml(xml);
  const versionNode = findOne(root, 'Version');
  const version = versionNode
    ? { major: versionNode.attrs.major ?? null, minor: versionNode.attrs.minor ?? null }
    : { major: null, minor: null };
  const labelScheme = findOne(root, 'Label-Scheme');

  const groups = [];
  let index = 0;
  for (const group of walk(root)) {
    if (group.tag !== 'Group') continue;
    const input = group.children.find((c) => c.tag === 'Input') ?? null;
    let inputText = '';
    let inputKind = 'empty';
    let textField = null;
    if (input) {
      const tfs = input.children.filter((c) => c.tag === 'Text-field');
      textField =
        tfs.find((c) => (c.attrs.style ?? '').toLowerCase().includes('maple input')) ??
        tfs.find((c) => textOf(c)) ??
        tfs[0] ??
        null;
      if (textField) {
        const direct = decodeEntities(textField.text ?? '').trim();
        if (direct) {
          inputText = direct;
          inputKind = '1d';
        } else {
          const eq = textField.children.find((c) => c.tag === 'Equation');
          if (eq && eq.attrs['input-equation']) {
            inputText = eq.attrs['input-equation'];
            inputKind = '2d';
          } else if (eq) {
            inputKind = '2d-opaque';
          }
        }
      }
    }
    const output = group.children.find((c) => c.tag === 'Output') ?? null;
    const outText = output ? textOf(output) : '';
    groups.push({
      index: index++,
      label: group.attrs.labelreference ?? null,
      drawlabel: group.attrs.drawlabel ?? null,
      section: sectionPath(group, root),
      inputKind,
      input: inputText,
      hasOutput: Boolean(output && (outText || output.children.length)),
      outputPreview: outText.slice(0, 400),
      _group: group,
      _textField: textField,
    });
  }

  return {
    version,
    labelScheme: labelScheme ? labelScheme.attrs : null,
    groupCount: groups.length,
    groups,
    _root: root,
  };
}

function buildWorksheetXml(cells, { major = '18', minor = '0' } = {}) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Worksheet>',
    `<Version major="${major}" minor="${minor}"></Version>`,
    '<Label-Scheme value="2" prefix=""></Label-Scheme>',
    '<View-Properties presentation="false"></View-Properties>',
  ];
  cells.forEach((code, i) => {
    parts.push(`<Group labelreference="L${i + 1}" drawlabel="true">`);
    parts.push('<Input>');
    parts.push(
      `<Text-field prompt="&gt; " style="Maple Input" layout="Normal">${encodeText(code)}</Text-field>`,
    );
    parts.push('</Input>');
    parts.push('</Group>');
  });
  parts.push('</Worksheet>');
  return parts.join('\n') + '\n';
}

function rebuildTextField(node, code) {
  const attrs = { prompt: '> ', style: 'Maple Input', layout: 'Normal', ...node.attrs };
  const attrText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${encodeAttr(v)}"`)
    .join(' ');
  return `<Text-field ${attrText}>${encodeText(code)}</Text-field>`;
}

async function readWorksheet(pathStr) {
  const file = resolveUserPath(pathStr);
  const xml = await readFile(file, 'utf8');
  return { file, xml, parsed: parseWorksheet(xml) };
}

// ─────────────────────────── инструменты ───────────────────────────

const ok = (text) => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

function renderEval(res) {
  const head = res.ok ? `ok (session ${res.session})` : `error (${res.phase}, session ${res.session})`;
  const body = res.output?.length ? res.output : '(нет вывода)';
  return `${head}\n${body}`;
}

async function toolEval({ code, session, timeout_seconds, resume = true }) {
  if (typeof code !== 'string' || !code.trim()) return fail('параметр code обязателен');
  const s = await getSession(session || 'default');
  const timeoutMs = timeout_seconds ? Number(timeout_seconds) * 1000 : MAPLE_TIMEOUT_SECONDS * 1000;
  const res = await s.evaluate(code, { timeoutMs, resume: resume !== false });
  return res.ok ? ok(renderEval(res)) : fail(renderEval(res));
}

async function toolCheck({ code }) {
  if (typeof code !== 'string' || !code.trim()) return fail('параметр code обязателен');
  const r = await syntaxCheck(code);
  return r.ok ? ok('синтаксис в порядке' + (r.raw ? `\n${r.raw}` : '')) : fail(`синтаксическая ошибка:\n${r.raw}`);
}

async function toolHealth() {
  if (!existsSync(MAPLE_BIN)) return fail(`Maple не найден: ${MAPLE_BIN}`);
  const probe =
    'printf("MAPLE|%a|%a|%a|%a\\n", kernelopts(version), kernelopts(platform), kernelopts(wordsize), kernelopts(mapledir)):';
  const s = await getSession('default');
  const t0 = Date.now();
  const res = await s.evaluate(probe, { timeoutMs: 60_000 });
  const ms = Date.now() - t0;
  if (!res.ok && res.phase === 'syntax') return fail(`не удалось выполнить пробу:\n${res.output}`);
  const line = res.output.split('\n').find((l) => l.startsWith('MAPLE|')) ?? res.output;
  return ok(
    [
      `бинарник: ${MAPLE_BIN}`,
      `аргументы: ${MAPLE_ARGS.join(' ')}`,
      `проба: ${line}`,
      `задержка: ${ms} мс`,
      `сессии: ${[...sessions.keys()].join(', ') || '(нет)'}`,
      `журналы сессий: ${SESSION_DIR}`,
      `остановка по простою: ${MAPLE_IDLE_SECONDS} с`,
      `каталог графиков: ${PLOT_DIR}`,
    ].join('\n'),
  );
}

async function toolListSessions() {
  const names = new Set([...sessions.keys(), ...journalNames()]);
  if (names.size === 0) return ok('сессий нет');
  const rows = [...names].sort().map((n) => {
    const live = sessions.get(n);
    const info = journalInfo(n);
    const state = live && !live.dead ? `жива (простой ${Math.round((Date.now() - live.lastUsed) / 1000)} с)` : 'остановлена';
    const journal = info ? `журнал: ${info.entries} шагов, последняя запись ${info.lastUsed}` : 'журнала нет';
    return `${n}\t${state}\t${journal}`;
  });
  return ok(
    `ядро гасится после ${MAPLE_IDLE_SECONDS} с простоя; журналы — в ${SESSION_DIR}\n` + rows.join('\n'),
  );
}

async function toolSessionResume({ session, timeout_seconds }) {
  const id = session || 'default';
  const live = sessions.get(id);
  if (live && !live.dead && live.restored) return ok(`сессия «${id}» уже жива вместе с состоянием`);
  const info = journalInfo(id);
  if (!info || info.entries === 0) return ok(`у сессии «${id}» нет журнала — восстанавливать нечего`);
  await resetSession(id);
  const s = await getSession(id);
  const r = await s.restore(timeout_seconds ? Number(timeout_seconds) * 1000 : undefined);
  return r.ok ? ok(`${r.output}\nшагов в журнале: ${r.entries}`) : fail(r.output);
}

async function toolSessionHistory({ session, limit = 40 }) {
  const id = session || 'default';
  const entries = journalRead(id);
  if (entries.length === 0) return ok(`журнал сессии «${id}» пуст`);
  const shown = entries.slice(-Math.max(1, Number(limit)));
  const from = entries.length - shown.length + 1;
  const body = shown
    .map((e, i) => `#${from + i}  ${e.t}\n${String(e.code).split('\n').map((l) => `    ${l}`).join('\n')}`)
    .join('\n');
  return ok(`сессия «${id}»: ${entries.length} записей в ${journalPath(id)}\n${body}`);
}

/** Перезапуск ядра с сохранением журнала: состояние вернётся при следующем вызове. */
async function toolSessionReset({ session }) {
  const id = session || 'default';
  const existed = await resetSession(id);
  const info = journalInfo(id);
  if (!existed && !info) return ok(`сессии «${id}» не было`);
  return ok(
    `сессия «${id}» перезапущена: ядро остановлено, журнал сохранён (${info?.entries ?? 0} шагов) — ` +
      `при следующем вызове состояние вернётся. Стереть совсем — maple_session_forget.`,
  );
}

async function toolSessionForget({ session }) {
  const id = session || 'default';
  const info = journalInfo(id);
  await resetSession(id);
  journalClear(id);
  return ok(
    info ? `сессия «${id}» забыта: ядро остановлено, журнал (${info.entries} шагов) удалён` : `сессии «${id}» и так не было`,
  );
}

async function toolLatex({ expression, session }) {
  if (!expression) return fail('параметр expression обязателен');
  const s = await getSession(session || 'default');
  const res = await s.evaluate(`printf("%s\\n", latex(${expression}, output=string)):`);
  if (!res.ok) return fail(renderEval(res));
  return ok(res.output);
}

/** Maple 18 через plottools:-exportplot умеет gif/jpeg/bmp; png и tiff — нет. */
const PLOT_FORMATS = { gif: 'gif', jpeg: 'jpeg', jpg: 'jpeg', bmp: 'bmp' };

async function toolPlot({ expression, format = 'gif', session }) {
  if (!expression) return fail('параметр expression обязателен');
  const ext = PLOT_FORMATS[String(format).toLowerCase()];
  if (!ext) return fail(`формат «${format}» этот Maple не умеет. Доступно: gif, jpeg, bmp.`);
  mkdirSync(PLOT_DIR, { recursive: true });
  const file = path.join(PLOT_DIR, `plot-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`);
  const code = [
    `__mcp_plot := ${expression}:`,
    `plottools:-exportplot("${file}", __mcp_plot):`,
    `printf("PLOT_DONE\\n"):`,
  ].join('\n');

  // Экспорт графика изредка роняет ядро (в контейнере видели код 79) — один ретрай
  // на свежей сессии; операция идемпотентная, так что повтор безопасен.
  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const s = await getSession(session || 'default');
    res = await s.evaluate(code);
    if (res.ok && existsSync(file)) break;
    if (attempt === 1 && (res.phase === 'exit' || res.phase === 'timeout')) {
      await resetSession(s.id);
      continue;
    }
    break;
  }
  if (!res.ok) return fail(renderEval(res));
  if (!existsSync(file)) return fail(`не удалось экспортировать график (формат ${ext}).\n${res.output}`);
  const data = await readFile(file);
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return {
    content: [
      {
        type: 'text',
        text: `график ${ext}, ${data.length} байт, файл: ${file}\n(некоторые мосты, например pi-mcp-extension, не пропускают изображения — тогда скажи пользователю путь к файлу)`,
      },
      { type: 'image', data: data.toString('base64'), mimeType: `image/${mime}` },
    ],
    isError: false,
  };
}

async function toolWorksheetRead({ path: p, include_output = false, max_groups = 200 }) {
  if (!p) return fail('параметр path обязателен');
  let doc;
  try {
    doc = await readWorksheet(p);
  } catch (e) {
    return fail(`не удалось прочитать ${p}: ${e?.message ?? e}`);
  }
  const { parsed, file } = doc;
  const lines = [
    `файл: ${file}`,
    `формат: major=${parsed.version.major} minor=${parsed.version.minor}; групп: ${parsed.groupCount}`,
    '',
  ];
  for (const g of parsed.groups.slice(0, Number(max_groups))) {
    const sec = g.section.length ? ` [${g.section.join(' / ')}]` : '';
    lines.push(`#${g.index} ${g.label ?? ''}${sec} kind=${g.inputKind}${g.hasOutput ? ' +output' : ''}`);
    if (g.input) lines.push(g.input.split('\n').map((l) => `    ${l}`).join('\n'));
    else if (g.inputKind === '2d-opaque') lines.push('    (2-D ввод, снаружи не читается)');
    if (include_output && g.outputPreview) lines.push(`    → ${g.outputPreview}`);
  }
  if (parsed.groupCount > Number(max_groups)) lines.push(`… ещё ${parsed.groupCount - Number(max_groups)} групп`);
  return ok(lines.join('\n'));
}

async function toolWorksheetCreate({ path: p, cells, overwrite = false, validate = true }) {
  if (!p) return fail('параметр path обязателен');
  if (!Array.isArray(cells) || cells.length === 0) return fail('параметр cells обязателен (массив строк)');
  const file = resolveUserPath(p);
  if (existsSync(file) && !overwrite) return fail(`файл уже существует: ${file} (передайте overwrite=true)`);

  const joined = cells.map(String).join('\n');
  const syn = await syntaxCheck(joined);
  if (!syn.ok) return fail(`синтаксис ячеек не проходит проверку Maple:\n${syn.raw}`);

  const xml = buildWorksheetXml(cells.map(String));
  await writeFile(file, xml, 'utf8');

  let note = 'файл записан';
  if (validate) {
    const chk = await runMapleScript(`Worksheet:-ReadFile(${mapleString(file)}):`);
    const bad = /Error,|syntax error/i.test(chk.text);
    note = bad
      ? `файл записан, но Maple его не принял:\n${chk.text}`
      : 'файл записан и проверен Maple (Worksheet:-ReadFile)';
    if (bad) return fail(note);
  }
  return ok(`${note}\n${file}\nгрупп: ${cells.length}`);
}

async function toolWorksheetEditCell({ path: p, index, code, validate = true }) {
  if (!p) return fail('параметр path обязателен');
  if (index === undefined || index === null) return fail('параметр index обязателен');
  if (!code) return fail('параметр code обязателен');
  let doc;
  try {
    doc = await readWorksheet(p);
  } catch (e) {
    return fail(`не удалось прочитать ${p}: ${e?.message ?? e}`);
  }
  const g = doc.parsed.groups[Number(index)];
  if (!g) return fail(`группы #${index} нет (всего ${doc.parsed.groupCount})`);
  if (!g._textField) return fail(`у группы #${index} нет Text-field для правки`);
  const rebuilt = rebuildTextField(g._textField, code);
  const xml = doc.xml.slice(0, g._textField.start) + rebuilt + doc.xml.slice(g._textField.end);
  await writeFile(doc.file, xml, 'utf8');

  let note = 'ячейка заменена';
  if (validate) {
    const chk = await runMapleScript(`Worksheet:-ReadFile(${mapleString(doc.file)}):`);
    if (/Error,|syntax error/i.test(chk.text)) return fail(`записано, но Maple не принял файл:\n${chk.text}`);
    note = 'ячейка заменена, файл проверен Maple';
  }
  return ok(`${note}: #${index} (${g.label ?? 'без метки'})\n${doc.file}`);
}

async function toolWorksheetRunCell({ path: p, index, session, timeout_seconds }) {
  if (!p) return fail('параметр path обязателен');
  if (index === undefined || index === null) return fail('параметр index обязателен');
  let doc;
  try {
    doc = await readWorksheet(p);
  } catch (e) {
    return fail(`не удалось прочитать ${p}: ${e?.message ?? e}`);
  }
  const g = doc.parsed.groups[Number(index)];
  if (!g) return fail(`группы #${index} нет (всего ${doc.parsed.groupCount})`);
  if (!g.input) return fail(`в группе #${index} нет читаемого ввода (kind=${g.inputKind})`);
  return toolEval({ code: g.input, session, timeout_seconds });
}

// ─────────────────────────── описание инструментов ───────────────────────────

const TOOLS = [
  {
    name: 'maple_health',
    description:
      'Проверить, что локальный Maple отвечает: версия, платформа, разрядность, каталог, задержка. Вызывать первым при проблемах.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'maple_evaluate_code',
    description:
      'Выполнить код на языке Maple в долгоживущей сессии и вернуть текстовый вывод. ' +
      'Состояние (переменные, функции, assume) сохраняется между вызовами, а после простоя или нового чата ' +
      'автоматически восстанавливается из журнала сессии. Синтаксис проверяется заранее; ошибки возвращаются как isError.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код Maple. Оператор с «;» печатает результат, с «:» — нет.' },
        session: { type: 'string', description: 'Имя сессии (по умолчанию default). Давай осмысленные имена разным расчётам.' },
        timeout_seconds: { type: 'number', description: 'Таймаут, сек (по умолчанию из MAPLE_TIMEOUT_SECONDS).' },
        resume: { type: 'boolean', description: 'Восстанавливать состояние из журнала (по умолчанию да). false — начать с чистого ядра.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_check_code',
    description: 'Проверить синтаксис кода Maple, не выполняя его (maple -P). Полезно перед опасным запуском.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Код Maple.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_to_latex',
    description: 'Преобразовать выражение Maple в LaTeX (latex(..., output=string)).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Выражение Maple, например int(x^2, x).' },
        session: { type: 'string', description: 'Имя сессии.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_plot',
    description: 'Построить график и вернуть изображение. Форматы: gif (по умолчанию), jpeg, bmp (png этот Maple не умеет).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Выражение-график, например plot(sin(x), x=-Pi..Pi).' },
        format: { type: 'string', description: 'gif | jpeg | bmp' },
        session: { type: 'string', description: 'Имя сессии.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_session_list',
    description:
      'Список сессий: живые ядра и сохранённые журналы (в т.ч. из прошлых чатов). Видно, сколько шагов в журнале и когда он обновлялся.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'maple_session_resume',
    description:
      'Поднять сессию из журнала: запустить свежее ядро и проиграть весь ранее выполненный код, ' +
      'чтобы вернуть переменные и функции. Нужно, чтобы продолжить работу в новом чате. ' +
      'Обычно вызывать не обязательно: maple_evaluate_code восстанавливает сессию сам.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Имя сессии (по умолчанию default).' },
        timeout_seconds: { type: 'number', description: 'Таймаут на восстановление, сек.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'maple_session_history',
    description: 'Показать журнал сессии: какой код выполнялся (по шагам, с датами). Полезно, чтобы вспомнить контекст расчёта.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Имя сессии (по умолчанию default).' },
        limit: { type: 'number', description: 'Сколько последних записей показать (по умолчанию 40).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'maple_session_reset',
    description:
      'Перезапустить ядро сессии, сохранив журнал: состояние вернётся при следующем вызове. ' +
      'Помогает, если ядро зависло или нужно освободить память.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Имя сессии (по умолчанию default).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'maple_session_forget',
    description: 'Забыть сессию совсем: остановить ядро и стереть журнал. Действие необратимо.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Имя сессии (по умолчанию default).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'maple_worksheet_read',
    description:
      'Прочитать .mw-воркшит: вернуть список execution groups с текстом ввода, метками, секциями и признаком вывода. ' +
      'Ввод в 2-D отдаётся в линейной форме (input-equation).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к .mw (абсолютный или относительно MAPLE_WORKSPACE_ROOT).' },
        include_output: { type: 'boolean', description: 'Показывать превью вывода групп.' },
        max_groups: { type: 'number', description: 'Ограничение числа групп (по умолчанию 200).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_worksheet_create',
    description:
      'Создать .mw-воркшит из массива ячеек (каждая ячейка — код Maple, вставляется как 1-D ввод). ' +
      'Файл проверяется самим Maple через Worksheet:-ReadFile.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Куда записать .mw.' },
        cells: { type: 'array', items: { type: 'string' }, description: 'Код ячеек по порядку.' },
        overwrite: { type: 'boolean', description: 'Перезаписать существующий файл.' },
        validate: { type: 'boolean', description: 'Проверять файл через Maple (по умолчанию да).' },
      },
      required: ['path', 'cells'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_worksheet_edit_cell',
    description: 'Заменить ввод одной execution group в .mw (по индексу из maple_worksheet_read). Файл проверяется Maple.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к .mw.' },
        index: { type: 'number', description: 'Индекс группы (с нуля).' },
        code: { type: 'string', description: 'Новый код ячейки.' },
        validate: { type: 'boolean', description: 'Проверять файл через Maple (по умолчанию да).' },
      },
      required: ['path', 'index', 'code'],
      additionalProperties: false,
    },
  },
  {
    name: 'maple_worksheet_run_cell',
    description: 'Прочитать одну execution group из .mw и выполнить её в сессии Maple.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к .mw.' },
        index: { type: 'number', description: 'Индекс группы (с нуля).' },
        session: { type: 'string', description: 'Имя сессии.' },
        timeout_seconds: { type: 'number', description: 'Таймаут, сек.' },
      },
      required: ['path', 'index'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  maple_health: toolHealth,
  maple_evaluate_code: toolEval,
  maple_check_code: toolCheck,
  maple_to_latex: toolLatex,
  maple_plot: toolPlot,
  maple_session_list: toolListSessions,
  maple_session_resume: toolSessionResume,
  maple_session_history: toolSessionHistory,
  maple_session_reset: toolSessionReset,
  maple_session_forget: toolSessionForget,
  maple_worksheet_read: toolWorksheetRead,
  maple_worksheet_create: toolWorksheetCreate,
  maple_worksheet_edit_cell: toolWorksheetEditCell,
  maple_worksheet_run_cell: toolWorksheetRunCell,
};

// ─────────────────────────── MCP по stdio ───────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Обрабатывает сообщение и возвращает ответ (null — для нотификаций). */
async function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Maple на этой машине. Используй maple_evaluate_code для вычислений: код Maple, «;» печатает результат, «:» — нет. ' +
          'Состояние живёт в сессии. Для воркшитов — maple_worksheet_*.',
      },
    };
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${name}` }], isError: true },
      };
    }
    try {
      const result = await handler(args);
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `внутренняя ошибка: ${e?.stack ?? e}` }], isError: true },
      };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

function serveStdio() {
  let stdinBuf = '';
  let inflight = 0;
  /** Ждём, пока доиграют начатые запросы: иначе на закрытии stdin теряем ответы. */
  const idle = (maxMs = 60_000) =>
    new Promise((resolve) => {
      const deadline = Date.now() + maxMs;
      const tick = () => (inflight === 0 || Date.now() > deadline ? resolve() : setTimeout(tick, 50));
      tick();
    });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let nl;
    while ((nl = stdinBuf.indexOf('\n')) >= 0) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      inflight++;
      dispatch(msg)
        .then((r) => {
          if (r) send(r);
        })
        .catch((e) => log('handler crash', e?.stack ?? e))
        .finally(() => {
          inflight--;
        });
    }
  });
  process.stdin.on('end', async () => {
    await idle();
    await bye();
  });
}

/**
 * Streamable HTTP (спецификация MCP 2025-03-26), совместимый с
 * StreamableHTTPClientTransport из @modelcontextprotocol/sdk (его использует
 * pi-mcp-extension). POST /mcp: отвечаем JSON или SSE в зависимости от Accept.
 */
function serveHttp(port, host) {
  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (url.pathname !== HTTP_PATH) {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
      return res.end('not found; MCP endpoint is ' + HTTP_PATH);
    }
    if (req.method === 'GET') {
      // Отдельный SSE-поток сервер→клиент нам не нужен.
      res.writeHead(405, { ...cors, Allow: 'POST, DELETE, OPTIONS' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST, DELETE, OPTIONS' });
      return res.end();
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    }

    const batch = Array.isArray(msg) ? msg : [msg];
    const replies = [];
    for (const m of batch) {
      const r = await dispatch(m).catch((e) => ({
        jsonrpc: '2.0',
        id: m?.id ?? null,
        error: { code: -32603, message: String(e?.message ?? e) },
      }));
      if (r) replies.push(r);
    }

    if (replies.length === 0) {
      res.writeHead(202, cors);
      return res.end();
    }
    const payload = batch.length === 1 && !Array.isArray(msg) ? replies[0] : replies;
    if (!req.headers['mcp-session-id']) res.setHeader('Mcp-Session-Id', randomUUID());
    const accept = String(req.headers.accept ?? '');
    if (accept.includes('text/event-stream')) {
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return res.end();
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  server.listen(port, host, () => {
    log(`HTTP MCP слушает http://${host}:${port}${HTTP_PATH}`);
    process.stderr.write(`[maple-mcp] HTTP MCP: http://${host}:${port}${HTTP_PATH}\n`);
  });
  server.on('error', (e) => {
    process.stderr.write(`[maple-mcp] не удалось поднять HTTP: ${e?.message ?? e}\n`);
    process.exit(1);
  });
  return server;
}

async function bye() {
  await stopAllSessions();
  await cleanupTmp();
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

// ─────────────────────────── точка входа ───────────────────────────

const argv = process.argv.slice(2);
const httpFlag = argv.findIndex((a) => a === '--http' || a.startsWith('--http='));
let HTTP_PATH = process.env.MAPLE_HTTP_PATH ?? '/mcp';

if (httpFlag >= 0) {
  const inline = argv[httpFlag].includes('=') ? argv[httpFlag].split('=')[1] : null;
  const port = Number(inline ?? argv[httpFlag + 1] ?? process.env.MAPLE_HTTP_PORT ?? 8770);
  const host = process.env.MAPLE_HTTP_HOST ?? '0.0.0.0';
  HTTP_PATH = process.env.MAPLE_HTTP_PATH ?? '/mcp';
  serveHttp(port, host);
} else {
  serveStdio();
}

log(`готов: ${MAPLE_BIN} ${MAPLE_ARGS.join(' ')}; root=${MAPLE_ROOT}; режим=${httpFlag >= 0 ? 'http' : 'stdio'}`);
