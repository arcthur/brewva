import { describe, expect, test } from "bun:test";
import {
  ManagedSessionCommandDispatchGate,
  ManagedSessionDeferredTurnState,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/deferred-dispatch.js";

describe("managed-agent-session deferred dispatch state", () => {
  test("queues, removes, and acknowledges queued prompts with stable ids", () => {
    const state = new ManagedSessionDeferredTurnState();
    const first = state.enqueueStreamingUserPrompt([{ type: "text", text: "first" }], "queue");
    const second = state.enqueueStreamingUserPrompt([{ type: "text", text: "second" }], "followUp");

    expect(state.getQueuedPromptViews().map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(state.removeQueuedPrompt(first.view.promptId, () => true)).toBe(true);
    expect(state.getQueuedPromptViews().map((entry) => entry.text)).toEqual(["second"]);
    expect(state.acknowledgeStartedQueuedUser(second.message)).toBe(true);
    expect(state.getQueuedPromptViews()).toEqual([]);
  });

  test("consumes next-turn custom messages exactly once", () => {
    const state = new ManagedSessionDeferredTurnState();
    state.pushNextTurnMessage({
      role: "custom",
      customType: "note",
      content: "next-turn",
      display: true,
      timestamp: 1,
    });
    state.pushNextTurnMessage({
      role: "custom",
      customType: "note",
      content: "second",
      display: true,
      timestamp: 2,
    });

    const firstRead = state.consumeNextTurnMessages();
    const secondRead = state.consumeNextTurnMessages();

    expect(
      firstRead.map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      ),
    ).toEqual(["next-turn", "second"]);
    expect(secondRead).toEqual([]);
  });

  test("command dispatch gate buffers only during active command scope", () => {
    const gate = new ManagedSessionCommandDispatchGate();

    expect(gate.bufferUser([{ type: "text", text: "ignored" }])).toBe(false);
    gate.begin();
    expect(gate.bufferUser([{ type: "text", text: "queued-user" }])).toBe(true);
    expect(
      gate.bufferTriggeredCustom({
        customType: "control",
        content: "queued-custom",
      }),
    ).toBe(true);
    gate.finishAfterCommand();

    const buffered = gate.consumeBufferedItems();
    expect(buffered).toMatchObject([
      { kind: "user", parts: [{ type: "text", text: "queued-user" }] },
      { kind: "custom", message: { customType: "control", content: "queued-custom" } },
    ]);
    expect(gate.consumeBufferedItems()).toEqual([]);
  });
});
