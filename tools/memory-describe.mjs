#!/usr/bin/env node
// Заполняет короткие описания файлов памяти для индекса.
//
//   node tools/memory-describe.mjs --memory /path/to/memory
//   node tools/memory-describe.mjs --memory /path/to/memory --force
//   node tools/memory-describe.mjs --memory /path/to/memory --dry
//
// Описание — одна строка в frontmatter файла. Уже написанные не трогаем без --force.
// Модель по умолчанию — deepseek-flash; ключ DEEPSEEK_API_KEY. Для DeepInfra задай
// ICARUS_DESCRIBE_URL и ICARUS_DESCRIBE_MODEL.
import fs from "node:fs";
import { buildCatalog, stripFrontmatter, updateDescription } from "../packages/extensions/lib/memory-catalog.ts";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const root = arg("memory", process.env.ICARUS_MEMORY_DIR);
if (!root) {
  console.error("[x] укажи --memory или ICARUS_MEMORY_DIR");
  process.exit(1);
}

const URL = process.env.ICARUS_DESCRIBE_URL ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.ICARUS_DESCRIBE_MODEL ?? "deepseek-flash";
const KEY = process.env.ICARUS_DESCRIBE_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.DEEPINFRA_API_KEY ?? "";
if (!KEY) {
  console.error("[x] нет ключа: DEEPSEEK_API_KEY (или ICARUS_DESCRIBE_KEY)");
  process.exit(1);
}

const dry = has("dry");
const force = has("force");
const files = buildCatalog(root).filter((file) => force || !file.hasDescription);
if (files.length === 0) {
  console.log("все описания уже на месте");
  process.exit(0);
}

function clean(text) {
  return String(text ?? "")
    .split("\n")[0]
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;]+$/, "")
    .slice(0, 160);
}

async function describe(file) {
  const body = stripFrontmatter(fs.readFileSync(file.abs, "utf8")).trim().slice(0, 3000);
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "Ты пишешь короткое описание файла памяти для индекса. Одна строка, до 120 символов, " +
            "по-русски, без кавычек и точки в конце. Скажи, что в файле лежит, а не пересказывай всё.",
        },
        { role: "user", content: `Файл: ${file.rel}\n\nСодержимое:\n${body}` },
      ],
      max_tokens: 120,
      temperature: 0.2,
      reasoning_effort: "none",
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  return clean(data.choices?.[0]?.message?.content);
}

for (const file of files) {
  try {
    const description = await describe(file);
    if (!description) {
      console.error(`[!] ${file.rel}: модель вернула пусто`);
      continue;
    }
    if (dry) {
      console.log(`${file.rel} — ${description}`);
      continue;
    }
    const result = updateDescription(file.rel, description, root);
    if (!result.ok) {
      console.error(`[!] ${file.rel}: ${result.error}`);
      continue;
    }
    console.log(`${file.rel} — ${description}`);
  } catch (error) {
    console.error(`[!] ${file.rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\nобработано: ${files.length}${dry ? " (dry run, не записано)" : ""}`);
