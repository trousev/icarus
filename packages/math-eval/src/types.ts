// Типы math-eval: набор задач, ответ модели и итог одной попытки.
//
// Отдельный пакет, а не тест сервиса: прогон бенчмарка — это не проверка кода,
// а измерение агента, и живёт он своей жизнью (сеть, минуты, отчёты).

/** answer — эталон известен; refusal — проверяем честность отказа (правило MAPLE.md). */
export type ProblemKind = 'answer' | 'refusal';

export type Problem = {
  id: string;
  category: string;
  tier: 'smoke' | 'full';
  kind: ProblemKind;
  question: string;
  /** Приемлемые эталоны в Maple-синтаксисе; у kind=refusal пусто. */
  answers: string[];
  /** Команда Maple, которой эталон проверен. Не выполняется прогоном — это протокол. */
  verify?: string;
  notes?: string;
};

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

/** Итог одной попытки: что спросили, что ответили, сошлось ли. */
export type Outcome = {
  id: string;
  category: string;
  arm: string;
  repeat: number;
  ok: boolean;
  /** Короткое объяснение вердикта: «сошлось с эталоном», «ответ не найден в тексте» и т.п. */
  reason: string;
  extracted: string | null;
  expected: string[];
  content: string;
  reasoning: string;
  ms: number;
  /** Сколько шагов дописано в журналы Maple за время задачи: видел ли агент Maple вообще. */
  mapleSteps: number;
  usage: Usage | null;
  error: string | null;
};

export type RunMeta = {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  model: string;
  user: string;
  arm: string;
  suite: string;
  grader: 'strict' | 'maple';
  repeat: number;
  problems: number;
};
