import type { Model, SimpleStreamOptions } from "../../contracts/index.js";
import type { AnthropicEffort } from "./contract.js";

export const claudeCodeVersion = "2.1.75";

const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

export const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;

export const fromClaudeCodeName = (name: string, tools?: Array<{ name: string }>): string => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
    if (matchedTool) return matchedTool.name;
  }
  return name;
};

export function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

export function mapThinkingLevelToEffort(
  level: SimpleStreamOptions["reasoning"],
  modelId: string,
): AnthropicEffort {
  switch (level) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
    default:
      return "high";
  }
}

export function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}
