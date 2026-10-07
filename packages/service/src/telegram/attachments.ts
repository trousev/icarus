// Вложения из Telegram: фото, картинка документом и голосовое.
//
// Bot API не присылает файлы — только ссылки: сначала getFile за путём, потом сам
// файл отдельным запросом. Картинку отдаём модели нативно (как это делает вход
// LibreChat) и кладём в incoming/ человека, чтобы её видели ещё и тулы. Голосовое
// модель не слышит: здесь только байты, а в текст его перекладывает speech.ts.
import fs from 'node:fs';
import path from 'node:path';
import { CONTAINER_INCOMING } from '../config.ts';
import {
  TELEGRAM_FILE_LIMIT,
  type TelegramApi,
  type TelegramDocument,
  type TelegramMessage,
  type TelegramPhotoSize,
} from './api.ts';

/** Фото Telegram — всегда JPEG, чем бы кадр ни был снят. */
export const PHOTO_MIME = 'image/jpeg';

/** Что модель умеет смотреть. Остальные картинки честнее прислать фото. */
export const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type IncomingImage = {
  /** base64 без префикса `data:` — ровно то, что ждёт pi в команде prompt. */
  data: string;
  mimeType: string;
  /** Путь внутри контейнера: по нему картинку найдёт тул. */
  file: string;
};

export type IncomingVoice = {
  audio: Buffer;
  mimeType: string;
  duration: number | null;
};

/**
 * Что человек прислал. Разбираем одно вложение на сообщение — так их и присылают,
 * а подпись к нему становится текстом реплики.
 */
export type Incoming = {
  text: string;
  images: IncomingImage[];
  voice: IncomingVoice | null;
  /** Вложение, которое мы не разбираем: «видео», «стикер», «аудиофайл». */
  unsupported: string | null;
};

/**
 * Забирает вложение и раскладывает его по видам. Бросает, если файл не скачался:
 * решать, что сказать человеку, — дело бота.
 */
export async function collectIncoming(
  api: TelegramApi,
  message: TelegramMessage,
  incomingDir: string,
): Promise<Incoming> {
  // У вложения текст лежит в подписи: «смотри, что нашёл» приходит именно там.
  const text = (message.text ?? message.caption ?? '').trim();
  const incoming: Incoming = { text, images: [], voice: null, unsupported: null };

  const photo = message.photo === undefined ? undefined : largestPhoto(message.photo);
  if (photo) {
    const bytes = await fetchFile(api, photo.file_id, photo.file_size);
    incoming.images.push({
      data: bytes.toString('base64'),
      mimeType: PHOTO_MIME,
      file: save(incomingDir, bytes, `${fileStem(message)}.jpg`),
    });
    return incoming;
  }

  // Документ-картинка — обычное дело: так присылают скриншот без сжатия Telegram.
  const document = message.document;
  if (document) {
    const mimeType = document.mime_type ?? '';
    if (!IMAGE_MIME.has(mimeType)) return { ...incoming, unsupported: 'документ' };
    const bytes = await fetchFile(api, document.file_id, document.file_size);
    incoming.images.push({
      data: bytes.toString('base64'),
      mimeType,
      file: save(incomingDir, bytes, documentName(message, document)),
    });
    return incoming;
  }

  const voice = message.voice;
  if (voice) {
    const bytes = await fetchFile(api, voice.file_id, voice.file_size);
    incoming.voice = {
      audio: bytes,
      mimeType: voice.mime_type ?? 'audio/ogg',
      duration: voice.duration ?? null,
    };
    return incoming;
  }

  return { ...incoming, unsupported: unsupportedKind(message) };
}

/** Вложение, которое мы не разбираем, — словами: бот скажет это человеку. */
export function unsupportedKind(message: TelegramMessage): string | null {
  if (message.video_note) return 'видеосообщение';
  if (message.video) return 'видео';
  if (message.sticker) return 'стикер';
  if (message.audio) return 'аудиофайл';
  return null;
}

/**
 * Файл из хранилища Telegram: сначала путь, потом байты. Размер проверяем до
 * скачивания, когда Telegram его назвал, и после — на всякий случай: больше 20 МБ
 * Bot API не отдаёт, и лучше сказать это сразу, чем ждать таймаута.
 */
async function fetchFile(api: TelegramApi, fileId: string, fileSize?: number): Promise<Buffer> {
  if ((fileSize ?? 0) > TELEGRAM_FILE_LIMIT) throw new Error(tooBig(fileSize ?? 0));
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не отдал путь к файлу');
  const bytes = await api.downloadFile(file.file_path);
  if (bytes.length > TELEGRAM_FILE_LIMIT) throw new Error(tooBig(bytes.length));
  return bytes;
}

function tooBig(bytes: number): string {
  const limit = Math.round(TELEGRAM_FILE_LIMIT / (1024 * 1024));
  return `файл ${Math.round(bytes / (1024 * 1024))} МБ — Telegram отдаёт не больше ${limit} МБ`;
}

/** Самый крупный размер снимка: Telegram шлёт один кадр лестницей. */
export function largestPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  return [...sizes].sort((a, b) => pixels(b) - pixels(a))[0];
}

function pixels(size: TelegramPhotoSize): number {
  return (size.width ?? 0) * (size.height ?? 0) || (size.file_size ?? 0);
}

/** Имя документа оставляем человеческим: по нему Икар понимает, что ему прислали. */
export function documentName(message: TelegramMessage, document: TelegramDocument): string {
  const original = safeName(document.file_name);
  const suffix = original === '' ? `.${extensionFor(document.mime_type ?? '')}` : `-${original}`;
  return `${fileStem(message)}${suffix}`;
}

/**
 * По чему назван файл: чат и номер сообщения. Одного номера сообщения мало — в личке
 * и в группе они нумеруются порознь, и два разговора завели бы один файл.
 */
function fileStem(message: TelegramMessage): string {
  return `telegram-${message.chat.id}-${message.message_id}`;
}

/** Чужое имя файла — это чужие «/» и «..»: оставляем буквы, цифры, точку, дефис, «_». */
export function safeName(name: string | undefined): string {
  return (name ?? '')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[._]+/, '')
    .slice(0, 60);
}

/** Расширение из mime: `image/png` → `png`; незнакомое — `bin`. */
export function extensionFor(mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? '';
  return extension === '' ? 'bin' : extension;
}

/**
 * Кладёт вложение в incoming/ человека: путь уезжает в реплику, и по нему картинку
 * найдёт тул. Имя привязано к сообщению, из которого файл пришёл, а не к часам:
 * так видно, откуда он взялся, и два снимка подряд не спорят за один файл.
 */
function save(incomingDir: string, bytes: Buffer, name: string): string {
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.writeFileSync(path.join(incomingDir, name), bytes);
  return `${CONTAINER_INCOMING}/${name}`;
}
