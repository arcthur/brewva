import { distillToolOutput } from "./tool-output-distiller.js";

export interface ResolveToolDisplayTextInput {
  toolName: string;
  isError: boolean;
  result: unknown;
}

export function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
}

export function resolveToolDisplayText(input: ResolveToolDisplayTextInput): string {
  const rawText = extractToolResultText(input.result);
  const distillation = distillToolOutput({
    toolName: input.toolName,
    isError: input.isError,
    outputText: rawText,
  });
  if (distillation.distillationApplied && distillation.summaryText.trim()) {
    return distillation.summaryText.trim();
  }
  return rawText;
}
