// Кто открыл панель управления.
//
// Пароля и одноразовых ссылок у панели нет: человека называет SSO-прокси, за которым
// она живёт (на проде — Authelia за nginx: он подставляет Remote-User из ответа
// /api/verify и перетирает всё, что клиент прислал сам). Сервис только читает заголовок
// и проверяет, что такой человек вообще заведён в конфиге.
//
// Отсюда единственное требование к эксплуатации: порт icarus не должен смотреть наружу
// мимо прокси. Кто дотянется до порта напрямую, тот назовётся любым именем — заголовок
// здесь не удостоверение, а договорённость с прокси.
import type { IncomingMessage } from 'node:http';
import { findUser, type IcarusConfig } from '../config.ts';
import { headerValue } from '../http/openai.ts';

export type PanelIdentity = {
  userId: string;
  /** header — назвал прокси; dev — config.yaml разрешил локальный запуск без SSO. */
  via: 'header' | 'dev';
};

export type PanelDenial = {
  status: 401 | 403;
  /** Что случилось — человеческим языком, его видно и на странице, и в JSON. */
  message: string;
  /** Что с этим делать. */
  hint: string;
};

export type PanelAccess = { ok: true; identity: PanelIdentity } | { ok: false; denial: PanelDenial };

/** Разбор panel.userHeader: в HTTP заголовки приезжают в нижнем регистре. */
function headerName(config: IcarusConfig): string {
  return config.panel.userHeader.toLowerCase();
}

export function identifyPanelUser(req: IncomingMessage, config: IcarusConfig): PanelAccess {
  // Слово прокси сильнее локальной настройки: панель за настоящим SSO остаётся панелью
  // за SSO, даже если в конфиге кто-то оставил devUser.
  const claimed = headerValue(req, headerName(config));
  if (claimed) {
    if (!findUser(config, claimed)) {
      return {
        ok: false,
        denial: {
          status: 403,
          message: `«${claimed}» не заведён в Icarus`,
          hint: 'Человека добавляют в users: config.yaml (на проде — переменная ICARUS_USERS).',
        },
      };
    }
    return { ok: true, identity: { userId: claimed, via: 'header' } };
  }

  const devUser = config.panel.devUser;
  if (devUser !== undefined) {
    return { ok: true, identity: { userId: devUser, via: 'dev' } };
  }

  return {
    ok: false,
    denial: {
      status: 401,
      message: `панель открывается через вход в ${config.panel.userHeader}: в запросе нет этого заголовка`,
      hint:
        'За панелью должен стоять SSO-прокси (Authelia + nginx) — он и называет вошедшего. ' +
        'Для локального запуска без прокси задай panel.devUser в config.yaml.',
    },
  };
}
