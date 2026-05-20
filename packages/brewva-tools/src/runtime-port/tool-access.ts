import type { BrewvaBundledToolOptions } from "../contracts/index.js";

export function explainToolAccess(input: {
  options: BrewvaBundledToolOptions;
  sessionId: string;
  toolName: string;
  args?: Record<string, unknown>;
  cwd: string;
}): { allowed: boolean; reason?: string } {
  return input.options.runtime.capabilities.tools.access.explain({
    sessionId: input.sessionId,
    toolName: input.toolName,
    args: input.args,
    cwd: input.cwd,
  });
}
