import { describe, expect, test } from "bun:test";
import {
  createHostedBehaviorHostAdapter,
  registerContextTransform,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { setStaticContextStatusThresholds } from "../../../fixtures/config.js";
import {
  createMockExtensionApi,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../../../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

interface BeforeAgentStartResult {
  message?: { content?: unknown };
  messages?: Array<{ content?: unknown }>;
}

function collectMessageContent(results: BeforeAgentStartResult[]): string {
  const chunks: string[] = [];
  for (const result of results) {
    if (typeof result.message?.content === "string") {
      chunks.push(result.message.content);
    }
    for (const message of result.messages ?? []) {
      if (typeof message.content === "string") {
        chunks.push(message.content);
      }
    }
  }
  return chunks.join("\n");
}

describe("context composition parity", () => {
  test("keeps gate-clearing semantics aligned between direct context registration and hosted behavior", async () => {
    const config = createRuntimeConfig((draft) => {
      setStaticContextStatusThresholds(draft, { hardRatio: 0.8 });
    });

    const makeRuntime = () =>
      createRuntimeFixture({
        config,
      });

    const sessionManager = { getSessionId: () => "parity-clear" };

    const fullRuntime = makeRuntime();
    const full = createMockExtensionApi();
    registerContextTransform(full.api, fullRuntime);
    await invokeHandlerAsync(
      full.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "arm", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );
    invokeHandler(
      full.handlers,
      "session_compact",
      {
        compactionEntry: { id: "cmp-full", summary: "clear gate" },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const fullAfter = await invokeHandlerAsync<BeforeAgentStartResult>(
      full.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "after compact", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );

    const hostedRuntime = makeRuntime();
    const hosted = createMockExtensionApi();
    await createHostedBehaviorHostAdapter({
      runtime: hostedRuntime,
      registerTools: false,
    }).register(hosted.api);
    await invokeHandlerAsync(
      hosted.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "arm", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );
    invokeHandler(
      hosted.handlers,
      "session_compact",
      {
        compactionEntry: { id: "cmp-hosted", summary: "clear gate" },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const hostedResults = await invokeHandlersAsync<BeforeAgentStartResult>(
      hosted.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "after compact", systemPrompt: "base" },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 150, contextWindow: 1000, percent: 0.15 }),
      },
    );
    const fullContent = collectMessageContent([fullAfter]);
    const hostedContent = collectMessageContent(hostedResults);

    expect(fullRuntime.ops.context.compaction.getGateStatus("parity-clear").required).toBe(false);
    expect(hostedRuntime.ops.context.compaction.getGateStatus("parity-clear").required).toBe(false);
    expect(fullContent.includes("[ContextCompactionGate]")).toBe(false);
    expect(hostedContent.includes("[ContextCompactionGate]")).toBe(false);
    expect(hostedContent.includes("[OperationalDiagnostics]")).toBe(false);
  });
});
