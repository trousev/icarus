// Распознавание речи: голосовые из Telegram модель не слышит, поэтому их сначала
// перекладывают в текст. Это обычный вызов OpenAI-совместимого API провайдера —
// метод /audio/transcriptions (у DeepInfra это Whisper), — тем же ключом, что уехал
// в контейнер для моделей. Ни ffmpeg, ни отдельного сервиса для этого не нужно:
// Telegram отдаёт голосовые готовым OGG/Opus, а провайдер принимает их как есть.
import type { IcarusConfig, SpeechConfig } from './config.ts';
import { redact } from './log.ts';

/** Сколько ждём расшифровку: голосовое в минуту Whisper разбирает за секунды. */
export const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Чем расшифровывают голосовое: голосовые байты на входе, текст на выходе. */
export type Transcriber = (audio: Uint8Array, mimeType: string) => Promise<string>;

export type TranscribeOptions = {
  /** Подменяется в тестах: сеть там ни к чему. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Расшифровщик по конфигу: распознавание не настроено (нет ключа провайдера или
 * `speech: none`) — null, и бот честно скажет, что голосовых не понимает.
 */
export function speechTranscriber(config: IcarusConfig, options: TranscribeOptions = {}): Transcriber | null {
  const speech = config.speech;
  if (!speech) return null;
  return (audio, mimeType) => transcribe(speech, audio, mimeType, options);
}

/** Голосовое целиком — в текст. Пустая строка значит «речи не разобрал». */
export async function transcribe(
  speech: SpeechConfig,
  audio: Uint8Array,
  mimeType: string,
  options: TranscribeOptions = {},
): Promise<string> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;

  const form = new FormData();
  // Тип части ставим явно: провайдер смотрит и на него, и на расширение имени.
  // Копия байтов — потому что Blob берёт только память с обычным ArrayBuffer,
  // а Buffer приходит с любым (голосовые маленькие, копия дешевле спора с типами).
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), audioName(mimeType));
  form.append('model', speech.model);
  // Просим json: у него в ответе есть поле text, а не только голая строка.
  form.append('response_format', 'json');
  if (speech.language) form.append('language', speech.language);

  let response: Response;
  try {
    response = await request(`${speech.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${speech.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Сообщение отсюда увидит человек в чате, поэтому «fetch failed» от undici
    // объясняем по-русски: сеть не дошла или провайдер не ответил вовремя.
    throw new Error(transportReason(error, timeoutMs), { cause: error });
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`распознавание не удалось (код ${response.status}): ${shorten(body)}`);
  }

  // Ответ не разобрался как JSON — значит, провайдер ответил текстом, как умеет
  // response_format=text. Это не ошибка: расшифровка и есть этот текст.
  try {
    return transcriptFrom(JSON.parse(body));
  } catch {
    return body.trim();
  }
}

/** Почему запрос не дошёл: таймаут называем своим словом, остальное — причиной сети. */
function transportReason(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `провайдер не ответил за ${Math.round(timeoutMs / 1000)} с`;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return `до провайдера не дошло: ${detail}`;
}

/** Ответ провайдера: у OpenAI-совместимого это `{ text }`, но бывает и строка. */
export function transcriptFrom(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  const text = (payload as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Имя файла в multipart: по расширению провайдер понимает формат. Telegram шлёт
 * голосовые в OGG/Opus, поэтому незнакомый mime считаем за него.
 */
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

export function audioName(mimeType: string): string {
  return `voice.${AUDIO_EXTENSIONS[mimeType.toLowerCase()] ?? 'ogg'}`;
}

/** Тело ошибки провайдера — в одну строку и без секретов. */
function shorten(body: string): string {
  const text = redact(body).replace(/\s+/g, ' ').trim().slice(0, 200);
  return text === '' ? 'пустой ответ' : text;
}
