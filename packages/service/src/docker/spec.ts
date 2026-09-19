// Отпечаток контейнера: то, что определяет его содержимое.
// Образ, маунты и окружение теперь общие для всех (см. config.yaml), поэтому
// отпечаток один на весь сервис: поменял образ или маунт — пересоздаются все
// контейнеры, а не только тот, который первым попал под руку.
import { createHash } from 'node:crypto';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';
import { derivePanelKey } from '../../../extensions/lib/panel-link.ts';

export const LABEL_MANAGED = 'icarus.managed';
export const LABEL_USER = 'icarus.user';
export const LABEL_SPEC = 'icarus.spec';

/** Уровни моделей уезжают в контейнер переменными — их читает расширение эскалации. */
export function modelTierEnv(config: IcarusConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const model of config.models) {
    if (!model.tier) continue;
    env[`ICARUS_MODEL_${model.tier.toUpperCase()}`] = `${model.provider}/${model.id}:${model.thinking ?? 'off'}`;
  }
  return env;
}

/**
 * Окружение контейнера: уровни моделей и общее из config.yaml, а поверх — личное
 * человека: кто он и каким ключом подписывает ссылку на свою память. Личные
 * значения идут последними: их нельзя перебить общим env — иначе один человек
 * подписывал бы ссылки за другого.
 */
export function containerEnv(
  config: IcarusConfig,
  user: UserConfig,
  panelSecret: string,
): Record<string, string> {
  return {
    ...modelTierEnv(config),
    ...config.env,
    ICARUS_USER_ID: user.id,
    ICARUS_PANEL_KEY: derivePanelKey(panelSecret, user.id),
    ICARUS_PANEL_URL: config.panelUrl,
  };
}

/** Всё, что влияет на содержимое контейнера, но не является секретом. */
export function specFor(config: IcarusConfig, user: UserConfig, panelSecret: string): string {
  const mounts = [...config.mounts]
    .map((mount) => `${mount.host}:${mount.container}:${mount.mode ?? 'rw'}`)
    .sort();
  const env = containerEnv(config, user, panelSecret);
  const payload = JSON.stringify({
    image: config.docker.image,
    network: config.docker.network ?? null,
    // DNS — часть содержимого контейнера: сменили серверы, старые контейнеры надо
    // пересоздать, иначе они останутся на прежнем резолвере.
    dns: config.docker.dns ?? [],
    // dataDir — не «просто настройка»: из него выводятся пути личной памяти, сессий и
    // pi-agent, которые монтируются в контейнер. Сменили dataDir — контейнеры обязаны
    // пересоздаться, иначе они останутся примонтированными к старым каталогам, а сервис
    // будет писать в новые. Ровно на этом мы и споткнулись при переезде конфига.
    dataDir: config.dataDir,
    mounts,
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export function containerNameFor(config: IcarusConfig, user: UserConfig): string {
  return userContainer(config, user);
}
