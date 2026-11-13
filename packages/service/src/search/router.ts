// The router itself: whom to call, whom to trust, whom to send to quarantine.
//
// The rules are simple and deliberately crude — half the providers have no quota API:
//  - the first by rating that is not in quarantine becomes the current one;
//  - a refusal or timeout — five minutes of quarantine and a request to the next one;
//  - 402/429 "about credits" — a day: within a day the quota will most likely return;
//  - 50 refusals in a row — "key broken" and seven days for the person to check;
//  - success clears everything: the quarantine, the flag and the counter.
import { PROVIDERS } from './providers.ts';
import {
  emptyProviderState,
  isBanned,
  mutateRouterState,
  providerState,
  readRouterState,
  scopeCurrent,
  scopeProviders,
  setScopeCurrent,
  soonestUnban,
  stateFile,
  type BanReason,
  type Capability,
  type RouterState,
} from './state.ts';
import {
  SearchFailure,
  type ProviderId,
  type SearchProvider,
  type SearchProviderId,
  type SearchResult,
} from './types.ts';
import { recordUsage } from './usage.ts';
import type { IcarusConfig } from '../config.ts';

/**
 * Search rating: at the top are those who return Google results or search best of all.
 * Cloudflare is not included: it can only extract pages.
 */
export const RATING: readonly SearchProviderId[] = [
  'serpapi',
  'serpstack',
  'brave',
  'exa',
  'tavily',
  'firecrawl',
  'you',
  'you-free',
  'linkup',
];

export const ATTEMPT_TIMEOUT_MS = 8_000;
export const TOTAL_DEADLINE_MS = 20_000;
/** A normal failure: five minutes is enough for the provider to recover. */
export const ERROR_BAN_MS = 5 * 60_000;
/** Credits ran out: a day, checking earlier is pointless. */
export const CREDIT_BAN_MS = 24 * 60 * 60_000;
/** "Key broken": seven days, but the first success will clear the flag. */
export const BROKEN_BAN_MS = 7 * 24 * 60 * 60_000;
/** How many refusals in a row to consider a key broken. */
export const BROKEN_AFTER = 50;

export type TriedProvider = { provider: ProviderId; reason: string };

export type RouteSuccess = {
  ok: true;
  provider: ProviderId;
  results: SearchResult[];
  tried: TriedProvider[];
  current: ProviderId | null;
};

export type RouteFailure = {
  ok: false;
  reason: 'no-keys' | 'all-banned' | 'all-failed';
  tried: TriedProvider[];
  current: ProviderId | null;
  retryAt: string | null;
};

export type RouteResult = RouteSuccess | RouteFailure;

export type RouteOptions = {
  fetch?: typeof fetch;
  /** Overridable time: tests must not wait five minutes. */
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
};

/** Setting value: the panel (secretEnv) beats .env, .env beats the environment. */
export function secretFor(config: IcarusConfig, name: string): string {
  return config.secretEnv?.[name]?.trim() || config.env[name]?.trim() || process.env[name]?.trim() || '';
}

/** Provider key — the first non-empty variable from its list. */
export function keyFor(config: IcarusConfig, provider: { keyNames: string[] }): string {
  for (const name of provider.keyNames) {
    const value = secretFor(config, name);
    if (value) return value;
  }
  return '';
}

/** How to disable a free provider without a key. */
const FREE_OFF = /^(off|false|no|none|0)$/i;

/**
 * Whether the provider participates in rotation.
 *
 * A normal one needs a key: without a key there is nothing to try — that is not a ban but a skip.
 * Free MCP You.com needs no key and is enabled by default — search
 * works even on an empty .env. It is disabled with a single line: ICARUS_SEARCH_FREE=off.
 */
export function providerEnabled(
  config: IcarusConfig,
  provider: { keyless?: boolean; keyNames: string[] },
): boolean {
  if (provider.keyless === true) return !FREE_OFF.test(secretFor(config, 'ICARUS_SEARCH_FREE'));
  return keyFor(config, provider) !== '';
}

/**
 * Is the provider ready: it participates in rotation and all required secrets are set.
 * Required ones are needed where a single key is not enough (Cloudflare: account + token).
 */
