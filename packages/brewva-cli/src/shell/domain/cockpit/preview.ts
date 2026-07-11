import { compactWhitespace } from "@brewva/brewva-std/text";

const PROMPT_PREVIEW_LIMIT = 160;
const THINKING_PREVIEW_LIMIT = 160;

export function compactPromptPreview(text: string): string | null {
  const normalized = compactWhitespace(text);
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length <= PROMPT_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, PROMPT_PREVIEW_LIMIT - 3).trimEnd()}...`;
}

export function appendThinkingPreview(current: string, delta: string): string {
  const existingTail = current.startsWith("...") ? current.slice(3) : current;
  const combined = `${existingTail}${delta}`.replace(/\s+/gu, " ").trimStart();
  if (combined.length <= THINKING_PREVIEW_LIMIT) {
    return combined;
  }
  return `...${combined.slice(-(THINKING_PREVIEW_LIMIT - 3)).trimStart()}`;
}
