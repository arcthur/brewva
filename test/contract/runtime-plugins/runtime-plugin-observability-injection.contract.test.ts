import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostedTurnPipeline,
  registerContextTransform,
  registerEventStream,
  registerLedgerWriter,
  registerQualityGate,
} from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createBrewvaHostPluginRunner, type BrewvaHostContext } from "@brewva/brewva-substrate";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import { createMockRuntimePluginApi, invokeHandlers } from "../../helpers/runtime-plugin.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

function createHostContext(workspace: string, sessionId: string): BrewvaHostContext {
  return {
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      editor: async () => undefined,
      setEditorComponent: () => undefined,
      theme: {},
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "unsupported" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    },
    hasUI: false,
    cwd: workspace,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
    },
    modelRegistry: undefined,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => ({ tokens: 700, contextWindow: 4000, percent: 0.175 }),
    compact: () => undefined,
    getSystemPrompt: () => "base",
  };
}

describe("Runtime plugin integration: observability injection", () => {
  test("given host plugin runner contract, when emitBeforeAgentStart executes, then brewva context message is included", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-dual-injection-"));
    mkdirSync(join(workspace, ".orchestrator"), { recursive: true });
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createOpsRuntimeConfig((config) => {
        config.projection.enabled = true;
      }),
    });
    const runner = await createBrewvaHostPluginRunner({
      plugins: [createHostedTurnPipeline({ runtime, registerTools: false, cwd: workspace })],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });
    const ctx = createHostContext(workspace, "dual-injection-session");

    await runner.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

    const result = await runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "continue fixing flaky tests",
        parts: [{ type: "text", text: "continue fixing flaky tests" }],
        systemPrompt: "base",
      },
      ctx,
    );
    const messageTypes = (result?.messages ?? []).map((message) => message.customType);
    const mergedContent = (result?.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    expect(result?.systemPrompt).toContain("[Brewva Context Contract]");
    expect(messageTypes).toEqual(["brewva-context-injection"]);
    expect(mergedContent.length).toBeGreaterThan(0);
    expect(mergedContent.includes("brewva.memory-recall")).toBe(false);
  });

  test("given tool_call and tool_result events, when observability handlers run, then ledger and correlation events are persisted", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-obs-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/a.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-obs-1";

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    registerContextTransform(api, runtime);
    registerQualityGate(api, runtime);
    registerLedgerWriter(api, runtime);

    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    invokeHandlers(handlers, "session_start", {}, ctx);
    invokeHandlers(handlers, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

    const toolCallId = "tc-edit-1";
    invokeHandlers(
      handlers,
      "tool_call",
      {
        toolCallId,
        toolName: "edit",
        input: {
          file_path: "src/a.ts",
          old_text: "export const value = 1;\n",
          new_text: "export const value = 2;\n",
        },
      },
      ctx,
      { stopOnBlock: true },
    );

    writeFileSync(join(workspace, "src/a.ts"), "export const value = 2;\n", "utf8");

    invokeHandlers(
      handlers,
      "tool_result",
      {
        toolCallId,
        toolName: "edit",
        input: { file_path: "src/a.ts" },
        isError: false,
        content: [{ type: "text", text: "edited" }],
        details: { durationMs: 2 },
      },
      ctx,
    );

    const observed = runtime.inspect.events.query(sessionId, {
      type: "tool_output_observed",
      last: 1,
    })[0];
    const observedPayload = observed?.payload as
      | {
          toolCallId?: string;
          toolName?: string;
          rawChars?: number;
          rawBytes?: number;
          rawTokens?: number;
          contextPressure?: string;
          artifactRef?: string | null;
        }
      | undefined;
    expect(observedPayload?.toolCallId).toBe(toolCallId);
    expect(observedPayload?.toolName).toBe("edit");
    expect(observedPayload?.rawChars).toBeGreaterThan(0);
    expect(observedPayload?.rawBytes).toBeGreaterThan(0);
    expect(observedPayload?.rawTokens).toBeGreaterThan(0);
    requireNonEmptyString(observedPayload?.contextPressure, "Expected contextPressure.");
    requireNonEmptyString(observedPayload?.artifactRef, "Expected observed artifactRef.");

    const artifactPersisted = runtime.inspect.events.query(sessionId, {
      type: "tool_output_artifact_persisted",
      last: 1,
    })[0];
    const artifactRef =
      (artifactPersisted?.payload as { artifactRef?: string } | undefined)?.artifactRef ?? "";
    const artifactPath = join(workspace, artifactRef);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("edited");

    const ledgerRows = runtime.inspect.ledger.listRows(sessionId);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.tool).toBe("edit");

    const recorded = runtime.inspect.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0];
    const payload = recorded?.payload as
      | {
          ledgerId?: string;
          outputObservation?: {
            rawChars?: number;
            rawBytes?: number;
            rawTokens?: number;
            artifactRef?: string | null;
          };
          outputArtifact?: {
            artifactRef?: string;
            rawChars?: number;
            rawBytes?: number;
            sha256?: string;
          } | null;
          outputDistillation?: {
            strategy?: string;
            summaryTokens?: number;
          } | null;
        }
      | undefined;
    expect(payload?.ledgerId).toBe(ledgerRows[0]?.id);
    expect(payload?.outputObservation?.rawChars).toBeGreaterThan(0);
    expect(payload?.outputObservation?.rawBytes).toBeGreaterThan(0);
    expect(payload?.outputObservation?.rawTokens).toBeGreaterThan(0);
    requireNonEmptyString(
      payload?.outputObservation?.artifactRef,
      "Expected outputObservation artifactRef.",
    );
    requireNonEmptyString(
      payload?.outputArtifact?.artifactRef,
      "Expected outputArtifact artifactRef.",
    );
    expect(payload?.outputDistillation).toBeNull();
    expect(runtime.inspect.events.query(sessionId, { type: "tool_result", last: 1 })).toHaveLength(
      0,
    );

    const snapshot = runtime.inspect.events.query(sessionId, {
      type: "file_snapshot_captured",
      last: 1,
    })[0];
    expect((snapshot?.payload as { files?: string[] } | undefined)?.files).toContain("src/a.ts");

    const patchRecorded = runtime.inspect.events.query(sessionId, {
      type: "patch_recorded",
      last: 1,
    })[0];
    expect(
      (patchRecorded?.payload as { changes?: Array<{ path: string; action: string }> } | undefined)
        ?.changes,
    ).toEqual([{ path: "src/a.ts", action: "modify" }]);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    expect(reloaded.inspect.events.query(sessionId).length).toBeGreaterThan(0);
    expect(reloaded.inspect.ledger.listRows(sessionId)).toHaveLength(1);
  });

  test("given session_shutdown event, when observability handler runs, then runtime cleanup is dispatched through the public session API", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ext-shutdown-clean-"));
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "ext-shutdown-clean-1";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.tools.markCall(sessionId, "edit");
    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      channelSuccess: true,
    });

    const { api, handlers } = createMockRuntimePluginApi();
    registerEventStream(api, runtime);
    const clearStateCalls: string[] = [];
    const originalClearState = runtime.maintain.session.clearState.bind(runtime.maintain.session);
    runtime.maintain.session.clearState = (nextSessionId: string) => {
      clearStateCalls.push(nextSessionId);
      originalClearState(nextSessionId);
    };
    try {
      invokeHandlers(
        handlers,
        "session_shutdown",
        {},
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => sessionId,
          },
        },
      );
    } finally {
      runtime.maintain.session.clearState = originalClearState;
    }

    expect(clearStateCalls).toEqual([sessionId]);
    expect(
      runtime.inspect.events.query(sessionId, { type: "session_shutdown", last: 1 }),
    ).toHaveLength(1);
  });
});
