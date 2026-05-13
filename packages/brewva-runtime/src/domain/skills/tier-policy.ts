import type { ToolEffectClass } from "../governance/api.js";
import type { LoadableSkillCategory } from "./types.js";

const ALL_TOOL_EFFECT_CLASSES = [
  "workspace_read",
  "workspace_write",
  "local_exec",
  "runtime_observe",
  "external_network",
  "external_side_effect",
  "schedule_mutation",
  "memory_write",
  "budget_mutation",
  "control_state_mutation",
  "delegation",
  "credential_access",
] as const satisfies readonly ToolEffectClass[];

export const SKILL_TIER_EFFECT_CEILINGS = {
  core: ["workspace_read", "workspace_write", "local_exec", "runtime_observe", "delegation"],
  domain: [
    "workspace_read",
    "workspace_write",
    "local_exec",
    "runtime_observe",
    "delegation",
    "memory_write",
    "schedule_mutation",
    "external_network",
    "external_side_effect",
  ],
  operator: ALL_TOOL_EFFECT_CLASSES.filter((effect) => effect !== "credential_access"),
  meta: ["workspace_read", "workspace_write", "local_exec", "runtime_observe", "memory_write"],
  internal: ALL_TOOL_EFFECT_CLASSES,
} as const satisfies Record<LoadableSkillCategory, readonly ToolEffectClass[]>;

export function listSkillTierEffectCeiling(category: LoadableSkillCategory): ToolEffectClass[] {
  return [...SKILL_TIER_EFFECT_CEILINGS[category]];
}

export function listEffectsExceedingSkillTierCeiling(input: {
  category: LoadableSkillCategory;
  effects: readonly ToolEffectClass[];
}): ToolEffectClass[] {
  const ceiling = new Set(SKILL_TIER_EFFECT_CEILINGS[input.category]);
  return [...new Set(input.effects)].filter((effect) => !ceiling.has(effect));
}
