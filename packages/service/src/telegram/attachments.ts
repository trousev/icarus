// Attachments from Telegram: photos, an image sent as a document, voice — and a point on the map.
//
// The Bot API doesn't send files — only links: first getFile for the path, then the file
// itself in a separate request. We give the image to the model natively (as the HTTP
// input does) and put it into the person's incoming/ so the tools can see it too. The
// model doesn't hear voice: only bytes here, and speech.ts turns it into text.
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

/** A Telegram photo is always JPEG, no matter what the shot was taken with. */
export const PHOTO_MIME = 'image/jpeg';

/** What the model can look at. Other images are more honest to send as a photo. */
export const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type IncomingImage = {
  /** base64 without the `data:` prefix — exactly what pi expects in the prompt command. */
  data: string;
  mimeType: string;
  /** Path inside the container: the tool will find the image by it. */
  file: string;
};

export type IncomingVoice = {
  audio: Buffer;
  mimeType: string;
  duration: number | null;
};

/**
 * What the person sent. We parse one attachment per message — that's how they're sent,
 * and its caption becomes the reply text.
 */
export type Incoming = {
  text: string;
  images: IncomingImage[];
  voice: IncomingVoice | null;
  /** An attachment we don't parse: “video”, “sticker”, “audio file”. */
  unsupported: string | null;
};

/**
 * Fetches the attachment and sorts it by kind. Throws if the file didn't download:
 * deciding what to tell the person is the bot's job.
 */
export async function collectIncoming(
  api: TelegramApi,
  message: TelegramMessage,
  incomingDir: string,
): Promise<Incoming> {
  // With an attachment the text is in the caption: “look what I found” arrives there.
  const text = (message.text ?? message.caption ?? '').trim();
  const incoming: Incoming = { text, images: [], voice: null, unsupported: null };

  // A location is not a file: there's nothing to download, and the place itself becomes the text
  // of the reply. A caption, if the person left one, stays on the first line.
  const place = placeText(message);
  if (place) {
    incoming.text = text === '' ? place : `${text}\n\n${place}`;
    return incoming;
  }

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

  // An image document is a common thing: that's how a screenshot is sent without Telegram compression.
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

/** An attachment we don't parse — in words: the bot will say this to the person. */
export function unsupportedKind(message: TelegramMessage): string | null {
  if (message.video_note) return 'видеосообщение';
  if (message.video) return 'видео';
  if (message.sticker) return 'стикер';
  if (message.audio) return 'аудиофайл';
  return null;
}

/** Where the map link leads: a pin by coordinates, outside any account. */
const MAP_URL = 'https://maps.google.com/?q=';

/**
 * A point on the map, said in words. Telegram sends coordinates and, for a venue, a name and an
 * address — the rest (“how do I get home from here”, “what's around”) the model does itself with
 * its tools. The point is written both the human way and as “lat,lon”: the transport scripts take
 * exactly that as a place name.
 */
export function placeText(message: TelegramMessage): string | null {
  const venue = message.venue;
  const location = venue?.location ?? message.location;
  if (!location) return null;

  const point = `${coordinate(location.latitude)},${coordinate(location.longitude)}`;
  // A venue is a check-in: the person chose a place by name, and its title is what they recognize.
  const named =
    venue === undefined ? '' : [venue.title, venue.address].map((part) => part.trim()).filter((part) => part !== '').join(', ');
  const head = named === '' ? `[локация] ${point}` : `[место] ${named} — ${point}`;
  return `${head} (на карте: ${MAP_URL}${point})`;
}

/** Coordinates to six decimals (about 0.1 m) and without the trailing zeroes Telegram pads with. */
function coordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * A file from Telegram storage: first the path, then the bytes. We check the size before
 * downloading, when Telegram has named it, and after — just in case: the Bot API doesn't
 * serve more than 20 MB, and it's better to say so right away than to wait for a timeout.
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

/** The largest size of the shot: Telegram sends one frame as a staircase. */
export function largestPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  return [...sizes].sort((a, b) => pixels(b) - pixels(a))[0];
}

function pixels(size: TelegramPhotoSize): number {
  return (size.width ?? 0) * (size.height ?? 0) || (size.file_size ?? 0);
}

/** We keep the document name human: Icarus understands from it what was sent to it. */
export function documentName(message: TelegramMessage, document: TelegramDocument): string {
  const original = safeName(document.file_name);
  const suffix = original === '' ? `.${extensionFor(document.mime_type ?? '')}` : `-${original}`;
  return `${fileStem(message)}${suffix}`;
}

/**
 * What the file is named after: the chat and the message number. One message number
 * alone is not enough — in a DM and in a group they number separately, and two
 * conversations would create one file.
 */
function fileStem(message: TelegramMessage): string {
  return `telegram-${message.chat.id}-${message.message_id}`;
}

/** Someone else's file name means someone else's “/” and “..”: we keep letters, digits, dot, hyphen, “_”. */
export function safeName(name: string | undefined): string {
  return (name ?? '')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[._]+/, '')
    .slice(0, 60);
}

/** Extension from the mime: `image/png` → `png`; an unknown one — `bin`. */
export function extensionFor(mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? '';
  return extension === '' ? 'bin' : extension;
}

/**
 * Puts the attachment into the person's incoming/: the path travels into the reply, and
 * the tool finds the image by it. The name is tied to the message the file came from,
 * not to the clock: that way you can see where it came from, and two shots in a row
 * don't compete for one file.
 */
function save(incomingDir: string, bytes: Buffer, name: string): string {
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.writeFileSync(path.join(incomingDir, name), bytes);
  return `${CONTAINER_INCOMING}/${name}`;
}
