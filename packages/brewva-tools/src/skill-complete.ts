import {
  PLANNING_EVIDENCE_KEYS,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  collectLatestPlanningOutputTimestamps,
  collectPlanningRiskCategories,
  coercePlanningArtifactSet,
  derivePlanningEvidenceState,
  REVIEW_CHANGE_CATEGORIES,
  resolveLatestWorkspaceWriteTimestamp,
  type SkillDocument,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  deriveImpactMapChangeCategories,
  deriveImpactMapChangedFileClasses,
} from "./impact-map.js";
import { KNOWLEDGE_SOURCE_TYPES } from "./knowledge-search-core.js";
import { buildLearningResearchOutputs } from "./learning-research.js";
import {
  REVIEW_CHANGED_FILE_CLASSES,
  classifyReviewChangedFiles,
  coerceReviewChangeCategories,
  coerceReviewChangedFileClasses,
  type ReviewChangeCategory,
} from "./review-classification.js";
import {
  deriveReviewLaneActivationPlan,
  materializeReviewLaneOutcomes,
  synthesizeReviewEnsemble,
  type ReviewEvidenceState,
  type ReviewPlanningPosture,
} from "./review-ensemble.js";
import { resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const REVIEW_OUTPUT_KEYS = ["review_report", "review_findings", "merge_decision"] as const;
const KNOWLEDGE_SOURCE_TYPE_SCHEMA = buildStringEnumSchema(KNOWLEDGE_SOURCE_TYPES, {});

const REVIEW_PLANNING_POSTURE_SCHEMA = Type.Union([
  Type.Literal("trivial"),
  Type.Literal("moderate"),
  Type.Literal("complex"),
  Type.Literal("high_risk"),
]);

const REVIEW_EVIDENCE_STATE_SCHEMA = Type.Union([
  Type.Literal("present"),
  Type.Literal("stale"),
  Type.Literal("missing"),
]);

const REVIEW_CHANGE_CATEGORY_SCHEMA = buildStringEnumSchema(REVIEW_CHANGE_CATEGORIES, {});
const REVIEW_CHANGED_FILE_CLASS_SCHEMA = buildStringEnumSchema(REVIEW_CHANGED_FILE_CLASSES, {});

const REVIEW_PRECEDENT_CONSULT_STATUS_SCHEMA = Type.Object(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
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

function resolveVerificationEvidenceState(input: {
  verificationOutcomes: ReturnType<BrewvaToolOptions["runtime"]["events"]["queryStructured"]>;
  latestWriteAt: number;
  hasConsumedVerificationEvidence: boolean;
}): ReviewEvidenceState {
  const verificationOutcomes = input.verificationOutcomes.toSorted(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  if (verificationOutcomes.length === 0) {
    return input.hasConsumedVerificationEvidence ? "present" : "missing";
  }
  let sawVerificationAfterLatestWrite = input.latestWriteAt === 0;
  let sawStaleVerification = false;
  for (let index = verificationOutcomes.length - 1; index >= 0; index -= 1) {
    const event = verificationOutcomes[index]!;
    if (event.timestamp < input.latestWriteAt) {
      break;
    }
    sawVerificationAfterLatestWrite = true;
    if (!isRecord(event.payload)) {
      continue;
    }
    const evidenceFreshness = readString(event.payload.evidenceFreshness)?.toLowerCase();
    if (evidenceFreshness === "fresh") {
      return "present";
    }
    if (evidenceFreshness === "stale" || evidenceFreshness === "mixed") {
      sawStaleVerification = true;
    }
  }
  if (!sawVerificationAfterLatestWrite || sawStaleVerification) {
    return "stale";
  }
  return input.hasConsumedVerificationEvidence ? "present" : "missing";
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

function isReviewContractSkill(skill: SkillDocument | undefined): skill is SkillDocument {
  if (!skill) {
    return false;
  }
  const outputs = skill.contract.intent?.outputs ?? [];
  return REVIEW_OUTPUT_KEYS.every((key) => outputs.includes(key));
}

function resolveLatestSkillActivationTimestamp(
  runtime: BrewvaToolOptions["runtime"],
  sessionId: string,
  skillName: string,
): number | undefined {
  const activations = runtime.events.queryStructured(sessionId, { type: "skill_activated" });
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
  const sessionEvents = input.runtime.events.query(input.sessionId);
  const latestWriteAt = resolveLatestWorkspaceWriteTimestamp(sessionEvents);
  const planningEvidenceState = derivePlanningEvidenceState({
    consumedOutputs: input.consumedOutputs,
    latestOutputTimestamps: collectLatestPlanningOutputTimestamps(sessionEvents),
    latestWriteAt,
  });
  const verificationOutcomes = input.runtime.events.queryStructured(input.sessionId, {
    type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  });
  for (const key of ["impact_map", ...PLANNING_EVIDENCE_KEYS, "verification_evidence"] as const) {
    if (!input.consumedKeys.includes(key)) {
      continue;
    }
    if (key === "verification_evidence") {
      out[key] = resolveVerificationEvidenceState({
        verificationOutcomes,
        latestWriteAt,
        hasConsumedVerificationEvidence: hasOwn(input.consumedOutputs, key),
      });
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

function buildReviewEnsembleOutputs(input: {
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
  const activeSkill = input.runtime.skills.getActive(input.sessionId);
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

  const consumedOutputs = input.runtime.skills.getConsumedOutputs(
    input.sessionId,
    activeSkill.name,
  );
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
      run.kind === "review" &&
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

export function createSkillCompleteTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_complete",
    label: "Skill Complete",
    description: "Validate skill outputs against contract and complete the active skill.",
    promptSnippet:
      "Validate and complete the active skill after required outputs and verification evidence are ready.",
    promptGuidelines: [
      "Do not call this until required outputs are prepared.",
      "Verification must pass or be intentionally read-only before completion.",
    ],
    parameters: Type.Object({
      outputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      learningResearch: Type.Optional(
        Type.Object(
          {
            query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
            sourceTypes: Type.Optional(Type.Array(KNOWLEDGE_SOURCE_TYPE_SCHEMA, { maxItems: 5 })),
            module: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            boundary: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            tags: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 10 }),
            ),
            problemKind: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            status: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          },
          { additionalProperties: false },
        ),
      ),
      reviewEnsemble: Type.Optional(
        Type.Object(
          {
            runIds: Type.Optional(Type.Array(Type.String())),
            planningPosture: Type.Optional(REVIEW_PLANNING_POSTURE_SCHEMA),
            changeCategories: Type.Optional(
              Type.Array(REVIEW_CHANGE_CATEGORY_SCHEMA, { maxItems: 32 }),
            ),
            changedFileClasses: Type.Optional(
              Type.Array(REVIEW_CHANGED_FILE_CLASS_SCHEMA, { maxItems: 24 }),
            ),
            evidenceState: Type.Optional(
              Type.Object(
                {
                  impact_map: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                  design_spec: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                  execution_plan: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                  verification_evidence: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                  risk_register: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                  implementation_targets: Type.Optional(REVIEW_EVIDENCE_STATE_SCHEMA),
                },
                { additionalProperties: false },
              ),
            ),
            precedentQuerySummary: Type.String({ minLength: 18 }),
            precedentConsultStatus: REVIEW_PRECEDENT_CONSULT_STATUS_SCHEMA,
          },
          { additionalProperties: false },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const rawOutputs = isRecord(params.outputs) ? params.outputs : {};
      const learningResearch = isRecord(params.learningResearch)
        ? params.learningResearch
        : undefined;
      const reviewEnsemble = isRecord(params.reviewEnsemble) ? params.reviewEnsemble : undefined;
      let outputs = rawOutputs;
      let learningResearchSynthesis:
        | {
            searchMode: string;
            broadened: boolean;
            consultedSourceTypes: readonly string[];
            matchedPaths: readonly string[];
          }
        | undefined;
      let reviewSynthesis:
        | {
            activatedLanes: string[];
            mergeDecision: "ready" | "needs_changes" | "blocked";
            runIds: string[];
          }
        | undefined;

      if (learningResearch) {
        const activeSkill = options.runtime.skills.getActive(sessionId);
        if (!activeSkill) {
          return failTextResult(
            "Learning research synthesis rejected. No active skill is loaded for the current session.",
            {
              ok: false,
            },
          );
        }
        const scope = resolveToolTargetScope(options.runtime, ctx);
        const synthesized = buildLearningResearchOutputs({
          activeSkill,
          rawOutputs,
          consumedOutputs: options.runtime.skills.getConsumedOutputs(sessionId, activeSkill.name),
          searchRoots: scope.allowedRoots,
          params: learningResearch,
        });
        if (!synthesized.ok) {
          return failTextResult(synthesized.message, {
            ok: false,
            ...(synthesized.details ? { details: synthesized.details } : {}),
          });
        }
        outputs = {
          ...outputs,
          ...synthesized.outputs,
        };
        learningResearchSynthesis = synthesized.details;
      }

      if (reviewEnsemble) {
        const synthesized = buildReviewEnsembleOutputs({
          runtime: options.runtime,
          sessionId,
          outputs: rawOutputs,
          reviewEnsemble,
        });
        if (!synthesized.ok) {
          return failTextResult(synthesized.message, {
            ok: false,
            ...(synthesized.details ? { details: synthesized.details } : {}),
          });
        }
        outputs = {
          ...rawOutputs,
          ...synthesized.outputs,
        };
        reviewSynthesis = synthesized.synthesis;
      }

      const completion = options.runtime.skills.validateOutputs(sessionId, outputs);
      if (!completion.ok) {
        const details = [
          completion.missing.length > 0
            ? `Missing required outputs: ${completion.missing.join(", ")}`
            : null,
          completion.invalid.length > 0
            ? `Invalid required outputs: ${completion.invalid
                .map((entry) => `${entry.name} (${entry.reason})`)
                .join(", ")}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(". ");
        return failTextResult(`Skill completion rejected. ${details}`, {
          ok: false,
          missing: completion.missing,
          invalid: completion.invalid,
          ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
          ...(reviewSynthesis ? { reviewSynthesis } : {}),
        });
      }

      const verification = await options.runtime.verification.verify(sessionId, undefined, {
        executeCommands: options.verification?.executeCommands,
        timeoutMs: options.verification?.timeoutMs,
      });

      if (!verification.passed) {
        return inconclusiveTextResult(
          `Verification gate blocked. Skill not completed: ${verification.missingEvidence.join(", ")}`,
          {
            ok: false,
            verification,
            ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
            ...(reviewSynthesis ? { reviewSynthesis } : {}),
          },
        );
      }

      const finalized = options.runtime.skills.complete(sessionId, outputs);
      if (!finalized.ok) {
        const details = [
          finalized.missing.length > 0
            ? `Missing required outputs: ${finalized.missing.join(", ")}`
            : null,
          finalized.invalid.length > 0
            ? `Invalid required outputs: ${finalized.invalid
                .map((entry) => `${entry.name} (${entry.reason})`)
                .join(", ")}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(". ");
        return failTextResult(`Skill completion rejected after verification. ${details}`, {
          ok: false,
          missing: finalized.missing,
          invalid: finalized.invalid,
          verification,
          ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
          ...(reviewSynthesis ? { reviewSynthesis } : {}),
        });
      }
      const message = verification.readOnly
        ? "Skill completed (read-only, no verification needed)."
        : "Skill completed and verification gate passed.";
      return textResult(message, {
        ok: true,
        ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
        verification,
        ...(reviewSynthesis ? { reviewSynthesis } : {}),
      });
    },
  });
}
