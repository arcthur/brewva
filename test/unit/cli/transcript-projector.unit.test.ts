import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { BrewvaPromptSessionEvent, SessionPhase } from "@brewva/brewva-substrate/session";
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
  test("projects runtime turn input as an active model phase", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-7",
        promptText: "who are you",
        trigger: "user",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-commit",
        ts: 2_000,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-7",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "I am Brewva.",
        toolOutputs: [],
      },
    ];

    const phaseEvents = projectRuntimeTurnSessionWireFrames(frames).filter(
      (event): event is BrewvaPromptSessionEvent & { type: "session_phase_change" } =>
        event.type === "session_phase_change",
    );

    expect(phaseEvents.map((event) => event.phase)).toEqual([
      {
        kind: "model_streaming",
        modelCallId: "runtime-turn:turn-7:attempt-1",
        turn: 7,
      },
      { kind: "idle" },
    ]);
  });

  test("projects idle phase when a runtime turn commits without assistant text", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-8",
        promptText: "run a tool",
        trigger: "user",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-commit",
        ts: 2_000,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-8",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "",
        toolOutputs: [],
      },
    ];

    const phaseEvents = projectRuntimeTurnSessionWireFrames(frames).filter(
      (event): event is BrewvaPromptSessionEvent & { type: "session_phase_change" } =>
        event.type === "session_phase_change",
    );

    const phases = phaseEvents.map((event) => event.phase as SessionPhase);
    expect(phases.map((phase) => phase.kind)).toEqual(["model_streaming", "idle"]);
  });

  test("projects runtime inconclusive tool frames with typed outcome", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-tool-finish",
        ts: 1_000,
        source: "live",
        durability: "cache",
        type: "tool.finished",
        turnId: "turn-11",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-poll-1"),
        toolName: asBrewvaToolName("poll"),
        verdict: "inconclusive",
        isError: false,
        text: "still running",
        details: { reason: "process_running", pid: 1234 },
      },
    ];

    const event = projectRuntimeTurnSessionWireFrames(frames).find(
      (candidate): candidate is BrewvaPromptSessionEvent & { type: "tool_execution_end" } =>
        candidate.type === "tool_execution_end",
    );
    const result = event?.result as Record<string, unknown> | undefined;

    expect(event?.isError).toBe(false);
    expect(result?.outcome).toEqual({
      kind: "inconclusive",
      reason: "process_running",
      value: { reason: "process_running", pid: 1234 },
    });
  });

  test("projects runtime approval, recovery, and post-tool phases", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-10",
        promptText: "write and recover",
        trigger: "user",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-tool-start",
        ts: 1_010,
        source: "live",
        durability: "cache",
        type: "tool.started",
        turnId: "turn-10",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-write-1"),
        toolName: asBrewvaToolName("write_file"),
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-approval",
        ts: 1_020,
        source: "live",
        durability: "cache",
        type: "approval.requested",
        turnId: "turn-10",
        requestId: "approval-1",
        toolCallId: asBrewvaToolCallId("tool-write-1"),
        toolName: asBrewvaToolName("write_file"),
        subject: "write src/app.ts",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-approval-decided",
        ts: 1_030,
        source: "live",
        durability: "cache",
        type: "approval.decided",
        turnId: "turn-10",
        requestId: "approval-1",
        decision: "accept",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-tool-finish",
        ts: 1_040,
        source: "live",
        durability: "cache",
        type: "tool.finished",
        turnId: "turn-10",
        attemptId: "attempt-1",
        toolCallId: asBrewvaToolCallId("tool-write-1"),
        toolName: asBrewvaToolName("write_file"),
        verdict: "pass",
        isError: false,
        text: "ok",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-recovery-enter",
        ts: 1_050,
        source: "live",
        durability: "cache",
        type: "turn.transition",
        turnId: "turn-10",
        attemptId: "attempt-2",
        family: "recovery",
        reason: "max_output_recovery",
        status: "entered",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-attempt-start",
        ts: 1_060,
        source: "live",
        durability: "cache",
        type: "attempt.started",
        turnId: "turn-10",
        attemptId: "attempt-2",
        reason: "max_output_recovery",
      },
    ];

    const phases = projectRuntimeTurnSessionWireFrames(frames)
      .filter(
        (event): event is BrewvaPromptSessionEvent & { type: "session_phase_change" } =>
          event.type === "session_phase_change",
      )
      .map((event) => event.phase as SessionPhase);

    expect(phases).toEqual([
      {
        kind: "model_streaming",
        modelCallId: "runtime-turn:turn-10:attempt-1",
        turn: 10,
      },
      {
        kind: "tool_executing",
        toolCallId: "tool-write-1",
        toolName: "write_file",
        turn: 10,
      },
      {
        kind: "waiting_approval",
        requestId: "approval-1",
        toolCallId: "tool-write-1",
        toolName: "write_file",
        turn: 10,
      },
      {
        kind: "tool_executing",
        toolCallId: "tool-write-1",
        toolName: "write_file",
        turn: 10,
      },
      {
        kind: "model_streaming",
        modelCallId: "runtime-turn:turn-10:attempt-1",
        turn: 10,
      },
      {
        kind: "recovering",
        recoveryAnchor: "transition:max_output_recovery",
        turn: 10,
      },
      {
        kind: "model_streaming",
        modelCallId: "runtime-turn:turn-10:attempt-2",
        turn: 10,
      },
    ]);
  });

  test("emits cockpit progress without transcript text for runtime thinking deltas", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-9",
        promptText: "think",
        trigger: "user",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-thinking",
        ts: 1_010,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-9",
        attemptId: "attempt-1",
        lane: "thinking",
        delta: "Need to inspect the runtime path.",
      },
    ];

    const events = projectRuntimeTurnSessionWireFrames(frames);

    expect(events).toContainEqual({
      type: "session_wire_progress",
      frameType: "assistant.delta",
      lane: "thinking",
      turnId: "turn-9",
      attemptId: "attempt-1",
    });
    expect(events.some((event) => event.type === "message_update")).toBe(false);
  });

  test("ignores malformed session phases before typed safety projection", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-call-1",
      },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setSafety")).toBe(false);
  });

  test("projects idle session phases as product safety copy", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: { kind: "idle" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "status.setSafety",
        safety: expect.objectContaining({
          source: "idle",
          statusText: "Record",
        }),
      }),
    );
  });

  test("tool events update transcript safety without fabricating session safety", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "tool_execution_phase_change",
      toolCallId: "tool-call-1",
      toolName: "read",
      phase: "execute",
      args: { path: "src/app.ts" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setSafety")).toBe(false);

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
        type: "status.setSafety",
        safety: expect.objectContaining({
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
