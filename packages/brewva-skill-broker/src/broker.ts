import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  clamp,
  collectPlaneSessionDigests,
  samePlaneSessionDigests,
  shouldThrottlePlaneRefresh,
  tokenize,
  uniqueStrings,
} from "@brewva/brewva-deliberation";
import {
  CONTEXT_SOURCES,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
  SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
  SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
  coerceReviewReportArtifact,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type ContextSourceProvider,
  type SkillDocument,
} from "@brewva/brewva-runtime";
import { FileSkillPromotionStore } from "./file-store.js";
import {
  SKILL_PROMOTION_STATE_SCHEMA,
  type SkillPromotionDraft,
  type SkillPromotionEvidenceRef,
  type SkillPromotionMaterialization,
  type SkillPromotionReview,
  type SkillPromotionSessionDigest,
  type SkillPromotionState,
  type SkillPromotionStatus,
  type SkillPromotionTarget,
  type SkillPromotionTargetKind,
} from "./types.js";

const DEFAULT_MAX_CONTEXT_DRAFTS = 2;
const PROMOTION_TRIGGER_TOKENS = new Set([
  "learn",
  "learning",
  "promote",
  "promotion",
  "skill",
  "skills",
  "rule",
  "rules",
  "remember",
  "systemic",
  "repeat",
  "repeated",
  "improve",
  "improvement",
  "workflow",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function compactText(value: string, maxChars = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function slugify(text: string, fallback = "draft"): string {
  const normalized = tokenize(text).join("-");
  return normalized.length > 0 ? normalized.slice(0, 64) : fallback;
}

function listSessionDigests(runtime: SkillPromotionRuntime): SkillPromotionSessionDigest[] {
  return collectPlaneSessionDigests(runtime.events);
}

function sameSessionDigests(
  left: readonly SkillPromotionSessionDigest[],
  right: readonly SkillPromotionSessionDigest[],
): boolean {
  return samePlaneSessionDigests(left, right);
}

function buildEvidence(event: BrewvaEventRecord): SkillPromotionEvidenceRef {
  return {
    sessionId: event.sessionId,
    eventId: event.id,
    eventType: event.type,
    timestamp: event.timestamp,
  };
}

function normalizeDecisionStatus(
  status: SkillPromotionStatus,
  review: SkillPromotionReview | undefined,
): SkillPromotionStatus {
  if (status === "promoted") return "promoted";
  if (!review) return status;
  if (review.decision === "approve") return "approved";
  if (review.decision === "reject") return "rejected";
  return "draft";
}

function inferReferencedSkill(
  text: string,
  skills: readonly SkillDocument[],
): SkillDocument | undefined {
  const haystack = ` ${text.toLowerCase()} `;
  return skills.find((skill) => haystack.includes(` ${skill.name.toLowerCase()} `));
}

function inferTarget(input: {
  sourceSkillName: string;
  text: string;
  skills: readonly SkillDocument[];
  title: string;
  workspaceRoot: string;
}): SkillPromotionTarget {
  const lower = input.text.toLowerCase();
  const referencedSkill = inferReferencedSkill(input.text, input.skills);
  if (
    lower.includes("agents.md") ||
    lower.includes("workspace rule") ||
    lower.includes("project rule")
  ) {
    return {
      kind: lower.includes("agents.md") ? "agents_update" : "project_rule",
      pathHint: lower.includes("agents.md")
        ? "AGENTS.md"
        : "skills/project/shared/derived-learning.md",
      rationale:
        "The proposal reads like durable repository guidance rather than a skill-local change.",
    };
  }
  if (lower.includes("docs/") || lower.includes("documentation") || lower.includes("reference")) {
    return {
      kind: "docs_note",
      pathHint: `docs/reference/${slugify(input.title, "promotion-note")}.md`,
      rationale: "The proposal reads like operator-facing runtime or workflow documentation.",
    };
  }
  if (
    lower.includes("new skill") ||
    lower.includes("extract skill") ||
    lower.includes("scaffold skill")
  ) {
    return {
      kind: "new_skill",
      pathHint: `skills/meta/${slugify(input.title, "promoted-skill")}/SKILL.md`,
      rationale:
        "The proposal explicitly describes a new reusable skill rather than patching an existing one.",
    };
  }
  if (referencedSkill) {
    const pathHint = referencedSkill.filePath.startsWith(input.workspaceRoot)
      ? relative(input.workspaceRoot, referencedSkill.filePath) || referencedSkill.filePath
      : referencedSkill.filePath;
    return {
      kind: "skill_patch",
      pathHint,
      rationale: `The proposal references the existing skill '${referencedSkill.name}', so the best home is a patch to that skill.`,
    };
  }
  return {
    kind: "project_rule",
    pathHint: `skills/project/shared/${slugify(input.sourceSkillName, "learning")}.md`,
    rationale: "No explicit target skill was referenced; default to a shared project rule draft.",
  };
}

function extractArrayPreview(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return compactText(entry, 160);
      if (isRecord(entry)) {
        try {
          return compactText(JSON.stringify(entry), 160);
        } catch {
          return "";
        }
      }
      return "";
    })
    .filter((entry) => entry.length > 0)
    .slice(0, 4);
}

function buildProposalText(input: {
  title: string;
  summary: string;
  rationale: string;
  target: SkillPromotionTarget;
  evidence: readonly SkillPromotionEvidenceRef[];
  sourceSkillName: string;
  snippets: readonly string[];
}): string {
  const lines = [
    `Title: ${input.title}`,
    `Source Skill: ${input.sourceSkillName}`,
    `Target Kind: ${input.target.kind}`,
    `Path Hint: ${input.target.pathHint}`,
    `Why This Home: ${input.target.rationale}`,
    "",
    "Summary:",
    input.summary,
    "",
    "Rationale:",
    input.rationale,
  ];
  if (input.snippets.length > 0) {
    lines.push("", "Source Snippets:");
    for (const snippet of input.snippets) {
      lines.push(`- ${snippet}`);
    }
  }
  lines.push("", "Evidence:");
  for (const ref of input.evidence.slice(0, 8)) {
    lines.push(
      `- session=${ref.sessionId} event=${ref.eventId} type=${ref.eventType} at=${new Date(ref.timestamp).toISOString()}`,
    );
  }
  return lines.join("\n");
}

type RawPromotionCandidate = {
  signature: string;
  title: string;
  summary: string;
  rationale: string;
  sourceSkillName: string;
  target: SkillPromotionTarget;
  evidence: SkillPromotionEvidenceRef[];
  sessionIds: string[];
  snippets: string[];
  tags: string[];
  firstCapturedAt: number;
  lastValidatedAt: number;
};

function extractPromotionCandidates(
  runtime: SkillPromotionRuntime,
  events: readonly BrewvaEventRecord[],
): RawPromotionCandidate[] {
  const skills = runtime.skills.list();
  const candidates: RawPromotionCandidate[] = [];

  for (const event of events) {
    if (event.type !== SKILL_COMPLETED_EVENT_TYPE) continue;
    if (!isRecord(event.payload)) continue;
    const sourceSkillName = readString(event.payload.skillName);
    const outputs = isRecord(event.payload.outputs) ? event.payload.outputs : undefined;
    if (!sourceSkillName || !outputs) continue;

    const outputSnippets: string[] = [];
    const primarySignals: string[] = [];
    const hypothesis = readString(outputs.improvement_hypothesis);
    const plan = readString(outputs.improvement_plan);
    const followup = readString(outputs.followup_recommendation);
    const structuredReviewReport = coerceReviewReportArtifact(outputs.review_report);
    const reviewReport = structuredReviewReport?.summary ?? readString(outputs.review_report);
    const retroSummary = readString(outputs.retro_summary);
    const reviewFindings = extractArrayPreview(outputs.review_findings);
    const retroFindings = extractArrayPreview(outputs.retro_findings);
    const backlog = extractArrayPreview(outputs.learning_backlog);

    if (hypothesis) {
      outputSnippets.push(`Hypothesis: ${compactText(hypothesis, 180)}`);
      primarySignals.push(hypothesis);
    }
    if (plan) {
      outputSnippets.push(`Plan: ${compactText(plan, 180)}`);
      primarySignals.push(plan);
    }
    if (followup) {
      outputSnippets.push(`Follow-up: ${compactText(followup, 180)}`);
      primarySignals.push(followup);
    }
    if (retroSummary) {
      outputSnippets.push(`Retro: ${compactText(retroSummary, 180)}`);
    }
    if (reviewReport) {
      outputSnippets.push(`Review: ${compactText(reviewReport, 180)}`);
    }
    if ((structuredReviewReport?.activated_lanes.length ?? 0) > 0) {
      outputSnippets.push(
        `Review lanes: ${structuredReviewReport!.activated_lanes.slice(0, 4).join(", ")}`,
      );
    }
    outputSnippets.push(...reviewFindings.map((entry) => `Review finding: ${entry}`));
    outputSnippets.push(...retroFindings.map((entry) => `Retro finding: ${entry}`));
    outputSnippets.push(...backlog.map((entry) => `Backlog: ${entry}`));

    if (outputSnippets.length === 0) {
      continue;
    }

    const signalText = primarySignals.join(" ").trim() || outputSnippets.join(" ").trim();
    const target = inferTarget({
      sourceSkillName,
      text: signalText,
      skills,
      title: signalText,
      workspaceRoot: runtime.workspaceRoot,
    });
    const title =
      compactText(
        hypothesis ??
          followup ??
          reviewReport ??
          retroSummary ??
          `Promote learning from ${sourceSkillName}`,
        100,
      ) || `Promote learning from ${sourceSkillName}`;
    const signature = [
      sourceSkillName,
      target.kind,
      target.pathHint.toLowerCase(),
      tokenize(title).slice(0, 6).join("-"),
    ].join(":");
    candidates.push({
      signature,
      title,
      summary: compactText(outputSnippets.slice(0, 3).join(" "), 240),
      rationale: compactText(
        plan ??
          followup ??
          hypothesis ??
          reviewReport ??
          retroSummary ??
          `Derived from ${sourceSkillName} completion.`,
        320,
      ),
      sourceSkillName,
      target,
      evidence: [buildEvidence(event)],
      sessionIds: [event.sessionId],
      snippets: outputSnippets,
      tags: uniqueStrings([sourceSkillName, target.kind, ...tokenize(target.pathHint).slice(0, 3)]),
      firstCapturedAt: event.timestamp,
      lastValidatedAt: event.timestamp,
    });
  }

  return candidates;
}

function mergeCandidates(candidates: readonly RawPromotionCandidate[]): RawPromotionCandidate[] {
  const merged = new Map<string, RawPromotionCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.signature);
    if (!existing) {
      merged.set(candidate.signature, {
        ...candidate,
        evidence: [...candidate.evidence],
        sessionIds: [...candidate.sessionIds],
        snippets: [...candidate.snippets],
        tags: [...candidate.tags],
      });
      continue;
    }
    existing.evidence.push(...candidate.evidence);
    existing.sessionIds.push(...candidate.sessionIds);
    existing.snippets.push(...candidate.snippets);
    existing.tags.push(...candidate.tags);
    existing.firstCapturedAt = Math.min(existing.firstCapturedAt, candidate.firstCapturedAt);
    if (candidate.lastValidatedAt >= existing.lastValidatedAt) {
      existing.lastValidatedAt = candidate.lastValidatedAt;
      existing.title = candidate.title;
      existing.summary = candidate.summary;
      existing.rationale = candidate.rationale;
      existing.target = candidate.target;
    }
  }
  return [...merged.values()];
}

