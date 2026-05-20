import type { SkillCard, ToolAccessResult } from "../protocol.js";
import type { ToolGovernanceDescriptor } from "../runtime/kernel/policy/public-contract.js";
import { getToolGovernanceDescriptor } from "../runtime/kernel/policy/tool-decision.js";
import { normalizeToolName } from "../utils/tool-name.js";

export interface ToolPolicyOptions {
  enforceDeniedEffects: boolean;
  effectAuthorizationMode: "off" | "warn" | "enforce";
  alwaysAllowedTools?: string[];
  resolveToolGovernanceDescriptor?: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => ToolGovernanceDescriptor | undefined;
}

function normalizeToolList(tools: string[]): string[] {
  return tools.map((tool) => normalizeToolName(tool)).filter((tool) => tool.length > 0);
}

export function checkToolAccess(
  card: SkillCard | undefined,
  toolName: string,
  options: ToolPolicyOptions,
  args?: Record<string, unknown>,
): ToolAccessResult {
  if (!card) return { allowed: true };

  const normalized = normalizeToolName(toolName);
  if (!normalized) return { allowed: true };

  const alwaysAllowed = new Set(normalizeToolList(options.alwaysAllowedTools ?? []));
  if (alwaysAllowed.has(normalized)) {
    return { allowed: true };
  }

  const descriptor =
    options.resolveToolGovernanceDescriptor?.(normalized, args) ??
    getToolGovernanceDescriptor(normalized, undefined, args);
  if (!descriptor) {
    const warning = `Tool '${normalized}' is missing effect governance metadata; effect authorization cannot be enforced for it yet.`;
    return { allowed: true, warning };
  }

  void options.enforceDeniedEffects;
  void options.effectAuthorizationMode;
  void descriptor;
  return { allowed: true };
}
