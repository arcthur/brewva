import { describe, expect, test } from "bun:test";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import { coalesceSessionProgressEvents } from "../../../packages/brewva-cli/src/shell/projectors/session-event-coalescing.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "../../helpers/prompt-session-events.js";

function textDelta(delta: string): BrewvaPromptSessionEvent {
  return createPromptMessageUpdateEvent({
    assistantMessageEvent: createTextDeltaAssistantEvent({ delta, partial: undefined }),
  });
}

function toolUpdate(input: {
  toolCallId: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
}): BrewvaPromptSessionEvent {
  return {
    type: "tool_execution_update",
    ...input,
  } as BrewvaPromptSessionEvent;
}

function readDelta(event: BrewvaPromptSessionEvent): string | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }
  const assistantEvent = event.assistantMessageEvent as { delta?: unknown } | undefined;
  return typeof assistantEvent?.delta === "string" ? assistantEvent.delta : undefined;
}

describe("coalesceSessionProgressEvents", () => {
  test("merges adjacent text deltas into one event", () => {
    const events = [textDelta("Hel"), textDelta("lo "), textDelta("world")];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced).toHaveLength(1);
    expect(readDelta(coalesced[0] as BrewvaPromptSessionEvent)).toBe("Hello world");
  });

  test("keeps non-mergeable events as run boundaries", () => {
    const phaseChange = {
      type: "session_phase_change",
      phase: { kind: "model_streaming", modelCallId: "call-1", turn: 1 },
    } as BrewvaPromptSessionEvent;
    const events = [textDelta("a"), textDelta("b"), phaseChange, textDelta("c")];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced).toHaveLength(3);
    expect(readDelta(coalesced[0] as BrewvaPromptSessionEvent)).toBe("ab");
    expect((coalesced[1] as { type: string }).type).toBe("session_phase_change");
    expect(readDelta(coalesced[2] as BrewvaPromptSessionEvent)).toBe("c");
  });

  test("keeps the freshest cumulative tool update per adjacent run", () => {
    const events = [
      toolUpdate({ toolCallId: "tc-1", toolName: "exec", args: { cmd: "ls" } }),
      toolUpdate({ toolCallId: "tc-1", partialResult: { output: "partial" } }),
      toolUpdate({ toolCallId: "tc-1", partialResult: { output: "longer partial" } }),
    ];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced).toHaveLength(1);
    const merged = coalesced[0] as Record<string, unknown>;
    expect(merged.toolCallId).toBe("tc-1");
    expect(merged.toolName).toBe("exec");
    expect(merged.args).toEqual({ cmd: "ls" });
    expect(merged.partialResult).toEqual({ output: "longer partial" });
  });

  test("does not merge tool updates across different call ids", () => {
    const events = [
      toolUpdate({ toolCallId: "tc-1", toolName: "exec" }),
      toolUpdate({ toolCallId: "tc-2", toolName: "grep" }),
      toolUpdate({ toolCallId: "tc-2", partialResult: { output: "x" } }),
    ];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced).toHaveLength(2);
    expect((coalesced[0] as Record<string, unknown>).toolCallId).toBe("tc-1");
    expect((coalesced[1] as Record<string, unknown>).toolCallId).toBe("tc-2");
    expect((coalesced[1] as Record<string, unknown>).toolName).toBe("grep");
  });

  test("does not merge message updates that carry assistant partial messages", () => {
    const partialUpdate = createPromptMessageUpdateEvent({
      message: { role: "assistant", content: [{ type: "text", text: "full partial" }] },
      assistantMessageEvent: createTextDeltaAssistantEvent({ delta: "x", partial: undefined }),
    });
    const events = [textDelta("a"), partialUpdate, textDelta("b")];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced).toHaveLength(3);
  });

  test("preserves arrival order across interleaved streams", () => {
    const events = [
      textDelta("a"),
      toolUpdate({ toolCallId: "tc-1", toolName: "exec" }),
      textDelta("b"),
    ];
    const coalesced = coalesceSessionProgressEvents(events);
    expect(coalesced.map((event) => (event as { type: string }).type)).toEqual([
      "message_update",
      "tool_execution_update",
      "message_update",
    ]);
  });
});
