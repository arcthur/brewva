import { describe, expect, test } from "bun:test";
import {
  COST_UPDATE_EVENT_TYPE,
  SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
  SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
  BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { createHostedSemanticOracle } from "../../../packages/brewva-gateway/src/host/semantic-oracle.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createAssistantResponse(jsonText: string) {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "sonnet",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 12,
      output: 6,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 18,
      cost: {
        total: 0.05,
      },
    },
    content: [{ type: "text", text: jsonText }],
  } as const;
}

describe("hosted semantic oracle", () => {
  test("records rerank receipts and cost updates for successful model calls", async () => {
    const workspace = createTestWorkspace("semantic-oracle-rerank");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "semantic-oracle-rerank-session";
    const oracle = createHostedSemanticOracle({
      runtime,
      model: { provider: "anthropic", id: "sonnet" } as never,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-api-key" }),
      },
      completeFn: async () => createAssistantResponse('{"ordered_ids":["b","a"]}') as never,
    });

    const result = await oracle.rerankNarrativeMemory?.({
      sessionId,
      surface: "narrative_memory",
      query: "bun commands",
      targetRoots: ["packages"],
      stateRevision: "1",
      candidates: [
        { id: "a", title: "A", summary: "A summary", content: "Use npm" },
        { id: "b", title: "B", summary: "B summary", content: "Use Bun" },
      ],
    });

    expect(result?.orderedIds).toEqual(["b", "a"]);
    const rerankEvent = runtime.events.query(sessionId, {
      type: SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
      last: 1,
    })[0];
    expect(rerankEvent?.payload?.outcome).toBe("reranked");
    expect(rerankEvent?.payload?.cached).toBe(false);
    expect(runtime.events.query(sessionId, { type: COST_UPDATE_EVENT_TYPE })).toHaveLength(1);
  });

  test("records extraction receipts even when the oracle rejects the candidate", async () => {
    const workspace = createTestWorkspace("semantic-oracle-extraction");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "semantic-oracle-extraction-session";
    const oracle = createHostedSemanticOracle({
      runtime,
      model: { provider: "anthropic", id: "sonnet" } as never,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-api-key" }),
      },
      completeFn: async () => createAssistantResponse('{"accept":false}') as never,
    });

    const result = await oracle.extractNarrativeMemoryCandidate?.({
      sessionId,
      agentId: runtime.agentId,
      targetRoots: ["packages"],
      userText: "Remember the latest merged PR status.",
      toolEvidence: [],
    });

    expect(result).toBeNull();
    const extractionEvent = runtime.events.query(sessionId, {
      type: SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
      last: 1,
    })[0];
    expect(extractionEvent?.payload?.outcome).toBe("rejected");
    expect(extractionEvent?.payload?.accepted).toBe(false);
    expect(runtime.events.query(sessionId, { type: COST_UPDATE_EVENT_TYPE })).toHaveLength(1);
  });

  test("builds Claude-style extraction instructions for durable narrative quality", async () => {
    const workspace = createTestWorkspace("semantic-oracle-prompt-quality");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "semantic-oracle-prompt-quality-session";
    let capturedSystemPrompt = "";
    let capturedUserText = "";
    const oracle = createHostedSemanticOracle({
      runtime,
      model: { provider: "anthropic", id: "sonnet" } as never,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-api-key" }),
      },
      completeFn: async (_model, request) => {
        capturedSystemPrompt = request.systemPrompt ?? "";
        const content = request.messages[0]?.content;
        capturedUserText =
          Array.isArray(content) &&
          content[0] &&
          typeof content[0] === "object" &&
          (content[0] as { type?: unknown }).type === "text"
            ? (((content[0] as { text?: unknown }).text as string) ?? "")
            : "";
        return createAssistantResponse('{"accept":false}') as never;
      },
    });

    await oracle.extractNarrativeMemoryCandidate?.({
      sessionId,
      agentId: runtime.agentId,
      targetRoots: ["packages"],
      userText: "Yeah, the single bundled PR was the right call here. Keep doing that.",
      toolEvidence: [],
    });

    expect(capturedSystemPrompt).toContain("validated positive feedback");
    expect(capturedSystemPrompt).toContain("'Why:'");
    expect(capturedSystemPrompt).toContain("'How to apply:'");
    expect(capturedSystemPrompt).toContain("normalize relative dates");
    expect(capturedUserText).toContain("today_local_date=");
  });
});