function buildDraftFromCandidate(
  candidate: RawPromotionCandidate,
  lifecycle: PromotionLifecycleState | undefined,
): SkillPromotionDraft {
  const uniqueSessions = uniqueStrings(candidate.sessionIds);
  const repeatCount = uniqueSessions.length;
  const evidence = [
    ...new Map(
      candidate.evidence.map((entry) => [`${entry.sessionId}:${entry.eventId}`, entry] as const),
    ).values(),
  ].toSorted((left, right) => right.timestamp - left.timestamp);
  const confidenceScore = clamp(
    0.48 +
      (candidate.sourceSkillName === "self-improve" ? 0.16 : 0.08) +
      Math.min(0.18, repeatCount * 0.08) +
      Math.min(0.08, evidence.length * 0.02),
    0,
    1,
  );
  const review = lifecycle?.review;
  const target = lifecycle?.target
    ? { ...candidate.target, ...lifecycle.target }
    : candidate.target;
  const baseStatus = lifecycle?.promoted ? "promoted" : normalizeDecisionStatus("draft", review);
  return {
    id: `spd:${slugify(candidate.signature, "promotion")}`,
    status: baseStatus,
    title: candidate.title,
    summary: candidate.summary,
    rationale: candidate.rationale,
    sourceSkillName: candidate.sourceSkillName,
    target,
    repeatCount,
    confidenceScore,
    firstCapturedAt: candidate.firstCapturedAt,
    lastValidatedAt: candidate.lastValidatedAt,
    sessionIds: uniqueSessions,
    evidence,
    tags: uniqueStrings(candidate.tags).slice(0, 12),
    proposalText: buildProposalText({
      title: candidate.title,
      summary: candidate.summary,
      rationale: candidate.rationale,
      target,
      evidence,
      sourceSkillName: candidate.sourceSkillName,
      snippets: uniqueStrings(candidate.snippets).slice(0, 8),
    }),
    review,
    promotion: lifecycle?.promotion,
  };
}

