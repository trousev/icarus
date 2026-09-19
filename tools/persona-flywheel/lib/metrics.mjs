// Дешёвые метрики поверх диалогов: длина, плотность шуток, служебные штампы.
export const MARKERS = [
  "отличный вопрос",
  "с удовольствием помогу",
  "чем могу быть полезен",
  "чем могу помочь",
  "как я могу помочь",
  "я здесь, чтобы помочь",
  "рад помочь",
  "давайте разберёмся",
  "давай разберёмся по шагам",
  "надеюсь, это поможет",
  "если у вас есть",
  "сочус",
  "сожалею",
];

const LAUGH = /(ахах|хаха|хех|аха|лол|🤣|😂|😄|🙂|смешно|ору|ржу|шутк|подкол|сарказ|ирония|мем|абсурд)/i;
const PUNCH = /[—–-]\s|\.\.\.|!|\?|«|»|как |будто |словно |представь|напоминает|типа |ровно |ровно как/i;

// грубая, но устойчивая оценка: реплика считается шутливой, если в ней есть
// игровая лексика, сравнение, вопрос-подначка или восклицание при короткой длине
export function looksLikeJoke(text) {
  if (!text) return false;
  if (LAUGH.test(text)) return true;
  const sentences = text.split(/\n+/).filter((line) => line.trim());
  const playful = PUNCH.test(text) && sentences.length <= 6;
  const shortJab = text.length < 220 && /\?|!/.test(text);
  return playful || shortJab;
}

export function dialogueMetrics(dialogue) {
  const icarusTurns = dialogue.filter((turn) => turn.role === "icarus");
  if (!icarusTurns.length) return { turns: 0, chars: 0, jokes: 0, jokeRate: 0, stamps: 0, ownTurns: 0 };
  const chars = icarusTurns.reduce((sum, turn) => sum + turn.text.length, 0);
  const jokes = icarusTurns.filter((turn) => looksLikeJoke(turn.text)).length;
  const stamps = icarusTurns.reduce((sum, turn) => sum + MARKERS.filter((marker) => turn.text.toLowerCase().includes(marker)).length, 0);
  const userTurns = dialogue.filter((turn) => turn.role === "user").length;
  return {
    turns: icarusTurns.length,
    chars: Math.round(chars / icarusTurns.length),
    jokes,
    jokeRate: Math.round((jokes / icarusTurns.length) * 100) / 100,
    stamps,
    userTurns,
  };
}
