import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { registerDebugLoop } from "@brewva/brewva-extensions";
import {
  BrewvaRuntime,
  DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
  DEFAULT_BREWVA_CONFIG,
} from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

type ToolExecutionContext = Parameters<ReturnType<typeof createSkillLoadTool>["execute"]>[4];

function repoRoot(): string {
  return process.cwd();
}

function createSkillWorkspace(name: string): string {
  const workspace = createTestWorkspace(name);
  writeTestConfig(workspace, structuredClone(DEFAULT_BREWVA_CONFIG));
  symlinkSync(
    join(repoRoot(), "skills"),
    join(workspace, "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return workspace;
}

function artifactPath(workspace: string, sessionId: string, fileName: string): string {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
  return join(workspace, ".orchestrator/artifacts/sessions", `sess_${encoded}`, fileName);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function createContext(
  sessionId: string,
  workspace: string,
): {
  cwd: string;
  sessionManager: { getSessionId(): string };
} {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function toToolContext(ctx: ReturnType<typeof createContext>): ToolExecutionContext {
  return ctx as ToolExecutionContext;
}

describe("extension debug loop", () => {
  test("failed implementation completion arms debug loop and persists failure artifacts", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-1";
    const ctx = createContext(sessionId, workspace);
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
      verification_evidence: "pending verification",
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
  });

  test("existing runtime trace skips runtime-forensics and jumps straight to debugging", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-trace");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-2";
    const ctx = createContext(sessionId, workspace);
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.skills.activate(sessionId, "runtime-forensics");
    runtime.skills.complete(sessionId, {
      runtime_trace: "trace",
      session_summary: "summary",
      artifact_findings: "none",
    });

    await loadTool.execute("tc-load", { name: "implementation" }, undefined, undefined, toolCtx);
    runtime.tools.markCall(sessionId, "edit");

    const outputs = {
      change_set: "updated one line",
      files_changed: ["src/example.ts"],
      verification_evidence: "pending verification",
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

  test("agent end and session shutdown persist latest-wins deterministic handoff packets", async () => {
    const workspace = createSkillWorkspace("ext-debug-loop-handoff");
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);

    const sessionId = "ext-debug-loop-3";
    const ctx = createContext(sessionId, workspace);
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
      verification_evidence: "pending verification",
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

    runtime.events.record({ sessionId, type: "session_shutdown" });
    handoff = readJsonFile<{
      reason: string;
      nextAction: string;
      debugLoop: { status: string } | null;
    }>(artifactPath(workspace, sessionId, "handoff.json"));
    expect(handoff.reason).toBe("session_shutdown");
    expect(handoff.nextAction).toBe("load:runtime-forensics");
  });
});
