// Checking an MCP server from the panel: bring it up, ask tools/list and honestly report
// what is wrong. It is not for beauty: the person adds a server and wants to know that
// it works BEFORE Icarus starts using it. For OAuth this is also a way
// to get the server's 401 hint before starting authorization.
//
// We check only HTTP transports. A stdio server lives in the person's container, and
// bringing it up from the service would mean running someone else's code on the host; pi will do that
// itself on the first connection.
import type { McpServerConfig } from '../config.ts';
import { tokenIsFresh } from './oauth.ts';
import { parseWwwAuthenticate, type FetchLike } from './oauth.ts';
import type { McpCredentials } from './registry.ts';

export type ProbeResult = {
  ok: boolean;
  /** Names of the tools the server returned. */
  tools?: string[];
  server?: { name?: string; version?: string; title?: string };
  protocolVersion?: string;
  /** The server requires authorization: the panel will offer to log in/paste a key. */
  needsAuth?: boolean;
  challenge?: { resourceMetadata?: string; scope?: string };
  /** stdio is not checked here. */
  unsupported?: boolean;
  error?: string;
};

type RpcResult = { id?: number | string; result?: Record<string, unknown>; error?: { message?: string } };

const PROBE_TIMEOUT_MS = 15_000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function authHeaders(server: McpServerConfig, credentials: McpCredentials | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...(server.headers ?? {}), ...(credentials?.headers ?? {}) };
  if (credentials?.oauth?.accessToken && tokenIsFresh(credentials.oauth)) {
    headers.Authorization = `Bearer ${credentials.oauth.accessToken}`;
  }
  return headers;
}

function initializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'icarus', version: '0.1.0' },
    },
  };
}

type SseEvent = { event: string; data: string };

/** Minimal SSE parsing: events are separated by an empty line, data is concatenated. */
class SseReader {
  private buffer = '';
  private decoder = new TextDecoder();
  private queue: SseEvent[] = [];
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private parse(): void {
    for (;;) {
      const index = this.buffer.search(/\r?\n\r?\n/);
      if (index === -1) return;
      const match = /\r?\n\r?\n/.exec(this.buffer.slice(index))?.[0] ?? '\n\n';
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + match.length);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        if (field === 'data') data.push(value);
      }
      if (data.length > 0) this.queue.push({ event, data: data.join('\n') });
    }
  }

  async next(timeoutMs: number): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.parse();
      const event = this.queue.shift();
      if (event) return event;
      if (this.done) throw new Error('SSE-поток закрылся, ответа нет');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SSE-сервер не ответил вовремя');
      const read = await Promise.race([
        this.reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 1000))),
      ]);
      if (read === null) continue;
      if (read.done) {
        this.done = true;
        continue;
      }
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }
}

async function readSseRpc(response: Response, id: number): Promise<RpcResult> {
  if (!response.body) throw new Error('сервер не прислал тело ответа');
  const reader = new SseReader(response.body.getReader());
  try {
    for (;;) {
      const event = await reader.next(PROBE_TIMEOUT_MS);
      if (event.event !== 'message' && event.event !== '') continue;
      let parsed: RpcResult;
      try {
        parsed = JSON.parse(event.data) as RpcResult;
      } catch {
        continue;
      }
      if (parsed.id === id) return parsed;
    }
  } finally {
    await response.body.cancel().catch(() => undefined);
  }
}

async function readRpc(response: Response, id: number): Promise<RpcResult> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) return readSseRpc(response, id);
  const text = await response.text();
  if (text.trim() === '') throw new Error('сервер ответил пустым телом');
  let parsed: RpcResult;
  try {
    parsed = JSON.parse(text) as RpcResult;
  } catch (error) {
    throw new Error(`сервер ответил не JSON: ${text.slice(0, 120)}`, { cause: error });
  }
  if (parsed.error) throw new Error(parsed.error.message ?? 'JSON-RPC error');
  return parsed;
}

function challengeOfResponse(response: Response): ProbeResult {
  return {
    ok: false,
    needsAuth: true,
    challenge: parseWwwAuthenticate(response.headers.get('www-authenticate')),
    error: 'сервер требует авторизацию',
  };
}

function toolsOf(result: RpcResult): string[] {
  const tools = Array.isArray(result.result?.tools) ? result.result.tools : [];
  return tools
    .map((tool) => asObject(tool)?.name)
    .filter((name): name is string => typeof name === 'string');
}

function serverOf(result: RpcResult): ProbeResult['server'] {
  const info = asObject(result.result?.serverInfo);
  if (!info) return undefined;
  return {
    ...(typeof info.name === 'string' ? { name: info.name } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
    ...(typeof info.title === 'string' ? { title: info.title } : {}),
  };
}

async function postRpc(
  url: string,
  headers: Record<string, string>,
  message: Record<string, unknown>,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
    signal,
    redirect: 'follow',
  });
}

