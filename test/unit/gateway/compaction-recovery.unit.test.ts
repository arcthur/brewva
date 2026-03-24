import { describe, expect, test } from "bun:test";
import {
  sendPromptWithCompactionRecovery,
  wrapSessionWithCompactionRecovery,
} from "../../../packages/brewva-gateway/src/session/compaction-recovery.js";

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

describe("compaction recovery helper", () => {
  test("serializes repeated compaction resumes within one prompt lifecycle", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const followUps: string[] = [];
    let inFlightFollowUps = 0;
    let maxInFlightFollowUps = 0;
    let resolveFirstFollowUpReleased: (() => void) | undefined;
    const firstFollowUpReleased = new Promise<void>((resolve) => {
      resolveFirstFollowUpReleased = resolve;
    });

    await sendPromptWithCompactionRecovery(
      {
        async prompt(content): Promise<void> {
          promptedMessages.push(content);
          eventBridge.runtime.events.record({
            sessionId: "agent-session-1",
            type: "session_compact",
            payload: { entryId: "comp-1" },
          });
        },
        async followUp(content): Promise<void> {
          followUps.push(content);
          inFlightFollowUps += 1;
          maxInFlightFollowUps = Math.max(maxInFlightFollowUps, inFlightFollowUps);

          try {
            if (followUps.length === 1) {
              eventBridge.runtime.events.record({
                sessionId: "agent-session-1",
                type: "session_compact",
                payload: { entryId: "comp-2" },
              });
              setTimeout(() => {
                resolveFirstFollowUpReleased?.();
              }, 10);
              await firstFollowUpReleased;
            }
          } finally {
            inFlightFollowUps -= 1;
          }
        },
        agent: {
          async waitForIdle(): Promise<void> {
            return;
          },
        },
      },
      "initial prompt",
      {
        runtime: eventBridge.runtime as any,
        sessionId: "agent-session-1",
        turnId: "turn-1",
      },
    );

    expect(promptedMessages).toEqual(["initial prompt"]);
    expect(followUps).toHaveLength(2);
    expect(maxInFlightFollowUps).toBe(1);
    expect(
      eventBridge.events.filter(
        (event) => event.type === "session_turn_compaction_resume_requested",
      ),
    ).toHaveLength(2);
    expect(
      eventBridge.events.filter(
        (event) => event.type === "session_turn_compaction_resume_dispatched",
      ),
    ).toHaveLength(2);
  });

  test("wrapSessionWithCompactionRecovery routes prompt through recovery while preserving session methods", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const followUps: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-2",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        eventBridge.runtime.events.record({
          sessionId: "agent-session-2",
          type: "session_compact",
          payload: { entryId: "comp-1" },
        });
      },
      async followUp(content: string): Promise<void> {
        followUps.push(content);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
      marker(): string {
        return this.sessionManager.getSessionId();
      },
    };

    const wrapped = wrapSessionWithCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    await wrapped.prompt("recover me");

    expect(promptedMessages).toEqual(["recover me"]);
    expect(followUps).toHaveLength(1);
    expect(wrapped.marker()).toBe("agent-session-2");
    expect(
      eventBridge.events.some(
        (event) => event.type === "session_turn_compaction_resume_dispatched",
      ),
    ).toBe(true);
  });

  test("falls back to sendUserMessage when prompt/followUp helpers are unavailable", async () => {
    const eventBridge = createRuntimeEventBridge();
    const deliveries: Array<{ content: string; deliverAs?: "steer" | "followUp" }> = [];

    await sendPromptWithCompactionRecovery(
      {
        async sendUserMessage(content, options): Promise<void> {
          const text =
            typeof content === "string"
              ? content
              : content
                  .filter(
                    (
                      part,
                    ): part is {
                      type: "text";
                      text: string;
                    } => part.type === "text" && typeof part.text === "string",
                  )
                  .map((part) => part.text)
                  .join("\n");
          deliveries.push({
            content: text,
            deliverAs: options?.deliverAs,
          });

          if (deliveries.length === 1) {
            eventBridge.runtime.events.record({
              sessionId: "agent-session-legacy",
              type: "session_compact",
              payload: { entryId: "comp-legacy-1" },
            });
          }
        },
        agent: {
          async waitForIdle(): Promise<void> {
            return;
          },
        },
        sessionManager: {
          getSessionId: () => "agent-session-legacy",
        },
      },
      "legacy prompt",
      {
        runtime: eventBridge.runtime as any,
        turnId: "turn-legacy-1",
      },
    );

    expect(deliveries).toEqual([
      {
        content: "legacy prompt",
        deliverAs: undefined,
      },
      {
        content: expect.stringContaining("Resume the interrupted turn"),
        deliverAs: "followUp",
      },
    ]);
  });
});
