// Files from Icarus's reply into the chat: a local link in markdown → a real attachment.
//
// The agent has no separate "send file": the only channel it has in both channels is
// markdown. So we read a file link in the reply as a request to show it: the panel draws
// an image from that same link (and for a non-image link it serves the file), Telegram sends
// an attachment (multipart, see api.ts). One way for the agent — the same result for the person.
//
// What we send and how: an image — as a photo if it fits within 10 MB; everything else
// (including large images) — as a document. GIF — always a document: as a photo
// Telegram would recompress it into a static frame.
import fs from 'node:fs';
import path from 'node:path';
import type { IcarusConfig, UserConfig } from '../config.ts';
import { log } from '../log.ts';
import { localFileOf } from '../local-files.ts';
import {
  CAPTION_LIMIT,
  describeTelegramError,
  TelegramError,
  TELEGRAM_PHOTO_LIMIT,
  TELEGRAM_UPLOAD_LIMIT,
  UploadTooBigError,
  type TelegramApi,
  type UploadFile,
  type UploadOptions,
} from './api.ts';

/** A link to a local file in the agent's reply: the human caption and the path. */
export type FileRef = { label: string; target: string };

/**
 * Link markup: `![caption](path "title")` and `[caption](path)`. Inside
 * the parentheses we take everything up to the closing one: human names have spaces, and
 * `[estimate](…/march estimate.pdf)` is the same link as with `%20`.
 */
const MARKDOWN_REF = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

/** The path from the link parentheses: without the `"…"` title and without the angle brackets `<…>`. */
export function targetOf(inside: string): string {
  let target = inside.trim();
  const title = /\s+"[^"]*"$/.exec(target);
  if (title) target = target.slice(0, title.index).trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  return target;
}

/**
 * File links in markdown are local only. We don't touch external addresses:
 * the person will open them themselves, and we won't download someone else's page into the chat.
 */
export function isLocalTarget(target: string): boolean {
  return /^(?:file:\/\/|\/workspaces\/|\/workspace\/|workspaces\/|workspace\/|\/artifacts\/|artifacts\/|incoming\/)/.test(
    target.trim(),
  );
}

/** Links to local files in the reply, without duplicates: one file — one attachment. */
export function answerFiles(text: string): FileRef[] {
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  for (const match of text.matchAll(MARKDOWN_REF)) {
    const target = targetOf(match[3] ?? '');
    if (!isLocalTarget(target) || seen.has(target)) continue;
    seen.add(target);
    refs.push({ label: (match[2] ?? '').trim(), target });
  }
  return refs;
}

/**
 * Removes local file links from the text: the files themselves travel as attachments, and
 * the person doesn't need the path in the message. A link that stands on its own line
 * disappears entirely (the file name and caption are visible in the attachment); inside a phrase
 * the caption remains — otherwise a word would drop out of the sentence.
 */
