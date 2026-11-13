// When MCP asks for a re-login, the person must get a link, not
// «invalid_token» in a trace. Here — one shared logic: from the tool
// name, the error and (if present) the reauth_url from the proxy response, assemble
// a human-readable notice with a link to the MCP card in the panel.
import type { IcarusConfig } from '../config.ts';
import { listVisible, readStore } from './registry.ts';

/** Link to the server card in the panel: it will highlight and scroll to it. */
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

/** We accept only our own link from the error body: someone else's domain is phishing. */
function trustedReauthUrl(config: IcarusConfig, url: string): string | null {
  try {
    const own = new URL(config.url);
    const candidate = new URL(url);
    return own.origin === candidate.origin && candidate.pathname === '/panel/mcp' ? candidate.toString() : null;
  } catch {
    return null;
  }
}

/** Text from the tool result: a string, content blocks, or a JSON string with them. */
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
        // this is just text, not JSON
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

/** Whether this looks like "token expired / login needed" rather than a network error. */
export function isMcpAuthFailure(toolName: string, isError: boolean, text: string): boolean {
  if (!isError || !toolName.startsWith('mcp_')) return false;
  if (/reauth_url/i.test(text)) return true;
  return /invalid_token|authentication failed|unauthorized|authorization required|access token.*(?:expired|invalid)|(?:expired|invalid).*access token|\b401\b/i.test(
    text,
  );
}

/** Reauthorization address from the proxy error body, if it is there. */
export function reauthUrlFromText(text: string): string | null {
  const direct = /"reauth_url"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const escaped = /\\"reauth_url\\"\s*:\s*\\"([^"\\]+)\\"/.exec(text)?.[1];
  const bare = /https?:\/\/[^\s"'<>]+\/panel\/mcp\?server=[^\s"'<>]+/.exec(text)?.[0];
  return (direct ?? escaped ?? bare)?.replace(/\\\//g, '/') ?? null;
}

/** ids of visible servers: we parse `mcp_<server>_<tool>` by them. */
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

/** pi replaces everything in tool names except letters, digits and underscores. */
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
  /** server id: links and deduplication are built from it. */
  server: string;
  /** Human-readable server name. */
  name: string;
  url: string;
};

/**
 * Parses the tool result and, if this is an authorization refusal, says where to lead
 * the person. Returns null for ordinary errors (timeout, 500, network).
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
  const trusted = fromText ? trustedReauthUrl(input.config, fromText) : null;
  let server = trusted ? serverIdFromReauthUrl(trusted) : null;
  if (!server && input.toolName === 'mcp_connect' && typeof input.args?.name === 'string') {
    server = input.args.name;
  }
  if (!server) server = serverIdFromTool(input.toolName, visibleServerIds(input.config, input.userId));
  if (!server) return null;

  return {
    server,
    name: serverName(input.config, input.userId, server),
    url: trusted ?? mcpReauthUrl(input.config, server),
  };
}
