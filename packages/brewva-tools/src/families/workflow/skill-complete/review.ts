import { KNOWLEDGE_SOURCE_TYPES } from "@brewva/brewva-recall/knowledge";
import {
  PLANNING_EVIDENCE_KEYS,
  REVIEW_CHANGE_CATEGORIES,
  collectPlanningRiskCategories,
  coercePlanningArtifactSet,
  deriveSkillPlanningEvidenceStateFromEvents,
  resolveSkillVerificationEvidenceContext,
  type SkillDocument,
} from "@brewva/brewva-runtime";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../../contracts/index.js";
import { buildStringEnumSchema } from "../../../registry/string-enum-contract.js";
import {
  deriveImpactMapChangeCategories,
  deriveImpactMapChangedFileClasses,
} from "../../../shared/impact-map.js";
import {
  REVIEW_CHANGED_FILE_CLASSES,
  classifyReviewChangedFiles,
  coerceReviewChangeCategories,
  coerceReviewChangedFileClasses,
  type ReviewChangeCategory,
} from "../../../shared/review-classification.js";
import {
  deriveReviewLaneActivationPlan,
  materializeReviewLaneOutcomes,
  synthesizeReviewEnsemble,
  type ReviewEvidenceState,
  type ReviewPlanningPosture,
} from "../../../shared/review-ensemble/index.js";

const REVIEW_OUTPUT_KEYS = ["review_report", "review_findings", "merge_decision"] as const;

