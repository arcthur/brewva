import {
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  resolveSkillEffectLevel,
  type BrewvaRuntime,
  type SkillDocument,
} from "@brewva/brewva-runtime";

type SkillRuntime = Pick<BrewvaRuntime, "skills">;

export type DelegationPlanningMode = "single" | "parallel";
export type DelegationPlanningPosture = "observe" | "reversible_mutate";

export interface DelegationPlanningContextBudget {
  maxInjectionTokens?: number;
  maxTurnTokens?: number;
}

export interface DelegationPlanningContextRef {
  kind: "event" | "ledger" | "artifact" | "projection" | "workspace_span" | "task" | "truth";
  locator: string;
  summary?: string;
}

export interface DelegationPlanningExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  preferredSkills?: string[];
}

export interface DelegationPacketDraft {
  objective: string;
  deliverable?: string;
  constraints?: string[];
  sharedNotes?: string[];
  activeSkillName?: string;
  entrySkill?: string;
  requiredOutputs?: string[];
  executionHints?: DelegationPlanningExecutionHints;
  contextRefs?: DelegationPlanningContextRef[];
  contextBudget?: DelegationPlanningContextBudget;
  effectCeiling?: {
    posture?: DelegationPlanningPosture;
  };
}

export interface DelegationProfileRecommendation {
  profile: string;
  mode: DelegationPlanningMode;
  posture: DelegationPlanningPosture;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export interface DelegationPacketBuilderInput {
  runtime: SkillRuntime;
  sessionId: string;
  objective: string;
  deliverable?: string;
  constraints?: string[];
  sharedNotes?: string[];
  entrySkill?: string;
  requiredOutputs?: string[];
  preferredSkills?: string[];
  contextRefs?: DelegationPacketDraft["contextRefs"];
  contextBudget?: DelegationPacketDraft["contextBudget"];
  effectCeiling?: DelegationPacketDraft["effectCeiling"];
  allowMutation?: boolean;
}

export interface DelegationPlanningInput extends DelegationPacketBuilderInput {
  taskCount?: number;
  preferProfile?: string;
  preferReview?: boolean;
  preferVerification?: boolean;
}

export interface DelegationPlan {
  recommendation: DelegationProfileRecommendation;
  packet: DelegationPacketDraft;
}

const REVIEW_KEYWORDS = ["review", "regression", "risk", "finding", "correctness", "audit"];
const VERIFICATION_KEYWORDS = [
  "verify",
  "verification",
  "test",
  "validate",
  "diagnostic",
  "assert",
  "check",
];
const PATCH_KEYWORDS = [
  "implement",
  "patch",
  "edit",
  "modify",
  "change",
  "fix",
  "refactor",
  "rewrite",
];

function normalizeStringArray(values: readonly string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeExecutionHints(
  activeSkill: SkillDocument | undefined,
  preferredSkills: readonly string[] | undefined,
): DelegationPlanningExecutionHints | undefined {
  const preferredTools = normalizeStringArray(
    activeSkill ? listSkillPreferredTools(activeSkill.contract) : undefined,
  );
  const fallbackTools = normalizeStringArray(
    activeSkill ? listSkillFallbackTools(activeSkill.contract) : undefined,
  );
  const mergedPreferredSkills = normalizeStringArray([
    ...(activeSkill ? [activeSkill.name] : []),
    ...(preferredSkills ?? []),
  ]);
  if (!preferredTools && !fallbackTools && !mergedPreferredSkills) {
    return undefined;
  }
  return {
    preferredTools,
    fallbackTools,
    preferredSkills: mergedPreferredSkills,
  };
}

function hasAnyKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function recommendFromSkill(
  activeSkill: SkillDocument | undefined,
  objective: string,
  allowMutation: boolean,
  mode: DelegationPlanningMode,
  preferReview: boolean,
  preferVerification: boolean,
): DelegationProfileRecommendation {
  const normalizedObjective = objective.trim().toLowerCase();
  const activeSkillName = activeSkill?.name;
  const effectLevel = resolveSkillEffectLevel(activeSkill?.contract);

  if (
    allowMutation ||
    (effectLevel === "mutation" && hasAnyKeyword(normalizedObjective, PATCH_KEYWORDS))
  ) {
    return {
      profile: "patch-worker",
      mode,
      posture: "reversible_mutate",
      confidence: allowMutation ? "high" : "medium",
      reason: allowMutation
        ? "Mutation-capable delegation was requested explicitly."
        : `Active skill '${activeSkillName ?? "unknown"}' permits mutation and the objective looks patch-oriented.`,
    };
  }

  if (
    preferVerification ||
    activeSkillName === "review" ||
    hasAnyKeyword(normalizedObjective, VERIFICATION_KEYWORDS)
  ) {
    return {
      profile: "verifier",
      mode,
      posture: "observe",
      confidence:
        preferVerification || hasAnyKeyword(normalizedObjective, VERIFICATION_KEYWORDS)
          ? "high"
          : "medium",
      reason:
        preferVerification || hasAnyKeyword(normalizedObjective, VERIFICATION_KEYWORDS)
          ? "The objective is verification-heavy."
          : "The active skill is review-oriented and benefits from a verifier lane.",
    };
  }

  if (
    preferReview ||
    activeSkillName === "review" ||
    hasAnyKeyword(normalizedObjective, REVIEW_KEYWORDS)
  ) {
    return {
      profile: "reviewer",
      mode,
      posture: "observe",
      confidence:
        preferReview || hasAnyKeyword(normalizedObjective, REVIEW_KEYWORDS) ? "high" : "medium",
      reason:
        preferReview || hasAnyKeyword(normalizedObjective, REVIEW_KEYWORDS)
          ? "The objective is review-heavy."
          : "The active skill already sits in a review lane.",
    };
  }

  if (activeSkillName === "design" || activeSkillName === "repository-analysis") {
    return {
      profile: "researcher",
      mode,
      posture: "observe",
      confidence: "medium",
      reason: `Active skill '${activeSkillName}' maps naturally to read-only exploration.`,
    };
  }

  return {
    profile: "researcher",
    mode,
    posture: "observe",
    confidence: "low",
    reason: "Defaulting to a read-only research lane keeps delegation narrow and safe.",
  };
}

export function recommendSubagentProfile(
  input: Omit<
    DelegationPlanningInput,
    | "entrySkill"
    | "constraints"
    | "sharedNotes"
    | "contextRefs"
    | "contextBudget"
    | "requiredOutputs"
    | "preferredSkills"
    | "effectCeiling"
    | "deliverable"
  >,
): DelegationProfileRecommendation {
  if (typeof input.preferProfile === "string" && input.preferProfile.trim()) {
    return {
      profile: input.preferProfile.trim(),
      mode: typeof input.taskCount === "number" && input.taskCount > 1 ? "parallel" : "single",
      posture: input.allowMutation ? "reversible_mutate" : "observe",
      confidence: "high",
      reason: "The caller requested an explicit subagent profile.",
    };
  }

  const activeSkill = input.runtime.skills.getActive(input.sessionId);
  const mode = typeof input.taskCount === "number" && input.taskCount > 1 ? "parallel" : "single";
  return recommendFromSkill(
    activeSkill,
    input.objective,
    input.allowMutation ?? false,
    mode,
    input.preferReview ?? false,
    input.preferVerification ?? false,
  );
}

export function buildDelegationPacketForActiveSkill(
  input: DelegationPacketBuilderInput,
): DelegationPacketDraft {
  const activeSkill = input.runtime.skills.getActive(input.sessionId);
  const effectLevel = resolveSkillEffectLevel(activeSkill?.contract);
  const posture =
    input.effectCeiling?.posture ??
    (input.allowMutation || effectLevel === "mutation" ? "reversible_mutate" : "observe");

  return {
    objective: input.objective.trim(),
    deliverable: input.deliverable?.trim() || undefined,
    constraints: normalizeStringArray(input.constraints),
    sharedNotes: normalizeStringArray(input.sharedNotes),
    activeSkillName: activeSkill?.name,
    entrySkill: input.entrySkill?.trim() || undefined,
    requiredOutputs: normalizeStringArray([
      ...listSkillOutputs(activeSkill?.contract),
      ...(input.requiredOutputs ?? []),
    ]),
    executionHints: normalizeExecutionHints(activeSkill, input.preferredSkills),
    contextRefs: input.contextRefs?.map((entry) => ({ ...entry })),
    contextBudget: input.contextBudget
      ? {
          maxInjectionTokens: input.contextBudget.maxInjectionTokens,
          maxTurnTokens: input.contextBudget.maxTurnTokens,
        }
      : undefined,
    effectCeiling: {
      posture,
    },
  };
}

export function planDelegationForActiveSkill(input: DelegationPlanningInput): DelegationPlan {
  const recommendation = recommendSubagentProfile(input);
  const packet = buildDelegationPacketForActiveSkill({
    ...input,
    effectCeiling: {
      posture: input.effectCeiling?.posture ?? recommendation.posture,
    },
  });
  return {
    recommendation,
    packet,
  };
}
