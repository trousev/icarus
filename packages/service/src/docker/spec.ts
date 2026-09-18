// Отпечаток контейнера пользователя: то, что определяет его личность.
// Если меняется образ, маунты или окружение — контейнер надо пересоздать,
// иначе он тихо живёт на старом образе (мы на это наступали).
import { createHash } from 'node:crypto';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';

export const LABEL_MANAGED = 'icarus.managed';
export const LABEL_USER = 'icarus.user';
export const LABEL_SPEC = 'icarus.spec';

/** Уровни моделей уезжают в контейнер переменными — их читает расширение эскалации. */
export function modelTierEnv(user: UserConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const model of user.models ?? []) {
    if (!model.tier) continue;
    env[`ICARUS_MODEL_${model.tier.toUpperCase()}`] = `${model.provider}/${model.id}:${model.thinking ?? 'off'}`;
  }
  return env;
}

/** Окружение контейнера целиком: уровни моделей плюс то, что задал человек. */
export function containerEnv(user: UserConfig): Record<string, string> {
  return { ...modelTierEnv(user), ...(user.env ?? {}) };
}

/** Всё, что влияет на содержимое контейнера, но не является секретом. */
export function specFor(config: IcarusConfig, user: UserConfig): string {
  const mounts = [...(user.mounts ?? [])]
    .map((mount) => `${mount.host}:${mount.container}:${mount.mode ?? 'rw'}`)
    .sort();
  const env = containerEnv(user);
  const payload = JSON.stringify({
    image: config.docker.image,
    network: config.docker.network ?? null,
    mounts,
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export function labelArgs(config: IcarusConfig, user: UserConfig): string[] {
  return [
    '--label',
    `${LABEL_MANAGED}=1`,
    '--label',
    `${LABEL_USER}=${user.id}`,
    '--label',
    `${LABEL_SPEC}=${specFor(config, user)}`,
  ];
}

export function containerNameFor(config: IcarusConfig, user: UserConfig): string {
  return userContainer(config, user);
}
