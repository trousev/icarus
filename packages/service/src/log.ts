// Логгер: человекочитаемые строки в stderr, без внешних зависимостей.
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.ICARUS_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, message: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 23);
  const tail = extra && Object.keys(extra).length > 0 ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${tail}\n`);
}

export const log = {
  debug: (message: string, extra?: Record<string, unknown>) => emit('debug', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => emit('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => emit('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => emit('error', message, extra),
};

/** Секреты не должны попадать в логи — вырезаем всё похожее на ключ. */
export function redact(value: string): string {
  return value.replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1***');
}
