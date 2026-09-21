// Локальный OIDC-заглушка для стенда: выдаёт access-токены для Management API LibreChat.
//
// Зачем она нужна. Management API (скиллы, агенты) принимает только OIDC machine-токены,
// подписанные ключом, который LibreChat может проверить через JWKS. На стенде провайдера
// нет, поэтому его роль играет этот файл: он держит один RSA-ключ на диске, отдаёт по нему
// JWKS и подписывает токены по client_credentials.
//
// Процесс запускается в двух местах с одним и тем же ключом подписи (см. compose.ts):
//   * внутри контейнера LibreChat — чтобы он видел заглушку как http://localhost:9100
//     (LibreChat разрешает http только для localhost; см. isRemoteOidcUrlAllowed)
//     и переживал пересоздание самого LibreChat;
//   * обычным сервисом `oidc` в сети compose — у него icarus берёт токен.
// Ключ у них общий: каталог docker/librechat/oidc-data монтируется в оба.
//
// Это стенд, а не продакшн: секрет клиента лежит в открытом виде, срок жизни токена —
// час, ревокации нет. В бою здесь должен быть настоящий OIDC-провайдер.
//
//   GET  /.well-known/openid-configuration
//   GET  /.well-known/jwks.json
//   POST /token   (grant_type=client_credentials, client_id, client_secret)
//   GET  /healthz
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';

const PORT = Number(process.env.OIDC_PORT ?? 9100);
const ISSUER = process.env.OIDC_ISSUER ?? `http://localhost:${PORT}`;
const AUDIENCE = process.env.OIDC_AUDIENCE ?? 'icarus-skills';
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'icarus-sync';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? 'icarus-sync-dev-secret';
const SUBJECT = process.env.OIDC_SUBJECT ?? CLIENT_ID;
const TTL_SECONDS = Number(process.env.OIDC_TTL_SECONDS ?? 3600);
const KEY_DIR = process.env.OIDC_KEY_DIR ?? '/data';
const KEY_FILE = path.join(KEY_DIR, 'oidc-signing-key.pem');

/**
 * Ключ один на весь стенд: первый стартовавший создаёт, остальные читают.
 *
 * Экземпляров два (LibreChat и icarus), и они поднимаются одновременно, поэтому
 * одного `wx` мало: победитель ещё дописывает файл, когда проигравший уже читает.
 * Поэтому проигравший ждёт, пока файл станет валидным PEM. Перезаписи нет: `wx`
 * создаёт файл ровно один раз, так что оба процесса остаются с одним ключом.
 */
async function loadOrCreateKey() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  try {
    const handle = fs.openSync(KEY_FILE, 'wx', 0o600);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeSync(handle, pem);
    fs.closeSync(handle);
    console.log(`[oidc-stub] создан новый ключ ${KEY_FILE}`);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pem = fs.readFileSync(KEY_FILE, 'utf8');
      createPrivateKey(pem); // файл дописан целиком — только теперь он годится
      return pem;
    } catch (error) {
      if (error?.code === 'EACCES') {
        // Ключ остался от запуска под другим пользователем: ждать бессмысленно.
        throw new Error(
          `нет доступа к ${KEY_FILE}: ${error.message}. Удали файл и перезапусти стенд (ключ создаётся заново)`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`не дождался валидного ключа ${KEY_FILE}`);
}

const privateKeyPem = await loadOrCreateKey();
const publicJwk = createPublicKey(privateKeyPem).export({ format: 'jwk' });
const kid = createHash('sha256')
  .update(publicJwk.n + publicJwk.e)
  .digest('base64url')
  .slice(0, 16);

const b64url = (input) => Buffer.from(input).toString('base64url');

function signToken(claims) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    jti: randomUUID(),
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem, 'base64url');
  return `${signingInput}.${signature}`;
}

function mintForClient(clientId) {
  // azp/client_id — по ним LibreChat ищет привязку, sub — проверяет по ней же.
  return signToken({ sub: SUBJECT, azp: clientId, client_id: clientId });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error('слишком большое тело'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  console.log(`[oidc-stub] ${req.method} ${url.pathname}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', issuer: ISSUER, kid });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    sendJson(res, 200, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ['token'],
      grant_types_supported: ['client_credentials'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/.well-known/jwks.json' || url.pathname === '/jwks.json')) {
    sendJson(res, 200, {
      keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    let clientId = params.get('client_id') ?? undefined;
    let clientSecret = params.get('client_secret') ?? undefined;

    // client_secret_basic — как это делает большинство M2M-клиентов.
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }

    if (params.get('grant_type') !== 'client_credentials') {
      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      sendJson(res, 401, { error: 'invalid_client' });
      return;
    }

    sendJson(res, 200, {
      access_token: mintForClient(clientId),
      token_type: 'Bearer',
      expires_in: TTL_SECONDS,
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

// Слушаем без указания адреса: на Linux это dual-stack (::), и `localhost`, который
// резолвится сначала в ::1, тоже работает — иначе LibreChat получает ECONNREFUSED.
server.listen(PORT, () => {
  console.log(`[oidc-stub] слушаю :${PORT}, issuer=${ISSUER}, audience=${AUDIENCE}, client=${CLIENT_ID}, kid=${kid}`);
});
