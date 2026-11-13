// Who opened the control panel.
//
// The panel has no password or one-time links: the person is named by the SSO proxy behind
// which it lives (in prod — Authelia behind nginx: it sets Remote-User from the response
// /api/verify and overwrites everything the client sent itself). The service only reads the header
// and checks that such a person exists in the config at all.
//
// Hence the only operational requirement: the icarus port must not face outward
// past the proxy. Whoever reaches the port directly can call themselves any name — the header
// here is not an identity proof but an agreement with the proxy.
import type { IncomingMessage } from 'node:http';
import { findUser, type IcarusConfig } from '../config.ts';
import { headerValue } from '../http/openai.ts';

export type PanelIdentity = {
  userId: string;
  /** header — named by the proxy; dev — config.yaml allowed a local run without SSO. */
  via: 'header' | 'dev';
};

export type PanelDenial = {
  status: 401 | 403;
  /** What happened — in human language, it's visible both on the page and in JSON. */
  message: string;
  /** What to do about it. */
  hint: string;
};

export type PanelAccess = { ok: true; identity: PanelIdentity } | { ok: false; denial: PanelDenial };

/** Parsing panel.userHeader: HTTP headers arrive in lowercase. */
function headerName(config: IcarusConfig): string {
  return config.panel.userHeader.toLowerCase();
}

export function identifyPanelUser(req: IncomingMessage, config: IcarusConfig): PanelAccess {
  // The proxy's word is stronger than the local setting: a panel behind real SSO stays a panel
  // behind SSO, even if someone left devUser in the config.
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
