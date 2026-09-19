// Личный пропуск в панель памяти: подписанная ссылка со сроком годности.
//
// Общего ключа у панели нет намеренно: один ключ на всех открывал память всех.
// Вместо него у каждого человека свой ключ, выведенный из секрета сервиса и его id
// (derivePanelKey). Ключ уезжает только в его контейнер, поэтому Икар может подписать
// ссылку, а по чужому ключу чужую ссылку не подделать: сам секрет сервиса в контейнер
// не попадает — он лежит в dataDir и монтируется только сервису.
//
// Формат пропуска — `id:срок:подпись`, где срок — миллисекунды эпохи, а подпись —
// HMAC личным ключом. Один и тот же пропуск несёт и URL страницы, и заголовок
// Authorization у её API-запросов.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Сколько живёт ссылка, если не сказано иное: сутки. */
export const DEFAULT_LINK_TTL_MINUTES = 24 * 60;

/** Больше месяца не даём: ссылка — пропуск, а не второй постоянный пароль. */
const MAX_LINK_TTL_MINUTES = 30 * 24 * 60;

/** Срок годности из окружения: мусор и неположительные значения — это дефолт. */
export function linkTtlMinutes(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LINK_TTL_MINUTES;
  return Math.min(Math.floor(value), MAX_LINK_TTL_MINUTES);
}

function hmacHex(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

/** Личный ключ панели: наружу (в контейнер человека) уезжает только он, не секрет. */
export function derivePanelKey(secret: string, userId: string): string {
  return hmacHex(secret, `panel:${userId}`);
}

/** Подписывает пропуск личным ключом. Срок — миллисекунды эпохи. */
export function signPanelCredential(key: string, userId: string, expiresAt: number): string {
  return `${userId}:${expiresAt}:${hmacHex(key, `${userId}:${expiresAt}`)}`;
}

export type PanelCredentialCheck =
  | { ok: true; userId: string; expiresAt: number }
  | { ok: false; reason: 'формат' | 'срок' | 'подпись' };

/** Сравнение подписей постоянное по времени; длина hex-строк у нас всегда одна. */
function sameSignature(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Проверяет пропуск секретом сервиса: сначала форму, потом срок, потом подпись.
 * Секрет сюда приходит только на стороне сервиса.
 */
export function verifyPanelCredential(
  secret: string,
  credential: string,
  now: number = Date.now(),
): PanelCredentialCheck {
  const parts = credential.split(':');
  if (parts.length !== 3) return { ok: false, reason: 'формат' };
  const [userId, rawExpires, signature] = parts;
  if (!userId || !/^\d+$/.test(rawExpires) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: 'формат' };
  }
  const expiresAt = Number(rawExpires);
  if (expiresAt <= now) return { ok: false, reason: 'срок' };
  const expected = hmacHex(derivePanelKey(secret, userId), `${userId}:${expiresAt}`);
  if (!sameSignature(signature, expected)) return { ok: false, reason: 'подпись' };
  return { ok: true, userId, expiresAt };
}

/** URL панели с пропуском: базовый адрес уже смотрит туда, откуда человек откроет ссылку. */
export function panelLinkUrl(base: string, credential: string): string {
  return `${base.replace(/\/+$/, '')}/panel?t=${encodeURIComponent(credential)}`;
}
