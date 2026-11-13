// Memory core: what Icarus knows about the person right away, without going into files.
// The core holds only "who they are" and "how to talk to them". People and projects don't go here:
// first `memory_index` returns files with descriptions, then the model reads what it selected.
// Otherwise facts in the prompt become a reason to change the subject — exactly what people complained about.
//
// Each item carries a month tag for when it appeared in memory: `- [2026-03] text`
// from git blame by line author time. The tag shows what's outdated and what's fresh.
// The tag doesn't change until memory itself changes, so the prompt is stable for the model's
// cache. No git, memory isn't a repository, the line isn't committed — we quietly return the text
// without the tag: the memory core is more important than the decoration.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripFrontmatter } from "./memory-catalog.ts";

const ICARUS = process.env.ICARUS_HOME ?? "/workspaces/.icarus";
const MEMORY = process.env.ICARUS_MEMORY_DIR ?? `${ICARUS}/memory`;
const LIMIT_PER_FILE = 1200;
const LIMIT_TOTAL = 6000;

/** Cache of ages by mtime and file size: otherwise git would be called every turn. */
type AgeEntry = { key: string; ages: Map<number, string> };
const AGE_CACHE = new Map<string, AgeEntry>();

/** Month from the line author time: `2026-03`. */
function monthOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 7);
}

/** Parses `git blame --line-porcelain`: file line number → month it was changed. */
function parseBlame(output: string): Map<number, string> {
  const ages = new Map<number, string>();
  let sha = '';
  let lineNumber = 0;
  let authorTime: number | null = null;
  for (const row of output.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (header) {
      sha = header[1];
      lineNumber = Number(header[2]);
      authorTime = null;
      continue;
    }
    const time = /^author-time (\d+)$/.exec(row);
    if (time) {
      authorTime = Number(time[1]);
      continue;
    }
    if (!row.startsWith('\t')) continue;
    // Zero sha — the line isn't committed yet: it has no date, we don't invent a tag.
    if (authorTime !== null && !/^0+$/.test(sha)) ages.set(lineNumber - 1, monthOf(authorTime));
  }
  return ages;
}

/** Asks git about the file's lines. No git, no repository — empty and quiet. */
function blameAges(file: string): Map<number, string> {
  const result = spawnSync(
    'git',
    ['-C', path.dirname(file), 'blame', '--line-porcelain', '--', path.basename(file)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0 || !result.stdout) return new Map();
  return parseBlame(result.stdout);
}

/**
 * Line ages with a cache by mtime and size. We don't cache an empty result:
 * lines could have been committed after the first read, and the file's mtime doesn't
 * change on commit — otherwise the tag would never appear.
 */
export function memoryAges(file: string): Map<number, string> {
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Map();
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = AGE_CACHE.get(file);
  if (cached && cached.key === key) return cached.ages;

  const ages = blameAges(file);
  if (ages.size > 0) AGE_CACHE.set(file, { key, ages });
  else AGE_CACHE.delete(file);
  return ages;
}

/** Resets the age cache: needed by tests so they don't depend on run order. */
export function clearMemoryAges(): void {
  AGE_CACHE.clear();
}

/** Inserts `- [2026-03] text`. We don't change the item text itself. */
export function annotateAges(file: string, text: string): string {
  const ages = memoryAges(file);
  if (ages.size === 0) return text;
  return text
    .split('\n')
    .map((line, index) => {
      const age = ages.get(index);
      if (!age) return line;
      const bullet = /^(\s*[-*]\s+)(.*)$/.exec(line);
      if (!bullet) return line;
      return `${bullet[1]}[${age}] ${bullet[2]}`;
    })
    .join('\n');
}

function readAnnotated(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  // The file description is metadata for the index, not a fact about the person: it doesn't go into the core.
  return stripFrontmatter(annotateAges(file, raw)).trim();
}

function clip(text: string, limit = LIMIT_PER_FILE): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n… (дальше сам, файл целиком по пути)`;
}

/**
 * The core — only "who they are" and "how to talk to them". People and projects don't go here:
 * first `memory_index` returns files with descriptions, then the model reads what it selected.
 * Otherwise facts in the prompt become a reason to change the subject — that's what people complained about.
 */
export function buildMemoryCore(root = MEMORY): string {
  const parts: string[] = [];
  const identity = readAnnotated(path.join(root, 'identity.md'));
  const preferences = readAnnotated(path.join(root, 'preferences.md'));

  if (identity) parts.push(`## Кто это\n${clip(identity)}`);
  if (preferences) parts.push(`## Предпочтения\n${clip(preferences)}`);

  const total = parts.join('\n\n');
  if (!total) return '';
  return clip(total, LIMIT_TOTAL);
}

/**
 * The "Memory core" block for the system prompt. It lives next to the facts themselves because
 * the temptation starts right here: the model takes "I know this" as a reason to
 * change the conversation ("by the way, …"). Memory is for answering their topic, not for choosing a topic.
 */
export function memoryPrompt(core: string): string {
  if (!core) return '';
  return [
    '# Ядро памяти',
    'Это справка о собеседнике, а не тема разговора. Не переспрашивай и не перечитывай файлы без нужды:',
    'если ответ есть здесь — отвечай им. Советуешь, планируешь или вспоминаешь — сначала `memory_index`, потом читай выбранные файлы.',
    'Люди и проекты лежат в памяти, а не здесь: выбери их по индексу и прочитай.',
    '',
    core,
    '',
    `Полная память лежит в ${MEMORY}/, семейная — в ${ICARUS}/shared-memory/.`,
    // The rule goes last: it closes the block so the facts aren't read as an invitation
    // to change the conversation, but also doesn't forbid searching memory to answer.
    'Память отвечает, а не начинает: не делай её темой, вопросом, шуткой или утешением. Для ответа — ищи и используй.',
  ].join('\n');
}

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const block = memoryPrompt(buildMemoryCore());
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${block}` };
  });
}
