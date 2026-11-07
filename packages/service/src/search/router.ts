// Сам роутер: кого звать, кому верить, кого отправить в карантин.
//
// Правила простые и намеренно грубые — API квот у половины провайдеров нет:
//  - первый по рейтингу, кто не в карантине, становится текущим;
//  - отказ или таймаут — пять минут карантина и запрос к следующему;
//  - 402/429 «про кредиты» — сутки: за сутки квота, скорее всего, вернётся;
//  - 50 отказов подряд — «ключ сломан» и семь дней, чтобы человек проверил;
//  - успех снимает всё: и карантин, и флаг, и счётчик.
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
import type { IcarusConfig } from '../config.ts';

/**
 * Рейтинг поиска: сверху — те, кто отдаёт выдачу Google или ищет лучше всех.
 * Cloudflare сюда не входит: он умеет только извлекать страницы.
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
/** Обычный сбой: пять минут — достаточно, чтобы провайдер очухался. */
export const ERROR_BAN_MS = 5 * 60_000;
/** Кончились кредиты: сутки, раньше проверять бессмысленно. */
export const CREDIT_BAN_MS = 24 * 60 * 60_000;
/** «Ключ сломан»: семь дней, но первый же успех снимет флаг. */
export const BROKEN_BAN_MS = 7 * 24 * 60 * 60_000;
/** Сколько отказов подряд считать сломанным ключом. */
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
  /** Подменяемое время: тесты не должны ждать пять минут. */
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
};

/** Значение настройки: панель (secretEnv) сильнее .env, .env сильнее окружения. */
export function secretFor(config: IcarusConfig, name: string): string {
  return config.secretEnv?.[name]?.trim() || config.env[name]?.trim() || process.env[name]?.trim() || '';
}

/** Ключ провайдера — первая непустая переменная из его списка. */
export function keyFor(config: IcarusConfig, provider: { keyNames: string[] }): string {
  for (const name of provider.keyNames) {
    const value = secretFor(config, name);
    if (value) return value;
  }
  return '';
}

/** Как выключить бесплатного провайдера без ключа. */
const FREE_OFF = /^(off|false|no|none|0)$/i;

/**
 * Участвует ли провайдер в ротации.
 *
 * Обычному нужен ключ: без ключа пробовать нечего — это не бан, а пропуск.
 * Бесплатный MCP You.com ключа не требует и включён по умолчанию — поиск
 * работает даже на пустом .env. Выключается одной строкой: ICARUS_SEARCH_FREE=off.
 */
export function providerEnabled(
  config: IcarusConfig,
  provider: { keyless?: boolean; keyNames: string[] },
): boolean {
  if (provider.keyless === true) return !FREE_OFF.test(secretFor(config, 'ICARUS_SEARCH_FREE'));
  return keyFor(config, provider) !== '';
}

/**
 * Готов ли провайдер: участвует в ротации и все обязательные секреты заданы.
 * Обязательные нужны там, где одного ключа мало (Cloudflare: аккаунт + токен).
 */
export function providerReady(
  config: IcarusConfig,
  provider: { keyless?: boolean; keyNames: string[]; requires?: string[] },
): boolean {
  if (!providerEnabled(config, provider)) return false;
  return (provider.requires ?? []).every((name) => secretFor(config, name) !== '');
}

/** Провайдеры, которых можно звать: с ключом или без него, если так задумано. */
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

/** Первый непопробованный и не забаненный: текущий — вперёд, дальше по рейтингу. */
function chooseAttempt(
  state: RouterState,
  candidates: readonly Candidate[],
  tried: Set<ProviderId>,
  now: number,
  scope: Capability = 'search',
): ProviderId | null {
  const free = availableIds(state, candidates, now, scope).filter((id) => !tried.has(id));
  if (free.length === 0) return null;
  // «Сломанный» ключ после семи дней карантина проверяем сами, одним настоящим
  // запросом: ответил — флаг снимается, нет — снова семь дней. Происходит это
  // один раз на провайдера, а не на каждый запрос.
  const providers = scopeProviders(state, scope);
  const revived = free.find((id) => providers[id]?.broken === true);
  if (revived !== undefined) return revived;
  const current = scopeCurrent(state, scope);
  if (current !== null && free.includes(current)) return current;
  return free[0] ?? null;
}

function banFor(kind: SearchFailure['kind'], id: ProviderId, now: number): { reason: BanReason; ms: number } {
  if (kind !== 'credits') return { reason: 'error', ms: ERROR_BAN_MS };
  // Суточную квоту незачем держать ровные сутки: ждём её сброса по календарю.
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
 * Записать отказ: счётчик, карантин, при 50 — «ключ сломан».
 * Если отвалился текущий — сразу выбрать нового текущего, чтобы следующий
 * запрос не начинал с того, кого мы только что отправили в карантин.
 *
 * scope нужен, потому что у извлечения страниц свой «текущий» и свои карантины.
 * Отказ страницы (kind === 'page') сюда не попадает — это свойство URL.
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

/** Успех означает «провайдер жив»: снимаем карантин, флаг и счётчик отказов. */
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

/** Собрать снимок для сравнения: надо ли вообще писать успех в файл. */
export function hasFaults(state: RouterState, id: ProviderId, scope: Capability = 'search'): boolean {
  const provider = scopeProviders(state, scope)[id];
  return !provider || provider.fails > 0 || provider.bannedUntil !== null || provider.broken;
}

/**
 * Главный вход: найти живого провайдера и вернуть его результаты.
 *
 * Пробуем по очереди, пока кто-нибудь не ответит. Каждый отказ сразу пишется в
 * состояние: следующий запрос (даже параллельный) уже не пойдёт к упавшему.
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

  // Текущего нет, у него больше нет ключа или он в карантине — выбираем первого
  // живого по рейтингу. Пока он жив, сам по себе текущий не меняется.
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
      return { ok: true, provider: id, results, tried, current: after.current };
    } catch (error) {
      // Клиент ушёл — это не вина провайдера, банить нельзя.
      if (options.signal?.aborted) break;
      const failure = asFailure(error);
      await mutateRouterState(file, (next) => applyFailure(next, id, failure, now(), candidates));
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
