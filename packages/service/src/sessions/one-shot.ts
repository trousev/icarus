// Одноразовый вызов дешёвой модели в контейнере пользователя: без тулов, без
// сессии и без персоны Икара — спрашиваем ровно то, что нужно, и забираем stdout.
// Так же зовёт модель расширение-экстрактор памяти, только оттуда — изнутри
// контейнера, а отсюда — через `docker exec`.
import type { ChildProcess } from 'node:child_process';
import { spawnDockerOnce } from '../docker/manager.ts';
import { redact } from '../log.ts';
import type { IcarusConfig, ModelConfig } from '../config.ts';

export type OneShotOptions = { timeoutMs?: number; signal?: AbortSignal };

/** Сколько ждём ответ по умолчанию: дешёвая модель отвечает за секунды. */
export const ONE_SHOT_TIMEOUT_MS = 12_000;

/** Персона и правила памяти тут только мешают: нужен ответ, а не разговор. */
export const ONE_SHOT_SYSTEM_PROMPT =
  'Отвечай ровно тем, о чём просят, без пояснений, без Markdown и без лишних слов.';

/** Аргументы pi для разового вопроса: ничего не читает, ничего не сохраняет. */
export function oneShotArgs(model: ModelConfig, prompt: string, systemPrompt: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    `${model.provider}/${model.id}`,
    '--thinking',
    model.thinking ?? 'off',
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
 * Спрашивает модель и отдаёт её stdout как есть.
 *
 * Бросает, если модель не ответила вовремя, pi упал или запрос отменили: решение,
 * чем заменить ответ, остаётся за вызывающим (заголовок падает обратно на эвристику).
 */
export function runOneShot(
  config: IcarusConfig,
  container: string,
  model: ModelConfig,
  prompt: string,
  options: OneShotOptions = {},
): Promise<string> {
  const { timeoutMs = ONE_SHOT_TIMEOUT_MS, signal } = options;

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('запрос уже отменён'));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnDockerOnce(config, container, ['pi', ...oneShotArgs(model, prompt, ONE_SHOT_SYSTEM_PROMPT)]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    // Таймер поднимаем до обработчиков: finish и колбэк ниже ссылаются на него,
    // а const честно говорит, что переприсваивать его не собираются.
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
