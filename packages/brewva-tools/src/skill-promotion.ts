import {
  getOrCreateSkillPromotionBroker,
  SKILL_PROMOTION_STATUSES,
  SKILL_PROMOTION_TARGET_KINDS,
  type SkillPromotionDraft,
} from "@brewva/brewva-skill-broker";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { createManagedBrewvaToolFactory } from "./utils/runtime-bound-tool.js";

const REVIEW_DECISION_VALUES = ["approve", "reject", "reopen"] as const;

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

export function createSkillPromotionInspectTool(options: BrewvaToolOptions): ToolDefinition {
  const skillPromotionTool = createManagedBrewvaToolFactory("skill_promotion_inspect");
  return skillPromotionTool.define({
    name: "skill_promotion_inspect",
    label: "Skill Promotion Inspect",
    description:
      "Inspect cached evidence-backed skill promotion drafts derived from completed work without deriving new drafts.",
    promptSnippet:
      "Use this to list or show already-derived promotion drafts. This tool is read-only and does not refresh broker state.",
    promptGuidelines: [
      "Use this before review or promote so the operator-visible draft is explicit.",
      "If no cached drafts are visible, let lifecycle maintenance derive drafts instead of using inspect as a refresh path.",
    ],
    parameters: Type.Object({
      draft_id: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(StatusSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const broker = getOrCreateSkillPromotionBroker(options.runtime, {
        subscribeToEvents: true,
      });
      const draftId = readTrimmedString(params.draft_id);
      const status = readStatus(params.status);
      const limit = Math.max(1, Math.min(20, params.limit ?? 10));

      if (!draftId) {
        const drafts = broker.listCached({
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

      const draft = broker.getDraftCached(draftId);
      if (!draft) {
        return failTextResult(
          `Skill promotion draft not found in cached broker state: ${draftId}`,
          {
            ok: false,
            error: "draft_not_found",
            draftId,
          },
        );
      }
      return textResult(formatDraftDetail(draft), {
        ok: true,
        draft,
      });
    },
  });
}

export function createSkillPromotionReviewTool(options: BrewvaToolOptions): ToolDefinition {
  const skillPromotionTool = createManagedBrewvaToolFactory("skill_promotion_review");
  return skillPromotionTool.define({
    name: "skill_promotion_review",
    label: "Skill Promotion Review",
    description: "Record an operator review decision on a skill promotion draft.",
    promptSnippet:
      "Use this only after inspecting the draft and deciding whether it should be approved, rejected, or reopened.",
    promptGuidelines: [
      "Review changes broker state and must be treated as operator-governed memory write.",
      "Reject ambiguous or low-confidence drafts instead of promoting them speculatively.",
    ],
    parameters: Type.Object({
      draft_id: Type.String({ minLength: 1 }),
      decision: ReviewDecisionSchema,
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
    }),
    async execute(_toolCallId, params) {
      const draftId = readTrimmedString(params.draft_id);
      const decision = readDecision(params.decision);
      if (!draftId || !decision) {
        return failTextResult("draft_id and decision are required.", {
          ok: false,
          error: "invalid_review_input",
        });
      }
      const broker = getOrCreateSkillPromotionBroker(options.runtime, {
        subscribeToEvents: true,
      });
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
    },
  });
}

export function createSkillPromotionPromoteTool(options: BrewvaToolOptions): ToolDefinition {
  const skillPromotionTool = createManagedBrewvaToolFactory("skill_promotion_promote");
  return skillPromotionTool.define({
    name: "skill_promotion_promote",
    label: "Skill Promotion Promote",
    description:
      "Materialize an approved skill promotion draft as a reviewable artifact without patching live rules.",
    promptSnippet:
      "Use this to create a materialized promotion packet after the draft has been reviewed and approved.",
    promptGuidelines: [
      "Promotion writes review artifacts only; it does not apply live AGENTS.md or skill-file changes.",
      "Prefer approved drafts. Re-check the target kind and path hint before materializing.",
    ],
    parameters: Type.Object({
      draft_id: Type.String({ minLength: 1 }),
      target_kind: Type.Optional(TargetKindSchema),
      path_hint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }),
    async execute(_toolCallId, params) {
      const draftId = readTrimmedString(params.draft_id);
      if (!draftId) {
        return failTextResult("draft_id is required.", {
          ok: false,
          error: "missing_draft_id",
        });
      }
      const broker = getOrCreateSkillPromotionBroker(options.runtime, {
        subscribeToEvents: true,
      });
      const currentDraft = broker.getDraft(draftId);
      if (!currentDraft) {
        return failTextResult(`Skill promotion draft not found: ${draftId}`, {
          ok: false,
          error: "draft_not_found",
          draftId,
        });
      }
      if (currentDraft.status !== "approved") {
        return failTextResult(
          `Skill promotion draft must be approved before promotion: ${draftId}`,
          {
            ok: false,
            error: "draft_not_approved",
            draftId,
            status: currentDraft.status,
          },
        );
      }
      const draft = broker.promoteDraft({
        draftId,
        targetKind: readTargetKind(params.target_kind),
        pathHint: readTrimmedString(params.path_hint),
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
