import { describe, expect, test } from "bun:test";
import {
  BrewvaManagedSessionStore,
  buildManagedSessionContext,
  type BrewvaBranchSummaryEntry,
  type BrewvaSessionEntry,
} from "@brewva/brewva-substrate/session";

function branchSummary(input: {
  id: string;
  parentId: string | null;
  summary: string;
  timestamp: string;
  activeSummaryKey?: string;
}): BrewvaBranchSummaryEntry {
  return {
    type: "branch_summary",
    id: input.id,
    parentId: input.parentId,
    timestamp: input.timestamp,
    fromId: input.parentId ?? "root",
    summary: input.summary,
    details: input.activeSummaryKey
      ? { activeSummaryKey: input.activeSummaryKey, schema: "test.branch-summary.v1" }
      : undefined,
  };
}

describe("managed session store branch summaries", () => {
  test("materializes only the latest active summary for a fork point", () => {
    const root: BrewvaSessionEntry = {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        timestamp: 1,
      },
    };
    const oldSummary = branchSummary({
      id: "summary-old",
      parentId: "root",
      summary: "old carry summary",
      timestamp: "2026-01-01T00:00:01.000Z",
      activeSummaryKey: "context_entry:root",
    });
    const latestSummary = branchSummary({
      id: "summary-latest",
      parentId: "summary-old",
      summary: "latest carry summary",
      timestamp: "2026-01-01T00:00:02.000Z",
      activeSummaryKey: "context_entry:root",
    });
    const context = buildManagedSessionContext([root, oldSummary, latestSummary], latestSummary.id);

    const summaries = context.messages.flatMap((message) =>
      message.role === "branchSummary" ? [(message as { summary: string }).summary] : [],
    );

    expect(summaries).toEqual(["latest carry summary"]);
  });

  test("keeps newest branch summaries inside the context budget", () => {
    const root: BrewvaSessionEntry = {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        timestamp: 1,
      },
    };
    const first = branchSummary({
      id: "summary-1",
      parentId: "root",
      summary: "first ".repeat(260),
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    const second = branchSummary({
      id: "summary-2",
      parentId: "summary-1",
      summary: "second ".repeat(260),
      timestamp: "2026-01-01T00:00:02.000Z",
    });
    const third = branchSummary({
      id: "summary-3",
      parentId: "summary-2",
      summary: "third ".repeat(260),
      timestamp: "2026-01-01T00:00:03.000Z",
    });
    const context = buildManagedSessionContext([root, first, second, third], third.id);

    const summaries = context.messages.flatMap((message) =>
      message.role === "branchSummary" ? [(message as { summary: string }).summary] : [],
    );
    const totalChars = summaries.reduce((sum, summary) => sum + summary.length, 0);

    expect(summaries.join("\n")).toContain("third");
    expect(summaries.join("\n")).not.toContain("first");
    expect(totalChars).toBeLessThanOrEqual(2_400);
  });

  test("stores branch summary details for context-time filtering", () => {
    const store = new BrewvaManagedSessionStore(process.cwd(), "summary-details-session");
    const rootId = store.appendMessage({
      role: "user",
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    store.branchWithSummary(rootId, "carry", {
      activeSummaryKey: `context_entry:${rootId}`,
      schema: "test.branch-summary.v1",
    });

    const summary = store
      .buildSessionContext()
      .messages.find((message) => message.role === "branchSummary");

    expect(summary?.details).toMatchObject({
      activeSummaryKey: `context_entry:${rootId}`,
    });
  });
});
