import {
  getOrCreateSkillPromotionBroker,
  SKILL_PROMOTION_STATUSES,
  SKILL_PROMOTION_TARGET_KINDS,
  type SkillPromotionDraft,
} from "@brewva/brewva-skill-broker";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ACTION_VALUES = ["list", "show", "review", "promote"] as const;
const REVIEW_DECISION_VALUES = ["approve", "reject", "reopen"] as const;

const ActionSchema = buildStringEnumSchema(ACTION_VALUES, {});
const StatusSchema = buildStringEnumSchema(SKILL_PROMOTION_STATUSES, {});
const ReviewDecisionSchema = buildStringEnumSchema(REVIEW_DECISION_VALUES, {});
const TargetKindSchema = buildStringEnumSchema(SKILL_PROMOTION_TARGET_KINDS, {});

function readStatus(value: unknown): (typeof SKILL_PROMOTION_STATUSES)[number] | undefined {
  return typeof value === "string" &&
    SKILL_PROMOTION_STATUSES.includes(value as (typeof SKILL_PROMOTION_STATUSES)[number])
    ? (value as (typeof SKILL_PROMOTION_STATUSES)[number])
    : undefined;
}

function readDecision(value: unknown): (typeof REVIEW_DECISION_VALUES)[number] | undefined {
  return typeof value === "string" &&
    REVIEW_DECISION_VALUES.includes(value as (typeof REVIEW_DECISION_VALUES)[number])
    ? (value as (typeof REVIEW_DECISION_VALUES)[number])
    : undefined;
}

function readTargetKind(value: unknown): (typeof SKILL_PROMOTION_TARGET_KINDS)[number] | undefined {
  return typeof value === "string" &&
    SKILL_PROMOTION_TARGET_KINDS.includes(value as (typeof SKILL_PROMOTION_TARGET_KINDS)[number])
    ? (value as (typeof SKILL_PROMOTION_TARGET_KINDS)[number])
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function formatDraftSummary(draft: SkillPromotionDraft): string {
  return [
    `- ${draft.id}`,
    `  status=${draft.status}`,
    `  source_skill=${draft.sourceSkillName}`,
    `  target=${draft.target.kind}:${draft.target.pathHint}`,
    `  confidence=${draft.confidenceScore.toFixed(2)}`,
    `  repeat_count=${draft.repeatCount}`,
    `  summary=${draft.summary}`,
  ].join("\n");
}

function formatDraftDetail(draft: SkillPromotionDraft): string {
  const lines = [
    "# Skill Promotion Draft",
    `id: ${draft.id}`,
    `status: ${draft.status}`,
    `source_skill: ${draft.sourceSkillName}`,
    `target_kind: ${draft.target.kind}`,
    `path_hint: ${draft.target.pathHint}`,
    `confidence_score: ${draft.confidenceScore.toFixed(2)}`,
    `repeat_count: ${draft.repeatCount}`,
    `first_captured_at: ${new Date(draft.firstCapturedAt).toISOString()}`,
    `last_validated_at: ${new Date(draft.lastValidatedAt).toISOString()}`,
    "",
    "## Summary",
    draft.summary,
    "",
    "## Rationale",
    draft.rationale,
    "",
    "## Target Rationale",
    draft.target.rationale,
    "",
    "## Tags",
    draft.tags.length > 0 ? draft.tags.join(", ") : "none",
    "",
    "## Proposal",
    draft.proposalText,
  ];

  if (draft.review) {
    lines.push(
      "",
      "## Review",
      `decision: ${draft.review.decision}`,
      `reviewed_at: ${new Date(draft.review.reviewedAt).toISOString()}`,
      `note: ${draft.review.note ?? "none"}`,
    );
  }

  if (draft.promotion) {
    lines.push(
      "",
      "## Materialization",
      `directory_path: ${draft.promotion.directoryPath}`,
      `primary_path: ${draft.promotion.primaryPath}`,
      `format: ${draft.promotion.format}`,
      `materialized_at: ${new Date(draft.promotion.materializedAt).toISOString()}`,
    );
  }

  if (draft.evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const evidence of draft.evidence.slice(0, 8)) {
      lines.push(
        `- session=${evidence.sessionId} event=${evidence.eventId} type=${evidence.eventType} at=${new Date(evidence.timestamp).toISOString()}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function createSkillPromotionTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_promotion",
    label: "Skill Promotion",
    description:
      "Inspect, review, and materialize evidence-backed skill promotion drafts derived from completed work.",
    promptSnippet:
      "Use this to inspect or advance post-execution promotion drafts without turning runtime execution into a turn-time skill broker.",
    promptGuidelines: [
      "List or show drafts before approving or promoting them when the target home is still ambiguous.",
      "Promotion materializes a review packet under .brewva/skill-broker/materialized and does not patch live skills automatically.",
    ],
    parameters: Type.Object({
      action: ActionSchema,
      draft_id: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(StatusSchema),
      decision: Type.Optional(ReviewDecisionSchema),
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
      target_kind: Type.Optional(TargetKindSchema),
      path_hint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const broker = getOrCreateSkillPromotionBroker(options.runtime, {
        subscribeToEvents: true,
      });
      const draftId = readTrimmedString(params.draft_id);
      const status = readStatus(params.status);
      const decision = readDecision(params.decision);
      const targetKind = readTargetKind(params.target_kind);
      const pathHint = readTrimmedString(params.path_hint);
      const limit = Math.max(1, Math.min(20, params.limit ?? 10));

      if (params.action === "list") {
        const drafts = broker.list({
          status,
          limit,
        });
        if (drafts.length === 0) {
          return inconclusiveTextResult("No skill promotion drafts match the current filter.", {
            ok: false,
            status: status ?? null,
            drafts: [],
          });
        }
        return textResult(
          [
            "# Skill Promotion Drafts",
            `count: ${drafts.length}`,
            ...drafts.map(formatDraftSummary),
          ].join("\n"),
          {
            ok: true,
            status: status ?? null,
            drafts,
          },
        );
      }

      if (!draftId) {
        return failTextResult("draft_id is required for show, review, and promote.", {
          ok: false,
          error: "missing_draft_id",
        });
      }

      if (params.action === "show") {
        const draft = broker.getDraft(draftId);
        if (!draft) {
          return failTextResult(`Skill promotion draft not found: ${draftId}`, {
            ok: false,
            error: "draft_not_found",
            draftId,
          });
        }
        return textResult(formatDraftDetail(draft), {
          ok: true,
          draft,
        });
      }

      if (params.action === "review") {
        if (!decision) {
          return failTextResult("review requires decision = approve | reject | reopen.", {
            ok: false,
            error: "missing_decision",
            draftId,
          });
        }
        const draft = broker.reviewDraft({
          draftId,
          decision,
          note: readTrimmedString(params.note),
        });
        if (!draft) {
          return failTextResult(`Skill promotion draft not found: ${draftId}`, {
            ok: false,
            error: "draft_not_found",
            draftId,
          });
        }
        return textResult(formatDraftDetail(draft), {
          ok: true,
          draft,
        });
      }

      const draft = broker.promoteDraft({
        draftId,
        targetKind,
        pathHint,
      });
      if (!draft) {
        return failTextResult(`Skill promotion draft not found: ${draftId}`, {
          ok: false,
          error: "draft_not_found",
          draftId,
        });
      }
      return textResult(formatDraftDetail(draft), {
        ok: true,
        draft,
        promotion: draft.promotion ?? null,
      });
    },
  });
}
