import type {
  RecallEvidenceStrength,
  RecallFreshness,
  RecallSearchEntry,
  RecallSearchIntent,
} from "../types.js";

const EVIDENCE_STRENGTH_WEIGHT: Record<RecallEvidenceStrength, number> = {
  strong: 2.0,
  moderate: 1.0,
  weak: 0,
};

const FRESHNESS_WEIGHT: Record<RecallFreshness, number> = {
  fresh: 0.3,
  aging: 0.12,
  stale: -0.28,
  unknown: 0,
};

export interface RecallRankingContext {
  currentSessionId: string;
  workspaceRoot: string;
  intent?: RecallSearchIntent;
}

export function createRankingContext(
  currentSessionId: string,
  intent: RecallSearchIntent | undefined,
  workspaceRoot = "",
): RecallRankingContext {
  return intent ? { currentSessionId, workspaceRoot, intent } : { currentSessionId, workspaceRoot };
}

function isCurrentSessionTapeEntry(
  entry: Pick<RecallSearchEntry, "sourceFamily" | "sessionId">,
  currentSessionId: string,
): boolean {
  return entry.sourceFamily === "tape_evidence" && entry.sessionId === currentSessionId;
}

function sourceBaseWeight(
  entry: Pick<RecallSearchEntry, "sourceFamily" | "evidenceStrength" | "sessionId">,
  context: RecallRankingContext,
): number {
  if (entry.sourceFamily === "tape_evidence") {
    if (entry.evidenceStrength === "strong") return 4.2;
    return context.intent === "current_session_evidence" &&
      isCurrentSessionTapeEntry(entry, context.currentSessionId)
      ? 2.7
      : 1.7;
  }
  if (entry.sourceFamily === "repository_precedent") return 3.25;
  return 1.25;
}

export function computeRankingScore(
  entry: Omit<RecallSearchEntry, "rankingScore" | "rankReasons">,
  context: RecallRankingContext,
  curationAdjustmentValue = 0,
): { rankingScore: number; rankReasons: string[] } {
  const source = sourceBaseWeight(entry, context);
  const strength = EVIDENCE_STRENGTH_WEIGHT[entry.evidenceStrength];
  const freshness = FRESHNESS_WEIGHT[entry.freshness];
  const semantic = Math.max(0, Math.min(1, entry.semanticScore));
  const rankingScore = source + strength + semantic + freshness + curationAdjustmentValue;
  const rankReasons = [
    `source:${entry.sourceFamily}`,
    `trust:${entry.trustLabel}`,
    `strength:${entry.evidenceStrength}`,
    `semantic:${semantic.toFixed(3)}`,
    `freshness:${entry.freshness}`,
  ];
  // Intent is a rank reason only where it actually moved this entry's score: the
  // current-session bump in sourceBaseWeight applies to NON-strong current-session
  // tape only (strong tape is a flat 4.2 regardless of intent).
  if (
    context.intent === "current_session_evidence" &&
    entry.evidenceStrength !== "strong" &&
    isCurrentSessionTapeEntry(entry, context.currentSessionId)
  ) {
    rankReasons.push(`intent:${context.intent}`);
  }
  if (curationAdjustmentValue !== 0) {
    rankReasons.push(`curation:${curationAdjustmentValue.toFixed(3)}`);
  }
  return {
    rankingScore: Number(rankingScore.toFixed(6)),
    rankReasons,
  };
}

export function finalizeRecallEntry(
  entry: Omit<RecallSearchEntry, "rankingScore" | "rankReasons">,
  context: RecallRankingContext,
): RecallSearchEntry {
  return {
    ...entry,
    ...computeRankingScore(entry, context),
  };
}

export function compareRecallSearchEntries(
  left: RecallSearchEntry,
  right: RecallSearchEntry,
): number {
  if (right.rankingScore !== left.rankingScore) {
    return right.rankingScore - left.rankingScore;
  }
  return left.stableId.localeCompare(right.stableId);
}
