import { isRecord } from "./normalization-shared.js";

interface ActiveConfigFieldPolicyRule {
  path: readonly string[];
  message: string;
}

export interface ActiveConfigFieldPolicyViolation {
  path: string;
  message: string;
}

const ACTIVE_CONFIG_FIELD_POLICY_RULES: readonly ActiveConfigFieldPolicyRule[] = [
  {
    path: ["projection", "dailyRefreshHourLocal"],
    message:
      "projection.dailyRefreshHourLocal has been removed; projection refresh timing is no longer runtime-managed.",
  },
  {
    path: ["projection", "crystalMinUnits"],
    message:
      "projection.crystalMinUnits has been removed; projection compaction units are no longer runtime-managed.",
  },
  {
    path: ["projection", "retrievalTopK"],
    message:
      "projection.retrievalTopK has been removed; projection retrieval tuning is no longer runtime-managed.",
  },
  {
    path: ["projection", "retrievalWeights"],
    message:
      "projection.retrievalWeights has been removed; projection retrieval weighting is no longer runtime-managed.",
  },
  {
    path: ["projection", "recallMode"],
    message:
      "projection.recallMode has been removed; adaptive recall mode is no longer runtime-managed.",
  },
  {
    path: ["projection", "externalRecall"],
    message:
      "projection.externalRecall has been removed; external recall integration is no longer runtime-managed.",
  },
  {
    path: ["projection", "evolvesMode"],
    message:
      "projection.evolvesMode has been removed; projection evolution mode is no longer runtime-managed.",
  },
  {
    path: ["projection", "cognitive"],
    message:
      "projection.cognitive has been removed; cognitive projection overlays are no longer runtime-managed.",
  },
  {
    path: ["projection", "global"],
    message:
      "projection.global has been removed; global projection controls are no longer runtime-managed.",
  },
  {
    path: ["skills", "cascade"],
    message: "skills.cascade has been removed; model path sequencing is no longer runtime-managed.",
  },
  {
    path: ["skills", "selector"],
    message:
      "skills.selector has been removed; candidate skill selection is model-native and only skills.routing remains configurable.",
  },
  {
    path: ["skills", "routing", "continuityPhrases"],
    message:
      "skills.routing.continuityPhrases has been removed; continuity overrides are no longer runtime-managed.",
  },
  {
    path: ["skills", "routing", "profile"],
    message:
      "skills.routing.profile has been removed; routing profiles are no longer runtime-managed.",
  },
  {
    path: ["security", "execution", "commandDenyList"],
    message:
      "security.execution.commandDenyList must not appear in active config. Move entries to security.boundaryPolicy.commandDenyList.",
  },
  {
    path: ["security", "execution", "sandbox", "apiKey"],
    message:
      "security.execution.sandbox.apiKey must not appear in active config. Import the secret into the credential vault and set security.credentials.sandboxApiKeyRef.",
  },
  {
    path: ["infrastructure", "contextBudget", "hardLimitPercent"],
    message:
      "infrastructure.contextBudget.hardLimitPercent has been replaced. Use infrastructure.contextBudget.thresholds.* and injection.* instead.",
  },
  {
    path: ["infrastructure", "contextBudget", "compactionThresholdPercent"],
    message:
      "infrastructure.contextBudget.compactionThresholdPercent has been replaced. Use infrastructure.contextBudget.thresholds.* and injection.* instead.",
  },
  {
    path: ["infrastructure", "contextBudget", "maxInjectionTokens"],
    message:
      "infrastructure.contextBudget.maxInjectionTokens has been replaced. Use infrastructure.contextBudget.thresholds.* and injection.* instead.",
  },
] as const;

function toSlashPath(path: readonly string[]): string {
  return `/${path.join("/")}`;
}

function hasOwnPropertyAtPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0 || !isRecord(value)) {
    return false;
  }

  let cursor: unknown = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (!segment || !isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
      return false;
    }
    cursor = cursor[segment];
  }

  const finalSegment = path[path.length - 1];
  return Boolean(finalSegment && isRecord(cursor) && Object.hasOwn(cursor, finalSegment));
}

function deletePropertyAtPath(root: Record<string, unknown>, path: readonly string[]): boolean {
  if (path.length === 0) {
    return false;
  }

  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (!segment || !isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
      return false;
    }
    cursor = cursor[segment];
  }

  const finalSegment = path[path.length - 1];
  if (!finalSegment || !isRecord(cursor) || !Object.hasOwn(cursor, finalSegment)) {
    return false;
  }

  delete cursor[finalSegment];
  return true;
}

export function collectActiveConfigFieldPolicyViolations(
  value: unknown,
): ActiveConfigFieldPolicyViolation[] {
  if (!isRecord(value)) {
    return [];
  }

  return ACTIVE_CONFIG_FIELD_POLICY_RULES.flatMap((rule) =>
    hasOwnPropertyAtPath(value, rule.path)
      ? [
          {
            path: toSlashPath(rule.path),
            message: rule.message,
          } satisfies ActiveConfigFieldPolicyViolation,
        ]
      : [],
  );
}

export function stripActiveConfigFieldPolicyFields(root: Record<string, unknown>): string[] {
  const stripped = new Set<string>();
  for (const rule of ACTIVE_CONFIG_FIELD_POLICY_RULES) {
    if (deletePropertyAtPath(root, rule.path)) {
      stripped.add(toSlashPath(rule.path));
    }
  }
  return [...stripped].toSorted((left, right) => left.localeCompare(right));
}