async function probeStreamable(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const init = await postRpc(url, headers, initializeMessage(), fetchImpl, controller.signal);
    if (init.status === 401 || init.status === 403) return challengeOfResponse(init);
    if (!init.ok) {
      const text = await init.text().catch(() => '');
      return { ok: false, error: `сервер ответил HTTP ${init.status}${text ? `: ${text.slice(0, 160)}` : ''}` };
    }
    const sessionId = init.headers.get('mcp-session-id');
    const initRpc = await readRpc(init, 1);
    if (initRpc.error) return { ok: false, error: initRpc.error.message ?? 'сервер отказал в initialize' };

    const nextHeaders: Record<string, string> = { ...headers, 'MCP-Protocol-Version': '2025-06-18' };
    if (sessionId) nextHeaders['mcp-session-id'] = sessionId;

    const initialized = await postRpc(
      url,
      nextHeaders,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      fetchImpl,
      controller.signal,
    );
    await initialized.body?.cancel().catch(() => undefined);

    const listed = await postRpc(url, nextHeaders, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, fetchImpl, controller.signal);
    if (listed.status === 401 || listed.status === 403) return challengeOfResponse(listed);
    if (!listed.ok) return { ok: false, error: `tools/list ответил HTTP ${listed.status}` };
    const listRpc = await readRpc(listed, 2);
    if (listRpc.error) return { ok: false, error: listRpc.error.message ?? 'сервер отказал в tools/list' };
    return {
      ok: true,
      tools: toolsOf(listRpc),
      ...(serverOf(initRpc) === undefined ? {} : { server: serverOf(initRpc) }),
      protocolVersion: typeof initRpc.result?.protocolVersion === 'string' ? initRpc.result.protocolVersion : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeSse(url: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const stream = await fetchImpl(url, {
      method: 'GET',
      headers: { ...headers, accept: 'text/event-stream' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (stream.status === 401 || stream.status === 403) return challengeOfResponse(stream);
    if (!stream.ok || !stream.body) return { ok: false, error: `SSE-сервер ответил HTTP ${stream.status}` };
    const reader = new SseReader(stream.body.getReader());
    let endpoint = '';
    for (;;) {
      const event = await reader.next(PROBE_TIMEOUT_MS);
      if (event.event === 'endpoint') {
        endpoint = event.data.trim();
        break;
      }
    }
    if (!endpoint) return { ok: false, error: 'SSE-сервер не прислал endpoint' };
    const target = new URL(endpoint, url).toString();
    const post = async (message: Record<string, unknown>) => {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return response;
      await response.body?.cancel().catch(() => undefined);
      return response;
    };

    const init = await post(initializeMessage());
    if (!init.ok) return init.status === 401 || init.status === 403 ? challengeOfResponse(init) : { ok: false, error: `SSE initialize: HTTP ${init.status}` };
    let initRpc: RpcResult | null = null;
    for (;;) {
      const event = await reader.next(PROBE_TIMEOUT_MS);
      if (event.event !== 'message') continue;
      try {
        const parsed = JSON.parse(event.data) as RpcResult;
        if (parsed.id === 1) {
          initRpc = parsed;
          break;
        }
      } catch {
        // not our answer
      }
    }
    if (!initRpc || initRpc.error) return { ok: false, error: initRpc?.error?.message ?? 'SSE initialize не ответил' };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    if (!listed.ok) return { ok: false, error: `SSE tools/list: HTTP ${listed.status}` };
    for (;;) {
      const event = await reader.next(PROBE_TIMEOUT_MS);
      if (event.event !== 'message') continue;
      try {
        const parsed = JSON.parse(event.data) as RpcResult;
        if (parsed.id === 2) {
          if (parsed.error) return { ok: false, error: parsed.error.message ?? 'SSE tools/list отказал' };
          return {
            ok: true,
            tools: toolsOf(parsed),
            ...(serverOf(initRpc) === undefined ? {} : { server: serverOf(initRpc) }),
          };
        }
      } catch {
        // not our answer
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function probeMcp(options: {
  server: McpServerConfig;
  credentials?: McpCredentials;
  fetchImpl?: FetchLike;
}): Promise<ProbeResult> {
  const transport = options.server.transport ?? (options.server.url ? 'streamable-http' : 'stdio');
  if (transport === 'stdio') {
    return { ok: false, unsupported: true, error: 'stdio-сервер проверится при подключении Икара: он живёт в контейнере' };
  }
  if (!options.server.url) return { ok: false, error: 'у HTTP-сервера нет адреса' };
  if (options.credentials?.oauth && !tokenIsFresh(options.credentials.oauth)) {
    return { ok: false, needsAuth: true, error: 'нужна авторизация через браузер' };
  }
  const headers = authHeaders(options.server, options.credentials);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return transport === 'sse'
      ? await probeSse(options.server.url, headers, fetchImpl)
      : await probeStreamable(options.server.url, headers, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, error: 'сервер не ответил вовремя' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