export function providerReady(
  config: IcarusConfig,
  provider: { keyless?: boolean; keyNames: string[]; requires?: string[] },
): boolean {
  if (!providerEnabled(config, provider)) return false;
  return (provider.requires ?? []).every((name) => secretFor(config, name) !== '');
}

/** Providers that can be called: with or without a key, if so intended. */
export function configuredProviders(config: IcarusConfig): SearchProvider[] {
  return RATING.map((id) => PROVIDERS[id]).filter((provider) => providerReady(config, provider));
}

type Candidate = { id: ProviderId };

function availableIds(
  state: RouterState,
  candidates: readonly Candidate[],
  now: number,
  scope: Capability = 'search',
): ProviderId[] {
  const providers = scopeProviders(state, scope);
  return candidates
    .map((provider) => provider.id)
    .filter((id) => !isBanned(providers[id] ?? emptyProviderState(), now));
}

function firstAvailable(
  state: RouterState,
  candidates: readonly Candidate[],
  now: number,
  scope: Capability = 'search',
): ProviderId | null {
  return availableIds(state, candidates, now, scope)[0] ?? null;
}

/** The first untried and unbanned one: the current goes first, then by rating. */
function chooseAttempt(
  state: RouterState,
  candidates: readonly Candidate[],
  tried: Set<ProviderId>,
  now: number,
  scope: Capability = 'search',
): ProviderId | null {
  const free = availableIds(state, candidates, now, scope).filter((id) => !tried.has(id));
  if (free.length === 0) return null;
  // We check a "broken" key ourselves after seven days of quarantine, with one real
  // request: if it answered — the flag is cleared, if not — seven more days. This happens
  // once per provider, not on every request.
  const providers = scopeProviders(state, scope);
  const revived = free.find((id) => providers[id]?.broken === true);
  if (revived !== undefined) return revived;
  const current = scopeCurrent(state, scope);
  if (current !== null && free.includes(current)) return current;
  return free[0] ?? null;
}

