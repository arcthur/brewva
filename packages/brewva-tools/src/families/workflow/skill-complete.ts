import { listSkillOutputs } from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import { buildLearningResearchOutputs } from "../../shared/learning-research.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";
import {
  KNOWLEDGE_SOURCE_TYPE_SCHEMA,
  REVIEW_CHANGED_FILE_CLASS_SCHEMA,
  REVIEW_CHANGE_CATEGORY_SCHEMA,
  REVIEW_EVIDENCE_STATE_SCHEMA,
  REVIEW_PLANNING_POSTURE_SCHEMA,
  REVIEW_PRECEDENT_CONSULT_STATUS_SCHEMA,
  buildReviewEnsembleOutputs,
  hasOwn,
  isRecord,
  isReviewContractSkill,
  readReviewMergeDecision,
} from "./skill-complete/review.js";

export function createSkillCompleteTool(options: BrewvaToolOptions): ToolDefinition {
  const skillCompleteTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "skill_complete");
  const runtime = skillCompleteTool.runtime;
  return skillCompleteTool.define(
    {
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
        outputs: Type.Record(Type.String(), Type.Unknown()),
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
        const paramsRecord = isRecord(params) ? params : {};
        const learningResearch = isRecord(params.learningResearch)
          ? params.learningResearch
          : undefined;
        const reviewEnsemble = isRecord(params.reviewEnsemble) ? params.reviewEnsemble : undefined;
        const activeSkill = runtime.inspect.skills.getActive(sessionId);
        if (!activeSkill) {
          return failTextResult(
            "Skill completion rejected. No active skill is loaded for the current session.",
            {
              ok: false,
              missing: [],
              invalid: [
                {
                  name: "skill",
                  reason: "No active skill is loaded for this session.",
                },
              ],
            },
          );
        }
        const hasOutputsProperty = hasOwn(paramsRecord, "outputs");
        const outputKeys = listSkillOutputs(activeSkill.contract);
        const misplacedOutputKeys = outputKeys.filter((key) => hasOwn(paramsRecord, key));
        if (misplacedOutputKeys.length > 0) {
          return failTextResult(
            [
              "Skill completion rejected. Required skill outputs must be supplied under the `outputs` object.",
              "Move top-level output fields into `outputs`.",
            ].join(" "),
            {
              ok: false,
              missing: ["outputs"],
              invalid: [
                {
                  name: "outputs",
                  reason:
                    "skill_complete requires an explicit outputs object unless a supported synthesis mode is enabled.",
                },
              ],
              misplacedOutputKeys,
            },
          );
        }
        if (!hasOutputsProperty) {
          return failTextResult(
            [
              "Skill completion rejected. Required skill outputs must be supplied under the `outputs` object.",
              "Use `outputs: {}` only for a skill that declares no outputs or when using a supported synthesis mode.",
            ].join(" "),
            {
              ok: false,
              missing: ["outputs"],
              invalid: [
                {
                  name: "outputs",
                  reason: "skill_complete requires an explicit outputs object.",
                },
              ],
            },
          );
        }
        if (hasOutputsProperty && !isRecord(params.outputs)) {
          return failTextResult(
            "Skill completion rejected. `outputs` must be an object whose keys are the active skill's required outputs.",
            {
              ok: false,
              missing: [],
              invalid: [
                {
                  name: "outputs",
                  reason: "outputs must be an object.",
                },
              ],
            },
          );
        }
        const rawOutputs = isRecord(params.outputs) ? params.outputs : {};
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
          const scope = resolveToolTargetScope(runtime, ctx);
          const synthesized = buildLearningResearchOutputs({
            activeSkill,
            rawOutputs,
            consumedOutputs: runtime.inspect.skills.getConsumedOutputs(sessionId, activeSkill.name)
              .outputs,
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
            runtime,
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

        const completion = runtime.inspect.skills.validateOutputs(sessionId, outputs);
        if (!completion.ok) {
          const failure = runtime.authority.skills.recordCompletionFailure(
            sessionId,
            outputs,
            completion,
            runtime.inspect.context.getUsage(sessionId),
          );
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
            ...(failure ? { repair: failure } : {}),
            ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
            ...(reviewSynthesis ? { reviewSynthesis } : {}),
          });
        }

        const verificationCommandsDeferred = options.verification?.executeCommands === false;
        const verification = await runtime.authority.verification.verify(sessionId, undefined, {
          executeCommands: options.verification?.executeCommands,
          timeoutMs: options.verification?.timeoutMs,
        });
        const deferredReviewDecision = isReviewContractSkill(activeSkill)
          ? readReviewMergeDecision(outputs.merge_decision)
          : undefined;
        const allowDeferredVerificationCompletion =
          verificationCommandsDeferred &&
          verification.failedChecks.length === 0 &&
          (deferredReviewDecision === "blocked" || deferredReviewDecision === "needs_changes");

        if (!verification.passed && !allowDeferredVerificationCompletion) {
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

        const finalized = runtime.authority.skills.complete(sessionId, outputs);
        if (!finalized.ok) {
          const failure = runtime.authority.skills.recordCompletionFailure(
            sessionId,
            outputs,
            finalized,
            runtime.inspect.context.getUsage(sessionId),
          );
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
            ...(failure ? { repair: failure } : {}),
            verification,
            ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
            ...(reviewSynthesis ? { reviewSynthesis } : {}),
          });
        }
        const message = verification.readOnly
          ? "Skill completed (read-only, no verification needed)."
          : !verification.passed && allowDeferredVerificationCompletion
            ? "Skill completed (review recorded with verification commands deferred)."
            : "Skill completed and verification gate passed.";
        return textResult(message, {
          ok: true,
          ...(learningResearchSynthesis ? { learningResearchSynthesis } : {}),
          verification,
          ...(reviewSynthesis ? { reviewSynthesis } : {}),
        });
      },
    },
    {
      requiredCapabilities: [
        "authority.skills.recordCompletionFailure",
        "authority.verification.verify",
        "authority.skills.complete",
        "inspect.context.getUsage",
        "inspect.events.query",
        "inspect.events.queryStructured",
        "inspect.skills.getActive",
        "inspect.skills.getConsumedOutputs",
        "inspect.task.getTargetDescriptor",
        "inspect.skills.validateOutputs",
      ],
    },
  );
}
