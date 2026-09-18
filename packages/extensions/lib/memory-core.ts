// Ядро памяти: то, что Икар должен знать про человека сразу, без похода в файлы.
// Работает вторым обработчиком before_agent_start и дописывает блок к промпту,
// который уже собрала персона.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";
const LIMIT_PER_FILE = 1200;
const LIMIT_TOTAL = 6000;

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function clip(text: string, limit = LIMIT_PER_FILE): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n… (дальше сам, файл целиком по пути)`;
}

/** Первые содержательные строки файла: для списков людей и проектов хватает шапки. */
function headings(dir: string, perFile = 240): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  return entries.sort().map((name) => {
    const body = clip(readFileSafe(path.join(dir, name)), perFile);
    return `### ${name.replace(/\.md$/, '')}\n${body}`;
  });
}

export function buildMemoryCore(root = MEMORY): string {
  const parts: string[] = [];
  const identity = readFileSafe(path.join(root, 'identity.md'));
  const preferences = readFileSafe(path.join(root, 'preferences.md'));

  if (identity) parts.push(`## Кто это\n${clip(identity)}`);
  if (preferences) parts.push(`## Предпочтения\n${clip(preferences)}`);

  const people = headings(path.join(root, 'people'));
  if (people.length > 0) parts.push(`## Люди\n${people.join('\n\n')}`);

  const projects = headings(path.join(root, 'projects'), 200);
  if (projects.length > 0) parts.push(`## Темы и дела\n${projects.join('\n\n')}`);

  const total = parts.join('\n\n');
  if (!total) return '';
  return clip(total, LIMIT_TOTAL);
}

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const core = buildMemoryCore();
    if (!core) return;

    const block = [
      '# Ядро памяти',
      'Это ты уже знаешь про собеседника. Не переспрашивай и не перечитывай эти файлы без нужды:',
      'если ответ есть здесь — отвечай сразу. За деталями (журнал, полные файлы) иди в память сам.',
      '',
      core,
      '',
      `Полная память лежит в ${MEMORY}/, семейная — в /workspace/shared-memory/.`,
    ].join('\n');

    return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${block}` };
  });
}
