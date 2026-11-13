// Re-reading settings without restarting the service.
//
// Keys are edited in the panel and live in two places: .env (the working file, also read by
// docker compose) and keys.json (panel settings, which are stronger and survive a deploy).
// You save a key — the service must see it now, not starting from the next restart:
// otherwise "saved" in the panel means "maybe, someday".
//
// The config in the service is shared: the session registry, the bot, the HTTP server and the panel hold it.
// So re-reading doesn't create a new object but replaces the contents of the old one —
// references that someone already holds stay valid.
import fs from 'node:fs';
import { DEFAULT_CONFIG_PATH, ENV_FILE, PROVIDER_ENV, loadConfig, type IcarusConfig } from './config.ts';
import { effectiveSecrets, fullCatalog, readEnvFile, readKeysStore, type KeysStore } from './keys.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';

/** What .env put into the process last time: to remove stale values rather than accumulate them. */
let fileOwned = new Map<string, string>();

/** Names the service is at all willing to pass into the pi process. */
function knownSecretNames(): Set<string> {
  const names = new Set<string>(Object.values(PROVIDER_ENV));
  for (const key of fullCatalog([])) names.add(key.name);
  return names;
}

export type RuntimeEnv = {
  /** Environment for loadConfig: file + panel settings on top of process.env. */
  env: NodeJS.ProcessEnv;
  /** What goes into the pi process: only keys and settings, not the whole PATH. */
  secrets: Record<string, string>;
  store: KeysStore;
  fileVars: Record<string, string>;
};

/**
 * Environment by layers: base (process environment) → .env → panel settings.
 * A separate function is needed by the panel: before writing a key it checks that the config
 * with the new value still parses, and does it on a copy rather than on the live env.
 */
export function envWithStore(
  base: NodeJS.ProcessEnv,
  fileVars: Record<string, string>,
  store: KeysStore,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(fileVars)) {
    if (!env[name]) env[name] = value;
  }
  for (const name of store.removed) delete env[name];
  for (const [name, value] of Object.entries(store.values)) {
    if (value.trim() === '') delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Assemble the environment from three layers.
 *
 * process.env is stronger than .env — just like docker compose with env_file and as
 * loadEnvFile expects: an empty variable from CI shouldn't overwrite the file's working value.
 * And panel settings are stronger than both — otherwise a key saved in the panel wouldn't
 * survive the first deploy that pours GitHub secrets back into .env.
 */
export function loadRuntimeEnv(
  options: { envFile?: string; keysFile?: string; base?: NodeJS.ProcessEnv } = {},
): RuntimeEnv {
  const envFile = options.envFile ?? ENV_FILE;
  const base = options.base ?? process.env;

  // The previous .env is no longer the owner of its values: remove what it put there,
  // if the person (or the panel) hasn't overridden anything since.
  for (const [name, value] of fileOwned) {
    if (base[name] === value) delete base[name];
  }

  let fileVars: Record<string, string>;
  try {
    fileVars = readEnvFile(envFile);
  } catch (error) {
    log.warn('не удалось прочитать .env — работаю на окружении и настройках панели', {
      file: envFile,
      error: String(error),
    });
    fileVars = {};
  }

  const store = readKeysStore(options.keysFile);
  const env = envWithStore(base, fileVars, store);
  fileOwned = new Map(Object.entries(fileVars));

  // The service also reads process.env directly (the MCP proxy container name, DOCKER_HOST).
  // So when we assemble the production environment, we bring the process to the same shape:
  // otherwise a key set in the panel would be seen only by loadConfig, not by the rest of the code.
  const sync = options.base === undefined || options.base === process.env;
  if (sync) {
    for (const name of Object.keys(process.env)) {
      if (!(name in env)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) process.env[name] = value;
    }
  }

  const secrets = effectiveSecrets(fileVars, store);
  // A removed key must be explicitly blanked in the pi process: the container environment still
  // remembers the old value from .env, and without an explicit empty variable the extension
  // would keep using it.
  for (const name of store.removed) secrets[name] = '';
  // A key exported into the environment (local run without .env) must also
  // reach pi: otherwise the service sees it but the container doesn't.
  const known = knownSecretNames();
  for (const [name, value] of Object.entries(env)) {
    if (!known.has(name) || value === undefined || value.trim() === '') continue;
    if (store.removed.includes(name)) continue;
    if (!(name in secrets)) secrets[name] = value;
  }

  return { env, secrets, store, fileVars };
}

/** Replace the config contents entirely: references to the object stay valid. */
export function replaceConfig(target: IcarusConfig, source: IcarusConfig): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in source)) delete record[key];
  }
  Object.assign(target, source);
}

/**
 * The environment as it will be after writing: the panel validates the config on this copy
 * and only then writes the file. Previous .env values are subtracted here — just like
 * in loadRuntimeEnv, otherwise validation would see something different from what the service sees.
 */
export function previewEnv(
  store: KeysStore,
  fileVars: Record<string, string>,
  options: { base?: NodeJS.ProcessEnv } = {},
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  for (const [name, value] of fileOwned) {
    if (clean[name] === value) delete clean[name];
  }
  return envWithStore(clean, fileVars, store);
}

export type ReloadResult = {
  users: number;
  keys: number;
  /** People whose environment didn't get rewritten: the key is saved but didn't reach the person. */
  warnings: string[];
};

/**
 * Re-read .env, keys.json and config.yaml and distribute the new values across people.
 *
 * pi reads auth.json and mcp.json when a session starts, so after rewriting the
 * files the session registry must mark the resources as updated (the caller does this:
 * runtime has no registry). Here — only files and the live config.
 */
export function reloadRuntime(config: IcarusConfig): ReloadResult {
  const state = loadRuntimeEnv({ envFile: config.envFile, keysFile: config.keysFile });
  const path = config.configPath ?? DEFAULT_CONFIG_PATH;
  const fresh = loadConfig(path, state.env);
  fresh.secretEnv = state.secrets;
  // Settings paths don't come from YAML: the caller sets them (or the defaults), and
  // they must not be lost on re-reading — otherwise the next saveKey would miss the
  // test's temporary file.
  if (config.envFile !== undefined) fresh.envFile = config.envFile;
  if (config.keysFile !== undefined) fresh.keysFile = config.keysFile;
  replaceConfig(config, fresh);

  const warnings: string[] = [];
  for (const user of config.users) {
    try {
      prepareUser(config, user);
    } catch (error) {
      warnings.push(`${user.id}: ${error instanceof Error ? error.message : String(error)}`);
      log.warn('окружение человека не обновилось после перечитывания ключей', {
        user: user.id,
        error: String(error),
      });
    }
  }

  log.info('ключи и конфиг перечитаны', {
    users: config.users.length,
    keys: Object.keys(state.secrets).length,
    warnings: warnings.length,
  });
  return { users: config.users.length, keys: Object.keys(state.secrets).length, warnings };
}

/** Whether .env exists: the panel shows this so a person understands where the keys came from. */
export function envFileExists(file: string = ENV_FILE): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
