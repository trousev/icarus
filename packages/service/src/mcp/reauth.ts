// Когда MCP просит повторный вход, человек должен получить ссылку, а не
// «invalid_token» в трассировке. Здесь — одна на всех логика: по имени
// инструмента, ошибке и (если есть) reauth_url из ответа прокси собрать
// человеческое уведомление со ссылкой на карточку MCP в панели.
import type { IcarusConfig } from '../config.ts';
import { listVisible, readStore } from './registry.ts';

/** Ссылка на карточку сервера в панели: подсветит и прокрутит к ней. */
export function mcpReauthUrl(config: IcarusConfig, serverId: string): string {
  const base = config.url.replace(/\/+$/, '');
  return `${base}/panel/mcp?server=${encodeURIComponent(serverId)}`;
}

export function serverIdFromReauthUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('server');
  } catch {
    return null;
  }
}

/** Текст из результата тула: строка, content-блоки или JSON-строка с ними. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n');
}

export function toolResultText(result: unknown): string {
  if (typeof result === 'string') {
    const text = result.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        const nested = toolResultText(parsed);
        if (nested && nested !== text) return nested;
      } catch {
        // это просто текст, не JSON
      }
    }
    return result;
  }
  if (Array.isArray(result)) return textOf(result);
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) return textOf(content);
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return '';
}

/** Похоже ли это на «токен протух / нужен вход», а не на сетевую ошибку. */
export function isMcpAuthFailure(toolName: string, isError: boolean, text: string): boolean {
  if (!isError || !toolName.startsWith('mcp_')) return false;
  if (/reauth_url/i.test(text)) return true;
  return /invalid_token|authentication failed|unauthorized|authorization required|access token.*(?:expired|invalid)|(?:expired|invalid).*access token|\b401\b/i.test(
    text,
  );
}

/** Адрес реавторизации из тела ошибки прокси, если он там есть. */
export function reauthUrlFromText(text: string): string | null {
  const direct = /"reauth_url"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const escaped = /\\"reauth_url\\"\s*:\s*\\"([^"\\]+)\\"/.exec(text)?.[1];
  const bare = /https?:\/\/[^\s"'<>]+\/panel\/mcp\?server=[^\s"'<>]+/.exec(text)?.[0];
  return (direct ?? escaped ?? bare)?.replace(/\\\//g, '/') ?? null;
}

/** id видимых серверов: по ним разбираем `mcp_<сервер>_<инструмент>`. */
function visibleServerIds(config: IcarusConfig, userId: string): string[] {
  try {
    return listVisible(config, readStore(config), userId).servers.map((server) => server.id);
  } catch {
    return [];
  }
}

function serverName(config: IcarusConfig, userId: string, id: string): string {
  try {
    const store = readStore(config);
    return store.servers[id]?.name ?? id;
  } catch {
    return id;
  }
}

/** pi заменяет в именах тулов всё, кроме букв, цифр и подчёркивания. */
function sanitized(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
}

export function serverIdFromTool(toolName: string, ids: string[]): string | null {
  if (!toolName.startsWith('mcp_')) return null;
  const rest = toolName.slice(4).toLowerCase();
  for (const id of ids) {
    if (rest.startsWith(`${sanitized(id)}_`)) return id;
  }
  return null;
}

export type McpReauthNotice = {
  /** id сервера: по нему строятся ссылки и дедуп. */
  server: string;
  /** Человеческое имя сервера. */
  name: string;
  url: string;
};

/**
 * Разбирает результат тула и, если это отказ авторизации, говорит, куда вести
 * человека. Возвращает null для обычных ошибок (таймаут, 500, сеть).
 */
export function mcpReauthNotice(input: {
  config: IcarusConfig;
  userId: string;
  toolName: string;
  args?: Record<string, unknown>;
  isError: boolean;
  result: unknown;
}): McpReauthNotice | null {
  const text = toolResultText(input.result);
  if (!isMcpAuthFailure(input.toolName, input.isError, text)) return null;

  const fromText = reauthUrlFromText(text);
  let server = fromText ? serverIdFromReauthUrl(fromText) : null;
  if (!server && input.toolName === 'mcp_connect' && typeof input.args?.name === 'string') {
    server = input.args.name;
  }
  if (!server) server = serverIdFromTool(input.toolName, visibleServerIds(input.config, input.userId));
  if (!server) return null;

  return {
    server,
    name: serverName(input.config, input.userId, server),
    url: fromText ?? mcpReauthUrl(input.config, server),
  };
}
