// Каталог скиллов для системного промпта.
//
// Персона (persona.ts) ЗАМЕНЯЕТ системный промпт pi целиком, а pi вставляет каталог
// скиллов только в свой собственный сборщик промпта — до замены. Поэтому каталог
// собираем здесь сами, повторяя формат pi (core/skills.ts, formatSkillsForPrompt):
// у моделей он «привычный», и отступать от него без причины не стоит.
//
// Сам скилл в промпт не едет: там только имя, описание и путь. Тело модели читают
// обычным read, когда задача совпала с описанием.

export type SkillEntry = {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Какой тул называется в подсказке: у pi это read, если он есть, иначе bash. */
export function skillFileReadTool(tools: string[]): 'read' | 'bash' | null {
  if (tools.includes('read')) return 'read';
  if (tools.includes('bash')) return 'bash';
  return null;
}

export function formatSkillsBlock(skills: SkillEntry[], tools: string[]): string {
  const readTool = skillFileReadTool(tools);
  const visible = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (!readTool || visible.length === 0) return '';

  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    readTool === 'read'
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use bash to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}
