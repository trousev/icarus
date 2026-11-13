// Skill catalog for the system prompt.
//
// The persona (persona.ts) REPLACES the pi system prompt entirely, and pi inserts the skill
// catalog only into its own prompt builder — before the replacement. So we build the catalog
// here ourselves, repeating pi's format (core/skills.ts, formatSkillsForPrompt):
// models find it "familiar", and there is no reason to deviate from it.
//
// The skill itself does not go into the prompt: only the name, description and path. The model
// reads the body with a normal read when a task matches the description.

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

/** Which tool is named in the hint: in pi it is read if present, otherwise bash. */
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
