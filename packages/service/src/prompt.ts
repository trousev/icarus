// The reply for pi: the human's text plus the list of files already on disk.
//
// One place for all inputs — Telegram and the OpenAI client: however an attachment
// arrives, the model must see it the same way, at the same path and with the same
// note. Otherwise “the image didn't arrive” turns into two different stories.
export function buildPrompt(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((file) => `- ${file}`).join('\n');
  return `${text}\n\n[Пользователь приложил файлы, они уже лежат на диске:\n${list}]`;
}
