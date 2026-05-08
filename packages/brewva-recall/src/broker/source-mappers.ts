import type { KnowledgeDocRecord } from "../knowledge/index.js";
import type { RecallScope, RecallSearchEntry } from "../types.js";
import type { RecallRankingContext } from "./ranking.js";
import { finalizeRecallEntry } from "./ranking.js";

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
