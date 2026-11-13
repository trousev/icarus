// What the panel knows about search: who's current, who's quarantined, whose key is broken.
//
// A separate layer is needed so that the «Ключи» page doesn't assemble state piecemeal:
// it gets a ready list, and the «Проверить» button pokes the provider directly and lifts
// the quarantine only if it actually responded.
import type { IcarusConfig } from '../config.ts';
import { FETCH_PROVIDERS, FETCH_RATING } from './fetch-providers.ts';
import { FETCH_ATTEMPT_TIMEOUT_MS, configuredFetchProviders } from './fetch-router.ts';
import { PROVIDERS } from './providers.ts';
import {
  ATTEMPT_TIMEOUT_MS,
  RATING,
  applyFailure,
  applySuccess,
  configuredProviders,
  keyFor,
  providerEnabled,
  providerReady,
  secretFor,
} from './router.ts';
import {
  isBanned,
  mutateRouterState,
  readRouterState,
  stateFile,
  type BanReason,
  type ProviderState,
} from './state.ts';
import { SearchFailure, isProviderId, type ProviderId, type SearchProviderId } from './types.ts';
import { usageReport, type UsageCount } from './usage.ts';

export type SearchProviderStatus = {
  id: ProviderId;
  label: string;
  /** The first variable name — the thing the person scans for in the key list. */
  keyName: string;
    /** This provider doesn't need a key: it's always available. */
  keyless: boolean;
  /**
   * There's no key, but none is needed: the same search already works via a keyless
   * provider (You.com MCP). The panel shows this instead of «нет ключа».
   */
  optional: boolean;
  /** A note under the name: what the provider is good at and what it can't do. */
  note: string | null;
  present: boolean;
  current: boolean;
  bannedUntil: string | null;
  banReason: BanReason | null;
  broken: boolean;
  fails: number;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Key successes and failures over the stats window: the panel shows the sum. */
  usage: UsageCount;
};

export type SearchStatus = {
  /** Search. */
  current: ProviderId | null;
  providers: SearchProviderStatus[];
  /** Page extraction: its own current one and its own set of providers. */
  fetch: {
    current: ProviderId | null;
    providers: SearchProviderStatus[];
  };
  /** Stats window: seven days, including today (in UTC). */
  usage: { days: number; since: string; through: string };
};

type RowProvider = {
  id: ProviderId;
  label: string;
  keyNames: string[];
  keyless?: boolean;
  keylessTwin?: ProviderId;
  requires?: string[];
};

/** What to show under the name: for a free provider, its limit and bounds. */
const KEYLESS_NOTE = '100 поисков в сутки без регистрации; страницы читать не умеет.';
const OPTIONAL_NOTE = 'Ключа нет, и он не нужен: поиск идёт через бесплатный MCP. Ключ даёт больше квоты и чтение страниц.';

function rows(
  config: IcarusConfig,
  order: readonly ProviderId[],
  providers: Record<string, RowProvider | undefined>,
  current: ProviderId | null,
  saved: Record<string, ProviderState>,
  usage: Partial<Record<ProviderId, UsageCount>>,
  now: number,
): SearchProviderStatus[] {
  return order
    .map((id) => providers[id])
    .filter((provider): provider is RowProvider => provider !== undefined)
    .map((provider) => {
      const state = saved[provider.id];
      const banned = state !== undefined && isBanned(state, now);
      const present = providerReady(config, provider);
      const twin = provider.keylessTwin === undefined ? undefined : providers[provider.keylessTwin];
      const optional = !present && twin !== undefined && providerEnabled(config, twin);
      return {
        id: provider.id,
        label: provider.label,
        keyName: provider.keyNames[0] ?? '',
        keyless: provider.keyless === true,
        optional,
        note: provider.keyless === true ? KEYLESS_NOTE : optional ? OPTIONAL_NOTE : null,
        present,
        current: current === provider.id,
        bannedUntil: banned ? (state?.bannedUntil ?? null) : null,
        banReason: banned ? (state?.banReason ?? null) : null,
        broken: state?.broken === true,
        fails: state?.fails ?? 0,
        lastError: state?.lastError ?? null,
        lastErrorAt: state?.lastErrorAt ?? null,
        usage: usage[provider.id] ?? { ok: 0, fail: 0 },
      } satisfies SearchProviderStatus;
    });
}

/** State for the panel. We don't hand out keys even partially — only "set/not set". */
export function searchStatus(config: IcarusConfig, now: number = Date.now()): SearchStatus {
  const state = readRouterState(stateFile(config));
  const usage = usageReport(config, now);
  return {
    current: state.current,
    // The rating is the order in which the router tries providers: the same in the panel.
    providers: rows(config, RATING, PROVIDERS, state.current, state.providers, usage.search, now),
    fetch: {
      current: state.fetch?.current ?? null,
      providers: rows(
        config,
        FETCH_RATING,
        FETCH_PROVIDERS,
        state.fetch?.current ?? null,
        state.fetch?.providers ?? {},
        usage.fetch,
        now,
      ),
    },
    usage: { days: usage.days, since: usage.since, through: usage.through },
  };
}

