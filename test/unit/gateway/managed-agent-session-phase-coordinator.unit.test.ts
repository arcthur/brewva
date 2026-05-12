import { describe, expect, test } from "bun:test";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import { ManagedSessionPhaseCoordinator } from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";

describe("managed-agent-session phase coordinator", () => {
  test("advances from assistant and tool events while emitting phase changes", async () => {
    const emitted: string[] = [];
    const coordinator = new ManagedSessionPhaseCoordinator({
      getTurn: () => 2,
      emitPhaseChange: async ({ phase }) => {
        emitted.push(phase.kind);
      },
      warnOnIncompatibleReconciledSessionPhase: () => undefined,
    });

    await coordinator.advanceFromAgentEvent({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {},
        stopReason: "stop",
        timestamp: 1,
      },
    } as never);
    expect(coordinator.get().kind).toBe("model_streaming");

    await coordinator.advanceFromAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {},
        stopReason: "stop",
        timestamp: 2,
      },
    } as never);
    expect(coordinator.get().kind).toBe("idle");

    await coordinator.advanceFromAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: {},
    } as never);
    await coordinator.advanceFromAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: {},
      isError: false,
    } as never);

    expect(emitted).toEqual(["model_streaming", "idle", "tool_executing", "idle"]);
  });

  test("reconciles external phase while preserving warning seam", async () => {
    const warnings: Array<{ previous: SessionPhase; next: SessionPhase }> = [];
    const coordinator = new ManagedSessionPhaseCoordinator({
      getTurn: () => 1,
      emitPhaseChange: async () => undefined,
      warnOnIncompatibleReconciledSessionPhase: (previous, next) => {
        warnings.push({ previous, next });
      },
    });

    await coordinator.reconcile({
      kind: "recovering",
      recoveryAnchor: "transition:wal_recovery_resume",
      turn: 1,
    });

    expect(coordinator.get().kind).toBe("recovering");
    expect(warnings).toHaveLength(1);
  });
});
