// Router state: who is quarantined, how many failed, whom we call by default.
//
// This is “rarely written, often read”: the file is tiny and changes only on a failure,
// a success, or a change of the current provider. No SQLite: JSON next to the service
// data, atomic write via rename and a per-process lock.
import fs from 'node:fs';
import path from 'node:path';
import type { IcarusConfig } from '../config.ts';
import { isProviderId, type ProviderId } from './types.ts';

export type BanReason = 'error' | 'credits' | 'broken';

/** The router's two capabilities: search and page extraction. Bans and the “current” one are separate. */
export type Capability = 'search' | 'fetch';

export type ProviderState = {
  /** How many consecutive failures: a success zeroes it. */
  fails: number;
  /** Until when we don't touch it; null — not in quarantine. */
  bannedUntil: string | null;
  banReason: BanReason | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** “Key is broken”: 50 consecutive failures. Lives until the first success or a key edit. */
  broken: boolean;
  brokenAt: string | null;
};

/** State of a single capability: its own current one and its own quarantines. */
export type ScopeState = {
  current: ProviderId | null;
  providers: Record<string, ProviderState>;
};

export type RouterState = {
  version: 2;
  /**
   * Search. The top-level fields are kept specifically for search so that state files
   * written before /fetch appeared are read without migration.
   */
  current: ProviderId | null;
  providers: Record<string, ProviderState>;
  /** Page extraction: its own “current”, which may differ from the search one. */
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

/** State file: next to the data by default, substituted in tests. */
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
 * Read the state. A corrupt file is no reason to crash: the router will start from a
 * clean slate rather than refuse search because of one broken line.
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

  // v1 → v2: extraction changed its ranking (now the reverse of search), so the old
  // fetch.current is reset — otherwise it would live forever and the priority would
  // never apply. The quarantines are kept meanwhile.
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

/** Write via a temporary file: an incompletely written JSON must not become the state. */
function writeRouterState(file: string, state: RouterState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload: RouterState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Per-process file lock: two simultaneous failures must not lose one of them.
// It doesn't protect across processes, but we have a single service.
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

/** Change state under the lock: read fresh, edit, write. */
export function mutateRouterState(file: string, change: (state: RouterState) => void): Promise<RouterState> {
  return withLock(file, () => {
    const state = readRouterState(file);
    change(state);
    writeRouterState(file, state);
    return state;
  });
}

/** Lazily create the fetch state: an old file doesn't contain it. */
export function fetchState(state: RouterState): ScopeState {
  state.fetch ??= { current: null, providers: {} };
  return state.fetch;
}

/** Provider map of the needed capability. */
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

/** Provider state in the map; a missing one is a clean slate. */
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

/** The nearest moment when anyone leaves quarantine: for a 503 response. */
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