/** A provider by environment variable name: editing a key lifts the quarantine. */
export function providerForKey(name: string): ProviderId | null {
  // Search and extraction keys overlap, and Cloudflare also has an account id: editing
  // any of them must lift the provider's quarantine.
  for (const provider of [...Object.values(PROVIDERS), ...Object.values(FETCH_PROVIDERS)]) {
    if (provider.keyNames.includes(name)) return provider.id;
    if ('requires' in provider && provider.requires?.includes(name)) return provider.id;
  }
  return null;
}

/** Lift the quarantine and the "broken" flag: the key was changed or the panel checked manually. */
export async function clearProviderState(config: IcarusConfig, id: ProviderId): Promise<void> {
  await mutateRouterState(stateFile(config), (state) => {
    // One key serves both capabilities: once fixed, we lift the quarantine everywhere.
    applySuccess(state, id, 'search');
    applySuccess(state, id, 'fetch');
  });
}

export type CheckResult = {
  ok: boolean;
  provider: ProviderId;
  ms: number;
  results: number;
  error: string | null;
};

/**
 * A check from the panel: a real search, not an "endpoint ping".
 *
 * Success lifts the quarantine and the flag; failure, conversely, sets them (and the
 * panel will honestly show exactly what the provider answered). We take the key from a
 * fresh secretEnv: the person may have just saved a new one.
 */
export async function checkProvider(
  config: IcarusConfig,
  id: ProviderId,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CheckResult> {
  if (!(id in PROVIDERS)) {
    return { ok: false, provider: id, ms: 0, results: 0, error: 'провайдер не умеет искать' };
  }
  const provider = PROVIDERS[id as SearchProviderId];
  const key = keyFor(config, provider);
  const now = options.now ?? (() => Date.now());
  const started = now();
  if (key === '' && provider.keyless !== true) {
    return { ok: false, provider: id, ms: 0, results: 0, error: 'ключ не задан' };
  }
  try {
    const results = await provider.search('проверка связи', 1, {
      key,
      fetch: options.fetch ?? fetch,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    await clearProviderState(config, id);
    return { ok: true, provider: id, ms: now() - started, results: results.length, error: null };
  } catch (error) {
    const failure =
      error instanceof SearchFailure
        ? error
        : new SearchFailure('network', error instanceof Error ? error.message : String(error));
    const candidates = configuredProviders(config);
    await mutateRouterState(stateFile(config), (state) => applyFailure(state, id, failure, now(), candidates));
    return { ok: false, provider: id, ms: now() - started, results: 0, error: failureText(failure) };
  }
}

function failureText(failure: SearchFailure): string {
  const body = failure.body.trim();
  return body === '' ? failure.message : `${failure.message}: ${body.slice(0, 200)}`;
}

export type FetchCheckResult = {
  ok: boolean;
  provider: ProviderId;
  ms: number;
  /** How many characters came: it's visible that the page was actually read. */
  chars: number;
  error: string | null;
};

/**
 * An extraction check: we pull example.com through the selected provider.
 * Success lifts the quarantine; a page failure doesn't ban (that's a property of the URL),
 * while a transport or money failure bans, like a regular request.
 */
export async function checkFetchProvider(
  config: IcarusConfig,
  id: ProviderId,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<FetchCheckResult> {
  const provider = FETCH_PROVIDERS[id];
  const now = options.now ?? (() => Date.now());
  const started = now();
  if (provider === undefined) {
    return { ok: false, provider: id, ms: 0, chars: 0, error: 'провайдер не умеет извлекать страницы' };
  }
  const key = keyFor(config, provider);
  if (!providerReady(config, provider)) {
    return {
      ok: false,
      provider: id,
      ms: 0,
      chars: 0,
      error: key === '' ? 'ключ не задан' : `не заданы обязательные секреты: ${(provider.requires ?? []).join(', ')}`,
    };
  }
  try {
    const result = await provider.fetch('https://example.com', {
      key,
      fetch: options.fetch ?? fetch,
      signal: AbortSignal.timeout(FETCH_ATTEMPT_TIMEOUT_MS),
      maxChars: 2_000,
      secret: (name) => secretFor(config, name),
    });
    await mutateRouterState(stateFile(config), (state) => applySuccess(state, id, 'fetch'));
    return { ok: true, provider: id, ms: now() - started, chars: result.text.length, error: null };
  } catch (error) {
    const failure =
      error instanceof SearchFailure
        ? error
        : new SearchFailure('network', error instanceof Error ? error.message : String(error));
    if (failure.kind !== 'page') {
      const candidates = configuredFetchProviders(config);
      await mutateRouterState(stateFile(config), (state) =>
        applyFailure(state, id, failure, now(), candidates, 'fetch'),
      );
    }
    return { ok: false, provider: id, ms: now() - started, chars: 0, error: failureText(failure) };
  }
}

/** For panel routes: "is this really a provider id?". */
export function asProviderId(value: string): ProviderId | null {
  return isProviderId(value) ? value : null;
}
