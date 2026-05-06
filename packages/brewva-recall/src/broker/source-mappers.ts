import type {
  DeliberationMemoryArtifact,
  NarrativeMemoryRecord,
  OptimizationLineageArtifact,
} from "@brewva/brewva-deliberation";
import type { SkillPromotionDraft } from "@brewva/brewva-skill-broker";
import type { KnowledgeDocRecord } from "../knowledge/index.js";
import type { RecallScope, RecallSearchEntry } from "../types.js";
import type { RecallRankingContext } from "./ranking.js";
import { finalizeRecallEntry } from "./ranking.js";
import { compactText, computeTokenOverlap, freshnessFromTimestamp } from "./text.js";

export function mapNarrativeRecord(
  record: NarrativeMemoryRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `narrative:${record.id}`,
      sourceFamily: "narrative_memory",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: record.title,
      summary: record.summary,
      excerpt: compactText(record.content, 220),
      freshness: freshnessFromTimestamp(record.updatedAt),
      matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
      targetRoots: record.provenance.targetRoots,
    },
    context,
  );
}

export function mapDeliberationArtifact(
  artifact: DeliberationMemoryArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `deliberation:${artifact.id}`,
      sourceFamily: "deliberation_memory",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: artifact.title,
      summary: artifact.summary,
      excerpt: compactText(artifact.content, 220),
      freshness: freshnessFromTimestamp(artifact.lastValidatedAt),
      matchReasons: matchReasons.length > 0 ? matchReasons : ["retrieval_match"],
      sessionId: artifact.sessionIds.at(-1),
    },
    context,
  );
}

export function mapOptimizationLineage(
  artifact: OptimizationLineageArtifact,
  score: number,
  matchReasons: string[],
  scope: RecallScope,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `optimization:${artifact.id}`,
      sourceFamily: "optimization_continuity",
      trustLabel: "Advisory posture",
      evidenceStrength: "weak",
      scope,
      semanticScore: score,
      title: artifact.goal ?? artifact.loopKey,
      summary: artifact.summary,
      excerpt: compactText(artifact.summary, 220),
      freshness: freshnessFromTimestamp(artifact.lastObservedAt),
      matchReasons,
      sessionId: artifact.rootSessionId,
    },
    context,
  );
}

export function mapPromotionDraft(
  draft: SkillPromotionDraft,
  queryTokens: readonly string[],
  scope: RecallScope,
  context: RecallRankingContext,
): RecallSearchEntry | null {
  const score = computeTokenOverlap(
    queryTokens,
    `${draft.title} ${draft.summary} ${draft.rationale} ${draft.proposalText} ${draft.tags.join(" ")}`,
  );
  if (score <= 0) return null;
  return finalizeRecallEntry(
    {
      stableId: `promotion:${draft.id}`,
      sourceFamily: "promotion_draft",
      trustLabel: "Advisory posture",
      evidenceStrength: "moderate",
      scope,
      semanticScore:
        score + draft.confidenceScore * 0.25 + Math.min(0.12, draft.repeatCount * 0.04),
      title: draft.title,
      summary: draft.summary,
      excerpt: compactText(draft.proposalText, 220),
      freshness: freshnessFromTimestamp(draft.lastValidatedAt),
      matchReasons: draft.tags.slice(0, 4),
      sessionId: draft.sessionIds.at(-1),
    },
    context,
  );
}

export function mapKnowledgeDoc(
  doc: KnowledgeDocRecord,
  score: number,
  matchReasons: string[],
  scope: RecallScope,
  context: RecallRankingContext,
): RecallSearchEntry {
  return finalizeRecallEntry(
    {
      stableId: `precedent:${doc.relativePath}`,
      sourceFamily: "repository_precedent",
      trustLabel: "Repository precedent",
      evidenceStrength: "moderate",
      scope,
      semanticScore: score,
      title: doc.title,
      summary: `${doc.sourceType} @ ${doc.relativePath}`,
      excerpt: doc.excerpt,
      freshness: doc.freshness,
      matchReasons,
      relativePath: doc.relativePath,
    },
    context,
  );
}
