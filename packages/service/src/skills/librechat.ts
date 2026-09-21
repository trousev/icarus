// Клиент LibreChat Management API — единственный официальный способ забрать скиллы,
// написанные в UI (см. docs LibreChat: Agent Management API, /api/agents/v1/skills).
//
// Авторизация только машинная: OIDC-токен, выпущенный провайдером, который настроен
// в `endpoints.agents.managementApi` самого LibreChat. Токен можно задать статикой
// (`token`) или брать по client_credentials (`tokenUrl` + `clientId` + `clientSecret`).
import { log } from '../log.ts';

export type SkillsAuth = {
  /** Готовый bearer-токен: удобно для отладки и для провайдеров без client_credentials. */
  token?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** audience для client_credentials, если провайдер его требует. */
  audience?: string;
};

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  fileCount: number;
  updatedAt: string;
  alwaysApply?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
};

export type SkillDetail = SkillSummary & {
  body: string;
  frontmatter?: Record<string, unknown>;
};

export type SkillFile = {
  relativePath: string;
  filename: string;
  mimeType: string;
  bytes: number;
};

export type SkillFileContent = SkillFile & { content?: string; isBinary: boolean };

/** Ошибка с кодом ответа: по ней решаем, повторять ли попытку и что писать в лог. */
export class LibreChatApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LibreChatApiError';
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Токен обновляем заранее: часы у сервиса и провайдера могут разъезжаться. */
const TOKEN_SKEW_SECONDS = 30;

/** exp из JWT без проверки подписи: нам он нужен только для кэша. */
export function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof parsed.exp === 'number' ? parsed.exp : null;
  } catch {
    return null;
  }
}

export class LibreChatSkillsClient {
  private readonly url: string;
  private readonly auth: SkillsAuth;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(options: { url: string; auth: SkillsAuth }) {
    this.url = options.url.replace(/\/+$/, '');
    this.auth = options.auth;
  }

  private get authDescription(): string {
    if (this.auth.token) return 'статический токен';
    return `client_credentials (${this.auth.clientId ?? 'без client_id'})`;
  }

  /** Токен: статический или по client_credentials, с кэшем до истечения. */
  private async accessToken(): Promise<string> {
    if (this.auth.token) return this.auth.token;
    const cached = this.cachedToken;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const { tokenUrl, clientId, clientSecret } = this.auth;
    if (!tokenUrl || !clientId || !clientSecret) {
      throw new Error('не заданы ни token, ни tokenUrl/clientId/clientSecret для Management API');
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.auth.audience) body.set('audience', this.auth.audience);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new LibreChatApiError(response.status, `провайдер не выдал токен: ${response.status}`);
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('провайдер вернул ответ без access_token');

    const exp = tokenExpiry(data.access_token);
    const expiresIn = data.expires_in ?? (exp === null ? 300 : exp - Math.floor(Date.now() / 1000));
    this.cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(0, expiresIn - TOKEN_SKEW_SECONDS) * 1000,
    };
    log.debug('токен Management API получен', { clientId, expiresIn, via: 'client_credentials' });
    return data.access_token;
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const response = await fetch(`${this.url}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new LibreChatApiError(response.status, `LibreChat ответил ${response.status} на ${path}: ${text}`);
    }
    return (await response.json()) as T;
  }

  /** Все активные скиллы, доступные привязанному пользователю LibreChat. */
  async listSkills(): Promise<SkillSummary[]> {
    const skills: SkillSummary[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (after) query.set('after', after);
      const data = await this.request<{
        data?: SkillSummary[];
        has_more?: boolean;
        after?: string | null;
      }>(`/api/agents/v1/skills?${query.toString()}`);
      skills.push(...(data.data ?? []));
      if (!data.has_more || !data.after) break;
      after = data.after;
    }
    return skills;
  }

  /** Скилл целиком: тело SKILL.md и frontmatter. */
  getSkill(id: string): Promise<SkillDetail> {
    return this.request<SkillDetail>(`/api/agents/v1/skills/${id}`);
  }

  /** Файлы бандла скилла (без содержимого). */
  async listFiles(id: string): Promise<SkillFile[]> {
    const data = await this.request<{ data?: SkillFile[] }>(`/api/agents/v1/skills/${id}/files`);
    return data.data ?? [];
  }

  /** Содержимое файла бандла; бинарные читать не умеем — вернём как есть, без content. */
  async getFile(id: string, relativePath: string): Promise<SkillFileContent> {
    const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
    return this.request<SkillFileContent>(`/api/agents/v1/skills/${id}/files/${encoded}`);
  }

  describe(): string {
    return `${this.url} (${this.authDescription})`;
  }
}
