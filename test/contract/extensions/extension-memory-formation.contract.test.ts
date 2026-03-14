import { describe, expect, test } from "bun:test";
import { listCognitionArtifacts, readCognitionArtifact } from "@brewva/brewva-deliberation";
import { registerMemoryFormation } from "@brewva/brewva-gateway/runtime-plugins";
import {
  createMockExtensionAPI,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

async function waitForSummaryArtifacts(
  runtime: ReturnType<typeof createRuntimeFixture>,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
    if (artifacts.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} summary artifact(s).`);
}

describe("memory formation extension", () => {
  test("writes resumable session summaries on agent end", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-agent-end";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the proposal boundary rollout and validate the gateway wake path.",
    });
    runtime.task.addItem(sessionId, {
      text: "Validate heartbeat wake-up context against memory rehydration.",
      status: "doing",
    });
    runtime.task.recordBlocker(sessionId, {
      id: "blk-release-readiness",
      message: "Need release readiness evidence before shipping.",
      source: "test.memory",
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      payload: {
        skillName: "implementation",
        outputKeys: ["patch_set", "verification_report"],
        completedAt: Date.now(),
      },
    });

    registerMemoryFormation(api, runtime);
    await invokeHandlerAsync(
      handlers,
      "agent_end",
      { type: "agent_end" },
      createSessionContext(sessionId),
    );

    await waitForSummaryArtifacts(runtime, 1);
    const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
    expect(artifacts).toHaveLength(1);
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      fileName: artifacts[0]!.fileName,
    });
    expect(content).toContain("[StatusSummary]");
    expect(content).toContain("summary_kind: session_summary");
    expect(content).toContain("status: blocked");
    expect(content).toContain(`session_scope: ${sessionId}`);
    expect(content).toContain("goal: Finish the proposal boundary rollout");
    expect(content).toContain("recent_skill: implementation");
    expect(content).toContain("recent_outputs: patch_set; verification_report");
    expect(content).toContain("blocked_on: blk-release-readiness:");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_summary_written",
    );
  });

  test("does not duplicate identical summaries across agent_end and session_shutdown", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-formation-dedupe";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep the session resumable.",
    });
    runtime.task.addItem(sessionId, {
      text: "Resume the same session later.",
      status: "doing",
    });

    registerMemoryFormation(api, runtime);
    await invokeHandlerAsync(
      handlers,
      "agent_end",
      { type: "agent_end" },
      createSessionContext(sessionId),
    );
    await waitForSummaryArtifacts(runtime, 1);

    await invokeHandlersAsync(handlers, "session_shutdown", {}, createSessionContext(sessionId));
    await waitForSummaryArtifacts(runtime, 1);

    expect(await listCognitionArtifacts(runtime.workspaceRoot, "summaries")).toHaveLength(1);
  });
});