interface PromotionLifecycleCursor {
  ordinal: number;
  timestamp: number;
}

interface PromotionLifecycleState {
  promoted: boolean;
  promotion?: SkillPromotionMaterialization;
  review?: SkillPromotionReview;
  target?: Pick<SkillPromotionTarget, "kind" | "pathHint">;
  promotionCursor?: PromotionLifecycleCursor;
  reviewCursor?: PromotionLifecycleCursor;
  materializationCursor?: PromotionLifecycleCursor;
}

function isLaterLifecycleEvent(
  current: PromotionLifecycleCursor | undefined,
  next: PromotionLifecycleCursor,
): boolean {
  if (!current) return true;
  if (next.timestamp !== current.timestamp) {
    return next.timestamp > current.timestamp;
  }
  return next.ordinal > current.ordinal;
}

function readMaterializationFormat(
  value: unknown,
): SkillPromotionMaterialization["format"] | undefined {
  return value === "markdown_packet" || value === "skill_scaffold" ? value : undefined;
}

function collectPromotionLifecycleState(input: {
  runtime: SkillPromotionRuntime;
  sessionDigests: readonly SkillPromotionSessionDigest[];
}): Map<string, PromotionLifecycleState> {
  const byDraftId = new Map<string, PromotionLifecycleState>();
  let ordinal = 0;
  for (const digest of input.sessionDigests) {
    for (const event of input.runtime.events.list(digest.sessionId)) {
      ordinal += 1;
      if (
        event.type !== SKILL_PROMOTION_REVIEWED_EVENT_TYPE &&
        event.type !== SKILL_PROMOTION_PROMOTED_EVENT_TYPE &&
        event.type !== SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE
      ) {
        continue;
      }
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const draftId = readString(payload?.draftId);
      if (!draftId) continue;
      const current = byDraftId.get(draftId) ?? { promoted: false };
      const cursor = {
        ordinal,
        timestamp: event.timestamp,
      };

      if (event.type === SKILL_PROMOTION_REVIEWED_EVENT_TYPE) {
        const decision = payload?.decision;
        if (decision !== "approve" && decision !== "reject" && decision !== "reopen") {
          continue;
        }
        if (!isLaterLifecycleEvent(current.reviewCursor, cursor)) {
          continue;
        }
        current.review = {
          decision,
          note: readString(payload?.note),
          reviewedAt: event.timestamp,
        };
        current.reviewCursor = cursor;
        byDraftId.set(draftId, current);
        continue;
      }

      if (event.type === SKILL_PROMOTION_PROMOTED_EVENT_TYPE) {
        if (!isLaterLifecycleEvent(current.promotionCursor, cursor)) {
          continue;
        }
        const targetKind = payload?.targetKind;
        const pathHint = readString(payload?.pathHint);
        current.promoted = true;
        if (
          (targetKind === "skill_patch" ||
            targetKind === "new_skill" ||
            targetKind === "docs_note" ||
            targetKind === "project_rule" ||
            targetKind === "agents_update") &&
          pathHint
        ) {
          current.target = {
            kind: targetKind,
            pathHint,
          };
        }
        current.promotionCursor = cursor;
        byDraftId.set(draftId, current);
        continue;
      }

      if (!isLaterLifecycleEvent(current.materializationCursor, cursor)) {
        continue;
      }
      const directoryPath = readString(payload?.directoryPath);
      const primaryPath = readString(payload?.primaryPath);
      const format = readMaterializationFormat(payload?.format);
      if (!directoryPath || !primaryPath || !format) {
        continue;
      }
      current.promoted = true;
      current.promotion = {
        materializedAt: event.timestamp,
        directoryPath,
        primaryPath,
        format,
      };
      current.materializationCursor = cursor;
      byDraftId.set(draftId, current);
    }
  }
  return byDraftId;
}

