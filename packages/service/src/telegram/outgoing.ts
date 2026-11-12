// Файлы из ответа Икара в чат: локальная ссылка в markdown → настоящее вложение.
//
// Отдельного «отправь файл» у агента нет: единственный канал, который у него есть
// в обоих каналах, — markdown. Поэтому ссылку на файл в ответе читаем как просьбу
// его показать: панель рисует по этой же ссылке картинку (а по ссылке на не-картинку
// отдаёт файл), Telegram отправляет вложение (multipart, см. api.ts). Один способ
// у агента — одинаковый результат у человека.
//
// Что отправляем и чем: картинку — фотографией, если она влезает в 10 МБ; всё
// остальное (и большие картинки) — документом. GIF — всегда документом: фотографией
// Telegram пережмёт его в статичный кадр.
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

/** Ссылка на локальный файл в ответе агента: подпись человека и путь. */
export type FileRef = { label: string; target: string };

/**
 * Разметка ссылки: `![подпись](путь "заголовок")` и `[подпись](путь)`. Внутри
 * скобок берём всё до закрывающей: в человеческих именах бывают пробелы, и
 * `[смета](…/смета за март.pdf)` — такая же ссылка, как с `%20`.
 */
const MARKDOWN_REF = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

/** Путь из скобок ссылки: без заголовка `"…"` и без угловых скобок `<…>`. */
export function targetOf(inside: string): string {
  let target = inside.trim();
  const title = /\s+"[^"]*"$/.exec(target);
  if (title) target = target.slice(0, title.index).trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  return target;
}

/**
 * Ссылки на файлы в markdown — только локальные. Внешние адреса не трогаем:
 * их человек откроет сам, а скачивать чужую страницу в чат мы не будем.
 */
export function isLocalTarget(target: string): boolean {
  return /^(?:file:\/\/|\/workspaces\/|\/workspace\/|workspaces\/|workspace\/|\/artifacts\/|artifacts\/|incoming\/)/.test(
    target.trim(),
  );
}

/** Ссылки на локальные файлы в ответе, без повторов: один файл — одно вложение. */
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
 * Убирает из текста ссылки на локальные файлы: сами файлы уедут вложением, а
 * путь в сообщении человеку не нужен. Ссылка, стоящая отдельной строкой,
 * исчезает целиком (имя файла и подпись видно во вложении); внутри фразы
 * остаётся подпись — иначе из предложения выпало бы слово.
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
    // У картинки подпись — это будущий caption; у ссылки это имя файла. В строке
    // с другим текстом оставляем подпись словами, чтобы фраза не сломалась.
    stripped += text.slice(at, index) + (match[1] ? '' : (match[2] ?? '').trim());
    at = end;
  }
  stripped += text.slice(at);
  // Ссылка могла быть единственным содержимым абзаца: пустые строки подчищаем,
  // иначе в ответе остаётся висящая пустота.
  return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Вид вложения: фотография показывается в пузыре, документ — файлом. */
export type AttachmentKind = 'photo' | 'document';

/** Картинки, которые Telegram принимает именно фотографией. */
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Как отправить файл: по типу, а не по расширению — расширение бывает и `bin`. */
export function attachmentKind(mimeType: string, bytes: number): AttachmentKind {
  const type = mimeType.split(';')[0]?.trim() ?? mimeType;
  if (!PHOTO_TYPES.has(type)) return 'document';
  // 10 МБ — предел фотографии: большая картинка доедет документом, но доедет.
  return bytes > TELEGRAM_PHOTO_LIMIT ? 'document' : 'photo';
}

/**
 * Имя файла для человека. Подпись из ответа (`![сравнение цен](…)`) понятнее
 * имени на диске, но без расширения Telegram не поймёт, что это за документ, —
 * поэтому расширение оригинала оставляем.
 */
export function humanName(label: string, file: string): string {
  const extension = path.extname(file);
  const stem = sanitizeName(label) || sanitizeName(path.basename(file, extension)) || 'файл';
  const named =
    extension && !stem.toLowerCase().endsWith(extension.toLowerCase()) ? `${stem}${extension}` : stem;
  return named.slice(0, 64);
}

/**
 * Чужое имя — это чужие «/» и «..»: оставляем буквы, цифры, пробел, точку, дефис
 * и «_». Скобки и решётки выкидываем — Telegram показывает имя в шапке файла.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[._\s]+/, '')
    .trim();
}

/** Готовый файл к отправке: то, что нужно методу api. */
export type OutgoingFile = UploadFile & { kind: AttachmentKind; caption: string };

/** Результат подготовки: файл или причина, по которой его не отправить. */
export type PreparedFile = { ok: true; file: OutgoingFile } | { ok: false; name: string; reason: string };

/**
 * Собирает вложение из ссылки ответа: читает байты, выбирает имя и вид.
 * Ошибки здесь — человеческие: их увидит человек в чате, а не только лог.
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
      // Подпись — то, что модель написала подписью к ссылке. Без неё вложение
      // уедет без пояснения, а имя и так видно в шапке файла.
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

/** Отправляет файлы из ответа по одному: сбой одного не отменяет остальные. */
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
 * Почему файл не доехал — словами для человека. Молча терять вложение нельзя:
 * агент написал «вот график», и человек ждёт график.
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

/** Служебная строка после хода: какие файлы не доехали и почему. */
export function filesFailedText(errors: DeliverResult['errors']): string {
  return ['⚠️ Не смог отправить файл:', ...errors.map((item) => `— «${item.name}»: ${item.reason}`)].join('\n');
}
