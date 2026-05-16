import {
  type AnyRecord,
  isRecord,
  normalizeStringArray,
  normalizeStringRecord,
} from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

export function normalizeSkillsConfig(
  skillsInput: AnyRecord,
  defaults: BrewvaConfig["skills"],
): BrewvaConfig["skills"] {
  return {
    roots: normalizeStringArray(skillsInput.roots, defaults.roots ?? []),
    disabled: normalizeStringArray(skillsInput.disabled, defaults.disabled),
  };
}

export function normalizeCapabilitiesConfig(
  capabilitiesInput: AnyRecord,
  defaults: BrewvaConfig["capabilities"],
): BrewvaConfig["capabilities"] {
  const policyInput = isRecord(capabilitiesInput.policy) ? capabilitiesInput.policy : {};
  return {
    roots: normalizeStringArray(capabilitiesInput.roots, defaults.roots),
    defaults: normalizeStringRecord(capabilitiesInput.defaults, defaults.defaults),
    policy: {
      agentScope: normalizeStringArray(policyInput.agentScope, defaults.policy.agentScope),
      workspaceScope: normalizeStringArray(
        policyInput.workspaceScope,
        defaults.policy.workspaceScope,
      ),
      allowedAccounts: normalizeStringArray(
        policyInput.allowedAccounts,
        defaults.policy.allowedAccounts,
      ),
    },
  };
}
