import { describe, expect, test } from "bun:test";
import {
  COMPACTION_RECOVERY_TEST_ONLY,
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
                turn: event.turn,
                payload: event.payload,
                schema: "brewva.event.v1" as const,
                isoTime: new Date(event.timestamp).toISOString(),
                category: event.type.startsWith("session_") ? "session" : "other",
              };
            });
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

function readTransitionPayloads(eventBridge: ReturnType<typeof createRuntimeEventBridge>) {
  return eventBridge.events
    .filter((event) => event.type === "session_turn_transition")
    .map((event) => event.payload ?? {});
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
    expect(readTransitionPayloads(eventBridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "compaction_retry",
          status: "entered",
          family: "recovery",
          attempt: 1,
        }),
        expect.objectContaining({
          reason: "compaction_retry",
          status: "completed",
          family: "recovery",
          attempt: 1,
        }),
      ]),
    );
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
    const transitions = readTransitionPayloads(eventBridge);
    expect(
      transitions.filter(
        (payload) => payload.reason === "compaction_retry" && payload.status === "entered",
      ),
    ).toHaveLength(2);
    expect(
      transitions.filter(
        (payload) => payload.reason === "compaction_retry" && payload.status === "completed",
      ),
    ).toHaveLength(2);
  });

  test("treats a newly completed compaction generation as deterministic recovery before max-output fallback", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-deterministic-recovery",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          eventBridge.runtime.events.record({
            sessionId: "agent-session-deterministic-recovery",
            type: "session_compact",
            turn: 5,
            payload: { entryId: "comp-deterministic-1" },
          });
          throw new Error("prompt too long");
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

    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-deterministic-recovery",
    });

    await wrapped.prompt("recover via compaction generation");

    expect(promptedMessages).toEqual([
      "recover via compaction generation",
      COMPACTION_RECOVERY_TEST_ONLY.COMPACTION_RESUME_PROMPT,
    ]);
    const transitions = readTransitionPayloads(eventBridge);
    expect(transitions.some((payload) => payload.reason === "max_output_recovery")).toBe(false);
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "compaction_retry",
          status: "entered",
          attempt: 1,
        }),
        expect.objectContaining({
          reason: "compaction_retry",
          status: "completed",
          attempt: 1,
        }),
      ]),
    );
  });

  test("retries retryable provider failures on an ephemeral fallback model and restores the original model afterwards", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: Array<{ content: string; model: string }> = [];
    const modelChanges: string[] = [];
    const thinkingLevelChanges: string[] = [];
    const currentModel = {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: true,
    };
    const fallbackModel = {
      provider: "openai",
      id: "gpt-5.4-mini",
      contextWindow: 200_000,
      maxTokens: 16_384,
      reasoning: true,
    };
    let activeModel = currentModel;
    let activeThinkingLevel = "high";

    const session = {
      get model() {
        return activeModel;
      },
      get thinkingLevel() {
        return activeThinkingLevel;
      },
      getAvailableThinkingLevels() {
        return ["off", "low", "medium", "high"];
      },
      modelRegistry: {
        async getAvailable() {
          return [currentModel, fallbackModel];
        },
      },
      sessionManager: {
        getSessionId: () => "agent-session-provider-fallback",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push({
          content,
          model: activeModel.id,
        });
        if (promptedMessages.length === 1) {
          throw new Error("provider returned error 529");
        }
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
        setModel(model: typeof currentModel) {
          activeModel = model;
          modelChanges.push(model.id);
        },
        setThinkingLevel(level: string) {
          activeThinkingLevel = level;
          thinkingLevelChanges.push(level);
        },
      },
      dispose(): void {
        return;
      },
    };

    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-provider-fallback",
    });

    await wrapped.prompt("recover through fallback model");

    expect(promptedMessages).toEqual([
      {
        content: "recover through fallback model",
        model: "gpt-5.4",
      },
      {
        content: COMPACTION_RECOVERY_TEST_ONLY.PROVIDER_FALLBACK_RECOVERY_PROMPT,
        model: "gpt-5.4-mini",
      },
    ]);
    expect(modelChanges).toEqual(["gpt-5.4-mini", "gpt-5.4"]);
    expect(thinkingLevelChanges).toEqual(["high", "high"]);
    expect(activeModel.id).toBe("gpt-5.4");
    expect(activeThinkingLevel).toBe("high");
    expect(readTransitionPayloads(eventBridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "provider_fallback_retry",
          status: "entered",
          family: "recovery",
          attempt: 1,
          model: "openai/gpt-5.4-mini",
        }),
        expect.objectContaining({
          reason: "provider_fallback_retry",
          status: "completed",
          family: "recovery",
          attempt: 1,
          model: "openai/gpt-5.4-mini",
        }),
      ]),
    );
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

  test("dispose on wrapped sessions tears down recovery and restores the raw prompt", async () => {
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

    expect(session.prompt).not.toBe(prompt);

    wrapped.dispose?.();
    eventBridge.runtime.events.record({
      sessionId: "agent-session-4",
      type: "session_compact",
      turn: 1,
      payload: { entryId: "comp-1" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposeCalls).toEqual(["disposed"]);
    expect(session.prompt).toBe(prompt);
    expect(readTransitionPayloads(eventBridge)).toEqual([]);
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

  test("opens the compaction retry breaker after three consecutive resume failures", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-breaker",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (content.includes("Resume the interrupted turn")) {
          throw new Error("resume_failed");
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

    installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-breaker",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      eventBridge.runtime.events.record({
        sessionId: "agent-session-breaker",
        type: "session_compact",
        turn: attempt + 1,
        payload: { entryId: `comp-${attempt + 1}` },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    eventBridge.runtime.events.record({
      sessionId: "agent-session-breaker",
      type: "session_compact",
      turn: 4,
      payload: { entryId: "comp-4" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const transitions = readTransitionPayloads(eventBridge);
    expect(
      transitions.filter(
        (payload) => payload.reason === "compaction_retry" && payload.status === "failed",
      ),
    ).toHaveLength(3);
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "compaction_retry",
          status: "skipped",
          breakerOpen: true,
          attempt: 4,
        }),
      ]),
    );
  });

  test("does not enter hosted max-output recovery after an operator-visible block in the same prompt", async () => {
    const eventBridge = createRuntimeEventBridge();
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-withheld",
      },
      async prompt(_content: string): Promise<void> {
        eventBridge.runtime.events.record({
          sessionId: "agent-session-withheld",
          type: "tool_call_blocked",
          payload: {
            toolName: "exec",
          },
        });
        throw new Error("max output tokens exceeded");
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

    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-withheld",
    });

    try {
      await wrapped.prompt("trigger failure");
      expect.unreachable("expected prompt failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("max output tokens exceeded");
    }
    const transitions = readTransitionPayloads(eventBridge);
    expect(
      transitions.some(
        (payload) =>
          payload.reason === "output_budget_escalation" || payload.reason === "max_output_recovery",
      ),
    ).toBe(false);
  });

  test("recovers max-output failures with a bounded follow-up prompt when no operator-visible fact exists", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-max-output-success",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          throw new Error("max output tokens exceeded");
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

    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-max-output-success",
    });

    await wrapped.prompt("trigger concise recovery");

    expect(promptedMessages).toEqual([
      "trigger concise recovery",
      COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT,
    ]);
    expect(readTransitionPayloads(eventBridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "skipped",
        }),
        expect.objectContaining({
          reason: "max_output_recovery",
          status: "entered",
          attempt: 1,
        }),
        expect.objectContaining({
          reason: "max_output_recovery",
          status: "completed",
          attempt: 1,
        }),
      ]),
    );
  });

  test("opens the max-output breaker after repeated recovery failures and skips later recovery attempts", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-max-output-breaker",
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);
        if (content === COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT) {
          throw new Error("recovery_prompt_failed");
        }
        throw new Error("max output tokens exceeded");
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

    const wrapped = wrapSessionWithSettledPrompts(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-max-output-breaker",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await wrapped.prompt(`trigger failure ${attempt}`);
        expect.unreachable("expected recovery failure");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }

    try {
      await wrapped.prompt("trigger breaker-open skip");
      expect.unreachable("expected breaker-open failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("max output tokens exceeded");
    }

    const transitions = readTransitionPayloads(eventBridge);
    expect(
      transitions.filter(
        (payload) => payload.reason === "max_output_recovery" && payload.status === "failed",
      ),
    ).toHaveLength(3);
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "max_output_recovery",
          status: "skipped",
          breakerOpen: true,
          attempt: 4,
        }),
      ]),
    );
    expect(
      promptedMessages.filter(
        (message) => message === COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT,
      ),
    ).toHaveLength(3);
  });
});
