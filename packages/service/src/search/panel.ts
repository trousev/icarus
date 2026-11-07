// Что панель знает о поиске: кто текущий, кто в карантине, у кого сломан ключ.
//
// Отдельный слой нужен, чтобы страница «Ключи» не собирала состояние по кусочкам:
// она получает готовый список, а кнопка «Проверить» дергает провайдера напрямую и
// снимает карантин только если тот действительно ответил.
import type { IcarusConfig } from '../config.ts';
import { PROVIDERS } from './providers.ts';
import { ATTEMPT_TIMEOUT_MS, RATING, applyFailure, applySuccess, configuredProviders, keyFor } from './router.ts';
import { isBanned, mutateRouterState, readRouterState, stateFile, type BanReason } from './state.ts';
import { SearchFailure, isProviderId, type ProviderId } from './types.ts';

export type SearchProviderStatus = {
  id: ProviderId;
  label: string;
  /** Первое имя переменной — то, что человек ищет глазами в списке ключей. */
  keyName: string;
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
  current: ProviderId | null;
  providers: SearchProviderStatus[];
};

/** Состояние для панели. Ключи не отдаём даже частично — только «задан/нет». */
export function searchStatus(config: IcarusConfig, now: number = Date.now()): SearchStatus {
  const state = readRouterState(stateFile(config));
  const providers = Object.values(PROVIDERS)
    .map((provider) => {
      const saved = state.providers[provider.id];
      return {
        id: provider.id,
        label: provider.label,
        keyName: provider.keyNames[0] ?? '',
        present: keyFor(config, provider) !== '',
        current: state.current === provider.id,
        bannedUntil: saved && isBanned(saved, now) ? saved.bannedUntil : null,
        banReason: saved && isBanned(saved, now) ? saved.banReason : null,
        broken: saved?.broken === true,
        fails: saved?.fails ?? 0,
        lastError: saved?.lastError ?? null,
        lastErrorAt: saved?.lastErrorAt ?? null,
      } satisfies SearchProviderStatus;
    })
    // Рейтинг — порядок, в котором роутер пробует провайдеров: в панели он же.
    .sort((a, b) => RATING.indexOf(a.id) - RATING.indexOf(b.id));
  return { current: state.current, providers };
}

/** Провайдер по имени переменной окружения: правка ключа снимает карантин. */
export function providerForKey(name: string): ProviderId | null {
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.keyNames.includes(name)) return provider.id;
  }
  return null;
}

/** Снять карантин и флаг «сломан»: ключ сменили или панель проверила вручную. */
export async function clearProviderState(config: IcarusConfig, id: ProviderId): Promise<void> {
  await mutateRouterState(stateFile(config), (state) => applySuccess(state, id));
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
  const provider = PROVIDERS[id];
  const key = keyFor(config, provider);
  const now = options.now ?? (() => Date.now());
  const started = now();
  if (key === '') {
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

/** Для роутов панели: «это правда id провайдера?». */
export function asProviderId(value: string): ProviderId | null {
  return isProviderId(value) ? value : null;
}
