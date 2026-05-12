import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_STATE, type ContextState } from "@brewva/brewva-substrate/contracts";
import type { BrewvaHostPluginRunner } from "@brewva/brewva-substrate/host-api";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import { ManagedSessionEventBridge } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/event-bridge.js";

function createRunnerStub(input?: {
  messageEndHandlers?: boolean;
  emitMessageEndResult?: { visibility?: { excludeFromContext?: boolean } };
}) {
  const emitted: string[] = [];
  const runner = {
    hasHandlers(eventName: string) {
      return eventName === "message_end" ? (input?.messageEndHandlers ?? false) : false;
    },
    async emit(eventName: string) {
      emitted.push(eventName);
    },
    async emitMessageEnd() {
      emitted.push("message_end");
      return input?.emitMessageEndResult;
    },
  } as unknown as BrewvaHostPluginRunner;
  return { runner, emitted };
}

describe("managed-agent-session event bridge", () => {
  test("syncs context state only when it changes", async () => {
    let currentState: ContextState | undefined = {
      ...DEFAULT_CONTEXT_STATE,
      budgetPressure: "high",
    };
    const { runner, emitted } = createRunnerStub();
    const listenerEvents: string[] = [];
    const bridge = new ManagedSessionEventBridge({
      runner,
      createHostContext: () => ({ sessionId: "sess-1" }) as never,
      emitToListeners: (event) => listenerEvents.push(event.type),
      appendMessage: () => undefined,
      appendCustomMessageEntry: () => undefined,
      readContextState: () => currentState,
      readTurnEventState: () => ({ turnIndex: 0, turnStartTimestamp: 0 }),
      writeTurnEventState: () => undefined,
    });

    await bridge.syncContextState();
    await bridge.syncContextState();
    currentState = {
      ...DEFAULT_CONTEXT_STATE,
      budgetPressure: "medium",
    };
    await bridge.syncContextState();

    expect(emitted).toEqual(["context_state_change", "context_state_change"]);
    expect(listenerEvents).toEqual(["context_state_change", "context_state_change"]);
    expect(bridge.getContextState().budgetPressure).toBe("medium");
  });

  test("uses single local fallback append for passive custom messages without message_end handlers", async () => {
    const appended: BrewvaTurnLoopMessage[] = [];
    const persisted: Array<{ customType: string; content: unknown }> = [];
    const listenerEvents: string[] = [];
    const { runner } = createRunnerStub();
    const bridge = new ManagedSessionEventBridge({
      runner,
      createHostContext: () => ({ sessionId: "sess-1" }) as never,
      emitToListeners: (event) => listenerEvents.push(event.type),
      appendMessage: (message) => appended.push(message),
      appendCustomMessageEntry: (customType, content) => persisted.push({ customType, content }),
      readContextState: () => DEFAULT_CONTEXT_STATE,
      readTurnEventState: () => ({ turnIndex: 0, turnStartTimestamp: 0 }),
      writeTurnEventState: () => undefined,
    });

    await bridge.appendPassiveCustomMessage({
      role: "custom",
      customType: "notice",
      content: "hello",
      display: true,
      timestamp: 1,
    });

    expect(appended).toHaveLength(1);
    expect(persisted).toEqual([{ customType: "notice", content: "hello" }]);
    expect(listenerEvents).toEqual(["message_start", "message_end"]);
  });

  test("forces transcript custom messages to stay excluded from context", async () => {
    const appended: BrewvaTurnLoopMessage[] = [];
    const { runner } = createRunnerStub();
    const bridge = new ManagedSessionEventBridge({
      runner,
      createHostContext: () => ({ sessionId: "sess-1" }) as never,
      emitToListeners: () => undefined,
      appendMessage: (message) => appended.push(message),
      appendCustomMessageEntry: () => undefined,
      readContextState: () => DEFAULT_CONTEXT_STATE,
      readTurnEventState: () => ({ turnIndex: 0, turnStartTimestamp: 0 }),
      writeTurnEventState: () => undefined,
    });

    await bridge.appendPassiveCustomMessage(
      {
        role: "custom",
        customType: "note",
        content: "hidden",
        display: true,
        timestamp: 1,
      },
      { transcript: true },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "custom",
      customType: "note",
      content: "hidden",
      excludeFromContext: true,
    });
  });
});
