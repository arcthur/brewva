import { describe, expect, test } from "bun:test";
import { registerDebugLoop } from "@brewva/brewva-gateway/runtime-plugins";
import {
  BrewvaRuntime,
  DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type ProposalRecord,
} from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import {
  artifactPath,
  createContext,
  createDebugLoopFixture,
  createSkillWorkspace,
  extractTextContent,
  readJsonFile,
  recordImplementationFailure,
  scheduleInitialRetry,
  toToolContext,
  waitFor,
} from "./extension-debug-loop.helpers.js";

describe("extension debug loop scheduling", () => {
  test("failed implementation completion arms debug loop and persists failure artifacts", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-1";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

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

    const result = await completeTool.execute(
      "tc-complete",
      { outputs },
      undefined,
      undefined,
      toolCtx,
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });

    expect(text).toContain("Debug loop scheduled. Next step: runtime-forensics");
    expect(text).toContain("failure-case.json");
    expect(text).toContain("debug-loop.json");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("runtime-forensics");
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "runtime-forensics",
      "debugging",
      "implementation",
    ]);
    expect(
      runtime.events.query(sessionId, { type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE, last: 1 }),
    ).toHaveLength(1);
    const retryScheduledEvent = runtime.events.query(sessionId, {
      type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      last: 1,
    })[0];
    expect(retryScheduledEvent?.payload?.committedBy).toBe("direct_cascade_start");
    expect(retryScheduledEvent?.payload?.intentId).toBe(
      runtime.skills.getCascadeIntent(sessionId)?.id,
    );

    const failureCase = readJsonFile<{
      attemptedOutputs?: Record<string, unknown>;
      failedChecks: string[];
    }>(artifactPath(workspace, sessionId, "failure-case.json"));
    expect(failureCase.attemptedOutputs?.change_set).toBe("updated one line");

    const debugLoop = readJsonFile<{ status: string; retryCount: number }>(
      artifactPath(workspace, sessionId, "debug-loop.json"),
    );
    expect(debugLoop.status).toBe("forensics");
    expect(debugLoop.retryCount).toBe(0);
    const latestContextPacket = await waitFor(
      () =>
        runtime.proposals.list(sessionId, {
          kind: "context_packet",
          limit: 1,
        })[0] as ProposalRecord<"context_packet"> | undefined,
      (record) => record?.proposal.payload.packetKey === "debug-loop:status",
      {
        label: "Timed out while waiting for initial debug-loop status packet.",
      },
    );
    expect(latestContextPacket?.proposal.payload.packetKey).toBe("debug-loop:status");
    expect(latestContextPacket?.proposal.payload.scopeId).toBe("leaf-debug-loop");
    expect(latestContextPacket?.proposal.payload.profile).toBe("status_summary");

    const scopedInjection = await waitFor(
      () =>
        runtime.context.buildInjection(sessionId, "resume debugging", undefined, "leaf-debug-loop"),
      (injection) => injection.text.includes("summary_kind: debug_loop_retry"),
      {
        label: "Timed out while waiting for retry summary injection.",
      },
    );
    expect(scopedInjection.text).toContain("[StatusSummary]");
    expect(scopedInjection.text).toContain("summary_kind: debug_loop_retry");
    expect(scopedInjection.text).toContain("mode: retry_scheduled");
    expect(scopedInjection.text).toContain("next_skill: runtime-forensics");
    expect(scopedInjection.text).toContain("references:");

    const otherLeafInjection = await runtime.context.buildInjection(
      sessionId,
      "resume debugging",
      undefined,
      "leaf-other",
    );
    expect(otherLeafInjection.text).not.toContain("[DebugLoopSummary]");
  });

  test("existing runtime trace skips runtime-forensics and jumps straight to debugging", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-trace");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-2";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-2");
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.skills.activate(sessionId, "runtime-forensics");
    runtime.skills.complete(sessionId, {
      runtime_trace: "Observed repeated guard arming, status polling, and late completion retries.",
      session_summary:
        "The session stayed in analysis mode and never converged on a stable completion contract.",
      artifact_findings: ["No durable artifact explained the repeated guard resets."],
    });

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

    const result = await completeTool.execute(
      "tc-complete",
      { outputs },
      undefined,
      undefined,
      toolCtx,
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });

    expect(text).toContain("Debug loop scheduled. Next step: debugging");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("debugging");
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "debugging",
      "implementation",
    ]);
  });

  test("retry limit transitions debug loop into exhausted", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-retry-limit",
      "ext-debug-loop-6",
      "leaf-debug-loop-6",
    );

    await scheduleInitialRetry(fixture);
    recordImplementationFailure(fixture.runtime, "ext-debug-loop-6", 2_000);
    recordImplementationFailure(fixture.runtime, "ext-debug-loop-6", 3_000);

    const debugLoop = readJsonFile<{
      status: string;
      retryCount: number;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-6", "debug-loop.json"));
    expect(debugLoop.status).toBe("exhausted");
    expect(debugLoop.retryCount).toBe(2);
    expect(debugLoop.blockedReason).toBe("retry_limit");
    expect(
      fixture.runtime.events.query("ext-debug-loop-6", {
        type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      }),
    ).toHaveLength(2);

    const handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-6", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.nextAction).toContain("inspect:");
    expect(handoff.debugLoop?.status).toBe("exhausted");
  });

  test("duplicate verification events do not reschedule retries twice", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-dedup",
      "ext-debug-loop-8",
      "leaf-debug-loop-8",
    );

    await scheduleInitialRetry(fixture);
    const debugLoop = readJsonFile<{
      retryCount: number;
      lastVerification?: { eventId?: string };
    }>(artifactPath(fixture.workspace, "ext-debug-loop-8", "debug-loop.json"));
    const duplicateEventId = debugLoop.lastVerification?.eventId;
    if (!duplicateEventId) {
      throw new Error("Expected debug loop state to persist the last verification event id.");
    }

    fixture.emitRuntimeEvent({
      schema: "brewva.event.v1",
      id: duplicateEventId,
      sessionId: "ext-debug-loop-8",
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      category: "verification",
      timestamp: 6_000,
      isoTime: new Date(6_000).toISOString(),
      turn: 1,
      payload: {
        outcome: "fail",
        activeSkill: "implementation",
        failedChecks: ["tests_failed"],
        missingEvidence: [],
        rootCause: "duplicate event should be ignored",
        recommendation: "none",
        commandsExecuted: [],
        evidenceIds: ["duplicate"],
        evidence: [],
      },
    });

    const updatedState = readJsonFile<{ retryCount: number }>(
      artifactPath(fixture.workspace, "ext-debug-loop-8", "debug-loop.json"),
    );
    expect(updatedState.retryCount).toBe(debugLoop.retryCount);
    expect(
      fixture.runtime.events.query("ext-debug-loop-8", {
        type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
  });
});
