function sanitizeFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export function buildSubagentAgentId(delegate: string): string {
  return `subagent-${sanitizeFragment(delegate) || "worker"}`;
}

export function buildForkSubagentAgentId(fromSessionId: string): string {
  return `subagent-fork-${sanitizeFragment(fromSessionId) || "parent"}`;
}
