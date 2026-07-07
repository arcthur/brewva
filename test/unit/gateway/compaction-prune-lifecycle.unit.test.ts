import { describe, expect, test } from "bun:test";
import {
  ManagedSessionCompactionLifecycle,
  type ManagedSessionCompactionLifecycleOptions,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/compaction-lifecycle.js";

const LARGE = "x".repeat(400);

function toolResult(toolName: string, text: string): unknown {
  return { role: "toolResult", toolName, content: [{ type: "text", text }] };
}

interface Capture {
  summarizerMessages: readonly unknown[] | undefined;
  receipt:
    | { operations?: readonly unknown[]; compactId?: string; tokensSaved?: number }
    | undefined;
  receiptCalls: number;
}

type PreviewRequest = Parameters<ManagedSessionCompactionLifecycle["preview"]>[0];

function buildLifecycle(input: {
  messages: readonly unknown[];
  pruneEnabled: boolean;
  capture: Capture;
  tailProtectTokens?: number | null;
  tailProtectRatio?: number;
  contextWindow?: number;
  onEmit?: (eventType: string) => void;
}): ManagedSessionCompactionLifecycle {
  const compaction = {
    pruneEnabled: input.pruneEnabled,
    minTurnsBetween: 2,
    protectedTools: ["workbench_note"],
    tailProtectTokens: input.tailProtectTokens === undefined ? 1 : input.tailProtectTokens,
    tailProtectRatio: input.tailProtectRatio ?? 0.2,
  };
  const options = {
    cwd: "/tmp/prune-lifecycle-test",
    runtime: {
      config: { infrastructure: { contextBudget: { compaction } } },
      ops: {
        context: {
          usage: {
            get: () => ({ contextWindow: input.contextWindow ?? 200_000 }),
          },
          telemetry: {
            preCompactPrune: (value: { payload?: Capture["receipt"] }) => {
              input.capture.receiptCalls += 1;
              input.capture.receipt = value.payload;
              return {};
            },
          },
        },
      },
    },
    agentState: () => ({ model: { provider: "openai", id: "gpt-5.4" }, systemPrompt: "sys" }),
    catalog: { find: () => ({ provider: "openai", id: "gpt-5.4", api: "openai-responses" }) },
    compactionSummaryGenerator: (genInput: { messages: readonly unknown[] }) => {
      input.capture.summarizerMessages = genInput.messages;
      return Promise.resolve({ summary: "test-summary" });
    },
    sessionManager: {
      getBranch: () => [],
      buildSessionContext: () => ({ messages: input.messages }),
      getSessionId: () => "session-1",
      getLeafId: () => null,
      previewCompaction: (summary: string, tokensBefore: number, compactId?: string) => ({
        compactId: compactId ?? "compact-1",
        sourceLeafEntryId: null,
        firstKeptEntryId: "entry-1",
        context: { messages: [] },
        tokensBefore,
        summary,
        cutPointReason: "token_budget",
      }),
    },
    runner: {
      emit: async (eventType: string) => {
        input.onEmit?.(eventType);
      },
    },
    createHostContext: () => ({}),
    emitToListeners: () => {},
    replaceMessages: async () => {},
    markSessionCompacted: async () => {},
  } as unknown as ManagedSessionCompactionLifecycleOptions;
  return new ManagedSessionCompactionLifecycle(options);
}

describe("compaction lifecycle pre-compaction prune wiring", () => {
  test("prunes the summarizer input and emits the receipt on finalize", async () => {
    const capture: Capture = {
      summarizerMessages: undefined,
      receipt: undefined,
      receiptCalls: 0,
    };
    const messages = [
      toolResult("read", LARGE),
      toolResult("read", LARGE), // duplicate of the first -> deduped / inform-replaced
      { role: "user", content: "recent tail" },
    ];
    const lifecycle = buildLifecycle({ messages, pruneEnabled: true, capture });

    const prepared = await lifecycle.preview({} as PreviewRequest);

    // The summarizer read a pruned input: array length unchanged, but the large
    // duplicated read bodies were collapsed out before it saw them.
    expect(capture.summarizerMessages).toHaveLength(messages.length);
    expect(JSON.stringify(capture.summarizerMessages ?? [])).not.toContain(LARGE);
    expect(prepared.pruneOperations.length).toBeGreaterThan(0);
    expect(prepared.pruneTokensSaved).toBeGreaterThan(0);

    const built = lifecycle.build(prepared);
    await lifecycle.finalize(prepared, built);

    // Exactly one receipt, joined to the compaction by id, carrying every op.
    expect(capture.receiptCalls).toBe(1);
    expect(capture.receipt?.compactId).toBe(prepared.preview.compactId);
    expect(capture.receipt?.operations?.length).toBe(prepared.pruneOperations.length);
    expect(capture.receipt?.tokensSaved).toBe(prepared.pruneTokensSaved);
  });

  test("feeds the raw input and emits no receipt when pruneEnabled is false", async () => {
    const capture: Capture = {
      summarizerMessages: undefined,
      receipt: undefined,
      receiptCalls: 0,
    };
    const messages = [
      toolResult("read", LARGE),
      toolResult("read", LARGE),
      { role: "user", content: "recent tail" },
    ];
    const lifecycle = buildLifecycle({ messages, pruneEnabled: false, capture });

    const prepared = await lifecycle.preview({} as PreviewRequest);

    expect(prepared.pruneOperations).toHaveLength(0);
    expect(prepared.pruneTokensSaved).toBe(0);
    expect(capture.summarizerMessages).toEqual(messages);

    const built = lifecycle.build(prepared);
    await lifecycle.finalize(prepared, built);
    expect(capture.receiptCalls).toBe(0);
  });

  test("resolves the tail-protect window from ratio x contextWindow when tailProtectTokens is null", async () => {
    // Two DISTINCT large old results (no dedupe possible), so any prune must come
    // from inform-replace, which fires only for entries OUTSIDE the tail window.
    // With tailProtectTokens null, that window is ratio x contextWindow — the
    // prune must not silently fall back to its own hard-coded 40k default.
    const messages = [
      toolResult("read", LARGE),
      toolResult("bash", "y".repeat(400)),
      { role: "user", content: "recent tail" },
    ];

    const wideCapture: Capture = {
      summarizerMessages: undefined,
      receipt: undefined,
      receiptCalls: 0,
    };
    const wide = buildLifecycle({
      messages,
      pruneEnabled: true,
      capture: wideCapture,
      tailProtectTokens: null,
      tailProtectRatio: 0.2,
      contextWindow: 100_000_000, // 0.2 x 100M protects everything -> nothing pruned
    });
    const preparedWide = await wide.preview({} as PreviewRequest);
    expect(preparedWide.pruneOperations).toHaveLength(0);

    const narrowCapture: Capture = {
      summarizerMessages: undefined,
      receipt: undefined,
      receiptCalls: 0,
    };
    const narrow = buildLifecycle({
      messages,
      pruneEnabled: true,
      capture: narrowCapture,
      tailProtectTokens: null,
      tailProtectRatio: 0.2,
      contextWindow: 10, // 0.2 x 10 ~= 2 tokens protected -> old results pruned
    });
    const preparedNarrow = await narrow.preview({} as PreviewRequest);
    expect(preparedNarrow.pruneOperations.length).toBeGreaterThan(0);
  });

  test("emits no prune receipt when the compaction commit fails (no orphan receipt)", async () => {
    const capture: Capture = {
      summarizerMessages: undefined,
      receipt: undefined,
      receiptCalls: 0,
    };
    const messages = [
      toolResult("read", LARGE),
      toolResult("read", LARGE),
      { role: "user", content: "recent tail" },
    ];
    const lifecycle = buildLifecycle({
      messages,
      pruneEnabled: true,
      capture,
      onEmit: (eventType) => {
        if (eventType === "session_compact") {
          throw new Error("commit failed");
        }
      },
    });
    const prepared = await lifecycle.preview({} as PreviewRequest);
    expect(prepared.pruneOperations.length).toBeGreaterThan(0);

    const built = lifecycle.build(prepared);
    let caught: Error | undefined;
    try {
      await lifecycle.finalize(prepared, built);
    } catch (error) {
      caught = error as Error;
    }
    // finalize rejected AND — because the receipt now trails the session_compact
    // commit — no prune receipt was emitted, so the tape has no orphan prune.
    expect(caught?.message).toBe("commit failed");
    expect(capture.receiptCalls).toBe(0);
  });
});
