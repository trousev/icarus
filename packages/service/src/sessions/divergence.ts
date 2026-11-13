// Comparing the history sent by the OpenAI client against what the pi session actually remembers.
// Decision 14: the pi session is the truth, divergences don't break it, but they are logged with a diff.

export type IncomingMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

export type SessionMessage = {
  role?: string;
  content?: unknown;
};

export type Turn = { role: 'user' | 'assistant'; text: string };

export type Comparison = {
  diverged: boolean;
  reason: string;
  diff: string;
  newUserText: string;
};

/** Extract flat text from content of any shape (string, OpenAI blocks, pi blocks). */
export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as { type?: string; text?: string };
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

/** Keep only dialogue turns: we don't count system messages and service ones. */
export function toTurns(messages: Array<IncomingMessage | SessionMessage>): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = normalizeContent(message.content).trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

function short(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * The comparison anchor is the user turns. pi splits the assistant's answers into several
 * messages (text → tools → text), while the client merges them into one, so they can't be
 * compared line by line: we'd get a divergence on every turn with tools.
 *
 * Expectation: the session's user turns are a prefix of the incoming ones. If so, the history
 * is consistent (even if the assistant was regenerated in the UI). If not — an edit or
 * a different conversation, we write a diff.
 */
export function compareHistory(
  incoming: IncomingMessage[],
  session: SessionMessage[],
): Comparison {
  const incomingUsers = toTurns(incoming).filter((turn) => turn.role === 'user');
  const sessionUsers = toTurns(session).filter((turn) => turn.role === 'user');
  const newUserText = incomingUsers[incomingUsers.length - 1]?.text ?? '';

  if (incomingUsers.length === 0) {
    return { diverged: true, reason: 'в запросе нет ни одной реплики пользователя', diff: '', newUserText };
  }
  if (sessionUsers.length === 0) {
    return { diverged: false, reason: 'новая сессия', diff: '', newUserText };
  }

  const lines: string[] = [];
  let firstMismatch = -1;

  for (let i = 0; i < sessionUsers.length; i += 1) {
    const expected = sessionUsers[i];
    const got = incomingUsers[i];
    if (!got || got.text !== expected.text) {
      firstMismatch = i;
      lines.push(`  реплика пользователя ${i + 1}`);
      lines.push(`    в сессии: ${short(expected.text)}`);
      lines.push(`    пришло:   ${got ? short(got.text) : '(нет)'}`);
      break;
    }
  }

  if (firstMismatch === -1 && incomingUsers.length < sessionUsers.length) {
    lines.push(
      `  реплик пользователя меньше, чем в сессии: пришло ${incomingUsers.length}, в сессии ${sessionUsers.length}`,
    );
  }

  if (lines.length === 0) {
    return { diverged: false, reason: 'история совпала', diff: '', newUserText };
  }

  return {
    diverged: true,
    reason: firstMismatch === -1 ? 'история короче сессии' : `расхождение на реплике ${firstMismatch + 1}`,
    diff: lines.join('\n'),
    newUserText,
  };
}
