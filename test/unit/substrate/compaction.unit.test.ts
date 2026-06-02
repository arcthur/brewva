import { describe, expect, test } from "bun:test";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import {
  BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER,
  buildBrewvaDeterministicCompactionSummary,
  createBrewvaCompactionSummaryMessage,
  estimateBrewvaSessionEntryTokens,
  findBrewvaCompactionCutPoint,
  projectBrewvaCompactionMessages,
  selectBrewvaSessionCompactionCutPoint,
  serializeBrewvaCompactionConversation,
  shouldCompactBrewvaContext,
  summarizeBrewvaCompactionMessage,
} from "@brewva/brewva-substrate/compaction";

describe("substrate compaction mechanisms", () => {
  test("serializes heterogeneous messages without gateway policy", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Investigate cache drift." }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "No drift." }] },
      { role: "custom", customType: "note", content: "Keep the failing fixture." },
      { role: "assistant", errorMessage: "stream interrupted" },
    ];

    expect(summarizeBrewvaCompactionMessage(messages[1])).toBe("assistant: [toolCall:read]");
    expect(serializeBrewvaCompactionConversation(messages)).toContain(
      "toolResult(read): No drift.",
    );
    expect(buildBrewvaDeterministicCompactionSummary(messages)).toContain(
      "- custom(note): Keep the failing fixture.",
    );
  });

  test("uses a stable default summary for empty inputs", () => {
    expect(buildBrewvaDeterministicCompactionSummary([])).toBe(
      `${BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER}\n- Preserve the current task state and latest verified evidence.`,
    );
  });

  test("emergency fallback prefers workbench continuity under tight line budgets", () => {
    const summary = buildBrewvaDeterministicCompactionSummary(
      [
        { role: "custom", customType: "workbench", content: "Keep file provenance v2 active." },
        { role: "user", content: "older noise" },
        { role: "assistant", content: "middle noise" },
        { role: "user", content: "latest instruction" },
      ],
      { maxLines: 2 },
    );

    expect(summary).toContain("custom(workbench): Keep file provenance v2 active.");
    expect(summary).toContain("user: latest instruction");
  });

  test("selects a cut point without compacting the entire context", () => {
    const messages = [
      { role: "user", content: "old" },
      { role: "assistant", content: "middle" },
      { role: "user", content: "recent" },
    ];

    const cutPoint = findBrewvaCompactionCutPoint(messages, {
      keepLastMessages: 1,
      maxKeptTokens: 1,
      estimateMessageTokens: () => 1,
    });

    expect(cutPoint).toMatchObject({
      firstKeptIndex: 2,
      messagesBefore: 2,
      messagesAfter: 1,
    });
  });

  test("projects a summary message in front of the kept tail", () => {
    const messages: BrewvaAgentProtocolMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "old" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "recent" }],
        timestamp: 2,
      },
    ];

    const projected = projectBrewvaCompactionMessages(messages, {
      firstKeptIndex: 1,
      summary: "old summarized",
      tokensBefore: 12,
      timestamp: 3,
    });

    expect(projected).toEqual([
      createBrewvaCompactionSummaryMessage({
        summary: "old summarized",
        tokensBefore: 12,
        timestamp: 3,
      }),
      messages[1]!,
    ]);
  });

  test("keeps compaction trigger calculation pure", () => {
    expect(shouldCompactBrewvaContext({ tokens: 81, contextWindow: 100 })).toBe(true);
    expect(
      shouldCompactBrewvaContext({ tokens: 81, contextWindow: 100 }, { thresholdRatio: 0.9 }),
    ).toBe(false);
    expect(shouldCompactBrewvaContext({ tokens: null, contextWindow: 100 })).toBe(false);
  });

  test("truncates oversized tool result bodies for the compaction transcript", () => {
    const longBody = "x".repeat(5_000);
    const message = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: longBody }],
    };
    const summary = summarizeBrewvaCompactionMessage(message)!;
    expect(summary.startsWith("toolResult(read): ")).toBe(true);
    expect(summary).toContain("more characters truncated");
    expect(summary.length).toBeLessThan(longBody.length);
  });

  test("renders image-bearing tool results as compact placeholders", () => {
    const message = {
      role: "toolResult",
      toolName: "screenshot",
      content: [
        { type: "text", text: "before" },
        { type: "image", url: "data:image/png;base64,..." },
        { type: "text", text: "after" },
      ],
    };
    const summary = summarizeBrewvaCompactionMessage(message)!;
    expect(summary).toContain("before");
    expect(summary).toContain("after");
    expect(summary).toContain("[image");
  });

  test("selects a token-aware session cut point from complete recent turns", () => {
    const entries = [
      sessionMessage("old-user", null, "user", 30),
      sessionMessage("old-assistant", "old-user", "assistant", 30),
      sessionMessage("mid-user", "old-assistant", "user", 15),
      sessionMessage("mid-assistant", "mid-user", "assistant", 15),
      sessionMessage("recent-user", "mid-assistant", "user", 5),
      sessionMessage("recent-assistant", "recent-user", "assistant", 5),
    ];

    expect(
      selectBrewvaSessionCompactionCutPoint(entries, {
        tailProtectTokens: 45,
        targetContextWindow: 100,
        reserveTokens: 0,
        estimateEntryTokens: (entry) => entry.tokenCount,
      }),
    ).toMatchObject({
      firstKeptEntryId: "mid-user",
      firstKeptIndex: 2,
      tokensKept: 40,
      turnPrefixSummaryRequired: false,
    });

    expect(
      selectBrewvaSessionCompactionCutPoint(entries, {
        tailProtectTokens: 12,
        targetContextWindow: 100,
        reserveTokens: 0,
        estimateEntryTokens: (entry) => entry.tokenCount,
      }),
    ).toMatchObject({
      firstKeptEntryId: "recent-user",
      firstKeptIndex: 4,
      tokensKept: 10,
      turnPrefixSummaryRequired: false,
    });
  });

  test("estimates Brewva session entry tokens from one shared compaction helper", () => {
    expect(
      estimateBrewvaSessionEntryTokens({
        id: "message",
        type: "message",
        message: { role: "user", content: "12345678" },
      }),
    ).toBeGreaterThan(1);

    expect(
      estimateBrewvaSessionEntryTokens({
        id: "branch-summary",
        type: "branch_summary",
        summary: "12345678",
      }),
    ).toBe(2);
  });

  test("does not split active tool pairs when the tail budget is too small", () => {
    const entries = [
      sessionMessage("old-user", null, "user", 20),
      sessionMessage("active-user", "old-user", "user", 10),
      sessionMessage("active-tool-call", "active-user", "assistant", 25),
      sessionMessage("active-tool-result", "active-tool-call", "toolResult", 25),
    ];

    expect(
      selectBrewvaSessionCompactionCutPoint(entries, {
        tailProtectTokens: 25,
        targetContextWindow: 100,
        reserveTokens: 0,
        estimateEntryTokens: (entry) => entry.tokenCount,
      }),
    ).toMatchObject({
      firstKeptEntryId: "active-user",
      firstKeptIndex: 1,
      tokensKept: 60,
      turnPrefixSummaryRequired: true,
      reason: "oversized_active_turn",
    });
  });

  test("clamps previous compaction position without splitting a turn group", () => {
    const entries = [
      sessionMessage("old-user", null, "user", 30),
      sessionMessage("old-assistant", "old-user", "assistant", 30),
      sessionMessage("recent-user", "old-assistant", "user", 10),
      sessionMessage("recent-assistant", "recent-user", "assistant", 10),
    ];

    expect(
      selectBrewvaSessionCompactionCutPoint(entries, {
        tailProtectTokens: 100,
        targetContextWindow: 100,
        reserveTokens: 0,
        previousFirstKeptEntryId: "recent-assistant",
        estimateEntryTokens: (entry) => entry.tokenCount,
      }),
    ).toMatchObject({
      firstKeptEntryId: "recent-user",
      firstKeptIndex: 2,
      tokensKept: 20,
      turnPrefixSummaryRequired: false,
    });
  });
});

function sessionMessage(
  id: string,
  parentId: string | null,
  role: string,
  tokenCount: number,
): {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: "message";
  readonly message: { readonly role: string };
  readonly tokenCount: number;
} {
  return {
    id,
    parentId,
    type: "message",
    message: { role },
    tokenCount,
  };
}