function collectDerivedDraftIds(input: {
  runtime: SkillPromotionRuntime;
  sessionDigests: readonly SkillPromotionSessionDigest[];
}): Set<string> {
  const derivedDraftIds = new Set<string>();
  for (const digest of input.sessionDigests) {
    for (const event of input.runtime.events.list(digest.sessionId)) {
      if (event.type !== SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE) continue;
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const draftId = readString(payload?.draftId);
      if (draftId) {
        derivedDraftIds.add(draftId);
      }
    }
  }
  return derivedDraftIds;
}

function buildPromotionState(input: {
  runtime: SkillPromotionRuntime;
  sessionDigests: readonly SkillPromotionSessionDigest[];
  updatedAt?: number;
}): SkillPromotionState {
  const lifecycleById = collectPromotionLifecycleState({
    runtime: input.runtime,
    sessionDigests: input.sessionDigests,
  });
  const rawCandidates = mergeCandidates(
    input.sessionDigests.flatMap((digest) =>
      extractPromotionCandidates(input.runtime, input.runtime.events.list(digest.sessionId)),
    ),
  );
  const drafts = rawCandidates
    .map((candidate) => {
      const id = `spd:${slugify(candidate.signature, "promotion")}`;
      return buildDraftFromCandidate(candidate, lifecycleById.get(id));
    })
    .toSorted(
      (left, right) =>
        right.lastValidatedAt - left.lastValidatedAt || left.id.localeCompare(right.id),
    );

  return {
    schema: SKILL_PROMOTION_STATE_SCHEMA,
    updatedAt: input.updatedAt ?? Date.now(),
    sessionDigests: [...input.sessionDigests],
    drafts,
  };
}