export const KNOWLEDGE_SOURCE_TYPE_SCHEMA = buildStringEnumSchema(KNOWLEDGE_SOURCE_TYPES, {});
export const REVIEW_PLANNING_POSTURE_SCHEMA = Type.Union([
  Type.Literal("trivial"),
  Type.Literal("moderate"),
  Type.Literal("complex"),
  Type.Literal("high_risk"),
]);
export const REVIEW_EVIDENCE_STATE_SCHEMA = Type.Union([
  Type.Literal("present"),
  Type.Literal("stale"),
  Type.Literal("missing"),
]);
export const REVIEW_CHANGE_CATEGORY_SCHEMA = buildStringEnumSchema(REVIEW_CHANGE_CATEGORIES, {});
export const REVIEW_CHANGED_FILE_CLASS_SCHEMA = buildStringEnumSchema(
  REVIEW_CHANGED_FILE_CLASSES,
  {},
);
export const REVIEW_PRECEDENT_CONSULT_STATUS_SCHEMA = Type.Object(
  {
    status: Type.Union([
      Type.Literal("consulted"),
      Type.Literal("no_match"),
      Type.Literal("not_required"),
    ]),
    precedentRefs: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length === value.length ? items : undefined;
}

function coercePlanningPosture(value: unknown): ReviewPlanningPosture | undefined {
  return value === "trivial" || value === "moderate" || value === "complex" || value === "high_risk"
    ? value
    : undefined;
}

function coerceEvidenceState(value: unknown): ReviewEvidenceState | undefined {
  return value === "present" || value === "stale" || value === "missing" ? value : undefined;
}

function coerceEvidenceStateRecord(
  value: unknown,
):
  | Partial<
      Record<
        "impact_map" | "verification_evidence" | (typeof PLANNING_EVIDENCE_KEYS)[number],
        ReviewEvidenceState
      >
    >
  | null
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const out: Partial<
    Record<
      "impact_map" | "verification_evidence" | (typeof PLANNING_EVIDENCE_KEYS)[number],
      ReviewEvidenceState
    >
  > = {};
  for (const key of ["impact_map", ...PLANNING_EVIDENCE_KEYS, "verification_evidence"] as const) {
    if (!hasOwn(value, key)) {
      continue;
    }
    const state = coerceEvidenceState(value[key]);
    if (!state) {
      return null;
    }
    out[key] = state;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coercePrecedentConsultStatus(value: unknown): {
  status: "consulted" | "no_match" | "not_required";
  precedent_refs?: string[];
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = readString(value.status);
  if (status !== "consulted" && status !== "no_match" && status !== "not_required") {
    return null;
  }
  const precedentRefs = hasOwn(value, "precedentRefs")
    ? readStringArray(value.precedentRefs)
    : undefined;
  if (hasOwn(value, "precedentRefs") && !precedentRefs) {
    return null;
  }
  return {
    status,
    ...(precedentRefs ? { precedent_refs: precedentRefs } : {}),
  };
}

export function isReviewContractSkill(skill: SkillDocument | undefined): skill is SkillDocument {
  if (!skill) {
    return false;
  }
  const outputs = skill.contract.intent?.outputs ?? [];
  return REVIEW_OUTPUT_KEYS.every((key) => outputs.includes(key));
}

export function readReviewMergeDecision(
  value: unknown,
): "ready" | "needs_changes" | "blocked" | undefined {
  const normalized = readString(value)?.toLowerCase();
  return normalized === "ready" || normalized === "needs_changes" || normalized === "blocked"
    ? normalized
    : undefined;
}

function resolveLatestSkillActivationTimestamp(
  runtime: BrewvaToolOptions["runtime"],
  sessionId: string,
  skillName: string,
): number | undefined {
  const activations = runtime.inspect.events.queryStructured(sessionId, {
    type: "skill_activated",
  });
  for (let index = activations.length - 1; index >= 0; index -= 1) {
    const event = activations[index];
    if (!event) {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (readString(payload?.skillName) === skillName) {
      return event.timestamp;
    }
  }
  return undefined;
}

function isReviewTerminalStatus(
  status: string,
): status is "completed" | "failed" | "cancelled" | "timeout" {
  return (
    status === "completed" || status === "failed" || status === "cancelled" || status === "timeout"
  );
}

type ReviewEvidenceStateRecord = Partial<
  Record<
    "impact_map" | "verification_evidence" | (typeof PLANNING_EVIDENCE_KEYS)[number],
    ReviewEvidenceState
  >
>;

function deriveEvidenceStateFromConsumedOutputs(input: {
  runtime: BrewvaToolOptions["runtime"];
  sessionId: string;
  consumedOutputs: Record<string, unknown>;
  consumedKeys: readonly string[];
}): ReviewEvidenceStateRecord | undefined {
  const out: ReviewEvidenceStateRecord = {};
  const sessionEvents = input.runtime.inspect.events.query(input.sessionId);
  const planningEvidenceState = deriveSkillPlanningEvidenceStateFromEvents({
    events: sessionEvents,
    consumedOutputs: input.consumedOutputs,
  });
  const verificationEvidenceContext = resolveSkillVerificationEvidenceContext(sessionEvents);
  for (const key of ["impact_map", ...PLANNING_EVIDENCE_KEYS, "verification_evidence"] as const) {
    if (!input.consumedKeys.includes(key)) {
      continue;
    }
    if (key === "verification_evidence") {
      out[key] = verificationEvidenceContext.state;
      continue;
    }
    if (key === "impact_map") {
      out[key] = hasOwn(input.consumedOutputs, key) ? "present" : "missing";
      continue;
    }
    out[key] = planningEvidenceState[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function deriveRiskCategoriesFromConsumedOutputs(
  consumedOutputs: Record<string, unknown>,
): ReviewChangeCategory[] | undefined {
  const planningArtifacts = coercePlanningArtifactSet(consumedOutputs);
  if (!planningArtifacts.riskRegister || planningArtifacts.riskRegister.length === 0) {
    return undefined;
  }
  const categories = collectPlanningRiskCategories(planningArtifacts.riskRegister);
  return categories.length > 0 ? [...new Set(categories)] : undefined;
}

export function buildReviewEnsembleOutputs(input: {
  runtime: BrewvaToolOptions["runtime"];
  sessionId: string;
  outputs: Record<string, unknown>;
  reviewEnsemble: Record<string, unknown>;
}):
  | {
      ok: true;
      outputs: Record<string, unknown>;
      synthesis: {
        activatedLanes: string[];
        mergeDecision: "ready" | "needs_changes" | "blocked";
        runIds: string[];
      };
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    } {
  const activeSkill = input.runtime.inspect.skills.getActive(input.sessionId);
  const activeSkillName = activeSkill?.name ?? null;
  if (!isReviewContractSkill(activeSkill)) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. The active skill does not declare the canonical review outputs.",
      details: {
        activeSkill: activeSkillName,
      },
    };
  }

  const conflictingOutputs = REVIEW_OUTPUT_KEYS.filter((key) => hasOwn(input.outputs, key));
  if (conflictingOutputs.length > 0) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. Do not supply manual review outputs when reviewEnsemble is enabled.",
      details: {
        conflictingOutputs,
      },
    };
  }

  const consumedOutputs = input.runtime.inspect.skills.getConsumedOutputs(
    input.sessionId,
    activeSkill.name,
  ).outputs;
  const consumedKeys = activeSkill.contract.consumes ?? [];

  const consultStatus = coercePrecedentConsultStatus(input.reviewEnsemble.precedentConsultStatus);
  if (!consultStatus) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. precedentConsultStatus must declare a valid consult disposition.",
    };
  }
  const precedentQuerySummary = readString(input.reviewEnsemble.precedentQuerySummary);
  if (!precedentQuerySummary) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. precedentQuerySummary must preserve the canonical review proof-of-consult context.",
    };
  }

  const activationTimestamp = resolveLatestSkillActivationTimestamp(
    input.runtime,
    input.sessionId,
    activeSkill.name,
  );
  if (activationTimestamp === undefined) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. The active review skill has no activation event in the current session.",
      details: {
        activeSkill: activeSkill.name,
      },
    };
  }

  const delegation = input.runtime.delegation;
  if (!delegation?.listRuns) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. Delegation run inspection is unavailable in this runtime.",
    };
  }

  const requestedRunIds = readStringArray(input.reviewEnsemble.runIds) ?? undefined;
  const explicitPlanningPosture = coercePlanningPosture(input.reviewEnsemble.planningPosture);
  const changeCategories = coerceReviewChangeCategories(input.reviewEnsemble.changeCategories);
  const changedFileClasses = coerceReviewChangedFileClasses(
    input.reviewEnsemble.changedFileClasses,
  );
  const evidenceState = coerceEvidenceStateRecord(input.reviewEnsemble.evidenceState);
  if (changeCategories === null) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. changeCategories must use only canonical review change-category values.",
    };
  }
  if (changedFileClasses === null) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. changedFileClasses must use only canonical review file-class values.",
    };
  }
  if (evidenceState === null) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. evidenceState must use only present, stale, or missing.",
    };
  }
  const consumedPlanningPosture = coercePlanningPosture(consumedOutputs.planning_posture);
  const planningPosture = explicitPlanningPosture ?? consumedPlanningPosture ?? "moderate";
  const changedPaths = readStringArray(consumedOutputs.files_changed) ?? [];
  const derivedChangeCategories =
    changeCategories ?? deriveImpactMapChangeCategories(consumedOutputs.impact_map);
  const derivedRiskCategories = deriveRiskCategoriesFromConsumedOutputs(consumedOutputs);
  const derivedChangedFileClasses =
    changedFileClasses ??
    deriveImpactMapChangedFileClasses(consumedOutputs.impact_map, changedPaths) ??
    classifyReviewChangedFiles(changedPaths);
  const derivedEvidenceState =
    evidenceState ??
    deriveEvidenceStateFromConsumedOutputs({
      runtime: input.runtime,
      sessionId: input.sessionId,
      consumedOutputs,
      consumedKeys,
    });

  const candidateRuns = delegation.listRuns(input.sessionId, {
    ...(requestedRunIds ? { runIds: requestedRunIds } : {}),
    includeTerminal: true,
  });

  const selectedRuns = candidateRuns.filter(
    (run) =>
      run.kind === "consult" &&
      run.consultKind === "review" &&
      run.parentSkill === activeSkill.name &&
      run.createdAt >= activationTimestamp &&
      isReviewTerminalStatus(run.status),
  );

  if (requestedRunIds) {
    const foundIds = new Set(selectedRuns.map((run) => run.runId));
    const missingRunIds = requestedRunIds.filter((runId) => !foundIds.has(runId));
    if (missingRunIds.length > 0) {
      return {
        ok: false,
        message:
          "Review ensemble synthesis rejected. Some requested runIds were not found in the current review activation window.",
        details: {
          missingRunIds,
        },
      };
    }
  }

  if (selectedRuns.length === 0) {
    return {
      ok: false,
      message:
        "Review ensemble synthesis rejected. No terminal delegated review lane outcomes were found for the active review window.",
      details: {
        activeSkill: activeSkill.name,
        activationTimestamp,
      },
    };
  }

  const activationPlan = deriveReviewLaneActivationPlan({
    planningPosture,
    ...(derivedChangeCategories ? { changeCategories: derivedChangeCategories } : {}),
    ...(derivedRiskCategories ? { riskCategories: derivedRiskCategories } : {}),
    ...(derivedChangedFileClasses ? { changedFileClasses: derivedChangedFileClasses } : {}),
    ...(derivedEvidenceState ? { evidenceState: derivedEvidenceState } : {}),
  });
  const synthesized = synthesizeReviewEnsemble({
    activationPlan,
    outcomes: materializeReviewLaneOutcomes(selectedRuns),
    precedentQuerySummary,
    precedentConsultStatus: consultStatus,
  });

  return {
    ok: true,
    outputs: {
      review_report: synthesized.reviewReport,
      review_findings: synthesized.reviewFindings,
      merge_decision: synthesized.mergeDecision,
    },
    synthesis: {
      activatedLanes: synthesized.reviewReport.activated_lanes,
      mergeDecision: synthesized.mergeDecision,
      runIds: selectedRuns.map((run) => run.runId),
    },
  };
}
