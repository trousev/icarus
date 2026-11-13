// Page extraction router. The rules are the same as in search, but with its own
// peculiarities: the "current" one here is separate, and a refusal of a specific page
// (404, robots, paywall) does not ban the provider — it is a property of the URL.
import type { IcarusConfig } from '../config.ts';
import {
  FETCH_MAX_CHARS,
  FETCH_PROVIDERS,
  FETCH_RATING,
} from './fetch-providers.ts';
import {
  applyFailure,
  applySuccess,
  asFailure,
  configuredProviders,
  hasFaults,
  keyFor,
  providerReady,
  secretFor,
} from './router.ts';
import {
  emptyProviderState,
  isBanned,
  mutateRouterState,
  readRouterState,
  scopeCurrent,
  scopeProviders,
  setScopeCurrent,
  soonestUnban,
  stateFile,
  type RouterState,
} from './state.ts';
import { SearchFailure, type FetchProvider, type FetchResult, type ProviderId } from './types.ts';
import { recordUsage } from './usage.ts';

export const FETCH_ATTEMPT_TIMEOUT_MS = 15_000;
export const FETCH_DEADLINE_MS = 30_000;

export type FetchTried = { provider: ProviderId; reason: string };

export type FetchRouteSuccess = {
  ok: true;
  provider: ProviderId;
  result: FetchResult;
  tried: FetchTried[];
  current: ProviderId | null;
};

export type FetchRouteFailure = {
  ok: false;
  reason: 'no-keys' | 'all-banned' | 'all-failed';
  tried: FetchTried[];
  current: ProviderId | null;
  retryAt: string | null;
};

export type FetchRouteResult = FetchRouteSuccess | FetchRouteFailure;

export type FetchRouteOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
  maxChars?: number;
};

/** Extraction providers that have a key (Cloudflare — also an account). */
export function configuredFetchProviders(config: IcarusConfig): FetchProvider[] {
  return FETCH_RATING.map((id) => FETCH_PROVIDERS[id]).filter(
    (provider): provider is FetchProvider => provider !== undefined && providerReady(config, provider),
  );
}

function availableIds(state: RouterState, candidates: readonly FetchProvider[], now: number): ProviderId[] {
  const providers = scopeProviders(state, 'fetch');
  return candidates
    .map((provider) => provider.id)
    .filter((id) => !isBanned(providers[id] ?? emptyProviderState(), now));
}

function chooseAttempt(
  state: RouterState,
  candidates: readonly FetchProvider[],
  tried: Set<ProviderId>,
  now: number,
): ProviderId | null {
  const free = availableIds(state, candidates, now).filter((id) => !tried.has(id));
  if (free.length === 0) return null;
  const providers = scopeProviders(state, 'fetch');
  const revived = free.find((id) => providers[id]?.broken === true);
  if (revived !== undefined) return revived;
  const current = scopeCurrent(state, 'fetch');
  if (current !== null && free.includes(current)) return current;
  return free[0] ?? null;
}

/**
 * A refusal that hits the whole account, not a single capability: credits ran out
 * (the balance is shared with search) or the key stopped letting through (401/403).
 * Then we ban the provider in search too — otherwise search would hit the same wall.
 */
function sharedWithSearch(failure: SearchFailure): boolean {
  if (failure.kind === 'credits') return true;
  return failure.kind === 'http' && (failure.status === 401 || failure.status === 403);
}

function failureText(failure: SearchFailure): string {
  const body = failure.body.trim();
  return body === '' ? failure.message : `${failure.message}: ${body.slice(0, 200)}`;
}

export async function routeFetch(
  config: IcarusConfig,
  url: string,
  options: FetchRouteOptions = {},
): Promise<FetchRouteResult> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? fetch;
  const maxChars = options.maxChars ?? FETCH_MAX_CHARS;
  const file = stateFile(config);
  const candidates = configuredFetchProviders(config);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-keys', tried: [], current: null, retryAt: null };
  }

  const start = now();
  const state = readRouterState(file);
  const knownIds = new Set(candidates.map((provider) => provider.id));
  const current = scopeCurrent(state, 'fetch');
  const providers = scopeProviders(state, 'fetch');

  // Cloudflare is "super-sticky": while it is not in quarantine, fetch forcibly makes
  // it the current one, even if someone else was current before. It pays
  // for browser time, not for pages, so it must be spent first.
  const sticky =
    candidates.some((provider) => provider.id === 'cloudflare') &&
    !isBanned(providers.cloudflare ?? emptyProviderState(), start);
  if (sticky) {
    if (current !== 'cloudflare') {
      await mutateRouterState(file, (fresh) => {
        setScopeCurrent(fresh, 'fetch', 'cloudflare');
      });
    }
  } else {
    const known =
      current !== null && knownIds.has(current) ? (providers[current] ?? emptyProviderState()) : null;
    if (known === null || isBanned(known, start)) {
      const next = availableIds(state, candidates, start)[0] ?? null;
      if (next !== null && next !== current) {
        await mutateRouterState(file, (fresh) => {
          setScopeCurrent(fresh, 'fetch', next);
        });
      }
    }
  }

  const tried: FetchTried[] = [];
  const triedIds = new Set<ProviderId>();
  const deadline = start + (options.deadlineMs ?? FETCH_DEADLINE_MS);

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const fresh = readRouterState(file);
    const id = chooseAttempt(fresh, candidates, triedIds, now());
    if (id === null) break;
    triedIds.add(id);

    const provider = FETCH_PROVIDERS[id];
    const key = keyFor(config, provider);
    if (key === '') {
      tried.push({ provider: id, reason: 'нет ключа' });
      continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      tried.push({ provider: id, reason: 'общий таймаут извлечения' });
      break;
    }
    const timeout = Math.min(options.timeoutMs ?? FETCH_ATTEMPT_TIMEOUT_MS, remaining);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);

    try {
      const result = await provider.fetch(url, {
        key,
        fetch: fetchImpl,
        signal,
        maxChars,
        secret: (name) => secretFor(config, name),
      });
      const before = readRouterState(file);
      const after = hasFaults(before, id, 'fetch')
        ? await mutateRouterState(file, (next) => applySuccess(next, id, 'fetch'))
        : before;
      await recordUsage(config, 'fetch', id, true, { now });
      return { ok: true, provider: id, result, tried, current: scopeCurrent(after, 'fetch') };
    } catch (error) {
      if (options.signal?.aborted) break;
      const failure = asFailure(error);
      tried.push({ provider: id, reason: failureText(failure) });
      // The page did not come back — not the provider's fault, we go to the next one without a ban.
      // The refusal still goes into the stats: tried is there, but no page.
      await recordUsage(config, 'fetch', id, false, { now });
      if (failure.kind === 'page') continue;

      // Cloudflare does not participate in search: its daily limit must not ban
      // search providers. The rest share the key and credits with search.
      const searchCandidates =
        id !== 'cloudflare' && sharedWithSearch(failure) ? configuredProviders(config) : [];
      await mutateRouterState(file, (next) => {
        applyFailure(next, id, failure, now(), candidates, 'fetch');
        if (searchCandidates.length > 0) {
          applyFailure(next, id, failure, now(), searchCandidates, 'search');
        }
      });
    }
  }

  const final = readRouterState(file);
  return {
    ok: false,
    reason: tried.length === 0 ? 'all-banned' : 'all-failed',
    tried,
    current: scopeCurrent(final, 'fetch'),
    retryAt: soonestUnban(final, candidates.map((provider) => provider.id), now(), 'fetch'),
  };
}
