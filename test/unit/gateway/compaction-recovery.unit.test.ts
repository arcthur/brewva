import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  type BrewvaPromptOptions,
} from "@brewva/brewva-substrate";
import {
  COMPACTION_RECOVERY_TEST_ONLY,
  applyPromptRecoveryPolicy,
  dispatchPromptWithCompactionSettlement,
  getCompactionGenerationState,
  installSessionCompactionRecovery,
} from "../../../packages/brewva-gateway/src/session/compaction-recovery.js";
import type { ThreadLoopRecoveryPolicyName } from "../../../packages/brewva-gateway/src/session/thread-loop-types.js";

function textPrompt(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
}

function promptText(parts: readonly BrewvaPromptContentPart[]): string {
  return buildBrewvaPromptText(parts);
}

function createRuntimeEventBridge() {
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-compaction-recovery-")),
  });
  const events: Array<{
    id: string;
    sessionId: string;
    type: string;
    timestamp: number;
    turn?: number;
    payload?: Record<string, unknown>;
  }> = [];
  runtime.inspect.events.subscribe((event) => {
    events.push({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      turn: event.turn,
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

async function dispatchWithSettlement(
  eventBridge: ReturnType<typeof createRuntimeEventBridge>,
  session: Parameters<typeof dispatchPromptWithCompactionSettlement>[0],
  sessionId: string,
  parts: readonly BrewvaPromptContentPart[],
  promptOptions?: BrewvaPromptOptions,
): Promise<void> {
  await dispatchPromptWithCompactionSettlement(session, parts, {
    runtime: eventBridge.runtime as any,
    sessionId,
    promptOptions,
  });
}

async function applyPolicy(
  eventBridge: ReturnType<typeof createRuntimeEventBridge>,
  input: {
    session: Parameters<typeof applyPromptRecoveryPolicy>[0]["session"];
    sessionId: string;
    policy: ThreadLoopRecoveryPolicyName;
    error: unknown;
    parts?: readonly BrewvaPromptContentPart[];
    afterGeneration?: number;
    operatorVisibleCheckpoint?: number;
  },
): Promise<Awaited<ReturnType<typeof applyPromptRecoveryPolicy>>> {
  return await applyPromptRecoveryPolicy({
    runtime: eventBridge.runtime as any,
    session: input.session,
    sessionId: input.sessionId,
    policy: input.policy,
    parts: input.parts ?? textPrompt("trigger recovery"),
    error: input.error,
    afterGeneration: input.afterGeneration ?? 0,
    operatorVisibleCheckpoint: input.operatorVisibleCheckpoint ?? 0,
    dispatchPrompt: (parts, promptOptions) =>
      dispatchWithSettlement(eventBridge, input.session, input.sessionId, parts, promptOptions),
  });
}

describe("compaction recovery controller", () => {
  test("installs generation tracking without replacing the session prompt method", () => {
    const eventBridge = createRuntimeEventBridge();
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-no-prompt-patch",
      },
      prompt: async (_parts: readonly BrewvaPromptContentPart[]): Promise<void> => {
        return;
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };
    const originalPrompt = session.prompt;

    const installed = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    expect(installed.prompt).toBe(originalPrompt);
  });

  test("background generation tracking preserves prompt return timing for interactive sessions", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-1",
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          recordRuntimeEvent(eventBridge.runtime, {
            sessionId: "agent-session-1",
            type: "session_compact",
            turn: 7,
            payload: { entryId: "comp-1" },
          });
          return;
        }
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    const wrapped = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
    });

    const initialPromptResult = await Promise.race([
      wrapped.prompt(textPrompt("interactive prompt")).then(() => "resolved"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed_out"), 20);
      }),
    ]);

    expect(initialPromptResult).toBe("resolved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptedMessages).toEqual(["interactive prompt"]);
    expect(readTransitionPayloads(eventBridge)).toEqual([]);
  });

  test("settled prompt helpers wait for compaction generations without dispatching resume prompts", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-2",
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          recordRuntimeEvent(eventBridge.runtime, {
            sessionId: "agent-session-2",
            type: "session_compact",
            turn: 3,
            payload: { entryId: "comp-1" },
          });
          return;
        }
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    const installed = installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-2",
    });
    await dispatchWithSettlement(
      eventBridge,
      installed,
      "agent-session-2",
      textPrompt("initial prompt"),
    );

    expect(promptedMessages).toEqual(["initial prompt"]);
    expect(readTransitionPayloads(eventBridge)).toEqual([]);
  });

  test("treats a newly completed compaction generation as deterministic recovery before max-output fallback", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];

    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-deterministic-recovery",
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          recordRuntimeEvent(eventBridge.runtime, {
            sessionId: "agent-session-deterministic-recovery",
            type: "session_compact",
            turn: 5,
            payload: { entryId: "comp-deterministic-1" },
          });
          throw new Error("prompt too long");
        }
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    const sessionId = "agent-session-deterministic-recovery";
    const afterGeneration = getCompactionGenerationState(session, {
      runtime: eventBridge.runtime as any,
      sessionId,
    }).requestedGeneration;
    try {
      await dispatchWithSettlement(
        eventBridge,
        session,
        sessionId,
        textPrompt("recover via compaction generation"),
      );
      expect.unreachable("expected prompt failure");
    } catch (error) {
      const result = await applyPolicy(eventBridge, {
        session,
        sessionId,
        policy: "deterministic_context_reduction",
        error,
        afterGeneration,
      });
      expect(result).toMatchObject({
        outcome: "recovered",
        policy: "deterministic_context_reduction",
      });
    }

    expect(promptedMessages).toEqual(["recover via compaction generation"]);
    const transitions = readTransitionPayloads(eventBridge);
    expect(transitions.some((payload) => payload.reason === "max_output_recovery")).toBe(false);
    expect(transitions).toEqual([]);
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
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push({
          content,
          model: activeModel.id,
        });
        if (promptedMessages.length === 1) {
          throw new Error("provider returned error 529");
        }
      },
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
      dispose(): void {
        return;
      },
    };

    const sessionId = "agent-session-provider-fallback";
    try {
      await dispatchWithSettlement(
        eventBridge,
        session,
        sessionId,
        textPrompt("recover through fallback model"),
      );
      expect.unreachable("expected provider failure");
    } catch (error) {
      const result = await applyPolicy(eventBridge, {
        session,
        sessionId,
        policy: "provider_fallback_retry",
        error,
        parts: textPrompt("recover through fallback model"),
      });
      expect(result).toMatchObject({
        outcome: "recovered",
        policy: "provider_fallback_retry",
      });
    }

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
      async prompt(_parts: readonly BrewvaPromptContentPart[], _options?: unknown): Promise<void> {
        return;
      },
      async waitForIdle(): Promise<void> {
        await idleReleased;
      },
      dispose(): void {
        return;
      },
    };

    installSessionCompactionRecovery(session, {
      runtime: eventBridge.runtime as any,
      sessionId: "agent-session-queued",
    });

    const queuedPromptResult = await Promise.race([
      dispatchWithSettlement(
        eventBridge,
        session,
        "agent-session-queued",
        textPrompt("queued prompt"),
        {
          streamingBehavior: "followUp",
        },
      ).then(() => "resolved"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed_out"), 20);
      }),
    ]);

    resolveIdle?.();
    expect(queuedPromptResult).toBe("resolved");
  });

  test("dispose on installed sessions tears down recovery without changing the raw prompt", async () => {
    const eventBridge = createRuntimeEventBridge();
    const prompt = async (_parts: readonly BrewvaPromptContentPart[]): Promise<void> => {
      return;
    };
    const disposeCalls: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-4",
      },
      prompt,
      async waitForIdle(): Promise<void> {
        return;
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
    recordRuntimeEvent(eventBridge.runtime, {
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

  test("session_compact events do not open compaction retry breakers without explicit resume dispatch", async () => {
    const eventBridge = createRuntimeEventBridge();
    const promptedMessages: string[] = [];
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-breaker",
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (content.includes("Resume the interrupted turn")) {
          throw new Error("resume_failed");
        }
      },
      async waitForIdle(): Promise<void> {
        return;
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
      recordRuntimeEvent(eventBridge.runtime, {
        sessionId: "agent-session-breaker",
        type: "session_compact",
        turn: attempt + 1,
        payload: { entryId: `comp-${attempt + 1}` },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    recordRuntimeEvent(eventBridge.runtime, {
      sessionId: "agent-session-breaker",
      type: "session_compact",
      turn: 4,
      payload: { entryId: "comp-4" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptedMessages).toEqual([]);
    expect(readTransitionPayloads(eventBridge)).toEqual([]);
  });

  test("does not enter hosted max-output recovery after an operator-visible block in the same prompt", async () => {
    const eventBridge = createRuntimeEventBridge();
    const session = {
      sessionManager: {
        getSessionId: () => "agent-session-withheld",
      },
      async prompt(_parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        recordRuntimeEvent(eventBridge.runtime, {
          sessionId: "agent-session-withheld",
          type: "tool_call_blocked",
          payload: {
            toolName: "exec",
          },
        });
        throw new Error("max output tokens exceeded");
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    try {
      await dispatchWithSettlement(
        eventBridge,
        session,
        "agent-session-withheld",
        textPrompt("trigger failure"),
      );
      expect.unreachable("expected prompt failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("max output tokens exceeded");
      const result = await applyPolicy(eventBridge, {
        session,
        sessionId: "agent-session-withheld",
        policy: "max_output_recovery",
        error,
        operatorVisibleCheckpoint: 0,
      });
      expect(result).toMatchObject({
        outcome: "aborted",
        policy: "max_output_recovery",
      });
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
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (promptedMessages.length === 1) {
          throw new Error("max output tokens exceeded");
        }
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    const sessionId = "agent-session-max-output-success";
    try {
      await dispatchWithSettlement(
        eventBridge,
        session,
        sessionId,
        textPrompt("trigger concise recovery"),
      );
      expect.unreachable("expected prompt failure");
    } catch (error) {
      const outputBudgetResult = await applyPolicy(eventBridge, {
        session,
        sessionId,
        policy: "output_budget_escalation",
        error,
        parts: textPrompt("trigger concise recovery"),
      });
      expect(outputBudgetResult).toMatchObject({
        outcome: "continued",
        policy: "output_budget_escalation",
      });
      if (outputBudgetResult.outcome !== "continued") {
        expect.unreachable("expected output budget policy to continue to max-output recovery");
      }
      const maxOutputResult = await applyPolicy(eventBridge, {
        session,
        sessionId,
        policy: "max_output_recovery",
        error: outputBudgetResult.error,
      });
      expect(maxOutputResult).toMatchObject({
        outcome: "recovered",
        policy: "max_output_recovery",
      });
    }

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
      async prompt(parts: readonly BrewvaPromptContentPart[]): Promise<void> {
        const content = promptText(parts);
        promptedMessages.push(content);
        if (content === COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT) {
          throw new Error("recovery_prompt_failed");
        }
        throw new Error("max output tokens exceeded");
      },
      async waitForIdle(): Promise<void> {
        return;
      },
      dispose(): void {
        return;
      },
    };

    const sessionId = "agent-session-max-output-breaker";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await dispatchWithSettlement(
          eventBridge,
          session,
          sessionId,
          textPrompt(`trigger failure ${attempt}`),
        );
        expect.unreachable("expected prompt failure");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const result = await applyPolicy(eventBridge, {
          session,
          sessionId,
          policy: "max_output_recovery",
          error,
        });
        expect(result).toMatchObject({
          outcome: "aborted",
          policy: "max_output_recovery",
        });
      }
    }

    try {
      await dispatchWithSettlement(
        eventBridge,
        session,
        sessionId,
        textPrompt("trigger breaker-open skip"),
      );
      expect.unreachable("expected breaker-open failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("max output tokens exceeded");
      const result = await applyPolicy(eventBridge, {
        session,
        sessionId,
        policy: "max_output_recovery",
        error,
      });
      expect(result).toMatchObject({
        outcome: "aborted",
        policy: "max_output_recovery",
      });
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
