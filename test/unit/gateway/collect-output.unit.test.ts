import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, type SessionWireFrame } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { collectSessionPromptOutput } from "../../../packages/brewva-gateway/src/session/collect-output.js";

type SessionLike = {
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  prompt: (content: string) => Promise<void>;
  agent: {
    waitForIdle: () => Promise<void>;
  };
  sessionManager?: {
    getSessionId?: () => string;
  };
  dispose?: () => void;
};

function createSessionMock(eventsToEmit: AgentSessionEvent[]): SessionLike {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async prompt(_content: string): Promise<void> {
      for (const event of eventsToEmit) {
        listener?.(event);
      }
    },
    agent: {
      async waitForIdle(): Promise<void> {
        return;
      },
    },
  };
}

function createRuntimeEventBridge() {
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-collect-output-")),
  });
  const events: Array<{
    id: string;
    sessionId: string;
    type: string;
    timestamp: number;
    payload?: Record<string, unknown>;
  }> = [];
  runtime.inspect.events.subscribe((event) => {
    events.push({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      payload: event.payload,
    });
  });

  return { runtime, events };
}

function readTransitionPayloads(eventBridge: ReturnType<typeof createRuntimeEventBridge>) {
  return eventBridge.events
    .filter((event) => event.type === "session_turn_transition")
    .map((event) => event.payload ?? {});
}

function recordTurnInput(
  eventBridge: ReturnType<typeof createRuntimeEventBridge>,
  sessionId: string,
  turnId: string,
): void {
  recordRuntimeEvent(eventBridge.runtime, {
    sessionId,
    turn: 1,
    type: "turn_input_recorded",
    payload: {
      turnId,
      trigger: "user",
      promptText: "test prompt",
    },
  });
}

