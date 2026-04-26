export interface BrewvaSystemPromptSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir?: string;
}

export interface BuildBrewvaSystemPromptOptions {
  /**
   * Custom base prompt text. Brewva-owned canonical sections such as
   * Communication are still appended by the prompt builder.
   */
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: BrewvaSystemPromptSkill[];
}

const DEFAULT_COMMUNICATION_SECTION = `Communication:
- Start with one direct conclusion sentence.
- Use Markdown tables for three or more comparable items.
- Use Mermaid for flows, dependencies, state changes, timing, or replay analysis.
- Put each table or diagram immediately after the sentence it supports.
- Do not restate a table or diagram in prose.
- If the channel cannot render a table or diagram, fall back to readable text or source.
- Do not use emoji, praise openings, exclamation marks, or thanks for tool results.`;

function formatSkillsForPrompt(skills: readonly BrewvaSystemPromptSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = ["", "", "# Available Skills", ""];
  for (const skill of skills) {
    const location = skill.baseDir ?? skill.filePath;
    lines.push(`- ${skill.name}: ${skill.description}`);
    lines.push(`  Location: ${location}`);
  }
  return lines.join("\n");
}

export function buildBrewvaSystemPrompt(options: BuildBrewvaSystemPromptOptions = {}): string {
  const cwd = (options.cwd ?? process.cwd()).replace(/\\/gu, "/");
  const date = new Date().toISOString().slice(0, 10);
  const selectedTools = options.selectedTools ?? ["read", "exec", "edit", "write"];
  const toolSnippets = options.toolSnippets ?? {};
  const promptGuidelines = new Set<string>();
  const hasExec = selectedTools.includes("exec");
  const hasRead = selectedTools.includes("read");
  const hasQuestion = selectedTools.includes("question");

  if (hasExec) {
    promptGuidelines.add("Prefer direct, deterministic tool usage over narration.");
  }
  if (hasQuestion) {
    promptGuidelines.add(
      "When progress depends on a blocking user choice or missing requirement, use the question tool instead of asking only in prose or deferring it into open_questions.",
    );
  }
  promptGuidelines.add("Be concise in responses.");
  promptGuidelines.add("Show file paths clearly when working with files.");
  for (const guideline of options.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      promptGuidelines.add(normalized);
    }
  }

  const appendSection = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";
  const communicationSection = `\n\n${DEFAULT_COMMUNICATION_SECTION}`;

  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];

  if (options.customPrompt) {
    let prompt = options.customPrompt;
    if (appendSection) {
      prompt += appendSection;
    }
    prompt += communicationSection;
    if (contextFiles.length > 0) {
      prompt += "\n\n# Project Context\n\n";
      for (const contextFile of contextFiles) {
        prompt += `## ${contextFile.path}\n\n${contextFile.content}\n\n`;
      }
    }
    if (hasRead && skills.length > 0) {
      prompt += formatSkillsForPrompt(skills);
    }
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${cwd}`;
    return prompt;
  }

  const visibleTools = selectedTools.filter((toolName) => toolSnippets[toolName]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((toolName) => `- ${toolName}: ${toolSnippets[toolName]}`).join("\n")
      : "(none)";
  const guidelines = [...promptGuidelines].map((line) => `- ${line}`).join("\n");

  let prompt = `You are an expert coding assistant operating inside Brewva, a coding-agent runtime.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other project-specific tools.

Guidelines:
${guidelines}${communicationSection}`;

  if (appendSection) {
    prompt += appendSection;
  }

  if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    for (const contextFile of contextFiles) {
      prompt += `## ${contextFile.path}\n\n${contextFile.content}\n\n`;
    }
  }

  if (hasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${cwd}`;
  return prompt;
}
