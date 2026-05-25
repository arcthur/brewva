import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { CliShellAction } from "../../../packages/brewva-cli/src/shell/domain/state.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import { projectRuntimeTurnSessionWireFrames } from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";
import type { CliShellUiPort } from "../../../packages/brewva-cli/src/shell/ports/ui-port.js";
import { ShellTranscriptProjector } from "../../../packages/brewva-cli/src/shell/projectors/transcript-projector.js";

function createProjectorHarness() {
  let messages: CliShellTranscriptMessage[] = [];
  const actions: CliShellAction[] = [];
  const projector = new ShellTranscriptProjector({
    getMessages() {
      return messages;
    },
    getSessionId() {
      return "session-1";
    },
    getTranscriptSeed() {
      return [];
    },
    setMessages(nextMessages) {
      messages = [...nextMessages];
    },
    commit(action) {
      actions.push(action);
    },
    getUi() {
      return {
        notify() {},
      } as unknown as CliShellUiPort;
    },
  });

  return {
    actions,
    getMessages: () => messages,
    projector,
  };
}

describe("shell transcript projector", () => {
  test("ignores malformed session phases before typed trust projection", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-call-1",
      },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setTrust")).toBe(false);
  });

  test("projects idle session phases as product trust copy", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: { kind: "idle" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "status.setTrust",
        trust: expect.objectContaining({
          source: "idle",
          statusText: "Record",
        }),
      }),
    );
  });

  test("tool events update transcript trust without fabricating session trust", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "tool_execution_phase_change",
      toolCallId: "tool-call-1",
      toolName: "read",
      phase: "execute",
      args: { path: "src/app.ts" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setTrust")).toBe(false);

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-call-1",
        toolName: "read",
        turn: 1,
      },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "status.setTrust",
        trust: expect.objectContaining({
          phase: "inspect",
          source: "tool",
          statusText: "Inspect",
        }),
      }),
    );
  });

  test("projects live runtime assistant segments around tool frames in transcript order", () => {
    const { getMessages, projector } = createProjectorHarness();
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-1",
        ts: 1_000,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "Let me inspect first.",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-2",
        ts: 1_010,
        source: "live",
        durability: "cache",
        type: "tool.started",
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-read-1"),
        toolName: asBrewvaToolName("read"),
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-3",
        ts: 1_020,
        source: "live",
        durability: "cache",
        type: "tool.finished",
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-read-1"),
        toolName: asBrewvaToolName("read"),
        verdict: "pass",
        isError: false,
        text: "src/app.ts",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-4",
        ts: 1_030,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "The file is in src/app.ts.",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-5",
        ts: 1_040,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "Let me inspect first.The file is in src/app.ts.",
        toolOutputs: [
          {
            toolCallId: asBrewvaToolCallId("tool-read-1"),
            toolName: asBrewvaToolName("read"),
            verdict: "pass",
            isError: false,
            text: "src/app.ts",
            ts: 1_020,
          },
        ],
      },
    ];

    for (const event of projectRuntimeTurnSessionWireFrames(frames)) {
      projector.handleSessionEvent(event);
    }

    expect(
      getMessages().map((message) => ({
        role: message.role,
        text: message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
        toolCallId: message.parts.find((part) => part.type === "tool")?.toolCallId,
      })),
    ).toEqual([
      { role: "assistant", text: "Let me inspect first.", toolCallId: undefined },
      { role: "tool", text: "", toolCallId: "tool-read-1" },
      { role: "assistant", text: "The file is in src/app.ts.", toolCallId: undefined },
    ]);
  });

  test("does not keep an empty assistant draft open across a tool frame", () => {
    const { getMessages, projector } = createProjectorHarness();
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-1",
        ts: 1_000,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "\n",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-2",
        ts: 1_010,
        source: "live",
        durability: "cache",
        type: "tool.started",
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-read-1"),
        toolName: asBrewvaToolName("read"),
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-3",
        ts: 1_020,
        source: "live",
        durability: "cache",
        type: "tool.finished",
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-read-1"),
        toolName: asBrewvaToolName("read"),
        verdict: "pass",
        isError: false,
        text: "src/app.ts",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-4",
        ts: 1_030,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "Done.",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-5",
        ts: 1_040,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "\nDone.",
        toolOutputs: [
          {
            toolCallId: asBrewvaToolCallId("tool-read-1"),
            toolName: asBrewvaToolName("read"),
            verdict: "pass",
            isError: false,
            text: "src/app.ts",
            ts: 1_020,
          },
        ],
      },
    ];

    for (const event of projectRuntimeTurnSessionWireFrames(frames)) {
      projector.handleSessionEvent(event);
    }

    expect(
      getMessages().map((message) => ({
        role: message.role,
        text: message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
        toolCallId: message.parts.find((part) => part.type === "tool")?.toolCallId,
      })),
    ).toEqual([
      { role: "tool", text: "", toolCallId: "tool-read-1" },
      { role: "assistant", text: "Done.", toolCallId: undefined },
    ]);
  });
});
