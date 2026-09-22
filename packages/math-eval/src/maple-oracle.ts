// Оракул равенства ответов на самом Maple: `simplify(ответ - эталон) = 0`.
//
// Нужен потому, что «x²−2x+2, умноженное на eˣ» человек запишет десятком способов,
// и сравнение строк тут врёт. Модель отвечает в Maple-синтаксисе (это требование
// набора), поэтому проверять её ответ может тот же движок, которым она считала.
//
// Ответ модели — недоверенный текст, поэтому он не подставляется в код, а
// разбирается через `parse` из строкового литерала: инъекция кода невозможна,
// а неразбираемая запись честно даёт null («проверить не удалось»).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toMapleSyntax, type AnswerOracle } from './grade.ts';

/** Строковый литерал Maple с экранированием. */
function mapleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function mapleOracle(bin: string, timeoutMs = 30_000): AnswerOracle {
  return async (got, expected) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'math-eval-maple-'));
    const file = path.join(dir, 'check.mpl');
    // Ответ человека — LaTeX; Maple его не разберёт, поэтому сначала приводим
    // запись к синтаксису движка (`\frac`, `\pi`, `e^x` → `exp(x)`).
    const code = [
      'try',
      `  g := parse(${mapleString(toMapleSyntax(got))}):`,
      `  e := parse(${mapleString(toMapleSyntax(expected))}):`,
      '  r := evalb(simplify(g-e) = 0):',
      'catch:',
      '  r := FAIL:',
      'end try:',
      'printf("%a\\n", r):',
      '',
    ].join('\n');
    writeFileSync(file, code, 'utf8');
    try {
      const output = await runMaple(bin, file, timeoutMs);
      const verdict = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop();
      if (verdict === 'true') return true;
      if (verdict === 'false') return false;
      return null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function runMaple(bin: string, file: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-q', '-s', '-e2', '--historyfile=none', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Maple не ответил за ${timeoutMs} мс`));
    }, timeoutMs);
    child.stdout.on('data', (part: Buffer) => (stdout += part.toString('utf8')));
    child.stderr.on('data', (part: Buffer) => (stderr += part.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Maple вышел с кодом ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
