import { describe, expect, test } from "bun:test";
import { BrewvaManagedSessionStore } from "@brewva/brewva-substrate";

describe("managed session store contract", () => {
  test("previews compaction without mutating the active leaf", () => {
    const store = new BrewvaManagedSessionStore("/workspace/brewva");
    store.appendModelChange("openai", "gpt-5.4");
    store.appendThinkingLevelChange("high");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Inspect the failing build." }],
      timestamp: 1,
    } as Parameters<BrewvaManagedSessionStore["appendMessage"]>[0]);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I am inspecting the build now." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    } as Parameters<BrewvaManagedSessionStore["appendMessage"]>[0]);

    const originalLeafId = store.getLeafId();
    const preview = store.previewCompaction("Preserve the current debugging state.", 64);

    expect(store.getLeafId()).toBe(originalLeafId);
    expect(preview.sourceLeafEntryId).toBe(originalLeafId);
    expect(preview.firstKeptEntryId).toBeDefined();
    expect(preview.context.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    expect(preview.context.thinkingLevel).toBe("high");
    expect(preview.context.model).toEqual({ provider: "openai", modelId: "gpt-5.4" });
  });
});
