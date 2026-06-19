import { describe, expect, test } from "bun:test";
import {
  ManagedSessionCommandDispatchGate,
  ManagedSessionDeferredTurnState,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/deferred-dispatch.js";

describe("managed-agent-session deferred dispatch state", () => {
  test("releases queued prompts before follow-ups regardless of arrival order", () => {
    const state = new ManagedSessionDeferredTurnState();
    state.enqueueStreamingUserPrompt([{ type: "text", text: "follow-up-1" }], "followUp");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-1" }], "queue");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "follow-up-2" }], "followUp");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-2" }], "queue");

    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual(["queue-1"]);
    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual(["queue-2"]);
    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual(["follow-up-1"]);
    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual(["follow-up-2"]);
    expect(state.consumeNextPromptBatch()).toEqual([]);
  });

  test("releases configured prompt batches without crossing queue lanes", () => {
    const state = new ManagedSessionDeferredTurnState({
      queueMode: "all",
      followUpMode: "all",
    });
    state.enqueueStreamingUserPrompt([{ type: "text", text: "follow-up-1" }], "followUp");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-1" }], "queue");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "follow-up-2" }], "followUp");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-2" }], "queue");

    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual([
      "queue-1",
      "queue-2",
    ]);
    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual([
      "follow-up-1",
      "follow-up-2",
    ]);
    expect(state.consumeNextPromptBatch()).toEqual([]);
  });

  test("restores unattempted batch entries ahead of newer work", () => {
    const state = new ManagedSessionDeferredTurnState({ queueMode: "all" });
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-1" }], "queue");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-2" }], "queue");
    const batch = state.consumeNextPromptBatch();
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queue-3" }], "queue");

    state.restoreUnattemptedPromptBatch(batch.slice(1));

    expect(state.consumeNextPromptBatch().map((entry) => entry.view.text)).toEqual([
      "queue-2",
      "queue-3",
    ]);
  });

  test("removes queued prompts by stable id across both lanes", () => {
    const state = new ManagedSessionDeferredTurnState();
    const first = state.enqueueStreamingUserPrompt([{ type: "text", text: "first" }], "queue");
    const second = state.enqueueStreamingUserPrompt([{ type: "text", text: "second" }], "followUp");

    expect(state.getQueuedPromptViews().map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(state.removeQueuedPrompt(first.view.promptId)).toBe(true);
    expect(state.getQueuedPromptViews().map((entry) => entry.text)).toEqual(["second"]);
    expect(state.removeQueuedPrompt(second.view.promptId)).toBe(true);
    expect(state.getQueuedPromptViews()).toEqual([]);
  });

  test("reports queued prompts and custom messages as pending work", () => {
    const state = new ManagedSessionDeferredTurnState();

    expect(state.hasPending()).toBe(false);
    state.enqueueStreamingUserPrompt([{ type: "text", text: "queued" }], "queue");
    expect(state.hasPending()).toBe(true);
    state.consumeNextPromptBatch();
    expect(state.hasPending()).toBe(false);

    state.pushNextTurnMessage({
      role: "custom",
      customType: "note",
      content: "next-turn",
      display: true,
      timestamp: 1,
    });
    expect(state.hasPending()).toBe(true);
    state.consumeNextTurnMessages();
    expect(state.hasPending()).toBe(false);
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
