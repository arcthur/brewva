import type { BrewvaConfig, SkillRoutingScope } from "../contracts/index.js";
import {
  type AnyRecord,
  isRecord,
  normalizeBoolean,
  normalizeStringArray,
} from "./normalization-shared.js";

const VALID_SKILL_ROUTING_SCOPES = new Set(["core", "domain", "operator", "meta"]);

function normalizeSkillOverrides(
  value: unknown,
  fallback: BrewvaConfig["skills"]["overrides"],
): BrewvaConfig["skills"]["overrides"] {
  if (!isRecord(value)) return structuredClone(fallback);
  const out: BrewvaConfig["skills"]["overrides"] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    out[key] = entry as BrewvaConfig["skills"]["overrides"][string];
  }
  return out;
}

function normalizeSkillRoutingScopeList(
  value: unknown,
  fallback: SkillRoutingScope[],
): SkillRoutingScope[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: SkillRoutingScope[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALID_SKILL_ROUTING_SCOPES.has(entry)) continue;
    const normalizedEntry = entry as SkillRoutingScope;
    if (out.includes(normalizedEntry)) continue;
    out.push(normalizedEntry);
  }
  return out.length > 0 ? out : [...fallback];
}

export function normalizeSkillsConfig(
  skillsInput: AnyRecord,
  defaults: BrewvaConfig["skills"],
): BrewvaConfig["skills"] {
  const skillsRoutingInput = isRecord(skillsInput.routing) ? skillsInput.routing : {};
  const normalizedRoutingScopes = normalizeSkillRoutingScopeList(
    skillsRoutingInput.scopes,
    defaults.routing.scopes,
  );

  return {
    roots: normalizeStringArray(skillsInput.roots, defaults.roots ?? []),
    disabled: normalizeStringArray(skillsInput.disabled, defaults.disabled),
    overrides: normalizeSkillOverrides(skillsInput.overrides, defaults.overrides),
    routing: {
      enabled: normalizeBoolean(skillsRoutingInput.enabled, defaults.routing.enabled),
      scopes: normalizedRoutingScopes,
    },
  };
}
