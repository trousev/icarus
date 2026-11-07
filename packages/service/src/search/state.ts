// Состояние роутера: кто в карантине, сколько провалился, кого зовём по умолчанию.
//
// Это «редко пишем, часто читаем»: файл крошечный, меняется только на отказе,
// успехе или смене текущего провайдера. Никакой SQLite: JSON рядом с данными
// сервиса, атомарная запись через переименование и замок на процесс.
import fs from 'node:fs';
import path from 'node:path';
import type { IcarusConfig } from '../config.ts';
import { isProviderId, type ProviderId } from './types.ts';

export type BanReason = 'error' | 'credits' | 'broken';

/** Две возможности роутера: поиск и извлечение страницы. Баны и «текущий» у них свои. */
export type Capability = 'search' | 'fetch';

export type ProviderState = {
  /** Сколько отказов подряд: успех обнуляет. */
  fails: number;
  /** До какого момента не трогаем; null — не в карантине. */
  bannedUntil: string | null;
  banReason: BanReason | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** «Ключ сломан»: 50 отказов подряд. Живёт до первого успеха или правки ключа. */
  broken: boolean;
  brokenAt: string | null;
};

/** Состояние одной возможности: свой текущий и свои карантины. */
export type ScopeState = {
  current: ProviderId | null;
  providers: Record<string, ProviderState>;
};

export type RouterState = {
  version: 2;
  /**
   * Поиск. Верхние поля оставлены именно поиску, чтобы файлы состояния,
   * записанные до появления /fetch, читались без миграции.
   */
  current: ProviderId | null;
  providers: Record<string, ProviderState>;
  /** Извлечение страниц: свой «текущий», он может не совпадать с поисковым. */
  fetch?: ScopeState;
  updatedAt: string;
};

export function emptyProviderState(): ProviderState {
  return {
    fails: 0,
    bannedUntil: null,
    banReason: null,
    lastError: null,
    lastErrorAt: null,
    broken: false,
    brokenAt: null,
  };
}

export function emptyRouterState(): RouterState {
  return { version: 2, current: null, providers: {}, updatedAt: new Date().toISOString() };
}

/** Файл состояния: по умолчанию рядом с данными, в тестах подменяется. */
export function stateFile(config: IcarusConfig): string {
  return config.searchStateFile ?? path.join(config.dataDir, 'search-router.json');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stamp = Date.parse(value);
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

function asProviderState(value: unknown): ProviderState | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const fails = typeof raw.fails === 'number' && Number.isFinite(raw.fails) ? Math.max(0, Math.trunc(raw.fails)) : 0;
  const reason =
    raw.banReason === 'error' || raw.banReason === 'credits' || raw.banReason === 'broken' ? raw.banReason : null;
  return {
    fails,
    bannedUntil: asIsoOrNull(raw.bannedUntil),
    banReason: reason,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    lastErrorAt: asIsoOrNull(raw.lastErrorAt),
    broken: raw.broken === true,
    brokenAt: asIsoOrNull(raw.brokenAt),
  };
}

function readProviders(value: unknown): Record<string, ProviderState> {
  const providers: Record<string, ProviderState> = {};
  for (const [id, raw] of Object.entries(asRecord(value) ?? {})) {
    if (!isProviderId(id)) continue;
    const state = asProviderState(raw);
    if (state) providers[id] = state;
  }
  return providers;
}

function readCurrent(value: unknown): ProviderId | null {
  return typeof value === 'string' && isProviderId(value) ? value : null;
}

/**
 * Прочитать состояние. Битый файл — не повод падать: роутер начнёт с чистого
 * листа, а не откажет в поиске из-за одной испорченной строки.
 */
export function readRouterState(file: string): RouterState {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyRouterState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyRouterState();
  }
  const root = asRecord(parsed);
  if (!root) return emptyRouterState();

  // v1 → v2: у извлечения сменился рейтинг (теперь он обратный поисковому),
  // поэтому старый fetch.current сбрасывается — иначе он жил бы вечно и
  // приоритет никогда бы не применился. Карантины при этом сохраняем.
  const migrated = root.version !== 2;
  const fetchRaw = asRecord(root.fetch);
  return {
    version: 2,
    current: readCurrent(root.current),
    providers: readProviders(root.providers),
    ...(fetchRaw
      ? {
          fetch: {
            current: migrated ? null : readCurrent(fetchRaw.current),
            providers: readProviders(fetchRaw.providers),
          },
        }
      : {}),
    updatedAt: asIsoOrNull(root.updatedAt) ?? new Date().toISOString(),
  };
}

/** Запись через временный файл: недописанный JSON не должен стать состоянием. */
function writeRouterState(file: string, state: RouterState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload: RouterState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Замок на файл внутри процесса: два одновременных отказа не должны потерять
// один из них. Между процессами не защищает, но сервис у нас один.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, task: () => T): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Изменить состояние под замком: читаем свежее, правим, пишем. */
export function mutateRouterState(file: string, change: (state: RouterState) => void): Promise<RouterState> {
  return withLock(file, () => {
    const state = readRouterState(file);
    change(state);
    writeRouterState(file, state);
    return state;
  });
}

/** Лениво создать состояние fetch: старый файл его не содержит. */
export function fetchState(state: RouterState): ScopeState {
  state.fetch ??= { current: null, providers: {} };
  return state.fetch;
}

/** Карта провайдеров нужной возможности. */
export function scopeProviders(state: RouterState, scope: Capability = 'search'): Record<string, ProviderState> {
  return scope === 'fetch' ? fetchState(state).providers : state.providers;
}

export function scopeCurrent(state: RouterState, scope: Capability = 'search'): ProviderId | null {
  return scope === 'fetch' ? (state.fetch?.current ?? null) : state.current;
}

export function setScopeCurrent(state: RouterState, scope: Capability, current: ProviderId | null): void {
  if (scope === 'fetch') fetchState(state).current = current;
  else state.current = current;
}

/** Состояние провайдера в карте; отсутствующее — чистый лист. */
export function providerState(state: RouterState, id: ProviderId, scope: Capability = 'search'): ProviderState {
  const providers = scopeProviders(state, scope);
  const existing = providers[id];
  if (existing) return existing;
  const fresh = emptyProviderState();
  providers[id] = fresh;
  return fresh;
}

export function isBanned(provider: ProviderState, now: number): boolean {
  if (!provider.bannedUntil) return false;
  return Date.parse(provider.bannedUntil) > now;
}

/** Ближайший момент, когда хоть кто-то выйдет из карантина: для ответа 503. */
export function soonestUnban(
  state: RouterState,
  ids: Iterable<ProviderId>,
  now: number,
  scope: Capability = 'search',
): string | null {
  const providers = scopeProviders(state, scope);
  let soonest: number | null = null;
  for (const id of ids) {
    const provider = providers[id];
    if (!provider?.bannedUntil) continue;
    const stamp = Date.parse(provider.bannedUntil);
    if (Number.isNaN(stamp) || stamp <= now) continue;
    if (soonest === null || stamp < soonest) soonest = stamp;
  }
  return soonest === null ? null : new Date(soonest).toISOString();
}
