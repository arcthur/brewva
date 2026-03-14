import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { registerDebugLoop } from "@brewva/brewva-gateway/runtime-plugins";
import {
  BrewvaRuntime,
  DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  type ProposalRecord,
} from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import {
  artifactPath,
  blockArtifactSessionsRoot,
  createContext,
  createDebugLoopFixture,
  createSkillWorkspace,
  readJsonFile,
  recordImplementationFailure,
  scheduleInitialRetry,
  toToolContext,
  waitFor,
} from "./extension-debug-loop.helpers.js";

describe("extension debug loop persistence", () => {
  test("session shutdown clears in-memory state so persisted hypothesis limits take effect", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-hypothesis-limit",
      "ext-debug-loop-7",
      "leaf-debug-loop-7",
    );

    await scheduleInitialRetry(fixture);
    fixture.runtime.events.record({ sessionId: "ext-debug-loop-7", type: "session_shutdown" });

    const statePath = artifactPath(fixture.workspace, "ext-debug-loop-7", "debug-loop.json");
    const persistedState = readJsonFile<Record<string, unknown>>(statePath);
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...persistedState,
          status: "implementing",
          activeSkillName: "implementation",
          hypothesisCount: 3,
          updatedAt: 4_000,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    recordImplementationFailure(fixture.runtime, "ext-debug-loop-7", 5_000);

    const debugLoop = readJsonFile<{
      status: string;
      hypothesisCount: number;
      blockedReason?: string | null;
    }>(statePath);
    expect(debugLoop.status).toBe("exhausted");
    expect(debugLoop.hypothesisCount).toBe(3);
    expect(debugLoop.blockedReason).toBe("hypothesis_limit");
  });

  test("artifact persistence failures are recorded as explicit runtime events", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-persist-fail");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-4";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-4");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    blockArtifactSessionsRoot(workspace);

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: ["pending verification"],
    };

    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId: "tc-complete",
        toolName: "skill_complete",
        input: { outputs },
      },
      ctx,
    );
    await completeTool.execute("tc-complete", { outputs }, undefined, undefined, toolCtx);

    const events = runtime.events.query(sessionId, {
      type: DEBUG_LOOP_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.payload?.artifactKind === "failure_case")).toBe(true);
    expect(events.some((event) => event.payload?.artifactKind === "state")).toBe(true);
    const latestContextPacket = await waitFor(
      () =>
        runtime.proposals.list(sessionId, {
          kind: "context_packet",
          limit: 1,
        })[0] as ProposalRecord<"context_packet"> | undefined,
      (record) => record?.receipt.decision === "accept",
      {
        label: "Timed out while waiting for debug-loop summary packet after persist failure.",
      },
    );
    if (!latestContextPacket) {
      throw new Error("Expected a debug-loop context packet after persist failure.");
    }
    expect(latestContextPacket.receipt.decision).toBe("accept");
    const injection = await waitFor(
      () =>
        runtime.context.buildInjection(
          sessionId,
          "resume debugging",
          undefined,
          "leaf-debug-loop-4",
        ),
      (candidate) => candidate.text.includes("mode: retry_scheduled"),
      {
        label: "Timed out while waiting for retry summary injection after persist failure.",
      },
    );
    expect(injection.text).toContain("[StatusSummary]");
    expect(injection.text).toContain("mode: retry_scheduled");
  });
});
