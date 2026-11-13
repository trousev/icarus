// Container fingerprint: the thing that determines its contents.
// The image, mounts, and environment are now shared by all (see config.yaml), so
// the fingerprint is one for the whole service: change the image or a mount and all
// containers are recreated, not just the one that happened to come first.
import { createHash } from 'node:crypto';
import { CONTAINER_PATHS, userContainer, type IcarusConfig, type UserConfig } from '../config.ts';
import { languageName, languageOf } from '../profile.ts';

export const LABEL_MANAGED = 'icarus.managed';
export const LABEL_USER = 'icarus.user';
export const LABEL_SPEC = 'icarus.spec';

/** Model tiers travel into the container as variables — the escalation extension reads them. */
export function modelTierEnv(config: IcarusConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const model of config.models) {
    if (!model.tier) continue;
    env[`ICARUS_MODEL_${model.tier.toUpperCase()}`] = `${model.provider}/${model.id}:${model.thinking ?? 'low'}`;
  }
  return env;
}

/**
 * Container environment: model tiers and the shared values from config.yaml, plus the
 * person's own: who they are and where the control panel lives. Personal values go last:
 * they must not be overridden by the shared env — otherwise one person would answer for another.
 */
export function containerEnv(config: IcarusConfig, user: UserConfig): Record<string, string> {
  return {
    ...modelTierEnv(config),
    ...config.env,
    // Extensions read this path themselves so they don't hardcode the layout a second time.
    ICARUS_HOME: CONTAINER_PATHS.home,
    ICARUS_USER_ID: user.id,
    ICARUS_URL: config.url,
    // Global artifact library: both MCP and folder-guard read this path.
    ICARUS_ARTIFACTS_DIR: CONTAINER_PATHS.artifacts,
    // Where skill_writer puts personal skills: the same directory pi and the panel read.
    ICARUS_SKILLS_DIR: `${CONTAINER_PATHS.piAgent}/skills`,
    // Conversation language — as a full name (English, Russian). The language extension sends it
    // as a separate system message: inside a large Russian prompt the language rule
    // did not hold (measurement — tools/persona-flywheel/smoke-language.mjs).
    ICARUS_LANGUAGE: languageName(languageOf(config, user)),
  };
}

/** Everything that affects the container's contents but is not a secret. */
export function specFor(config: IcarusConfig, user: UserConfig): string {
  const env = containerEnv(config, user);
  const payload = JSON.stringify({
    image: config.docker.image,
    network: config.docker.network ?? null,
    // DNS is part of the container's contents: change the servers and the old containers must be
    // recreated, otherwise they stay on the previous resolver.
    dns: config.docker.dns ?? [],
    // dataDir is not "just a setting": the paths of personal memory, sessions, and
    // pi-agent are derived from it and mounted into the container. Change dataDir and the
    // containers must be recreated, otherwise they stay mounted to the old directories while
    // the service writes to the new ones. This is exactly what we tripped over when moving the config.
    dataDir: config.dataDir,
    // The layout inside the container is also contents: our directories moved to
    // /workspace/.icarus, and without this field the old containers would keep the previous
    // mount points while the service would report paths that don't exist there.
    layout: CONTAINER_PATHS,
    // Maple is the only external tree in the container; its path is also part of the contents.
    mapleDir: config.mapleDir ?? null,
    // The code of built-in MCPs is mounted from the repository: an old container without this
    // mount won't start the artifact server, so the list is part of the fingerprint.
    tools: [
      'artifacts-mcp',
      'opds-mcp',
      'arr-mcp',
      'video-blog-mcp',
      ...(config.mapleDir === undefined ? [] : ['maple-mcp']),
    ],
    // Global artifact library — a separate /artifacts mount.
    artifacts: true,
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export function containerNameFor(config: IcarusConfig, user: UserConfig): string {
  return userContainer(config, user);
}
