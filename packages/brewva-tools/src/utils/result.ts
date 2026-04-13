import type { BrewvaToolResult as AgentToolResult } from "@brewva/brewva-substrate";

export type ToolResultVerdict = "pass" | "fail" | "inconclusive";

export function toolDetails(details: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details as Record<string, unknown>));
}

export function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function withVerdict<T extends Record<string, unknown>>(
  details: T,
  verdict?: ToolResultVerdict,
): T & { verdict?: ToolResultVerdict } {
  if (!verdict) {
    return details;
  }
  return {
    ...details,
    verdict,
  };
}

export function failTextResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return textResult(text, withVerdict(details, "fail"));
}

export function inconclusiveTextResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return textResult(text, withVerdict(details, "inconclusive"));
}
