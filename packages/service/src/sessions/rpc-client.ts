// RPC bridge to pi: JSONL over stdio via `docker exec -i`.
// The protocol was verified in M0 (see PLAN.md, the "Frozen contract" section).
import type { ChildProcess } from 'node:child_process';
import { spawnDockerExec } from '../docker/manager.ts';
import { log, redact } from '../log.ts';
import type { IcarusConfig } from '../config.ts';

export type RpcEvent = { type: string } & Record<string, unknown>;
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
/** How to launch pi: docker exec in production, any process with JSONL on stdio in tests. */
export type Spawner = (
  container: string,
  args: string[],
  env?: Record<string, string>,
  workdir?: string,
) => ChildProcess;

export class RpcClient {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: RpcEvent) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private closed = false;
  private container: string;

  constructor(
    config: IcarusConfig,
    container: string,
    piArgs: string[],
    spawner?: Spawner,
    env: Record<string, string> = {},
    workdir?: string,
  ) {
    this.container = container;
    const launch: Spawner =
      spawner ?? ((name, args, extra, dir) => spawnDockerExec(config, name, args, extra, dir));
    this.child = launch(container, ['pi', ...piArgs], env, workdir);

    this.child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = redact(chunk.toString('utf8')).trim();
      if (text) log.debug('pi stderr', { container, text: text.slice(0, 400) });
    });
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const [, pending] of this.pending) pending.reject(new Error('pi завершился'));
      this.pending.clear();
      for (const listener of this.exitListeners) listener(code);
      log.warn('процесс pi завершился', { container, code });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;

      let event: RpcEvent;
      try {
        event = JSON.parse(line) as RpcEvent;
      } catch {
        log.debug('неразобранная строка от pi', { line: line.slice(0, 200) });
        continue;
      }

      if (event.type === 'response' && typeof event.id === 'string') {
        const pending = this.pending.get(event.id);
        if (pending) {
          this.pending.delete(event.id);
          pending.resolve(event);
          continue;
        }
      }

      for (const listener of this.listeners) listener(event);
    }
  }

  get alive(): boolean {
    return !this.closed;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Sends a command and waits for a response with the same id. */
  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('RPC-канал закрыт'));
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`таймаут команды ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin?.write(JSON.stringify({ id, ...command }) + '\n');
    });
  }

  /** Command without waiting for a response (e.g. abort during a stream). */
  send(command: Record<string, unknown>): void {
    this.child.stdin?.write(JSON.stringify(command) + '\n');
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    setTimeout(() => this.child.kill('SIGTERM'), 500);
  }
}
