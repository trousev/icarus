// Сверка истории, которую прислал LibreChat, с тем, что реально помнит сессия pi.
// Решение 14: сессия pi — истина, расхождения не ломают её, но логируются с диффом.

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

/** Достаём плоский текст из content любой формы (строка, блоки OpenAI, блоки pi). */
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

/** Оставляем только реплики диалога: системные сообщения и служебное не считаем. */
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
 * Якорь сравнения — реплики пользователя. Ответы ассистента pi дробит на несколько
 * сообщений (текст → тулы → текст), а LibreChat склеивает их в одно, поэтому сверять
 * их построчно нельзя: получим расхождение на каждом ходу с тулами.
 *
 * Ожидание: пользовательские реплики сессии — префикс присланных. Если да, история
 * согласована (даже если ассистента перегенерировали в UI). Если нет — правка или
 * другой разговор, пишем дифф.
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