describe("gateway collect output", () => {
  test("given high-volume exec result, when collecting output, then tool output is distilled", async () => {
    const eventBridge = createRuntimeEventBridge();
    const sessionId = "session-high-volume";
    recordTurnInput(eventBridge, sessionId, "turn-high-volume");
    const noisyOutput = Array.from({ length: 240 }, (_value, index) =>
      index % 31 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_start",
        toolCallId: "tc-gw-exec",
        toolName: "exec",
        args: { command: "pwd" },
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-exec",
        toolName: "exec",
        result: noisyOutput,
        isError: true,
      } as AgentSessionEvent,
    ]);

    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        runtime: eventBridge.runtime as any,
        sessionId,
        turnId: "turn-high-volume",
      },
    );

    expect(output.toolOutputs).toHaveLength(1);
    const text = output.toolOutputs[0]?.text ?? "";
    expect(text).toContain("[ExecDistilled]");
    expect(text).toContain("status: failed");
    expect(text.length).toBeLessThan(noisyOutput.length);
  });

  test("given tool execution updates, when collecting output, then streamed chunk uses distilled text", async () => {
    const eventBridge = createRuntimeEventBridge();
    recordTurnInput(eventBridge, "session-tool-update", "turn-tool-update");
    const noisyPartial = Array.from({ length: 200 }, (_value, index) =>
      index % 22 === 0 ? `error at step ${index}: timeout` : `line ${index}: running`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_start",
        toolCallId: "tc-gw-update",
        toolName: "exec",
        args: { command: "pwd" },
      } as AgentSessionEvent,
      {
        type: "tool_execution_update",
        toolCallId: "tc-gw-update",
        toolName: "exec",
        partialResult: noisyPartial,
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-update",
        toolName: "exec",
        result: "done",
        isError: false,
      } as AgentSessionEvent,
    ]);

    const frames: SessionWireFrame[] = [];
    await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        runtime: eventBridge.runtime as any,
        sessionId: "session-tool-update",
        turnId: "turn-tool-update",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    const toolUpdateFrame = frames.find((frame) => frame.type === "tool.progress");
    const attemptStartFrame = frames.find(
      (frame) => frame.type === "attempt.started" && frame.reason === "initial",
    );
    expect(attemptStartFrame).toBeDefined();
    expect(toolUpdateFrame).toBeDefined();
    if (!toolUpdateFrame || toolUpdateFrame.type !== "tool.progress") {
      return;
    }
    expect(toolUpdateFrame.text).toContain("[ExecDistilled]");
    expect(toolUpdateFrame.attemptId).toBe("attempt-1");
  });

  test("given explicit fail verdict with successful tool channel, when collecting output, then gateway preserves the verdict", async () => {
    const eventBridge = createRuntimeEventBridge();
    const sessionId = "session-fail-verdict";
    recordTurnInput(eventBridge, sessionId, "turn-fail-verdict");
    const noisyOutput = Array.from({ length: 180 }, (_value, index) =>
      index % 25 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_start",
        toolCallId: "tc-gw-fail-verdict",
        toolName: "exec",
        args: { command: "pwd" },
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-fail-verdict",
        toolName: "exec",
        result: {
          content: [{ type: "text", text: noisyOutput }],
          details: { verdict: "fail" },
        },
        isError: false,
      } as AgentSessionEvent,
    ]);

    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        runtime: eventBridge.runtime as any,
        sessionId,
        turnId: "turn-fail-verdict",
      },
    );

    expect(output.toolOutputs).toHaveLength(1);
    expect(output.toolOutputs[0]?.verdict).toBe("fail");
    expect(output.toolOutputs[0]?.text).toContain("status: failed");
  });

  test("given session_compact during the turn, when collecting output, then gateway waits for the resumed turn", async () => {
    const eventBridge = createRuntimeEventBridge();
    recordTurnInput(eventBridge, "agent-session-1", "turn-compact");
    const sentMessages: string[] = [];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session: SessionLike = {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        getSessionId: () => "agent-session-1",
      },
      async prompt(content): Promise<void> {
        sentMessages.push(content);
        if (sentMessages.length === 1) {
          listener?.({
            type: "tool_execution_end",
            toolCallId: "tc-compact",
            toolName: "session_compact",
            result: "requested",
            isError: false,
          } as AgentSessionEvent);
          recordRuntimeEvent(eventBridge.runtime, {
            sessionId: "agent-session-1",
            type: "session_compact",
            payload: {
              entryId: "comp-1",
            },
          });
          return;
        }

        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "resumed answer" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
    };

    const frames: SessionWireFrame[] = [];
    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "initial prompt",
      {
        runtime: eventBridge.runtime as any,
        sessionId: "agent-session-1",
        turnId: "turn-compact",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("initial prompt");
    expect(sentMessages[1]).toContain("Resume the interrupted turn");
    expect(output.assistantText).toBe("resumed answer");
    expect(output.attemptId).toBe("attempt-2");
    expect(frames).toEqual(
      expect.arrayContaining([
        {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-1",
          type: "attempt.started",
          turnId: "turn-compact",
          attemptId: "attempt-1",
          reason: "initial",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-1",
          type: "attempt.superseded",
          turnId: "turn-compact",
          attemptId: "attempt-1",
          supersededByAttemptId: "attempt-2",
          reason: "compaction_retry",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId: "agent-session-1",
          type: "attempt.started",
          turnId: "turn-compact",
          attemptId: "attempt-2",
          reason: "compaction_retry",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
      ]),
    );
    expect(readTransitionPayloads(eventBridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "compaction_retry",
          status: "entered",
          family: "recovery",
        }),
        expect.objectContaining({
          reason: "compaction_retry",
          status: "completed",
          family: "recovery",
        }),
      ]),
    );
  });

  test("given reasoning_revert during the turn, when collecting output, then the current turn owner resumes inline from the restored branch", async () => {
    const eventBridge = createRuntimeEventBridge();
    const sessionId = "agent-session-reasoning-resume";
    recordTurnInput(eventBridge, sessionId, "turn-reasoning-resume");
    eventBridge.runtime.maintain.context.onTurnStart(sessionId, 1);
    const checkpointA = eventBridge.runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "operator_marker",
      leafEntryId: "leaf-restore-a",
    });
    eventBridge.runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "verification_boundary",
      leafEntryId: "leaf-restore-b",
    });

    const sentMessages: string[] = [];
    const branchWithSummaryCalls: Array<{
      targetLeafEntryId: string | null;
      summaryText: string;
      summaryDetails: Record<string, unknown>;
      replaceCurrent: boolean;
    }> = [];
    const replacedMessages: unknown[] = [];
    const rebuiltMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "restored branch summary" }],
      },
    ];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      subscribe(next: (event: AgentSessionEvent) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        getSessionId: () => sessionId,
        branchWithSummary: (
          targetLeafEntryId: string | null,
          summaryText: string,
          summaryDetails: Record<string, unknown>,
          replaceCurrent: boolean,
        ) => {
          branchWithSummaryCalls.push({
            targetLeafEntryId,
            summaryText,
            summaryDetails,
            replaceCurrent,
          });
        },
        buildSessionContext: () => ({
          messages: rebuiltMessages,
        }),
      },
      async prompt(content: string): Promise<void> {
        sentMessages.push(content);
        if (sentMessages.length === 1) {
          eventBridge.runtime.authority.reasoning.revert(sessionId, {
            toCheckpointId: checkpointA.checkpointId,
            trigger: "operator_request",
            continuity: "Continue from the restored branch only.",
          });
          throw new Error("turn aborted for reasoning revert");
        }
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored answer" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
        replaceMessages(messages: unknown): void {
          replacedMessages.push(messages);
        },
      },
    };

    const frames: SessionWireFrame[] = [];
    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "initial prompt",
      {
        runtime: eventBridge.runtime as any,
        sessionId,
        turnId: "turn-reasoning-resume",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("initial prompt");
    expect(sentMessages[1]).toContain("Reasoning branch revert completed");
    expect(output.assistantText).toBe("restored answer");
    expect(output.attemptId).toBe("attempt-2");
    expect(branchWithSummaryCalls).toEqual([
      expect.objectContaining({
        targetLeafEntryId: "leaf-restore-a",
        summaryText: "Continue from the restored branch only.",
        replaceCurrent: true,
        summaryDetails: expect.objectContaining({
          toCheckpointId: checkpointA.checkpointId,
          trigger: "operator_request",
        }),
      }),
    ]);
    expect(replacedMessages).toEqual([rebuiltMessages]);
    expect(frames).toEqual(
      expect.arrayContaining([
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.superseded",
          turnId: "turn-reasoning-resume",
          attemptId: "attempt-1",
          supersededByAttemptId: "attempt-2",
          reason: "reasoning_revert_resume",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.started",
          turnId: "turn-reasoning-resume",
          attemptId: "attempt-2",
          reason: "reasoning_revert_resume",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
      ]),
    );
    expect(readTransitionPayloads(eventBridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "reasoning_revert_resume",
          status: "entered",
          family: "recovery",
        }),
        expect.objectContaining({
          reason: "reasoning_revert_resume",
          status: "completed",
          family: "recovery",
        }),
      ]),
    );
  });

  test("given a late tool completion from a superseded attempt, when collecting output, then stale tool output stays live-scoped to its original attempt and stays out of committed state", async () => {
    const eventBridge = createRuntimeEventBridge();
    recordTurnInput(eventBridge, "agent-session-stale-tool", "turn-stale-tool");
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session: SessionLike = {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        getSessionId: () => "agent-session-stale-tool",
      },
      async prompt(): Promise<void> {
        listener?.({
          type: "tool_execution_start",
          toolCallId: "tc-stale-attempt-1",
          toolName: "read",
          args: { path: "a.txt" },
        } as AgentSessionEvent);
        recordRuntimeEvent(eventBridge.runtime, {
          sessionId: "agent-session-stale-tool",
          type: "session_turn_transition",
          payload: {
            reason: "provider_fallback_retry",
            status: "entered",
            sequence: 1,
            family: "recovery",
            attempt: 1,
            sourceEventId: null,
            sourceEventType: null,
            error: null,
            breakerOpen: false,
            model: "test/fallback",
          },
        });
        listener?.({
          type: "tool_execution_end",
          toolCallId: "tc-stale-attempt-1",
          toolName: "read",
          result: "stale attempt output",
          isError: false,
        } as AgentSessionEvent);
        listener?.({
          type: "tool_execution_start",
          toolCallId: "tc-current-attempt-2",
          toolName: "read",
          args: { path: "b.txt" },
        } as AgentSessionEvent);
        listener?.({
          type: "tool_execution_end",
          toolCallId: "tc-current-attempt-2",
          toolName: "read",
          result: "current attempt output",
          isError: false,
        } as AgentSessionEvent);
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
    };

    const frames: SessionWireFrame[] = [];
    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "retry this",
      {
        runtime: eventBridge.runtime as any,
        sessionId: "agent-session-stale-tool",
        turnId: "turn-stale-tool",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(output.attemptId).toBe("attempt-2");
    expect(output.toolOutputs).toEqual([
      {
        toolCallId: "tc-current-attempt-2",
        toolName: "read",
        verdict: "pass",
        isError: false,
        text: "current attempt output",
      },
    ]);
    const finishedToolCallIds = frames
      .filter((frame): frame is Extract<SessionWireFrame, { type: "tool.finished" }> => {
        return frame.type === "tool.finished";
      })
      .map((frame) => ({ toolCallId: frame.toolCallId, attemptId: frame.attemptId }));
    expect(finishedToolCallIds).toEqual([
      { toolCallId: "tc-stale-attempt-1", attemptId: "attempt-1" },
      { toolCallId: "tc-current-attempt-2", attemptId: "attempt-2" },
    ]);
  });

  test("given tool update and finish without authoritative binding, when collecting output, then live tool preview is dropped and a diagnostic event is recorded", async () => {
    const eventBridge = createRuntimeEventBridge();
    const sessionId = "agent-session-missing-binding";
    recordTurnInput(eventBridge, sessionId, "turn-missing-binding");
    const session = createSessionMock([
      {
        type: "tool_execution_update",
        toolCallId: "tc-missing-binding",
        toolName: "exec",
        partialResult: "partial output",
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-missing-binding",
        toolName: "exec",
        result: "terminal output",
        isError: false,
      } as AgentSessionEvent,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      } as AgentSessionEvent,
    ]);

    const frames: SessionWireFrame[] = [];
    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        runtime: eventBridge.runtime as any,
        sessionId,
        turnId: "turn-missing-binding",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(output.toolOutputs).toEqual([]);
    expect(
      frames.some((frame) => frame.type === "tool.progress" || frame.type === "tool.finished"),
    ).toBe(false);
    const diagnostics = eventBridge.runtime.inspect.events.query(sessionId, {
      type: "tool_attempt_binding_missing",
    });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "tc-missing-binding",
          toolName: "exec",
          phase: "tool.progress",
          source: "session_wire_live",
        }),
        expect.objectContaining({
          toolCallId: "tc-missing-binding",
          toolName: "exec",
          phase: "tool.finished",
          source: "session_wire_live",
        }),
      ]),
    );
  });
});
