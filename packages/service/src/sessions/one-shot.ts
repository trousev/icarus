// A one-shot call to a cheap model in the user's container: no tools, no session, and
// no Icarus persona — we ask exactly what's needed and take stdout. The memory-extractor
// extension calls the model the same way, only from there — from inside the container,
// while from here — via `docker exec`.
import type { ChildProcess } from 'node:child_process';
import { spawnDockerOnce } from '../docker/manager.ts';
import { redact } from '../log.ts';
import type { IcarusConfig, ModelConfig } from '../config.ts';

export type OneShotOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * What sets the role. The default is «отвечай ровно тем, о чём просят»: that's what a
   * one-shot question is for. A different role is needed where the answer is read by code
   * rather than a person (for example, the panel asks for a skill as JSON).
   */
  systemPrompt?: string;
};

/** How long we wait for an answer by default: a cheap model answers in seconds. */
export const ONE_SHOT_TIMEOUT_MS = 12_000;

/** Persona and memory rules only get in the way here: we need an answer, not a conversation. */
export const ONE_SHOT_SYSTEM_PROMPT =
  'Отвечай ровно тем, о чём просят, без пояснений, без Markdown и без лишних слов.';

/** pi arguments for a one-shot question: reads nothing, saves nothing. */
export function oneShotArgs(model: ModelConfig, prompt: string, systemPrompt: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    `${model.provider}/${model.id}`,
    '--thinking',
    model.thinking ?? 'low',
    '--system-prompt',
    systemPrompt,
    '--no-tools',
    '--no-session',
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
  ];
}

/**
 * Asks the model and returns its stdout as is.
 *
 * Throws if the model didn't answer in time, pi crashed, or the request was cancelled:
 * the decision of what to replace the answer with is left to the caller (the title falls
 * back to a heuristic).
 */
export function runOneShot(
  config: IcarusConfig,
  container: string,
  model: ModelConfig,
  prompt: string,
  options: OneShotOptions = {},
): Promise<string> {
  const { timeoutMs = ONE_SHOT_TIMEOUT_MS, signal, systemPrompt = ONE_SHOT_SYSTEM_PROMPT } = options;

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('запрос уже отменён'));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnDockerOnce(config, container, ['pi', ...oneShotArgs(model, prompt, systemPrompt)]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    // We set the timer before the handlers: finish and the callback below reference it,
    // and const honestly says there's no intent to reassign it.
    const timer: NodeJS.Timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`модель не ответила за ${timeoutMs} мс`));
    }, timeoutMs);

    function finish(error: Error | null, value = ''): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }

    function onAbort(): void {
      child.kill('SIGTERM');
      finish(new Error('запрос отменён'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on('close', (code) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const detail = redact(stderr).replace(/\s+/g, ' ').trim().slice(0, 200);
      finish(new Error(`pi завершился с кодом ${String(code)}${detail ? `: ${detail}` : ''}`));
    });
  });
}