function shouldInjectDrafts(promptText: string, drafts: readonly SkillPromotionDraft[]): boolean {
  if (drafts.some((draft) => draft.status === "approved")) {
    return true;
  }
  const tokens = new Set(tokenize(promptText));
  for (const token of tokens) {
    if (PROMOTION_TRIGGER_TOKENS.has(token)) {
      return true;
    }
  }
  return false;
}

function renderContextDraft(draft: SkillPromotionDraft): string {
  return [
    `[SkillPromotionDraft]`,
    `id: ${draft.id}`,
    `status: ${draft.status}`,
    `target: ${draft.target.kind} -> ${draft.target.pathHint}`,
    `confidence: ${draft.confidenceScore.toFixed(2)}`,
    `repeat_count: ${draft.repeatCount}`,
    `summary: ${draft.summary}`,
    `rationale: ${draft.rationale}`,
  ].join("\n");
}

function resolveMaterializationDirectory(workspaceRoot: string, draftId: string): string {
  return resolve(workspaceRoot, ".brewva", "skill-broker", "materialized", draftId);
}

function writeMaterializedFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function buildMarkdownPacket(draft: SkillPromotionDraft): string {
  const lines = [
    `# Skill Promotion Draft`,
    "",
    `## Title`,
    draft.title,
    "",
    `## Status`,
    draft.status,
    "",
    `## Proposed Target`,
    `- kind: ${draft.target.kind}`,
    `- path_hint: ${draft.target.pathHint}`,
    `- rationale: ${draft.target.rationale}`,
    "",
    `## Summary`,
    draft.summary,
    "",
    `## Rationale`,
    draft.rationale,
    "",
    `## Proposal`,
    draft.proposalText,
  ];
  if (draft.review?.note) {
    lines.push("", "## Review Note", draft.review.note);
  }
  return `${lines.join("\n")}\n`;
}

