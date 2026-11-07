// Что панель знает о поиске: кто текущий, кто в карантине, у кого сломан ключ.
//
// Отдельный слой нужен, чтобы страница «Ключи» не собирала состояние по кусочкам:
// она получает готовый список, а кнопка «Проверить» дергает провайдера напрямую и
// снимает карантин только если тот действительно ответил.
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

export type SearchProviderStatus = {
  id: ProviderId;
  label: string;
  /** Первое имя переменной — то, что человек ищет глазами в списке ключей. */
  keyName: string;
  /** Ключ этому провайдеру не нужен: он доступен всегда. */
  keyless: boolean;
  /**
   * Ключа нет, но он и не нужен: тот же поиск уже работает через провайдера
   * без ключа (You.com MCP). Панель показывает это вместо «нет ключа».
   */
  optional: boolean;
  /** Пояснение под названием: чем провайдер хорош и чего не умеет. */
  note: string | null;
  present: boolean;
  current: boolean;
  bannedUntil: string | null;
  banReason: BanReason | null;
  broken: boolean;
  fails: number;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type SearchStatus = {
  /** Поиск. */
  current: ProviderId | null;
  providers: SearchProviderStatus[];
  /** Извлечение страниц: свой текущий и свой набор провайдеров. */
  fetch: {
    current: ProviderId | null;
    providers: SearchProviderStatus[];
  };
};

type RowProvider = {
  id: ProviderId;
  label: string;
  keyNames: string[];
  keyless?: boolean;
  keylessTwin?: ProviderId;
  requires?: string[];
};

/** Что показать под названием: у бесплатного провайдера — его лимит и пределы. */
const KEYLESS_NOTE = '100 поисков в сутки без регистрации; страницы читать не умеет.';
const OPTIONAL_NOTE = 'Ключа нет, и он не нужен: поиск идёт через бесплатный MCP. Ключ даёт больше квоты и чтение страниц.';

function rows(
  config: IcarusConfig,
  order: readonly ProviderId[],
  providers: Record<string, RowProvider | undefined>,
  current: ProviderId | null,
  saved: Record<string, ProviderState>,
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
      } satisfies SearchProviderStatus;
    });
}

/** Состояние для панели. Ключи не отдаём даже частично — только «задан/нет». */
export function searchStatus(config: IcarusConfig, now: number = Date.now()): SearchStatus {
  const state = readRouterState(stateFile(config));
  return {
    current: state.current,
    // Рейтинг — порядок, в котором роутер пробует провайдеров: в панели он же.
    providers: rows(config, RATING, PROVIDERS, state.current, state.providers, now),
    fetch: {
      current: state.fetch?.current ?? null,
      providers: rows(config, FETCH_RATING, FETCH_PROVIDERS, state.fetch?.current ?? null, state.fetch?.providers ?? {}, now),
    },
  };
}

/** Провайдер по имени переменной окружения: правка ключа снимает карантин. */
export function providerForKey(name: string): ProviderId | null {
  // Ключи поиска и извлечения пересекаются, а у Cloudflare ещё и account id:
  // правка любого из них должна снимать карантин с провайдера.
  for (const provider of [...Object.values(PROVIDERS), ...Object.values(FETCH_PROVIDERS)]) {
    if (provider.keyNames.includes(name)) return provider.id;
    if ('requires' in provider && provider.requires?.includes(name)) return provider.id;
  }
  return null;
}

/** Снять карантин и флаг «сломан»: ключ сменили или панель проверила вручную. */
export async function clearProviderState(config: IcarusConfig, id: ProviderId): Promise<void> {
  await mutateRouterState(stateFile(config), (state) => {
    // Ключ один на обе возможности: починили — снимаем карантин везде.
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
 * Проверка из панели: настоящий поиск, а не «пинг эндпоинта».
 *
 * Успех снимает карантин и флаг, отказ — наоборот, ставит (и панель честно
 * покажет, что именно ответил провайдер). Ключ берём из свежего secretEnv:
 * человек мог только что сохранить новый.
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
  /** Сколько знаков пришло: видно, что страница реально прочиталась. */
  chars: number;
  error: string | null;
};

/**
 * Проверка извлечения: тянем example.com через выбранного провайдера.
 * Успех снимает карантин; отказ страницы не банит (это свойство URL), а
 * транспортный или денежный — банит, как обычный запрос.
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

/** Для роутов панели: «это правда id провайдера?». */
export function asProviderId(value: string): ProviderId | null {
  return isProviderId(value) ? value : null;
}
