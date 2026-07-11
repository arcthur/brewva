import { compactWhitespace } from "@brewva/brewva-std/text";

export function compactText(value: string, maxChars = 220): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}
