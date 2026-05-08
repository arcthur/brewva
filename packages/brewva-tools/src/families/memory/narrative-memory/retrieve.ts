import type { NarrativeMemoryPlane, NarrativeMemoryRecord } from "@brewva/brewva-deliberation";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../../utils/result.js";
import { rerankMemoryToolRetrievals } from "../internal/memory-plane-tool.js";
import { formatRecordSummary } from "./render.js";

export async function retrieveNarrativeMemoryRecords(input: {
  plane: NarrativeMemoryPlane;
  runtime: BrewvaBundledToolRuntime;
  sessionId: string;
  query: string | undefined;
  recordClass: NarrativeMemoryRecord["class"] | undefined;
  status: NarrativeMemoryRecord["status"] | undefined;
  scope: NarrativeMemoryRecord["applicabilityScope"] | undefined;
  limit: number;
  targetRoots: readonly string[];
}) {
  if (!input.query) {
    return failTextResult("retrieve requires query.", {
      ok: false,
      error: "missing_query",
    });
  }
  const query = input.query;

  let retrievals = input.plane
    .retrieve(query, {
      limit: Math.max(input.limit * 3, input.limit),
      targetRoots: input.targetRoots,
      statuses: input.status ? [input.status] : ["active", "promoted"],
      recordRetrieval: false,
    })
    .filter((entry) => !input.recordClass || entry.record.class === input.recordClass)
    .filter((entry) => !input.scope || entry.record.applicabilityScope === input.scope);
  const oracle = input.runtime.semanticReranker;
  const rerankNarrativeMemory = oracle?.rerankNarrativeMemory?.bind(oracle);

  retrievals = await rerankMemoryToolRetrievals({
    retrievals,
    getId: (entry) => entry.record.id,
    getScore: (entry) => entry.score,
    toCandidate: (entry) => ({
      id: entry.record.id,
      title: entry.record.title,
      summary: entry.record.summary,
      content: entry.record.content,
      kind: entry.record.class,
      scope: entry.record.applicabilityScope,
    }),
    rerank: rerankNarrativeMemory
      ? (candidates) =>
          rerankNarrativeMemory({
            sessionId: input.sessionId,
            surface: "narrative_memory",
            query,
            targetRoots: input.targetRoots,
            candidates,
            stateRevision: String(input.plane.getState().updatedAt),
          })
      : undefined,
  });

  retrievals = retrievals.slice(0, input.limit);
  if (retrievals.length === 0) {
    return inconclusiveTextResult("No narrative memory records matched the retrieval query.", {
      ok: false,
      query,
      class: input.recordClass ?? null,
      status: input.status ?? null,
      scope: input.scope ?? null,
      retrievals: [],
    });
  }
  input.plane.markRetrieved(retrievals.map((entry) => entry.record.id));
  return textResult(
    [
      "# Narrative Memory Retrieval",
      `count: ${retrievals.length}`,
      ...retrievals.map(
        (entry) =>
          `${formatRecordSummary(entry.record)}\n  retrieval_score=${entry.score.toFixed(2)}\n  matched_terms=${
            entry.matchedTerms.join(", ") || "none"
          }`,
      ),
    ].join("\n"),
    {
      ok: true,
      query,
      retrievals,
    },
  );
}
