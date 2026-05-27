import type { ThinkingBudgets, ThinkingLevel } from "../../../contracts/index.js";
import type { GoogleThinkingConfig, GoogleThinkingLevel } from "./contract.js";

export function isGemini3ProModel(modelId: string): boolean {
  return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}

export function isGemini3FlashModel(modelId: string): boolean {
  return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}

export function isGemini3Model(modelId: string): boolean {
  return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

export function getDisabledThinkingConfig(modelId: string): GoogleThinkingConfig {
  if (isGemini3ProModel(modelId)) {
    return { thinkingLevel: "LOW" };
  }
  if (isGemini3FlashModel(modelId)) {
    return { thinkingLevel: "MINIMAL" };
  }

  return { thinkingBudget: 0 };
}

export function buildGoogleThinkingLevelConfig(level: GoogleThinkingLevel): GoogleThinkingConfig {
  if (level === "THINKING_LEVEL_UNSPECIFIED") {
    return {};
  }
  return { thinkingLevel: level };
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

export function getGoogleThinkingLevel(
  effort: ClampedThinkingLevel,
  modelId: string,
): GoogleThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
        return "HIGH";
    }
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
}

export function resolveThinkingBudget(
  baseMaxTokens: number,
  modelMaxTokens: number,
  thinkingLevel: Exclude<ThinkingLevel, "xhigh">,
  thinkingBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budgets = { ...defaultBudgets, ...thinkingBudgets };

  const minOutputTokens = 1024;
  let thinkingBudget = budgets[thinkingLevel]!;
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}
