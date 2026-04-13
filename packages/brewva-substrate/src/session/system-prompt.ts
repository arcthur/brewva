export interface BrewvaSystemPromptSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir?: string;
}

export interface BuildBrewvaSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: BrewvaSystemPromptSkill[];
}

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
  const selectedTools = options.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolSnippets = options.toolSnippets ?? {};
  const promptGuidelines = new Set<string>();
  const hasBash = selectedTools.includes("bash");
  const hasRead = selectedTools.includes("read");

  if (hasBash) {
    promptGuidelines.add("Prefer direct, deterministic tool usage over narration.");
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

  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];

  if (options.customPrompt) {
    let prompt = options.customPrompt;
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
${guidelines}`;

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
