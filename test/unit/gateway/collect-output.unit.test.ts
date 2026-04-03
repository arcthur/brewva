import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  collectSessionPromptOutput,
  type SessionStreamChunk,
} from "../../../packages/brewva-gateway/src/session/collect-output.js";

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
  const listeners = new Set<
    (event: {
      id: string;
      sessionId: string;
      type: string;
      timestamp: number;
      payload?: Record<string, unknown>;
    }) => void
  >();
  const events: Array<{
    id: string;
    sessionId: string;
    type: string;
    timestamp: number;
    payload?: Record<string, unknown>;
  }> = [];

  return {
    runtime: {
      events: {
        subscribe(listener: (event: (typeof events)[number]) => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        queryStructured(sessionId: string, query?: { type?: string }) {
          return events
            .filter(
              (event) =>
                event.sessionId === sessionId && (!query?.type || event.type === query.type),
            )
            .map((event) => {
              return {
                id: event.id,
                sessionId: event.sessionId,
                type: event.type,
                timestamp: event.timestamp,
                payload: event.payload,
                schema: "brewva.event.v1" as const,
                isoTime: new Date(event.timestamp).toISOString(),
                category: event.type.startsWith("session_") ? "session" : "other",
              };
            });
        },
        record(input: { sessionId: string; type: string; payload?: Record<string, unknown> }) {
          const event = {
            id: `evt-${events.length + 1}`,
            sessionId: input.sessionId,
            type: input.type,
            timestamp: Date.now(),
            payload: input.payload,
          };
          events.push(event);
          for (const listener of listeners) {
            listener(event);
          }
          return undefined;
        },
      },
    },
    events,
  };
}

function readTransitionPayloads(eventBridge: ReturnType<typeof createRuntimeEventBridge>) {
  return eventBridge.events
    .filter((event) => event.type === "session_turn_transition")
    .map((event) => event.payload ?? {});
}

describe("gateway collect output", () => {
  test("given high-volume exec result, when collecting output, then tool output is distilled", async () => {
    const noisyOutput = Array.from({ length: 240 }, (_value, index) =>
      index % 31 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
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
    );

    expect(output.toolOutputs).toHaveLength(1);
    const text = output.toolOutputs[0]?.text ?? "";
    expect(text).toContain("[ExecDistilled]");
    expect(text).toContain("status: failed");
    expect(text.length).toBeLessThan(noisyOutput.length);
  });

  test("given tool execution updates, when collecting output, then streamed chunk uses distilled text", async () => {
    const noisyPartial = Array.from({ length: 200 }, (_value, index) =>
      index % 22 === 0 ? `error at step ${index}: timeout` : `line ${index}: running`,
    ).join("\n");
    const session = createSessionMock([
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

    const chunks: SessionStreamChunk[] = [];
    await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const toolUpdateChunk = chunks.find((chunk) => chunk.kind === "tool_update");
    const attemptStartChunk = chunks.find((chunk) => chunk.kind === "attempt_start");
    expect(attemptStartChunk).toBeDefined();
    expect(toolUpdateChunk).toBeDefined();
    if (!toolUpdateChunk || toolUpdateChunk.kind !== "tool_update") {
      return;
    }
    expect(toolUpdateChunk.attemptId).toBe("attempt-1");
    expect(toolUpdateChunk.text).toContain("[ExecDistilled]");
  });

  test("given explicit fail verdict with successful tool channel, when collecting output, then gateway preserves the verdict", async () => {
    const noisyOutput = Array.from({ length: 180 }, (_value, index) =>
      index % 25 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
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
    );

    expect(output.toolOutputs).toHaveLength(1);
    expect(output.toolOutputs[0]?.verdict).toBe("fail");
    expect(output.toolOutputs[0]?.text).toContain("status: failed");
  });

  test("given session_compact during the turn, when collecting output, then gateway waits for the resumed turn", async () => {
    const eventBridge = createRuntimeEventBridge();
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
          eventBridge.runtime.events.record({
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

    const chunks: SessionStreamChunk[] = [];
    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "initial prompt",
      {
        runtime: eventBridge.runtime as any,
        sessionId: "agent-session-1",
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("initial prompt");
    expect(sentMessages[1]).toContain("Resume the interrupted turn");
    expect(output.assistantText).toBe("resumed answer");
    expect(output.attemptId).toBe("attempt-2");
    expect(chunks).toEqual(
      expect.arrayContaining([
        {
          kind: "attempt_start",
          attemptId: "attempt-1",
          reason: "initial",
        },
        {
          kind: "attempt_superseded",
          attemptId: "attempt-1",
          supersededByAttemptId: "attempt-2",
          reason: "compaction_retry",
        },
        {
          kind: "attempt_start",
          attemptId: "attempt-2",
          reason: "compaction_retry",
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
});
