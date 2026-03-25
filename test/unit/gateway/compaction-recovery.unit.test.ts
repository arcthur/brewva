import { describe, expect, test } from "bun:test";
import {
  installSessionCompactionRecovery,
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

    const wrapped = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    const initialPromptResult = await Promise.race([
      wrapped.prompt("interactive prompt").then(() => "resolved"),
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
      dispose(): void {
        return;
      },
    };

    const installed = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-2",
    });
    const wrapped = wrapSessionWithSettledPrompts(installed, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-2",
    });
    await wrapped.prompt("initial prompt");

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

  test("queued streaming prompts do not wait for idle settlement", async () => {
    const eventBridge = createRuntimeEventBridge();
    let resolveIdle: (() => void) | undefined;
    const idleReleased = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    const session = {
      isStreaming: true,
      sessionManager: {
        getSessionId: () => "agent-session-queued",
      },
      async prompt(_content: string, _options?: unknown): Promise<void> {
        return;
      },
      agent: {
        async waitForIdle(): Promise<void> {
          await idleReleased;
        },
      },
      dispose(): void {
        return;
      },
    };

    const wrapped = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-queued",
    });

    const queuedPromptResult = await Promise.race([
      wrapped
        .prompt("queued prompt", {
          streamingBehavior: "followUp",
        })
        .then(() => "resolved"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed_out"), 20);
      }),
    ]);

    resolveIdle?.();
    expect(queuedPromptResult).toBe("resolved");
  });

  test("wrapped session intercepts internal this.prompt dispatch without rebinding methods", async () => {
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
      async delegatePrompt(content: string): Promise<void> {
        await this.prompt(content);
      },
      marker(): string {
        return this.sessionManager.getSessionId();
      },
      dispose(): void {
        return;
      },
    };

    const installed = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });
    const wrapped = wrapSessionWithSettledPrompts(installed, {
      runtime: eventBridge.runtime as any,
    });

    await wrapped.delegatePrompt("print prompt");

    expect(promptedMessages).toHaveLength(2);
    expect(promptedMessages[0]).toBe("print prompt");
    expect(promptedMessages[1]).toContain("Resume the interrupted turn");
    expect(wrapped.marker()).toBe("agent-session-3");
  });

  test("dispose on wrapped sessions tears down recovery without mutating the raw session", async () => {
    const eventBridge = createRuntimeEventBridge();
    const prompt = async (): Promise<void> => {
      return;
    };
    const disposeCalls: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-4",
      },
      prompt,
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
      dispose(): void {
        disposeCalls.push("disposed");
      },
    };

    const wrapped = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    expect(session.prompt).toBe(prompt);

    wrapped.dispose?.();
    eventBridge.runtime.events.record({
      sessionId: "agent-session-4",
      type: "session_compact",
      turn: 1,
      payload: { entryId: "comp-1" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposeCalls).toEqual(["disposed"]);
    expect(
      eventBridge.events.some((event) => event.type === "session_turn_compaction_resume_requested"),
    ).toBe(false);
  });

  test("settled prompt wrappers are idempotent over installed sessions", () => {
    const eventBridge = createRuntimeEventBridge();
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-5",
      },
      async prompt(): Promise<void> {
        return;
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

    const installed = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });
    const wrapped = wrapSessionWithSettledPrompts(installed, {
      runtime: eventBridge.runtime as any,
    });
    const wrappedAgain = wrapSessionWithSettledPrompts(installed, {
      runtime: eventBridge.runtime as any,
    });

    expect(wrappedAgain).toBe(wrapped);
  });
});