function buildSkillScaffold(draft: SkillPromotionDraft): string {
  const skillName = slugify(draft.title, "promoted-skill").replace(/-/gu, "_");
  return `---
name: ${skillName}
description: ${draft.summary}
stability: experimental
intent:
  outputs: []
effects:
  allowed_effects:
    - workspace_read
resources:
  default_lease:
    max_tool_calls: 40
    max_tokens: 80000
  hard_ceiling:
    max_tool_calls: 80
    max_tokens: 140000
execution_hints:
  preferred_tools: []
consumes: []
requires: []
---

# ${draft.title}

## Objective

${draft.summary}

## Trigger

- Use this when the recurring pattern captured in the promotion draft appears again.

## Workflow

1. Re-ground on the evidence summarized below.
2. Apply the bounded guidance captured in the promotion packet.
3. Validate against the same failure mode or repeated friction that triggered the draft.

## Source Guidance

${draft.proposalText}

## Stop Conditions

- The guidance no longer matches the repository reality.
- The underlying recurring pattern is not reproducible from evidence.

## Anti-Patterns

- Promoting a one-off bug into a reusable skill.
- Copying this scaffold into the live skill catalog without tightening scope and outputs.

## Examples

Input: "The same friction is repeating; extract the reusable workflow."

Output: a production-ready skill derived from this scaffold.
`;
}

export class SkillPromotionBroker {
  private readonly runtime: SkillPromotionRuntime;
  private readonly workspaceRoot: string;
  private readonly store: FileSkillPromotionStore;
  private readonly minRefreshIntervalMs: number;
  private state: SkillPromotionState | undefined;
  private dirty = true;

  constructor(
    runtime: SkillPromotionRuntime,
    options: {
      workspaceRoot?: string;
      subscribeToEvents?: boolean;
      minRefreshIntervalMs?: number;
    } = {},
  ) {
    this.runtime = runtime;
    this.workspaceRoot = options.workspaceRoot ?? runtime.workspaceRoot;
    this.store = new FileSkillPromotionStore(this.workspaceRoot);
    this.minRefreshIntervalMs = Math.max(0, options.minRefreshIntervalMs ?? 0);
    this.state = this.store.read();
    if (options.subscribeToEvents !== false) {
      this.runtime.events.subscribe((event) => {
        if (event.type === SKILL_COMPLETED_EVENT_TYPE) {
          this.dirty = true;
        }
      });
    }
  }

  list(
    options: {
      status?: SkillPromotionStatus;
      limit?: number;
    } = {},
  ): SkillPromotionDraft[] {
    const drafts = this.sync().drafts;
    return drafts
      .filter((draft) => !options.status || draft.status === options.status)
      .slice(0, Math.max(1, options.limit ?? drafts.length));
  }

  listCached(
    options: {
      status?: SkillPromotionStatus;
      limit?: number;
    } = {},
  ): SkillPromotionDraft[] {
    const drafts = this.state?.drafts ?? [];
    return drafts
      .filter((draft) => !options.status || draft.status === options.status)
      .slice(0, Math.max(1, options.limit ?? drafts.length));
  }

