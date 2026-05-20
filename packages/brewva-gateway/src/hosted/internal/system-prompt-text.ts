const ENVIRONMENT_BLOCK_PATTERN =
  /\n\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: .+$/u;

export function appendHostedSystemPromptSection(input: {
  systemPrompt: string;
  section: string;
}): string {
  const section = input.section.trim();
  if (!section) {
    return input.systemPrompt;
  }
  const base = input.systemPrompt.trimEnd();
  if (!base) {
    return section;
  }
  const environmentBlock = ENVIRONMENT_BLOCK_PATTERN.exec(input.systemPrompt);
  if (!environmentBlock || environmentBlock.index === undefined) {
    return `${base}\n\n${section}`;
  }
  return `${input.systemPrompt.slice(0, environmentBlock.index)}\n\n${section}${input.systemPrompt.slice(environmentBlock.index)}`;
}
