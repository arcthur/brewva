import { describe, expect, test } from "bun:test";
import {
  BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER,
  buildBrewvaDeterministicCompactionSummary,
  createBrewvaCompactionSummaryMessage,
  findBrewvaCompactionCutPoint,
  projectBrewvaCompactionMessages,
  serializeBrewvaCompactionConversation,
  shouldCompactBrewvaContext,
  summarizeBrewvaCompactionMessage,
} from "@brewva/brewva-substrate/compaction";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";

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
    const messages: BrewvaTurnLoopMessage[] = [
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
});
