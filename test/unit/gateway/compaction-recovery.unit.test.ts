import { describe, expect, test } from "bun:test";
import { sendPromptWithCompactionRecovery } from "../../../packages/brewva-gateway/src/session/compaction-recovery.js";

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
    const sentMessages: string[] = [];
    let inFlightFollowUps = 0;
    let maxInFlightFollowUps = 0;
    let resolveFirstFollowUpReleased: (() => void) | undefined;
    const firstFollowUpReleased = new Promise<void>((resolve) => {
      resolveFirstFollowUpReleased = resolve;
    });

    await sendPromptWithCompactionRecovery(
      {
        async sendUserMessage(content): Promise<void> {
          sentMessages.push(content);

          if (sentMessages.length === 1) {
            eventBridge.runtime.events.record({
              sessionId: "agent-session-1",
              type: "session_compact",
              payload: { entryId: "comp-1" },
            });
            return;
          }

          inFlightFollowUps += 1;
          maxInFlightFollowUps = Math.max(maxInFlightFollowUps, inFlightFollowUps);

          try {
            if (sentMessages.length === 2) {
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

    expect(sentMessages).toHaveLength(3);
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
});
