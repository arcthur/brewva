import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { BrewvaPromptSessionEvent, SessionPhase } from "@brewva/brewva-substrate/session";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { createShellCockpitWireFoldStore } from "../../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import type { CliShellAction } from "../../../packages/brewva-cli/src/shell/domain/state.js";
import {
  buildTextTranscriptMessage,
  type CliShellTranscriptMessage,
} from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import {
  buildSessionWireTranscriptSeedMessages,
  projectRuntimeTurnSessionWireFrames,
} from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";
import type { CliShellUiPort } from "../../../packages/brewva-cli/src/shell/ports/ui-port.js";
import { ShellTranscriptProjector } from "../../../packages/brewva-cli/src/shell/projectors/transcript-projector.js";

function createProjectorHarness(
  options: {
    getWireFoldSnapshot?: ConstructorParameters<
      typeof ShellTranscriptProjector
    >[0]["getWireFoldSnapshot"];
  } = {},
) {
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
    getWireFoldSnapshot: options.getWireFoldSnapshot,
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
  test("refreshes transcript from folded wire state without replaying legacy deltas", () => {
    const fold = createShellCockpitWireFoldStore();
    for (let index = 0; index < 200; index += 1) {
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: `frame-delta-${index}`,
        ts: 1_000 + index,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "x",
      });
    }
    const { getMessages, projector } = createProjectorHarness({
      getWireFoldSnapshot: () => fold.snapshot("session-1"),
    });

    expect(projector.refreshFromWireFold()).toBe(true);
    expect(projector.refreshFromWireFold()).toBe(false);

    expect(getMessages()).toHaveLength(1);
    expect(getMessages()[0]).toMatchObject({
      role: "assistant",
      renderMode: "streaming",
      parts: [
        {
          type: "text",
          text: "x".repeat(200),
        },
      ],
    });
  });

  test("interleaves user prompts with folded wire turns instead of hoisting them", () => {
    const fold = createShellCockpitWireFoldStore();
    const { getMessages, projector } = createProjectorHarness({
      getWireFoldSnapshot: () => fold.snapshot("session-1"),
    });
    const rememberInput = (turnId: string, frameId: string, ts: number, promptText: string) =>
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId,
        ts,
        source: "live",
        durability: "cache",
        type: "turn.input",
        turnId,
        trigger: "user",
        promptText,
      });
    const rememberAnswer = (turnId: string, frameId: string, ts: number, delta: string) =>
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId,
        ts,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId,
        attemptId: "attempt-1",
        lane: "answer",
        delta,
      });

    // Turn 1: instant-feedback user row is appended, then the folded answer arrives.
    projector.appendMessage(
      buildTextTranscriptMessage({ id: "user:1", role: "user", text: "first question" }),
    );
    rememberInput("turn-1", "frame-input-1", 1_000, "first question");
    rememberAnswer("turn-1", "frame-delta-1", 1_001, "answer one");
    projector.refreshFromWireFold();

    // Turn 2: the second prompt must follow turn 1's answer, not sit beside turn 1's prompt.
    projector.appendMessage(
      buildTextTranscriptMessage({ id: "user:2", role: "user", text: "second question" }),
    );
    rememberInput("turn-2", "frame-input-2", 2_000, "second question");
    rememberAnswer("turn-2", "frame-delta-2", 2_001, "answer two");
    projector.refreshFromWireFold();

    const transcript = getMessages().map((message) => ({
      role: message.role,
      text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    }));
    expect(transcript).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "answer one" },
      { role: "user", text: "second question" },
      { role: "assistant", text: "answer two" },
    ]);
  });

  test("interleaves custom messages (skill cards) into their turn, not the front", () => {
    const fold = createShellCockpitWireFoldStore();
    const { getMessages, projector } = createProjectorHarness({
      getWireFoldSnapshot: () => fold.snapshot("session-1"),
    });
    const rememberInput = (turnId: string, frameId: string, ts: number, promptText: string) =>
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId,
        ts,
        source: "live",
        durability: "cache",
        type: "turn.input",
        turnId,
        trigger: "user",
        promptText,
      });
    const rememberAnswer = (turnId: string, frameId: string, ts: number, delta: string) =>
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId,
        ts,
        source: "live",
        durability: "cache",
        type: "assistant.delta",
        turnId,
        attemptId: "attempt-1",
        lane: "answer",
        delta,
      });
    const rememberCustom = (turnId: string, frameId: string, ts: number, content: string) =>
      fold.remember({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId,
        ts,
        source: "live",
        durability: "cache",
        type: "custom.message",
        turnId,
        customType: "brewva-skill-selection",
        content,
        display: true,
      });

    // Turn 1: optimistic user placeholder, then the turn's wire frames (the
    // custom skill card enters through wire-fold, not a free-floating message).
    projector.appendMessage(buildTextTranscriptMessage({ id: "user:1", role: "user", text: "q1" }));
    rememberInput("turn-1", "fi-1", 1_000, "q1");
    rememberCustom("turn-1", "fc-1", 1_000, "Selected Skills: architecture");
    rememberAnswer("turn-1", "fd-1", 1_001, "a1");
    projector.refreshFromWireFold();

    // Turn 2: the second skill card lands inside turn 2, not hoisted to the front.
    projector.appendMessage(buildTextTranscriptMessage({ id: "user:2", role: "user", text: "q2" }));
    rememberInput("turn-2", "fi-2", 2_000, "q2");
    rememberCustom("turn-2", "fc-2", 2_000, "Selected Skills: review");
    rememberAnswer("turn-2", "fd-2", 2_001, "a2");
    projector.refreshFromWireFold();

    const transcript = getMessages().map((message) => ({
      role: message.role,
      text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    }));
    expect(transcript).toEqual([
      { role: "user", text: "q1" },
      { role: "custom", text: "Selected Skills: architecture" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "custom", text: "Selected Skills: review" },
      { role: "assistant", text: "a2" },
    ]);
  });

  test("keeps the CLI-only rewind marker at the tail past a custom row across refreshes", () => {
    const fold = createShellCockpitWireFoldStore();
    const { getMessages, projector } = createProjectorHarness({
      getWireFoldSnapshot: () => fold.snapshot("session-1"),
    });
    fold.remember({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: asBrewvaSessionId("session-1"),
      frameId: "fi-1",
      ts: 1_000,
      source: "live",
      durability: "cache",
      type: "turn.input",
      turnId: "turn-1",
      trigger: "user",
      promptText: "q1",
    });
    fold.remember({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: asBrewvaSessionId("session-1"),
      frameId: "fc-1",
      ts: 1_000,
      source: "live",
      durability: "cache",
      type: "custom.message",
      turnId: "turn-1",
      customType: "brewva-skill-selection",
      content: "Selected Skills: review",
      display: true,
    });
    fold.remember({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: asBrewvaSessionId("session-1"),
      frameId: "fd-1",
      ts: 1_001,
      source: "live",
      durability: "cache",
      type: "assistant.delta",
      turnId: "turn-1",
      attemptId: "attempt-1",
      lane: "answer",
      delta: "a1",
    });
    projector.setRewindMarker("rewound to turn-1");
    projector.refreshFromWireFold();

    const snapshotRoles = () =>
      getMessages().map((message) => ({
        role: message.role,
        text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      }));

    // The rewind marker is a CLI-only overlay appended after the wire snapshot,
    // landing after the turn's custom (skill card) row, not hoisted.
    expect(snapshotRoles()).toEqual([
      { role: "user", text: "q1" },
      { role: "custom", text: "Selected Skills: review" },
      { role: "assistant", text: "a1" },
      { role: "custom", text: "rewound to turn-1" },
    ]);

    // A later frame triggers a wholesale replace; the marker survives at the tail
    // and is not duplicated by the rebuild.
    fold.remember({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: asBrewvaSessionId("session-1"),
      frameId: "fd-2",
      ts: 1_002,
      source: "live",
      durability: "cache",
      type: "assistant.delta",
      turnId: "turn-1",
      attemptId: "attempt-1",
      lane: "answer",
      delta: " more",
    });
    projector.refreshFromWireFold();
    const after = snapshotRoles();
    expect(after.at(-1)).toEqual({ role: "custom", text: "rewound to turn-1" });
    expect(after.filter((entry) => entry.text === "rewound to turn-1")).toHaveLength(1);
  });

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

  test("surfaces an empty-turn notice when a completed turn produced no reply and no tool call", () => {
    const { getMessages, projector } = createProjectorHarness();
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-empty-committed",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "",
        toolOutputs: [],
      },
    ];

    for (const event of projectRuntimeTurnSessionWireFrames(frames)) {
      projector.handleSessionEvent(event);
    }

    const assistantTexts = getMessages()
      .filter((message) => message.role === "assistant")
      .map((message) =>
        message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
      );
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTexts[0]).toContain("max_tokens");
  });

  test("does not surface the empty-turn notice when a completed turn ran a tool", () => {
    const { getMessages, projector } = createProjectorHarness();
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-tool-started",
        ts: 1_000,
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
        frameId: "frame-tool-finished",
        ts: 1_010,
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
        frameId: "frame-committed",
        ts: 1_020,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "",
        toolOutputs: [
          {
            toolCallId: asBrewvaToolCallId("tool-read-1"),
            toolName: asBrewvaToolName("read"),
            verdict: "pass",
            isError: false,
            text: "src/app.ts",
            ts: 1_010,
          },
        ],
      },
    ];

    for (const event of projectRuntimeTurnSessionWireFrames(frames)) {
      projector.handleSessionEvent(event);
    }

    const assistantTexts = getMessages()
      .filter((message) => message.role === "assistant")
      .map((message) =>
        message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
      );
    expect(assistantTexts.some((text) => text.includes("max_tokens"))).toBe(false);
    expect(getMessages().some((message) => message.role === "tool")).toBe(true);
  });

  test("buildSessionWireTranscriptSeedMessages surfaces an empty-turn notice on replay", () => {
    const frames: SessionWireFrame[] = [
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-input",
        ts: 1_000,
        source: "live",
        durability: "durable",
        type: "turn.input",
        turnId: "turn-1",
        trigger: "user",
        promptText: "build the whole app",
      },
      {
        schema: SESSION_WIRE_SCHEMA,
        sessionId: asBrewvaSessionId("session-1"),
        frameId: "frame-committed",
        ts: 1_010,
        source: "live",
        durability: "durable",
        type: "turn.committed",
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "",
        toolOutputs: [],
      },
    ];

    const messages = buildSessionWireTranscriptSeedMessages(frames) as ReadonlyArray<{
      readonly role: string;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    }>;

    const assistantMessages = messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    const [notice] = assistantMessages;
    if (!notice) {
      throw new Error("expected an empty-turn notice assistant message");
    }
    const noticeText = notice.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    expect(noticeText).toContain("max_tokens");
  });
});
