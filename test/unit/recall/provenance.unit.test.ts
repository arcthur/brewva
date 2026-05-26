import { describe, expect, test } from "bun:test";
import {
  RECALL_SOURCE_FAMILIES,
  projectRecallResultProvenance,
  type RecallSearchEntry,
} from "@brewva/brewva-recall";

function recallEntry(input: Partial<RecallSearchEntry> = {}): RecallSearchEntry {
  return {
    stableId: input.stableId ?? "tape:current:event-1",
    sourceFamily: input.sourceFamily ?? "tape_evidence",
    trustLabel: input.trustLabel ?? "Verified evidence",
    evidenceStrength: input.evidenceStrength ?? "strong",
    scope: input.scope ?? "user_repository_root",
    semanticScore: input.semanticScore ?? 1,
    rankingScore: input.rankingScore ?? 1,
    title: input.title ?? "Evidence",
    summary: input.summary ?? "Summary",
    excerpt: input.excerpt ?? "Excerpt",
    freshness: input.freshness ?? "fresh",
    matchReasons: input.matchReasons ?? [],
    rankReasons: input.rankReasons ?? [],
    sessionId: input.sessionId,
    relativePath: input.relativePath,
    targetRoots: input.targetRoots,
    rootRef: input.rootRef ?? "/repo",
    sessionScope:
      input.sessionScope ??
      (input.sourceFamily === "repository_precedent" ? "cross_workspace" : "current_session"),
  };
}

describe("recall provenance projection", () => {
  test("keeps recall source families constrained to tape evidence and repository precedent", () => {
    expect(RECALL_SOURCE_FAMILIES).toEqual(["tape_evidence", "repository_precedent"]);
  });

  test("projects root and session scope orthogonally from recall entries", () => {
    expect(
      projectRecallResultProvenance(
        recallEntry({
          sessionId: "current",
          targetRoots: ["/repo"],
        }),
        { currentSessionId: "current", defaultRootRef: "/repo" },
      ),
    ).toEqual({
      stableId: "tape:current:event-1",
      sourceFamily: "tape_evidence",
      sessionScope: "current_session",
      rootRef: "/repo",
    });

    expect(
      projectRecallResultProvenance(
        recallEntry({
          stableId: "precedent:docs/solutions/runtime.md",
          sourceFamily: "repository_precedent",
          trustLabel: "Repository precedent",
          evidenceStrength: "moderate",
          sessionId: undefined,
          relativePath: "docs/solutions/runtime.md",
          rootRef: "/repo",
        }),
        { currentSessionId: "current", defaultRootRef: "/repo" },
      ),
    ).toEqual({
      stableId: "precedent:docs/solutions/runtime.md",
      sourceFamily: "repository_precedent",
      sessionScope: "cross_workspace",
      rootRef: "/repo",
    });
  });
});
