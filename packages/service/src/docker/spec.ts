// Отпечаток контейнера: то, что определяет его содержимое.
// Образ, маунты и окружение теперь общие для всех (см. config.yaml), поэтому
// отпечаток один на весь сервис: поменял образ или маунт — пересоздаются все
// контейнеры, а не только тот, который первым попал под руку.
import { createHash } from 'node:crypto';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';

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

/** Окружение контейнера целиком: уровни моделей плюс заданное в config.yaml. */
export function containerEnv(config: IcarusConfig): Record<string, string> {
  return { ...modelTierEnv(config), ...config.env };
}

/** Всё, что влияет на содержимое контейнера, но не является секретом. */
export function specFor(config: IcarusConfig): string {
  const mounts = [...config.mounts]
    .map((mount) => `${mount.host}:${mount.container}:${mount.mode ?? 'rw'}`)
    .sort();
  const env = containerEnv(config);
  const payload = JSON.stringify({
    image: config.docker.image,
    network: config.docker.network ?? null,
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
