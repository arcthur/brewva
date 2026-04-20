import { describe, expect, test } from "bun:test";
import {
  createInMemorySessionHost,
  type InternalSessionHostPlugin,
  type InternalSessionHostPluginContext,
  type SessionPhase,
} from "@brewva/brewva-substrate";

function createPluginContext(): InternalSessionHostPluginContext {
  return {
    commands: {
      interrupt() {},
      newSession() {},
      reloadSession() {},
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  };
}

describe("substrate session host", () => {
  test("owns prompt queue and execution phase transitions", async () => {
    const observedPhases: SessionPhase[] = [];
    const plugin: InternalSessionHostPlugin = {
      name: "phase-audit",
      onSessionPhaseChange(phase) {
        observedPhases.push(phase);
      },
    };
    const host = createInMemorySessionHost({
      plugins: [plugin],
      pluginContext: createPluginContext(),
    });

    host.submitPrompt({
      promptId: "prompt_1",
      parts: [{ type: "text", text: "Inspect the runtime boundary" }],
      submittedAt: 1,
    });
    host.submitPrompt({
      promptId: "prompt_2",
      parts: [{ type: "text", text: "Propose the next kernel cut" }],
      submittedAt: 2,
    });

    expect(host.getQueuedPrompts().map((prompt) => prompt.promptId)).toEqual([
      "prompt_1",
      "prompt_2",
    ]);
    expect(host.shiftPrompt()?.promptId).toBe("prompt_1");

    await host.transition({ type: "start_model_stream", modelCallId: "model_1", turn: 1 });
    await host.transition({ type: "finish_model_stream" });
    await host.transition({
      type: "start_tool_execution",
      toolCallId: "tool_1",
      toolName: "read",
      turn: 1,
    });
    await host.transition({ type: "finish_tool_execution" });

    expect(host.getPhase()).toEqual({ kind: "idle" });
    expect(observedPhases).toEqual([
      { kind: "model_streaming", modelCallId: "model_1", turn: 1 },
      { kind: "idle" },
      { kind: "tool_executing", toolCallId: "tool_1", toolName: "read", turn: 1 },
      { kind: "idle" },
    ]);
  });

  test("can terminate from any non-terminal phase", async () => {
    const host = createInMemorySessionHost({
      plugins: [],
      pluginContext: createPluginContext(),
    });

    await host.transition({ type: "terminate", reason: "host_closed" });

    expect(host.getPhase()).toEqual({
      kind: "terminated",
      reason: "host_closed",
    });
  });
});