  getDraft(draftId: string): SkillPromotionDraft | undefined {
    const normalizedId = draftId.trim();
    if (!normalizedId) return undefined;
    return this.sync().drafts.find((draft) => draft.id === normalizedId);
  }

  getDraftCached(draftId: string): SkillPromotionDraft | undefined {
    const normalizedId = draftId.trim();
    if (!normalizedId) return undefined;
    return this.state?.drafts.find((draft) => draft.id === normalizedId);
  }

  sync(): SkillPromotionState {
    return this.reconcile();
  }

  reviewDraft(input: {
    draftId: string;
    decision: SkillPromotionReview["decision"];
    note?: string;
  }): SkillPromotionDraft | undefined {
    const state = this.sync();
    const index = state.drafts.findIndex((draft) => draft.id === input.draftId.trim());
    if (index < 0) return undefined;
    const current = state.drafts[index];
    if (!current) return undefined;
    const review: SkillPromotionReview = {
      decision: input.decision,
      note: readString(input.note),
      reviewedAt: Date.now(),
    };
    const next: SkillPromotionDraft = {
      ...current,
      status: normalizeDecisionStatus(current.status === "promoted" ? "promoted" : "draft", review),
      review,
    };
    state.drafts[index] = next;
    state.updatedAt = Date.now();
    this.store.write(state);
    this.state = state;
    this.runtime.events.record({
      sessionId: next.sessionIds[0] ?? "skill-promotion",
      type: SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
      payload: {
        draftId: next.id,
        decision: review.decision,
        status: next.status,
        note: review.note ?? null,
        targetKind: next.target.kind,
      },
    });
    return next;
  }

  promoteDraft(input: {
    draftId: string;
    targetKind?: SkillPromotionTargetKind;
    pathHint?: string;
  }): SkillPromotionDraft | undefined {
    const state = this.sync();
    const index = state.drafts.findIndex((draft) => draft.id === input.draftId.trim());
    if (index < 0) return undefined;
    const current = state.drafts[index];
    if (!current) return undefined;
    const nextTarget: SkillPromotionTarget =
      input.targetKind || readString(input.pathHint)
        ? {
            kind: input.targetKind ?? current.target.kind,
            pathHint: readString(input.pathHint) ?? current.target.pathHint,
            rationale: current.target.rationale,
          }
        : current.target;
    const materialization = this.materializeDraft({
      ...current,
      target: nextTarget,
    });
    const next: SkillPromotionDraft = {
      ...current,
      status: "promoted",
      target: nextTarget,
      promotion: materialization,
    };
    state.drafts[index] = next;
    state.updatedAt = Date.now();
    this.store.write(state);
    this.state = state;
    this.runtime.events.record({
      sessionId: next.sessionIds[0] ?? "skill-promotion",
      type: SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
      payload: {
        draftId: next.id,
        targetKind: next.target.kind,
        pathHint: next.target.pathHint,
        materializedPath: next.promotion?.primaryPath ?? null,
      },
    });
    this.runtime.events.record({
      sessionId: next.sessionIds[0] ?? "skill-promotion",
      type: SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
      payload: {
        draftId: next.id,
        directoryPath: next.promotion?.directoryPath ?? null,
        primaryPath: next.promotion?.primaryPath ?? null,
        format: next.promotion?.format ?? null,
      },
    });
    return next;
  }

  private materializeDraft(draft: SkillPromotionDraft): SkillPromotionMaterialization {
    const directoryPath = resolveMaterializationDirectory(this.workspaceRoot, draft.id);
    mkdirSync(directoryPath, { recursive: true });
    const metadataPath = resolve(directoryPath, "metadata.json");
    writeMaterializedFile(metadataPath, `${JSON.stringify(draft, null, 2)}\n`);
    if (draft.target.kind === "new_skill") {
      const skillPath = resolve(directoryPath, "SKILL.md");
      writeMaterializedFile(skillPath, buildSkillScaffold(draft));
      return {
        materializedAt: Date.now(),
        directoryPath,
        primaryPath: skillPath,
        format: "skill_scaffold",
      };
    }
    const markdownPath = resolve(directoryPath, "PROMOTION.md");
    writeMaterializedFile(markdownPath, buildMarkdownPacket(draft));
    return {
      materializedAt: Date.now(),
      directoryPath,
      primaryPath: markdownPath,
      format: "markdown_packet",
    };
  }

