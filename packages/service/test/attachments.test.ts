// Вложения из Telegram: что понимаем, что нет и по какому пути файл находит pi.
// Сети тут нет: Bot API — заглушка, у неё «в хранилище» лежат готовые байты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectIncoming,
  documentName,
  extensionFor,
  largestPhoto,
  safeName,
  unsupportedKind,
} from '../src/telegram/attachments.ts';
import type { TelegramApi, TelegramMessage } from '../src/telegram/api.ts';

const JPEG = Buffer.from('не-совсем-jpeg');
const OGG = Buffer.from('не-совсем-ogg');

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-tg-'));
}

/** Bot API с одним лишь хранилищем файлов: апдейты и отправка тут ни при чём. */
function fakeApi(files: Record<string, Buffer> = {}) {
  const downloaded: string[] = [];
  const api = {
    async getFile(fileId: string) {
      const file = files[fileId];
      if (!file) throw new Error(`нет файла ${fileId}`);
      return { file_id: fileId, file_path: fileId, file_size: file.length };
    },
    async downloadFile(filePath: string) {
      downloaded.push(filePath);
      const file = files[filePath];
      if (!file) throw new Error(`нет файла ${filePath}`);
      return file;
    },
  } as unknown as TelegramApi;
  return { api, downloaded };
}

function message(parts: Partial<TelegramMessage> = {}): TelegramMessage {
  return { message_id: 5, chat: { id: 1, type: 'private' }, ...parts };
}

test('фото: берём самый крупный кадр и отдаём байты модели', async () => {
  const dir = tmp();
  const { api } = fakeApi({ big: JPEG });

  const incoming = await collectIncoming(
    api,
    message({
      caption: 'что тут?',
      photo: [
        { file_id: 'small', width: 90, height: 60 },
        { file_id: 'big', width: 1280, height: 960 },
      ],
    }),
    dir,
  );

  assert.equal(incoming.text, 'что тут?', 'подпись — это текст реплики');
  assert.deepEqual(incoming.images, [
    { data: JPEG.toString('base64'), mimeType: 'image/jpeg', file: '/workspace/incoming/telegram-1-5.jpg' },
  ]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'telegram-1-5.jpg')), JPEG);
});

test('документ-картинка сохраняется под своим именем', async () => {
  const dir = tmp();
  const { api } = fakeApi({ shot: JPEG });

  const incoming = await collectIncoming(
    api,
    message({ document: { file_id: 'shot', file_name: 'скриншот.png', mime_type: 'image/png' } }),
    dir,
  );

  assert.equal(incoming.images[0]?.mimeType, 'image/png');
  assert.equal(incoming.images[0]?.file, '/workspace/incoming/telegram-1-5-скриншот.png');
});

test('голосовое отдаётся байтами: расшифровка — не его забота', async () => {
  const { api } = fakeApi({ voice: OGG });

  const incoming = await collectIncoming(
    api,
    message({ voice: { file_id: 'voice', duration: 12, mime_type: 'audio/ogg', file_size: OGG.length } }),
    tmp(),
  );

  assert.deepEqual(incoming.voice, { audio: OGG, mimeType: 'audio/ogg', duration: 12 });
  assert.deepEqual(incoming.images, []);
  assert.equal(incoming.unsupported, null);
});

test('голосовое без mime и длительности не ломает разбор', async () => {
  const { api } = fakeApi({ voice: OGG });

  const incoming = await collectIncoming(api, message({ voice: { file_id: 'voice' } }), tmp());

  assert.equal(incoming.voice?.mimeType, 'audio/ogg', 'у Telegram это всегда OGG');
  assert.equal(incoming.voice?.duration, null);
});

test('видео, стикер и аудиофайл — не наши', async () => {
  assert.equal(unsupportedKind(message({ video: {} })), 'видео');
  assert.equal(unsupportedKind(message({ video_note: {} })), 'видеосообщение');
  assert.equal(unsupportedKind(message({ sticker: {} })), 'стикер');
  assert.equal(unsupportedKind(message({ audio: {} })), 'аудиофайл');
  assert.equal(unsupportedKind(message({ text: 'просто текст' })), null, 'тексту ничего не мешает');

  const { api } = fakeApi();
  const incoming = await collectIncoming(api, message({ video: {} }), tmp());
  assert.equal(incoming.unsupported, 'видео');
  assert.equal(incoming.voice, null);
});

test('не-картинка документом тоже не разбирается', async () => {
  const { api } = fakeApi();

  const incoming = await collectIncoming(
    api,
    message({ document: { file_id: 'doc', file_name: 'смета.pdf', mime_type: 'application/pdf' } }),
    tmp(),
  );

  assert.equal(incoming.unsupported, 'документ');
});

test('картинка, которую модель не умеет смотреть, честно не берётся', async () => {
  const { api } = fakeApi({ heic: JPEG });

  const incoming = await collectIncoming(
    api,
    message({ document: { file_id: 'heic', file_name: 'IMG_1.heic', mime_type: 'image/heic' } }),
    tmp(),
  );

  assert.equal(incoming.unsupported, 'документ', 'HEIC переживёт не всякая модель');
  assert.deepEqual(incoming.images, []);
});

test('чужое имя файла не выводит за пределы incoming', () => {
  assert.equal(safeName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName(undefined), '');
  assert.equal(safeName('файл с пробелами.pdf'), 'файл_с_пробелами.pdf');
  assert.equal(documentName(message(), { file_id: 'x' }), 'telegram-1-5.bin', 'без имени — по mime');
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor(''), 'bin');
});

test('лестница размеров сортируется по площади, а не по порядку', () => {
  const sizes = [
    { file_id: 'a', width: 100, height: 100 },
    { file_id: 'b', width: 1280, height: 960 },
    { file_id: 'c', width: 320, height: 240 },
  ];
  assert.equal(largestPhoto(sizes)?.file_id, 'b');
  // Площади нет вовсе — решает размер файла, который Telegram всё равно назвал.
  assert.equal(largestPhoto([{ file_id: 'x', file_size: 10 }, { file_id: 'y', file_size: 900 }])?.file_id, 'y');
});
