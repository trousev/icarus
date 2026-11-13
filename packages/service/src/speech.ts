// Speech recognition: the model can't hear Telegram voice messages, so they are first
// converted to text. This is a regular call to the provider's OpenAI-compatible API —
// the /audio/transcriptions method (Whisper on DeepInfra) — with the same key that was shipped
// into the container for the models. Neither ffmpeg nor a separate service is needed for this:
// Telegram delivers voice messages as ready OGG/Opus, and the provider accepts them as is.
import type { IcarusConfig, SpeechConfig } from './config.ts';
import { redact } from './log.ts';

/** How long we wait for transcription: Whisper handles a minute of voice in seconds. */
export const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** What transcribes a voice message: voice bytes in, text out. */
export type Transcriber = (audio: Uint8Array, mimeType: string) => Promise<string>;

export type TranscribeOptions = {
  /** Overridden in tests: no need for the network there. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Transcriber from the config: recognition isn't set up (no provider key or
 * `speech: none`) — null, and the bot honestly says it doesn't understand voice messages.
 */
export function speechTranscriber(config: IcarusConfig, options: TranscribeOptions = {}): Transcriber | null {
  const speech = config.speech;
  if (!speech) return null;
  return (audio, mimeType) => transcribe(speech, audio, mimeType, options);
}

/** A voice message as a whole — to text. An empty string means "couldn't make out the speech". */
export async function transcribe(
  speech: SpeechConfig,
  audio: Uint8Array,
  mimeType: string,
  options: TranscribeOptions = {},
): Promise<string> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;

  const form = new FormData();
  // We set the part type explicitly: the provider looks at both it and the filename extension.
  // A copy of the bytes — because Blob only takes memory with a regular ArrayBuffer,
  // while Buffer comes with any (voice messages are small, the copy is cheaper than fighting the types).
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), audioName(mimeType));
  form.append('model', speech.model);
  // We ask for json: its response has a text field, not just a bare string.
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
    // The message from here will be seen by the human in the chat, so we explain undici's
    // "fetch failed" in Russian: the network didn't reach or the provider didn't respond in time.
    throw new Error(transportReason(error, timeoutMs), { cause: error });
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`распознавание не удалось (код ${response.status}): ${shorten(body)}`);
  }

  // The response didn't parse as JSON — so the provider responded with text, as it can
  // with response_format=text. This isn't an error: the transcription is that text.
  try {
    return transcriptFrom(JSON.parse(body));
  } catch {
    return body.trim();
  }
}

/** Why the request didn't get through: we name the timeout by its own word, the rest is the network cause. */
function transportReason(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `провайдер не ответил за ${Math.round(timeoutMs / 1000)} с`;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return `до провайдера не дошло: ${detail}`;
}

/** Provider response: for OpenAI-compatible it's `{ text }`, but it can also be a string. */
export function transcriptFrom(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  const text = (payload as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Filename in multipart: the provider infers the format from the extension. Telegram sends
 * voice messages as OGG/Opus, so an unfamiliar mime is treated as that.
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

/** Provider error body — on one line and without secrets. */
function shorten(body: string): string {
  const text = redact(body).replace(/\s+/g, ' ').trim().slice(0, 200);
  return text === '' ? 'пустой ответ' : text;
}
