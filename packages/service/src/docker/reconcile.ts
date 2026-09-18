// План реконсиляции: что делать с контейнерами, которые уже есть на хосте.
// Чистая функция — решения принимаются здесь, а исполняет их docker/manager.
import type { IcarusConfig, UserConfig } from '../config.ts';
import { containerNameFor, specFor } from './spec.ts';

export type ManagedContainer = {
  name: string;
  user: string | null;
  spec: string | null;
  running: boolean;
};

export type ReconciliationPlan = {
  /** Совпал отпечаток, контейнер работает — не трогаем. */
  keep: string[];
  /** Совпал отпечаток, но контейнер остановлен — поднять. */
  start: string[];
  /** Отпечаток разошёлся (образ, маунты, окружение) — удалить и создать заново. */
  recreate: string[];
  /** Человека больше нет в конфиге — остановить. */
  stop: string[];
  /** Контейнера ещё нет — создать. */
  create: string[];
};

export function planReconciliation(input: {
  config: IcarusConfig;
  users: UserConfig[];
  containers: ManagedContainer[];
}): ReconciliationPlan {
  const { config, users, containers } = input;
  const plan: ReconciliationPlan = { keep: [], start: [], recreate: [], stop: [], create: [] };

  for (const container of containers) {
    const user = users.find((candidate) => candidate.id === container.user);
    if (!user) {
      plan.stop.push(container.name);
      continue;
    }
    // Контейнеры, созданные до появления меток, приходят с spec = null и попадают
    // в пересоздание — так проходит миграция на новый формат.
    if (container.spec !== specFor(config)) {
      plan.recreate.push(container.name);
      continue;
    }
    if (container.running) plan.keep.push(container.name);
    else plan.start.push(container.name);
  }

  for (const user of users) {
    const name = containerNameFor(config, user);
    if (!containers.some((container) => container.name === name)) plan.create.push(user.id);
  }

  return plan;
}

/** Есть ли в плане хоть что-то, кроме «оставить как есть». */
export function planIsQuiet(plan: ReconciliationPlan): boolean {
  return (
    plan.start.length === 0 &&
    plan.recreate.length === 0 &&
    plan.stop.length === 0 &&
    plan.create.length === 0
  );
}

export function describePlan(plan: ReconciliationPlan): string {
  return [
    plan.keep.length ? `оставляю ${plan.keep.length}` : '',
    plan.start.length ? `поднимаю ${plan.start.length}` : '',
    plan.recreate.length ? `пересоздаю ${plan.recreate.length}` : '',
    plan.stop.length ? `останавливаю ${plan.stop.length}` : '',
    plan.create.length ? `создам при первом запросе: ${plan.create.length}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}
