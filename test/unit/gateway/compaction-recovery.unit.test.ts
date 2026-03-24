import { describe, expect, test } from "bun:test";
import {
  installSessionCompactionRecovery,
  sendPromptWithCompactionRecovery,
  wrapSessionWithSettledPrompts,
} from "../../../packages/brewva-gateway/src/session/compaction-recovery.js";

function createRuntimeEventBridge() {
  const listeners = new Set<
    (event: {
      id: string;
      sessionId: string;
      type: string;
      timestamp: number;
      turn?: number;
      payload?: Record<string, unknown>;
    }) => void
  >();
  const events: Array<{
    id: string;
    sessionId: string;
    type: string;
    timestamp: number;
    turn?: number;
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
        record(input: {
          sessionId: string;
          type: string;
          turn?: number;
          payload?: Record<string, unknown>;
        }) {
          const event = {
            id: `evt-${events.length + 1}`,
            sessionId: input.sessionId,
            type: input.type,
            timestamp: Date.now(),
            turn: input.turn,
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

describe("compaction recovery controller", () => {
  test("background recovery preserves prompt return timing for interactive sessions", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    let resolveResumePrompt: (() => void) | undefined;
    const resumePromptReleased = new Promise<void>((resolve) => {
      resolveResumePrompt = resolve;
    });

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-1",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          eventBridge.runtime.events.record({
            sessionId: "agent-session-1",
            type: "session_compact",
            turn: 7,
            payload: { entryId: "comp-1" },
          });
          return;
        }
        await resumePromptReleased;
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
      dispose(): void {
        return;
      },
    };

    installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    const initialPromptResult = await Promise.race([
      session.prompt("interactive prompt").then(() => "resolved"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed_out"), 20);
      }),
    ]);

    expect(initialPromptResult).toBe("resolved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptedMessages[0]).toBe("interactive prompt");
    expect(promptedMessages[1]).toContain("Resume the interrupted turn");

    resolveResumePrompt?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      eventBridge.events.some(
        (event) => event.type === "session_turn_compaction_resume_dispatched",
      ),
    ).toBe(true);
  });

  test("serializes repeated compaction resumes for settled prompt helpers", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    let inFlightResumePrompts = 0;
    let maxInFlightResumePrompts = 0;
    let resolveFirstResume: (() => void) | undefined;
    const firstResumeReleased = new Promise<void>((resolve) => {
      resolveFirstResume = resolve;
    });

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-2",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          eventBridge.runtime.events.record({
            sessionId: "agent-session-2",
            type: "session_compact",
            turn: 3,
            payload: { entryId: "comp-1" },
          });
          return;
        }

        inFlightResumePrompts += 1;
        maxInFlightResumePrompts = Math.max(maxInFlightResumePrompts, inFlightResumePrompts);
        try {
          if (promptedMessages.length === 2) {
            eventBridge.runtime.events.record({
              sessionId: "agent-session-2",
              type: "session_compact",
              turn: 3,
              payload: { entryId: "comp-2" },
            });
            setTimeout(() => {
              resolveFirstResume?.();
            }, 10);
            await firstResumeReleased;
          }
        } finally {
          inFlightResumePrompts -= 1;
        }
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
    };

    await sendPromptWithCompactionRecovery(session, "initial prompt", {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-2",
    });

    expect(promptedMessages[0]).toBe("initial prompt");
    expect(promptedMessages[1]).toContain("Resume the interrupted turn");
    expect(promptedMessages[2]).toContain("Resume the interrupted turn");
    expect(maxInFlightResumePrompts).toBe(1);
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

  test("settled prompt wrapper is reserved for synchronous consumers and preserves bound methods", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-3",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          eventBridge.runtime.events.record({
            sessionId: "agent-session-3",
            type: "session_compact",
            payload: { entryId: "comp-1" },
          });
        }
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

    installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });
    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
    });

    await wrapped.prompt("print prompt");

    expect(promptedMessages).toHaveLength(2);
    expect(promptedMessages[0]).toBe("print prompt");
    expect(promptedMessages[1]).toContain("Resume the interrupted turn");
    expect(wrapped.marker()).toBe("agent-session-3");
  });
});
