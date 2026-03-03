import type { SkillCascadeSource, SkillCascadeSourceDecision, SkillChainIntent } from "../types.js";

const UNCONFIGURED_RANK = Number.MAX_SAFE_INTEGER;

function normalizeRank(rank: number): number | null {
  return rank === UNCONFIGURED_RANK ? null : rank;
}

function sourceRank(sourcePriority: SkillCascadeSource[], source: SkillCascadeSource): number {
  const index = sourcePriority.findIndex((entry) => entry === source);
  return index >= 0 ? index : UNCONFIGURED_RANK;
}

function isSourceEnabled(
  enabledSources: SkillCascadeSource[],
  source: SkillCascadeSource,
): boolean {
  return enabledSources.includes(source);
}

export function evaluateSkillCascadeSourceDecision(input: {
  enabledSources: SkillCascadeSource[];
  sourcePriority: SkillCascadeSource[];
  existingIntent?: SkillChainIntent;
  incomingSource: SkillCascadeSource;
}): SkillCascadeSourceDecision {
  const { enabledSources, sourcePriority, existingIntent, incomingSource } = input;
  const incomingRank = sourceRank(sourcePriority, incomingSource);
  if (!isSourceEnabled(enabledSources, incomingSource)) {
    return {
      replace: false,
      reason: "incoming_source_disabled",
      incomingSource,
      existingSource: existingIntent?.source,
      incomingRank: normalizeRank(incomingRank),
      existingRank: existingIntent
        ? normalizeRank(sourceRank(sourcePriority, existingIntent.source))
        : null,
    };
  }

  if (!existingIntent) {
    return {
      replace: true,
      reason: "no_existing_intent",
      incomingSource,
      incomingRank: normalizeRank(incomingRank),
      existingRank: null,
    };
  }
  if (
    existingIntent.status === "completed" ||
    existingIntent.status === "failed" ||
    existingIntent.status === "cancelled"
  ) {
    const existingRank = sourceRank(sourcePriority, existingIntent.source);
    return {
      replace: true,
      reason: "existing_terminal",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank: normalizeRank(incomingRank),
      existingRank: normalizeRank(existingRank),
    };
  }

  const existingRank = sourceRank(sourcePriority, existingIntent.source);
  const explicitEnabled = isSourceEnabled(enabledSources, "explicit");

  if (existingIntent.source === "explicit" && incomingSource !== "explicit" && !explicitEnabled) {
    return {
      replace: false,
      reason: "explicit_source_locked",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank: normalizeRank(incomingRank),
      existingRank: normalizeRank(existingRank),
    };
  }

  if (!isSourceEnabled(enabledSources, existingIntent.source)) {
    return {
      replace: true,
      reason: "existing_source_disabled",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank: normalizeRank(incomingRank),
      existingRank: normalizeRank(existingRank),
    };
  }

  if (incomingRank === UNCONFIGURED_RANK) {
    return {
      replace: false,
      reason: "incoming_source_not_configured",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank: null,
      existingRank: normalizeRank(existingRank),
    };
  }

  if (existingRank === UNCONFIGURED_RANK) {
    if (incomingSource === existingIntent.source) {
      return {
        replace: true,
        reason: "incoming_same_unconfigured_source",
        incomingSource,
        existingSource: existingIntent.source,
        incomingRank: normalizeRank(incomingRank),
        existingRank: null,
      };
    }
    return {
      replace: false,
      reason: "existing_source_not_configured",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank: normalizeRank(incomingRank),
      existingRank: null,
    };
  }

  if (incomingRank <= existingRank) {
    return {
      replace: true,
      reason: "incoming_higher_or_equal_priority",
      incomingSource,
      existingSource: existingIntent.source,
      incomingRank,
      existingRank,
    };
  }
  return {
    replace: false,
    reason: "incoming_lower_priority",
    incomingSource,
    existingSource: existingIntent.source,
    incomingRank,
    existingRank,
  };
}
