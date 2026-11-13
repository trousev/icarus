// Reconciliation plan: what to do with containers that already exist on the host.
// A pure function — decisions are made here, and docker/manager executes them.
import type { IcarusConfig, UserConfig } from '../config.ts';
import { containerNameFor, specFor } from './spec.ts';

export type ManagedContainer = {
  name: string;
  user: string | null;
  spec: string | null;
  running: boolean;
};

export type ReconciliationPlan = {
  /** Fingerprint matched, the container is running — do not touch. */
  keep: string[];
  /** Fingerprint matched, but the container is stopped — start it. */
  start: string[];
  /** Fingerprint diverged (image, mounts, environment) — delete and recreate. */
  recreate: string[];
  /** The person is no longer in the config — stop it. */
  stop: string[];
  /** The container does not exist yet — create it. */
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
    // Containers created before labels appeared come with spec = null and fall
    // into recreation — that is how migration to the new format happens.
    if (container.spec !== specFor(config, user)) {
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

/** Is there anything in the plan besides "leave as is". */
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
