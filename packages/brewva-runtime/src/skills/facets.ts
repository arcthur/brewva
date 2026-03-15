import type {
  SkillContractLike,
  SkillCostHint,
  SkillEffectLevel,
  SkillExecutionHints,
  SkillIntentContract,
  SkillOutputContract,
  SkillResourceBudget,
  ToolEffectClass,
} from "../types.js";

const READ_ONLY_EFFECTS: ToolEffectClass[] = ["workspace_read", "runtime_observe"];
const EXECUTE_EFFECTS = new Set<ToolEffectClass>(["local_exec", "external_network"]);
const MUTATION_EFFECTS = new Set<ToolEffectClass>([
  "workspace_write",
  "external_side_effect",
  "schedule_mutation",
  "memory_write",
]);

export function resolveSkillIntent(contract: SkillContractLike | undefined): SkillIntentContract {
  return contract?.intent ?? {};
}

export function listSkillOutputs(contract: SkillContractLike | undefined): string[] {
  return [...(resolveSkillIntent(contract).outputs ?? [])];
}

export function getSkillOutputContracts(
  contract: SkillContractLike | undefined,
): Record<string, SkillOutputContract> {
  return { ...resolveSkillIntent(contract).outputContracts };
}

export function deriveSkillEffectLevel(
  effects: Iterable<ToolEffectClass> | undefined,
): SkillEffectLevel {
  if (!effects) {
    return "read_only";
  }

  let level: SkillEffectLevel = "read_only";
  for (const effect of effects) {
    if (MUTATION_EFFECTS.has(effect)) {
      return "mutation";
    }
    if (EXECUTE_EFFECTS.has(effect)) {
      level = "execute";
    }
  }
  return level;
}

export function resolveSkillEffectLevel(contract: SkillContractLike | undefined): SkillEffectLevel {
  const explicit = contract?.effects?.allowedEffects;
  return deriveSkillEffectLevel(explicit !== undefined ? explicit : READ_ONLY_EFFECTS);
}

export function listSkillAllowedEffects(
  contract: SkillContractLike | undefined,
): ToolEffectClass[] {
  const explicit = contract?.effects?.allowedEffects;
  if (explicit !== undefined) {
    return [...explicit];
  }
  return [...READ_ONLY_EFFECTS];
}

export function listSkillDeniedEffects(contract: SkillContractLike | undefined): ToolEffectClass[] {
  return [...(contract?.effects?.deniedEffects ?? [])];
}

export function resolveSkillExecutionHints(
  contract: SkillContractLike | undefined,
): SkillExecutionHints {
  return contract?.executionHints ?? {};
}

export function listSkillPreferredTools(contract: SkillContractLike | undefined): string[] {
  return [...(resolveSkillExecutionHints(contract).preferredTools ?? [])];
}

export function listSkillFallbackTools(contract: SkillContractLike | undefined): string[] {
  return [...(resolveSkillExecutionHints(contract).fallbackTools ?? [])];
}

export function getSkillCostHint(contract: SkillContractLike | undefined): SkillCostHint {
  return resolveSkillExecutionHints(contract).costHint ?? "medium";
}

export function resolveSkillDefaultLease(
  contract: SkillContractLike | undefined,
): SkillResourceBudget | undefined {
  return contract?.resources?.defaultLease;
}

export function resolveSkillHardCeiling(
  contract: SkillContractLike | undefined,
): SkillResourceBudget | undefined {
  return contract?.resources?.hardCeiling;
}
