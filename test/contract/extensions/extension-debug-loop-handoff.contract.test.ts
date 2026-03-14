import { describe, expect, test } from "bun:test";
import { listCognitionArtifacts } from "@brewva/brewva-deliberation";
import { registerDebugLoop } from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import {
  artifactPath,
  createContext,
  createDebugLoopFixture,
  createSkillWorkspace,
  readJsonFile,
  scheduleInitialRetry,
  toToolContext,
  waitFor,
} from "./extension-debug-loop.helpers.js";

describe("extension debug loop handoff", () => {
  test("agent end and session shutdown persist latest-wins deterministic handoff packets", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-handoff");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-3";
    const ctx = createContext(sessionId, workspace, "leaf-debug-loop-3");
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
    await completeTool.execute("tc-complete", { outputs }, undefined, undefined, toolCtx);

    runtime.events.record({ sessionId, type: "agent_end" });
    let handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(workspace, sessionId, "handoff.json"));
    expect(handoff.reason).toBe("agent_end");
    expect(handoff.nextAction).toBe("load:runtime-forensics");
    expect(handoff.debugLoop?.status).toBe("forensics");
    let injection = await waitFor(
      () => runtime.context.buildInjection(sessionId, "resume", undefined, "leaf-debug-loop-3"),
      (candidate) => candidate.text.includes("reason: agent_end"),
      {
        label: "Timed out while waiting for agent_end handoff summary injection.",
      },
    );
    expect(injection.text).toContain("[StatusSummary]");
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("mode: handoff");
    expect(injection.text).toContain("reason: agent_end");
    expect(injection.text).not.toContain("mode: retry_scheduled");

    runtime.events.record({ sessionId, type: "session_shutdown" });
    handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(workspace, sessionId, "handoff.json"));
    expect(handoff.reason).toBe("session_shutdown");
    expect(handoff.nextAction).toBe("load:runtime-forensics");
    injection = await waitFor(
      () => runtime.context.buildInjection(sessionId, "resume", undefined, "leaf-debug-loop-3"),
      (candidate) => candidate.text.includes("reason: session_shutdown"),
      {
        label: "Timed out while waiting for session_shutdown handoff summary injection.",
      },
    );
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("mode: handoff");
    expect(injection.text).toContain("reason: session_shutdown");
    expect(injection.text).not.toContain("reason: agent_end");
  });

  test("terminal converged state persists debug-loop terminal handoff after successful implementation", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-converged",
      "ext-debug-loop-5",
      "leaf-debug-loop-5",
    );

    await scheduleInitialRetry(fixture);
    fixture.runtime.skills.activate("ext-debug-loop-5", "runtime-forensics");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      runtime_trace: "Observed repeated guard arming, status polling, and late completion retries.",
      session_summary:
        "The session stayed in analysis mode and never converged on a stable completion contract.",
      artifact_findings: ["No durable artifact explained the repeated guard resets."],
    });
    fixture.runtime.skills.activate("ext-debug-loop-5", "debugging");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      root_cause: "null guard missing",
      fix_strategy: "add explicit null handling",
      failure_evidence: "stack trace",
    });
    fixture.runtime.skills.activate("ext-debug-loop-5", "implementation");
    fixture.runtime.skills.complete("ext-debug-loop-5", {
      change_set: "added null guard",
      files_changed: ["src/example.ts"],
      verification_evidence: ["tests pass"],
    });

    const debugLoop = readJsonFile<{
      status: string;
      hypothesisCount: number;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-5", "debug-loop.json"));
    expect(debugLoop.status).toBe("converged");
    expect(debugLoop.hypothesisCount).toBe(1);
    expect(debugLoop.blockedReason ?? null).toBeNull();

    const handoff = readJsonFile<{
      reason: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-5", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.debugLoop?.status).toBe("converged");

    const injection = await waitFor(
      () =>
        fixture.runtime.context.buildInjection(
          "ext-debug-loop-5",
          "resume",
          undefined,
          "leaf-debug-loop-5",
        ),
      (candidate) => candidate.text.includes("reason: debug_loop_terminal"),
      {
        label: "Timed out while waiting for terminal handoff summary injection.",
      },
    );
    expect(injection.text).toContain("summary_kind: debug_loop_handoff");
    expect(injection.text).toContain("reason: debug_loop_terminal");

    const referenceArtifacts = await listCognitionArtifacts(
      fixture.runtime.workspaceRoot,
      "reference",
    );
    expect(
      referenceArtifacts.some((artifact) =>
        artifact.fileName.includes("debug-loop-converged-handoff"),
      ),
    ).toBe(true);
  });

  test("cascade start failures push debug loop into blocked terminal state", async () => {
    const fixture = createDebugLoopFixture(
      "ext-debug-loop-blocked",
      "ext-debug-loop-9",
      "leaf-debug-loop-9",
    );
    const originalStartCascade = fixture.runtime.skills.startCascade.bind(fixture.runtime.skills);
    (
      fixture.runtime.skills as unknown as {
        startCascade: typeof originalStartCascade;
      }
    ).startCascade = () => {
      return {
        ok: false,
        reason: "forced_blocked_path",
      };
    };

    try {
      await scheduleInitialRetry(fixture);
    } finally {
      (
        fixture.runtime.skills as unknown as {
          startCascade: typeof originalStartCascade;
        }
      ).startCascade = originalStartCascade;
    }

    const debugLoop = readJsonFile<{
      status: string;
      blockedReason?: string | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-9", "debug-loop.json"));
    expect(debugLoop.status).toBe("blocked");
    expect(debugLoop.blockedReason).toBe("forced_blocked_path");

    const handoff = readJsonFile<{
      reason: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(fixture.workspace, "ext-debug-loop-9", "handoff.json"));
    expect(handoff.reason).toBe("debug_loop_terminal");
    expect(handoff.debugLoop?.status).toBe("blocked");
  });
});