  private reconcile(): SkillPromotionState {
    const now = Date.now();
    const sessionDigests = listSessionDigests(this.runtime);
    const current = this.store.read() ?? this.state;
    const hasState = Boolean(current);
    const digestsChanged =
      !hasState || !sameSessionDigests(current?.sessionDigests ?? [], sessionDigests);
    if (!digestsChanged && !this.dirty) {
      this.state = current;
      return current ?? createEmptyPromotionState(sessionDigests);
    }
    if (
      current &&
      shouldThrottlePlaneRefresh({
        currentUpdatedAt: current.updatedAt,
        dirty: this.dirty,
        digestsChanged,
        minRefreshIntervalMs: this.minRefreshIntervalMs,
        now,
      })
    ) {
      this.state = current;
      return current;
    }

    const next = buildPromotionState({
      runtime: this.runtime,
      sessionDigests,
      updatedAt: now,
    });
    const previousIds = new Set((current?.drafts ?? []).map((draft) => draft.id));
    const derivedDraftIds = collectDerivedDraftIds({
      runtime: this.runtime,
      sessionDigests,
    });
    for (const draft of next.drafts) {
      if (previousIds.has(draft.id) || derivedDraftIds.has(draft.id)) continue;
      this.runtime.events.record({
        sessionId: draft.sessionIds[0] ?? "skill-promotion",
        type: SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
        payload: {
          draftId: draft.id,
          sourceSkillName: draft.sourceSkillName,
          title: draft.title,
          targetKind: draft.target.kind,
          pathHint: draft.target.pathHint,
          repeatCount: draft.repeatCount,
          confidenceScore: draft.confidenceScore,
        },
      });
    }
    this.store.write(next);
    this.state = next;
    this.dirty = false;
    return next;
  }
}

function createEmptyPromotionState(
  sessionDigests: readonly SkillPromotionSessionDigest[] = [],
): SkillPromotionState {
  return {
    schema: SKILL_PROMOTION_STATE_SCHEMA,
    updatedAt: Date.now(),
    sessionDigests: [...sessionDigests],
    drafts: [],
  };
}

const brokerByRuntime = new WeakMap<object, SkillPromotionBroker>();

export function getOrCreateSkillPromotionBroker(
  runtime: SkillPromotionRuntime,
  options: {
    workspaceRoot?: string;
    subscribeToEvents?: boolean;
    minRefreshIntervalMs?: number;
  } = {},
): SkillPromotionBroker {
  const key = runtime as unknown as object;
  const existing = brokerByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new SkillPromotionBroker(runtime, options);
  brokerByRuntime.set(key, created);
  return created;
}

export function createSkillPromotionContextProvider(input: {
  runtime: SkillPromotionRuntime;
  maxDrafts?: number;
  minRefreshIntervalMs?: number;
}): ContextSourceProvider {
  const broker = getOrCreateSkillPromotionBroker(input.runtime, {
    subscribeToEvents: true,
    minRefreshIntervalMs: input.minRefreshIntervalMs,
  });
  return {
    source: CONTEXT_SOURCES.skillPromotionDrafts,
    category: "narrative",
    budgetClass: "recall",
    order: 16,
    collect: (providerInput) => {
      const activeDrafts = broker
        .listCached()
        .filter((entry) => entry.status === "draft" || entry.status === "approved");
      if (!shouldInjectDrafts(providerInput.promptText, activeDrafts)) {
        return;
      }
      for (const draft of activeDrafts.slice(
        0,
        Math.max(1, input.maxDrafts ?? DEFAULT_MAX_CONTEXT_DRAFTS),
      )) {
        providerInput.register({
          id: draft.id,
          content: renderContextDraft(draft),
        });
      }
    },
  };
}

export type SkillPromotionRuntime = Pick<BrewvaRuntime, "workspaceRoot" | "events" | "skills">;
