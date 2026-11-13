// Sending files to Telegram: the multipart body, Bot API limits and which file
// becomes a photo and which a document. There's no network: fetch is a stub, it
// returns exactly the responses the test needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifactsRoot, writeAcl } from '../src/artifacts.ts';
import { userPaths } from '../src/config.ts';
import { isRasterImage, localFileOf } from '../src/local-files.ts';
import {
  CAPTION_LIMIT,
  TelegramApi,
  TelegramError,
  TELEGRAM_PHOTO_LIMIT,
  TELEGRAM_UPLOAD_LIMIT,
  UploadTooBigError,
  type UploadFile,
} from '../src/telegram/api.ts';
import {
  answerFiles,
  attachmentKind,
  deliverFiles,
  filesFailedText,
  humanName,
  isLocalTarget,
  prepareFile,
  stripLocalRefs,
  uploadReason,
} from '../src/telegram/outgoing.ts';
import { makeConfig, probe } from './fixtures.ts';

// --- Bot API: multipart ------------------------------------------------------

type Call = { url: string; init: RequestInit };

/** fetch stub: collects requests and returns pre-made responses. */
function capture(responses: Array<Record<string, unknown> | Response | Error>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next ?? { ok: true, result: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

const PNG = Buffer.from('не-совсем-png');
const file = (name: string, mimeType: string, bytes: Buffer = PNG): UploadFile => ({ bytes, name, mimeType });

test('a photo goes as a multipart form, not a JSON string', async () => {
  const { calls, fetch } = capture([{ ok: true, result: { message_id: 5, message_thread_id: 17 } }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  const sent = await api.sendPhoto(42, file('chart.png', 'image/png'), { caption: 'цены', threadId: 17 });

  assert.equal(sent.message_id, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://tg.test/botTOKEN/sendPhoto');
  const form = calls[0]?.init.body;
  assert.ok(form instanceof FormData, 'тело — форма: строкой файл в Telegram не отправить');
  assert.equal(form.get('chat_id'), '42');
  assert.equal(form.get('caption'), 'цены');
  assert.equal(form.get('message_thread_id'), '17');
  const photo = form.get('photo');
  assert.ok(photo instanceof File, 'файл лежит отдельной частью формы');
  assert.equal(photo.name, 'chart.png');
  assert.equal(photo.type, 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG);

  // What goes over the wire: the multipart boundary and named parts, as the Bot API expects.
  const wire = new Response(form);
  assert.match(wire.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/);
  const body = await wire.text();
  assert.match(body, /name="chat_id"\r\n\r\n42/);
  assert.match(body, /name="photo"; filename="chart\.png"/);
  assert.match(body, /content-type: image\/png/i);
});

test('a document goes as a multipart form with a human name', async () => {
  const { calls, fetch } = capture([{ ok: true, result: { message_id: 6 } }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await api.sendDocument(42, file('смета за март.pdf', 'application/pdf'));

  const form = calls[0]?.init.body as FormData;
  assert.equal(calls[0]?.url, 'https://tg.test/botTOKEN/sendDocument');
  assert.equal((form.get('document') as File).name, 'смета за март.pdf');
  assert.equal(form.get('message_thread_id'), null, 'без топика поле не уезжает');
});

test('we do not send a file over the limit at all: we don\'t touch the network', async () => {
  const { calls, fetch } = capture([{ ok: true, result: {} }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(
    () => api.sendPhoto(42, file('big.png', 'image/png', Buffer.alloc(TELEGRAM_PHOTO_LIMIT + 1))),
    (error: unknown) => {
      assert.ok(error instanceof UploadTooBigError);
      assert.match(error.message, /«big\.png» весит 10 МБ/);
      assert.equal(error.limit, TELEGRAM_PHOTO_LIMIT);
      return true;
    },
  );
  // A document has its own limit, and it too is checked before the request.
  const huge = { length: TELEGRAM_UPLOAD_LIMIT + 1 } as Buffer;
  await assert.rejects(
    () => api.sendDocument(42, file('huge.bin', 'application/octet-stream', huge)),
    UploadTooBigError,
  );
  assert.equal(calls.length, 0, 'до сети дело не дошло');
});

test('an empty file and a nameless file are errors before the request', async () => {
  const { calls, fetch } = capture([{ ok: true, result: {} }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(() => api.sendPhoto(42, file('empty.png', 'image/png', Buffer.alloc(0))), /пустой/);
  await assert.rejects(() => api.sendPhoto(42, file('   ', 'image/png')), /имени/);
  assert.equal(calls.length, 0);
});

test('Telegram rejected the token — error 401, and the person is told this in words', async () => {
  const { fetch } = capture([{ ok: false, error_code: 401, description: 'Unauthorized' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(
    () => api.sendDocument(42, file('chart.png', 'image/png')),
    (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, 401);
      assert.equal(uploadReason(error), 'Telegram не принял токен бота');
      return true;
    },
  );
});

test('a file too large for Telegram: 413 and no retries', async () => {
  const { calls, fetch } = capture([
    { ok: false, error_code: 413, description: 'Request Entity Too Large' },
  ]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(
    () => api.sendDocument(42, file('chart.png', 'image/png')),
    (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, 413);
      assert.equal(uploadReason(error), 'Telegram отказал: файл слишком большой');
      return true;
    },
  );
  assert.equal(calls.length, 1, '413 — это ответ, а не сбой сети: повторять нечего');
});

test('HTML instead of JSON from the proxy: the status is not lost', async () => {
  const { fetch } = capture([new Response('<html>too large</html>', { status: 413 })]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(
    () => api.sendDocument(42, file('chart.png', 'image/png')),
    (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, 413);
      assert.match(error.message, /HTTP 413/);
      return true;
    },
  );
});

// --- what to send -----------------------------------------------------------

test('an image as a photo, a large file and a non-image as a document', () => {
  assert.equal(attachmentKind('image/png', 1024), 'photo');
  assert.equal(attachmentKind('image/jpeg; quality=90', 1024), 'photo');
  assert.equal(attachmentKind('image/png', TELEGRAM_PHOTO_LIMIT + 1), 'document', '10 МБ — предел фото');
  assert.equal(attachmentKind('image/gif', 1024), 'document', 'GIF фотографией станет статичным');
  assert.equal(attachmentKind('application/pdf', 1024), 'document');
  assert.equal(attachmentKind('application/octet-stream', 1024), 'document');
});

test('the file name is human, but with the original extension', () => {
  assert.equal(humanName('график цен', '/tmp/chart.png'), 'график цен.png');
  assert.equal(humanName('chart.png', '/tmp/chart.png'), 'chart.png', 'расширение не удваивается');
  assert.equal(humanName('', '/tmp/отчёт за март.pdf'), 'отчёт за март.pdf');
  assert.equal(humanName('../../etc/passwd', '/tmp/x.csv'), 'etc_passwd.csv', 'чужие «/» не проходят');
});

test('local file links are seen only for a local path', () => {
  assert.equal(isLocalTarget('/workspaces/talk/chart.png'), true);
  assert.equal(isLocalTarget('/artifacts/plan/index.png'), true);
  assert.equal(isLocalTarget('file:///workspaces/.icarus/incoming/x.jpg'), true);
  assert.equal(isLocalTarget('https://example.com/x.png'), false);
  assert.equal(isLocalTarget('/etc/passwd'), false);
});

test('file links are extracted from the answer, not site links', () => {
  const text = [
    'Готово!',
    '![график цен](/workspaces/talk/chart.png)',
    '[смета](/workspaces/talk/смета.pdf "за март")',
    // A human name may contain a space: it's the same link as with %20.
    '[смета за март](/workspaces/talk/смета за март.pdf)',
    '![чужое](https://example.com/x.png)',
    '[сайт](https://example.com)',
    '![график ещё раз](/workspaces/talk/chart.png)',
  ].join('\n');

  assert.deepEqual(answerFiles(text), [
    { label: 'график цен', target: '/workspaces/talk/chart.png' },
    { label: 'смета', target: '/workspaces/talk/смета.pdf' },
    { label: 'смета за март', target: '/workspaces/talk/смета за март.pdf' },
  ]);
});

test('file links are removed from the text: the whole line, the caption within a phrase', () => {
  // A link on its own line must not remain: the name and caption are visible
  // in the attachment, and the person doesn't need the path in the message.
  assert.equal(
    stripLocalRefs('Готово!\n\n![график цен](/workspaces/talk/chart.png)\n\n[смета](/workspaces/talk/смета.pdf)'),
    'Готово!',
  );
  assert.equal(
    stripLocalRefs('Вот [смета за март](/workspaces/talk/смета за март.pdf) — посмотри'),
    'Вот смета за март — посмотри',
    'внутри фразы подпись остаётся словами',
  );
  // We don't touch external links: the person opens them themselves.
  assert.equal(
    stripLocalRefs('[сайт](https://example.com)'),
    '[сайт](https://example.com)',
  );
});

// --- files on disk ----------------------------------------------------------

function tmpUser(): { config: ReturnType<typeof makeConfig>; user: ReturnType<typeof probe>; workspaces: string } {
  const config = makeConfig();
  const user = probe();
  return { config, user, workspaces: userPaths(config, user).workspaces };
}

test('a file resolves from the workspace, incoming and the artifact library', () => {
  const { config, user, workspaces } = tmpUser();
  const incoming = userPaths(config, user).incoming;
  fs.mkdirSync(path.join(workspaces, 'talk'), { recursive: true });
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(workspaces, 'talk', 'chart.png'), PNG);
  fs.writeFileSync(path.join(incoming, 'kotic.jpg'), PNG);

  assert.equal(localFileOf(config, user, '/workspaces/talk/chart.png')?.type, 'image/png');
  assert.equal(localFileOf(config, user, '/workspaces/.icarus/incoming/kotic.jpg')?.type, 'image/jpeg');
  assert.equal(localFileOf(config, user, '/workspaces/talk/../../etc/passwd'), null);

  // Artifacts are a shared library, but with permissions: we don't hand out someone else's personal one.
  const dir = path.join(artifactsRoot(config), 'plan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.png'), PNG);
  writeAcl(dir, 'probe', { me: 'admin', family: 'none' });
  assert.ok(localFileOf(config, user, '/artifacts/plan/index.png'), 'владелец видит свой артефакт');
  assert.equal(localFileOf(config, { id: 'vita' }, '/artifacts/plan/index.png'), null);
  writeAcl(dir, 'probe', { me: 'admin', family: 'read' });
  assert.ok(localFileOf(config, { id: 'vita' }, '/artifacts/plan/index.png'), 'открытый — видит семья');
});

test('only a raster image counts as an image in the panel: SVG stays a file', () => {
  assert.equal(isRasterImage('image/png'), true);
  assert.equal(isRasterImage('image/svg+xml'), false);
  assert.equal(isRasterImage('application/pdf'), false);
});

test('attachment preparation: bytes, name and caption from the link', () => {
  const { config, user, workspaces } = tmpUser();
  fs.mkdirSync(path.join(workspaces, 'talk'), { recursive: true });
  fs.writeFileSync(path.join(workspaces, 'talk', 'chart.png'), PNG);

  const prepared = prepareFile(config, user, { label: 'график цен', target: '/workspaces/talk/chart.png' });
  assert.ok(prepared.ok);
  assert.equal(prepared.file.name, 'график цен.png');
  assert.equal(prepared.file.kind, 'photo');
  assert.equal(prepared.file.caption, 'график цен');
  assert.deepEqual(prepared.file.bytes, PNG);

  const missing = prepareFile(config, user, { label: 'схема', target: '/workspaces/talk/нет.png' });
  assert.ok(!missing.ok);
  assert.equal(missing.reason, 'файл не найден или недоступен');
});

type SentUpload = { chatId: number; name: string; caption?: string; threadId?: number | null };

/** api stub: records attachments the way Telegram will see them. */
function uploadApi() {
  const photos: SentUpload[] = [];
  const documents: SentUpload[] = [];
  const api = {
    async sendPhoto(chatId: number, file: { name: string }, options: { caption?: string; threadId?: number | null } = {}) {
      photos.push({ chatId, name: file.name, ...(options.caption ? { caption: options.caption } : {}), threadId: options.threadId });
      return { message_id: photos.length };
    },
    async sendDocument(chatId: number, file: { name: string }, options: { caption?: string; threadId?: number | null } = {}) {
      documents.push({ chatId, name: file.name, ...(options.caption ? { caption: options.caption } : {}), threadId: options.threadId });
      return { message_id: documents.length };
    },
  };
  return { api: api as unknown as TelegramApi, photos, documents };
}

test('deliverFiles: a photo and a file go to their topic, one failure does not cancel the others', async () => {
  const { config, user, workspaces } = tmpUser();
  fs.mkdirSync(path.join(workspaces, 'talk'), { recursive: true });
  fs.writeFileSync(path.join(workspaces, 'talk', 'chart.png'), PNG);
  fs.writeFileSync(path.join(workspaces, 'talk', 'смета.pdf'), Buffer.from('PDF'));
  const { api, photos, documents } = uploadApi();

  const result = await deliverFiles(
    api,
    config,
    user,
    42,
    [
      { label: 'график', target: '/workspaces/talk/chart.png' },
      { label: 'нет такой', target: '/workspaces/talk/нет.png' },
      { label: 'смета', target: '/workspaces/talk/смета.pdf' },
    ],
    { threadId: 17 },
  );

  assert.deepEqual(result, { sent: 2, errors: [{ name: 'нет такой', reason: 'файл не найден или недоступен' }] });
  assert.deepEqual(photos, [{ chatId: 42, name: 'график.png', caption: 'график', threadId: 17 }]);
  assert.deepEqual(documents, [{ chatId: 42, name: 'смета.pdf', caption: 'смета', threadId: 17 }]);
});

test('a file send error is explained to the person, not just written to the log', () => {
  assert.equal(uploadReason(new UploadTooBigError('chart.gif', 60 * 1024 * 1024, TELEGRAM_UPLOAD_LIMIT)), '«chart.gif» весит 60 МБ — Telegram принимает не больше 50 МБ');
  assert.match(filesFailedText([{ name: 'схема.png', reason: 'файл не найден или недоступен' }]), /схема\.png/);
  assert.match(filesFailedText([{ name: 'схема.png', reason: 'файл не найден или недоступен' }]), /файл не найден/);
});

test('the caption is truncated to the Bot API limit', () => {
  const { config, user, workspaces } = tmpUser();
  fs.mkdirSync(path.join(workspaces, 'talk'), { recursive: true });
  fs.writeFileSync(path.join(workspaces, 'talk', 'chart.png'), PNG);
  const prepared = prepareFile(config, user, { label: 'я'.repeat(CAPTION_LIMIT + 50), target: '/workspaces/talk/chart.png' });
  assert.ok(prepared.ok);
  assert.equal(prepared.file.caption.length, CAPTION_LIMIT);
  assert.equal(prepared.file.name.length <= 64, true);
});