export function stripLocalRefs(text: string): string {
  let stripped = '';
  let at = 0;
  for (const match of text.matchAll(MARKDOWN_REF)) {
    if (!isLocalTarget(targetOf(match[3] ?? ''))) continue;
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    const before = text.slice(lineStart, index);
    const after = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
    if (before.trim() === '' && after.trim() === '') {
      const cutTo = lineEnd === -1 ? text.length : lineEnd + 1;
      stripped += text.slice(at, Math.max(at, lineStart));
      at = cutTo;
      continue;
    }
    // For an image the caption is the future caption; for a link it's the file name. On a line
    // with other text we keep the caption as words so the phrase doesn't break.
    stripped += text.slice(at, index) + (match[1] ? '' : (match[2] ?? '').trim());
    at = end;
  }
  stripped += text.slice(at);
  // The link could be the only content of a paragraph: we clean up empty lines,
  // otherwise dangling emptiness remains in the reply.
  return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Attachment kind: a photo is shown in a bubble, a document — as a file. */
export type AttachmentKind = 'photo' | 'document';

/** Images that Telegram accepts specifically as a photo. */
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** How to send the file: by type, not by extension — the extension can even be `bin`. */
export function attachmentKind(mimeType: string, bytes: number): AttachmentKind {
  const type = mimeType.split(';')[0]?.trim() ?? mimeType;
  if (!PHOTO_TYPES.has(type)) return 'document';
  // 10 MB is the photo limit: a large image will arrive as a document, but it will arrive.
  return bytes > TELEGRAM_PHOTO_LIMIT ? 'document' : 'photo';
}

/**
 * The file name for a human. The caption from the reply (`![price comparison](…)`) is clearer
 * than the name on disk, but without an extension Telegram won't understand what kind of document
 * it is — so we keep the original's extension.
 */
export function humanName(label: string, file: string): string {
  const extension = path.extname(file);
  const stem = sanitizeName(label) || sanitizeName(path.basename(file, extension)) || 'файл';
  const named =
    extension && !stem.toLowerCase().endsWith(extension.toLowerCase()) ? `${stem}${extension}` : stem;
  return named.slice(0, 64);
}

/**
 * A foreign name means foreign "/" and "..": we keep letters, digits, space, dot, hyphen,
 * and "_". We drop brackets and hashes — Telegram shows the name in the file header.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[._\s]+/, '')
    .trim();
}

/** A ready file to send: what the api method needs. */
export type OutgoingFile = UploadFile & { kind: AttachmentKind; caption: string };

/** Preparation result: the file or the reason why it can't be sent. */
export type PreparedFile = { ok: true; file: OutgoingFile } | { ok: false; name: string; reason: string };

/**
 * Builds an attachment from a reply link: reads the bytes, picks the name and kind.
 * The errors here are human-facing: a person in the chat will see them, not just the log.
 */
export function prepareFile(config: IcarusConfig, user: UserConfig, ref: FileRef): PreparedFile {
  const name = ref.label || path.basename(ref.target);
  const found = localFileOf(config, user, ref.target);
  if (!found) return { ok: false, name, reason: 'файл не найден или недоступен' };

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(found.file);
  } catch (error) {
    log.warn('телеграм: файл не прочитался', { file: found.file, error: String(error) });
    return { ok: false, name, reason: 'файл не читается' };
  }
  if (bytes.length === 0) return { ok: false, name, reason: 'файл пустой' };
  if (bytes.length > TELEGRAM_UPLOAD_LIMIT) {
    const limit = Math.round(TELEGRAM_UPLOAD_LIMIT / (1024 * 1024));
    return { ok: false, name, reason: `файл больше ${limit} МБ — Telegram такое не принимает` };
  }

  return {
    ok: true,
    file: {
      bytes,
      name: humanName(ref.label, found.file),
      mimeType: found.type,
      kind: attachmentKind(found.type, bytes.length),
      // The caption is what the model wrote as the link caption. Without it the attachment
      // travels without an explanation, and the name is already visible in the file header.
      caption: ref.label.slice(0, CAPTION_LIMIT),
    },
  };
}

export type DeliverOptions = {
  threadId?: number | null;
};

export type DeliverResult = {
  sent: number;
  errors: Array<{ name: string; reason: string }>;
};

/** Sends the files from the reply one by one: a failure of one doesn't cancel the rest. */
export async function deliverFiles(
  api: TelegramApi,
  config: IcarusConfig,
  user: UserConfig,
  chatId: number,
  refs: FileRef[],
  options: DeliverOptions = {},
): Promise<DeliverResult> {
  const result: DeliverResult = { sent: 0, errors: [] };
  for (const ref of refs) {
    const prepared = prepareFile(config, user, ref);
    if (!prepared.ok) {
      result.errors.push({ name: prepared.name, reason: prepared.reason });
      continue;
    }
    const { file } = prepared;
    const upload: UploadOptions = {
      ...(file.caption ? { caption: file.caption } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    };
    try {
      if (file.kind === 'photo') await api.sendPhoto(chatId, file, upload);
      else await api.sendDocument(chatId, file, upload);
      result.sent += 1;
    } catch (error) {
      const reason = uploadReason(error);
      log.warn('телеграм: файл не отправился', { name: file.name, error: describeTelegramError(error) });
      result.errors.push({ name: file.name, reason });
    }
  }
  return result;
}

/**
 * Why the file didn't arrive — in words for a human. We can't silently lose an attachment:
 * the agent wrote "here's the chart", and the person expects the chart.
 */
export function uploadReason(error: unknown): string {
  if (error instanceof UploadTooBigError) return error.message;
  if (error instanceof TelegramError) {
    if (error.code === 413) return 'Telegram отказал: файл слишком большой';
    if (error.code === 401) return 'Telegram не принял токен бота';
    return `Telegram: ${error.message.replace(/^telegram: /, '')}`;
  }
  return describeTelegramError(error);
}

/** A service line after the turn: which files didn't arrive and why. */
export function filesFailedText(errors: DeliverResult['errors']): string {
  return ['⚠️ Не смог отправить файл:', ...errors.map((item) => `— «${item.name}»: ${item.reason}`)].join('\n');
}