function banFor(kind: SearchFailure['kind'], id: ProviderId, now: number): { reason: BanReason; ms: number } {
  if (kind !== 'credits') return { reason: 'error', ms: ERROR_BAN_MS };
  // There is no point in holding a daily quota for exactly a day: we wait for it to reset by the calendar.
  const search = id in PROVIDERS ? PROVIDERS[id as SearchProviderId] : undefined;
  const reset = search?.creditsResetAt?.(now);
  return { reason: 'credits', ms: reset === undefined ? CREDIT_BAN_MS : Math.max(60_000, reset - now) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function failureText(failure: SearchFailure): string {
  const body = failure.body.trim();
  return body === '' ? failure.message : `${failure.message}: ${body.slice(0, 200)}`;
}

/**
 * Record a failure: counter, quarantine, and at 50 — "key broken".
 * If the current one dropped out — immediately pick a new current, so the next
 * request does not start with the one we just sent to quarantine.
 *
 * scope is needed because page extraction has its own "current" and its own quarantines.
 * A page refusal (kind === 'page') does not get here — it is a property of the URL.
 */
export function applyFailure(
  state: RouterState,
  id: ProviderId,
  failure: SearchFailure,
  now: number,
  candidates: readonly Candidate[],
  scope: Capability = 'search',
): void {
  const provider = providerState(state, id, scope);
  provider.fails += 1;
  provider.lastError = failureText(failure);
  provider.lastErrorAt = iso(now);

  if (provider.fails >= BROKEN_AFTER) {
    provider.broken = true;
    provider.brokenAt = iso(now);
    provider.banReason = 'broken';
    provider.bannedUntil = iso(now + BROKEN_BAN_MS);
  } else {
    const ban = banFor(failure.kind, id, now);
    provider.banReason = ban.reason;
    provider.bannedUntil = iso(now + ban.ms);
  }

  if (scopeCurrent(state, scope) === id) {
    const next = firstAvailable(state, candidates, now, scope);
    if (next !== null) setScopeCurrent(state, scope, next);
  }
}

/** Success means "the provider is alive": we clear the quarantine, the flag and the failure counter. */
export function applySuccess(state: RouterState, id: ProviderId, scope: Capability = 'search'): void {
  const provider = providerState(state, id, scope);
  provider.fails = 0;
  provider.bannedUntil = null;
  provider.banReason = null;
  provider.lastError = null;
  provider.lastErrorAt = null;
  provider.broken = false;
  provider.brokenAt = null;
}

function asFailure(error: unknown): SearchFailure {
  if (error instanceof SearchFailure) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SearchFailure('timeout', 'провайдер не ответил вовремя');
  }
  return new SearchFailure('network', error instanceof Error ? error.message : String(error));
}

export { asFailure };

/** Build a snapshot for comparison: is it even necessary to write the success to the file. */
export function hasFaults(state: RouterState, id: ProviderId, scope: Capability = 'search'): boolean {
  const provider = scopeProviders(state, scope)[id];
  return !provider || provider.fails > 0 || provider.bannedUntil !== null || provider.broken;
}

/**
 * The main entry: find a live provider and return its results.
 *
 * We try in turn until someone answers. Every refusal is immediately written to
 * the state: the next request (even a parallel one) will no longer go to the failed one.
 */
export async function routeSearch(
  config: IcarusConfig,
  query: string,
  limit: number,
  options: RouteOptions = {},
): Promise<RouteResult> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? fetch;
  const file = stateFile(config);
  const candidates = configuredProviders(config);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-keys', tried: [], current: null, retryAt: null };
  }

  const start = now();
  const state = readRouterState(file);
  const candidatesIds = new Set(candidates.map((provider) => provider.id));

  // There is no current one, it no longer has a key, or it is in quarantine — we pick the first
  // live one by rating. While it is alive, the current one does not change by itself.
  const knownCurrent = scopeCurrent(state, 'search');
  const known =
    knownCurrent !== null && candidatesIds.has(knownCurrent)
      ? (scopeProviders(state, 'search')[knownCurrent] ?? emptyProviderState())
      : null;
  if (known === null || isBanned(known, start)) {
    const next = firstAvailable(state, candidates, start, 'search');
    if (next !== null && next !== knownCurrent) {
      await mutateRouterState(file, (fresh) => {
        setScopeCurrent(fresh, 'search', next);
      });
    }
  }

  const tried: TriedProvider[] = [];
  const triedIds = new Set<ProviderId>();
  const deadline = start + (options.deadlineMs ?? TOTAL_DEADLINE_MS);

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const fresh = readRouterState(file);
    const id = chooseAttempt(fresh, candidates, triedIds, now());
    if (id === null) break;
    triedIds.add(id);

    const provider = PROVIDERS[id as SearchProviderId];
    const key = keyFor(config, provider);
    if (key === '' && provider.keyless !== true) {
      tried.push({ provider: id, reason: 'нет ключа' });
      continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      tried.push({ provider: id, reason: 'общий таймаут поиска' });
      break;
    }
    const timeout = Math.min(options.timeoutMs ?? ATTEMPT_TIMEOUT_MS, remaining);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);

    try {
      const results = await provider.search(query, limit, { key, fetch: fetchImpl, signal });
      const before = readRouterState(file);
      const previous = before.providers[id];
      const dirty = !previous || previous.fails > 0 || previous.bannedUntil !== null || previous.broken;
      const after = dirty ? await mutateRouterState(file, (next) => applySuccess(next, id)) : before;
      await recordUsage(config, 'search', id, true, { now });
      return { ok: true, provider: id, results, tried, current: after.current };
    } catch (error) {
      // The client left — not the provider's fault, we must not ban.
      if (options.signal?.aborted) break;
      const failure = asFailure(error);
      await mutateRouterState(file, (next) => applyFailure(next, id, failure, now(), candidates));
      await recordUsage(config, 'search', id, false, { now });
      tried.push({ provider: id, reason: failureText(failure) });
    }
  }

  const final = readRouterState(file);
  const reason = tried.length === 0 ? 'all-banned' : 'all-failed';
  return {
    ok: false,
    reason,
    tried,
    current: final.current,
    retryAt: soonestUnban(final, candidates.map((provider) => provider.id), now()),
  };
}
