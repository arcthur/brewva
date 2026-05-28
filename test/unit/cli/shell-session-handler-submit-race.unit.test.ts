import { describe, expect, test } from "bun:test";
import { ShellSessionHandler } from "../../../packages/brewva-cli/src/shell/controller/handlers/session-handler.js";
import type { ShellEffect } from "../../../packages/brewva-cli/src/shell/domain/effects.js";

describe("ShellSessionHandler submitComposer", () => {
  test("concurrent submit calls only commit one user prompt", async () => {
    const effects: ShellEffect[] = [];
    const state = {
      composer: {
        text: "Hello from the prompt.",
        parts: [],
      },
    };
    let checkpointCount = 0;

    const handler = new ShellSessionHandler({
      cwd: "/tmp",
      getState: () => state as never,
      getBundle: () =>
        ({
          session: {
            model: "test-model",
          },
        }) as never,
      getSessionPort: () =>
        ({
          getSessionId: () => "session-1",
          listModels: async () => {
            await Bun.sleep(5);
            return [{ id: "test-model" }];
          },
          recordRewindCheckpoint: async () => {
            checkpointCount += 1;
          },
        }) as never,
      getSessionPhase: () => ({ kind: "idle" }),
      getSessionGeneration: () => 1,
      getUi: () =>
        ({
          notify() {},
        }) as never,
      promptMemory: {
        appendHistory() {},
      },
      transcriptProjector: {
        clearRewindMarker() {},
        appendMessage() {},
        setRewindMarker() {},
        refreshFromSession() {},
      },
      modelSelection: {
        async openModelsDialog() {},
      },
      providerAuth: {
        async openConnectDialog() {},
      },
      commit: (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return;
        }
        if ((input as { type?: string }).type === "composer.setText") {
          state.composer.text = (input as { text: string }).text;
        }
      },
      runShellEffects: async (nextEffects) => {
        effects.push(...nextEffects);
        await Bun.sleep(5);
      },
      handleShellCommand: async () => false,
      getShortcutLabel: () => undefined,
      buildSessionStatusActions: () => [],
      dismissPendingInteractiveQuestionRequests() {},
      mountSession() {},
      initializeState() {},
      refreshOperatorSnapshot: async () => {},
      notifyInteractiveUserPromptCommitted() {},
    });

    await Promise.all([handler.submitComposer(), handler.submitComposer()]);

    expect(checkpointCount).toBe(1);
    expect(effects.filter((effect) => effect.type === "session.prompt")).toHaveLength(1);
  });

  test("can return after scheduling the prompt effect so the renderer remains interactive", async () => {
    const effects: ShellEffect[] = [];
    const state = {
      composer: {
        text: "Keep the editor live.",
        parts: [],
      },
    };
    let resolveEffectStarted: (() => void) | undefined;
    let resolvePromptEffect: (() => void) | undefined;
    const effectStarted = new Promise<void>((resolve) => {
      resolveEffectStarted = resolve;
    });
    const promptEffect = new Promise<void>((resolve) => {
      resolvePromptEffect = resolve;
    });

    const handler = new ShellSessionHandler({
      cwd: "/tmp",
      getState: () => state as never,
      getBundle: () =>
        ({
          session: {
            model: "test-model",
          },
        }) as never,
      getSessionPort: () =>
        ({
          getSessionId: () => "session-1",
          listModels: async () => [{ id: "test-model" }],
          recordRewindCheckpoint: async () => {},
        }) as never,
      getSessionPhase: () => ({ kind: "idle" }),
      getSessionGeneration: () => 1,
      getUi: () =>
        ({
          notify() {},
        }) as never,
      promptMemory: {
        appendHistory() {},
      },
      transcriptProjector: {
        clearRewindMarker() {},
        appendMessage() {},
        setRewindMarker() {},
        refreshFromSession() {},
      },
      modelSelection: {
        async openModelsDialog() {},
      },
      providerAuth: {
        async openConnectDialog() {},
      },
      commit: (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return;
        }
        if ((input as { type?: string }).type === "composer.setText") {
          state.composer.text = (input as { text: string }).text;
        }
      },
      runShellEffects: async (nextEffects) => {
        effects.push(...nextEffects);
        resolveEffectStarted?.();
        await promptEffect;
      },
      handleShellCommand: async () => false,
      getShortcutLabel: () => undefined,
      buildSessionStatusActions: () => [],
      dismissPendingInteractiveQuestionRequests() {},
      mountSession() {},
      initializeState() {},
      refreshOperatorSnapshot: async () => {},
      notifyInteractiveUserPromptCommitted() {},
    });

    let submitResolved = false;
    const submit = handler.submitComposer({ waitForPromptEffect: false }).then(() => {
      submitResolved = true;
    });
    await effectStarted;
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(effects.filter((effect) => effect.type === "session.prompt")).toHaveLength(1);
      expect(submitResolved).toBe(true);
    } finally {
      resolvePromptEffect?.();
      await submit;
    }
  });

  test("rejects blocked cockpit composer submissions before prompt mutation", async () => {
    const effects: ShellEffect[] = [];
    const notifications: string[] = [];
    let listedModels = 0;
    const state = {
      composer: {
        text: "Do not submit yet.",
        parts: [],
      },
      cockpit: {
        projection: {
          composerPolicy: "block",
        },
      },
    };

    const handler = new ShellSessionHandler({
      cwd: "/tmp",
      getState: () => state as never,
      getBundle: () =>
        ({
          session: {
            model: "test-model",
          },
        }) as never,
      getSessionPort: () =>
        ({
          getSessionId: () => "session-1",
          listModels: async () => {
            listedModels += 1;
            return [{ id: "test-model" }];
          },
          recordRewindCheckpoint: async () => {
            throw new Error("recordRewindCheckpoint should not run");
          },
        }) as never,
      getSessionPhase: () => ({ kind: "idle" }),
      getSessionGeneration: () => 1,
      getUi: () =>
        ({
          notify(message: string) {
            notifications.push(message);
          },
        }) as never,
      promptMemory: {
        appendHistory() {
          throw new Error("appendHistory should not run");
        },
      },
      transcriptProjector: {
        clearRewindMarker() {},
        appendMessage() {},
        setRewindMarker() {},
        refreshFromSession() {},
      },
      modelSelection: {
        async openModelsDialog() {},
      },
      providerAuth: {
        async openConnectDialog() {},
      },
      commit: () => {
        throw new Error("commit should not run");
      },
      runShellEffects: async (nextEffects) => {
        effects.push(...nextEffects);
      },
      handleShellCommand: async () => false,
      getShortcutLabel: () => undefined,
      buildSessionStatusActions: () => [],
      dismissPendingInteractiveQuestionRequests() {},
      mountSession() {},
      initializeState() {},
      refreshOperatorSnapshot: async () => {},
      notifyInteractiveUserPromptCommitted() {},
    });

    await handler.submitComposer();

    expect(listedModels).toBe(0);
    expect(effects).toEqual([]);
    expect(state.composer.text).toBe("Do not submit yet.");
    expect(notifications[0]).toContain("Composer is blocked");
  });

  test("marks queued cockpit composer submissions as queue behavior", async () => {
    const effects: ShellEffect[] = [];
    const state = {
      composer: {
        text: "Run after the active turn.",
        parts: [],
      },
      cockpit: {
        projection: {
          composerPolicy: "queue",
        },
      },
    };

    const handler = new ShellSessionHandler({
      cwd: "/tmp",
      getState: () => state as never,
      getBundle: () =>
        ({
          session: {
            model: "test-model",
          },
        }) as never,
      getSessionPort: () =>
        ({
          getSessionId: () => "session-1",
          listModels: async () => [{ id: "test-model" }],
          recordRewindCheckpoint: async () => {},
        }) as never,
      getSessionPhase: () => ({ kind: "idle" }),
      getSessionGeneration: () => 1,
      getUi: () =>
        ({
          notify() {},
        }) as never,
      promptMemory: {
        appendHistory() {},
      },
      transcriptProjector: {
        clearRewindMarker() {},
        appendMessage() {},
        setRewindMarker() {},
        refreshFromSession() {},
      },
      modelSelection: {
        async openModelsDialog() {},
      },
      providerAuth: {
        async openConnectDialog() {},
      },
      commit: (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return;
        }
        if ((input as { type?: string }).type === "composer.setText") {
          state.composer.text = (input as { text: string }).text;
        }
      },
      runShellEffects: async (nextEffects) => {
        effects.push(...nextEffects);
      },
      handleShellCommand: async () => false,
      getShortcutLabel: () => undefined,
      buildSessionStatusActions: () => [],
      dismissPendingInteractiveQuestionRequests() {},
      mountSession() {},
      initializeState() {},
      refreshOperatorSnapshot: async () => {},
      notifyInteractiveUserPromptCommitted() {},
    });

    await handler.submitComposer();

    const promptEffect = effects.find((effect) => effect.type === "session.prompt");
    expect(promptEffect).toMatchObject({
      type: "session.prompt",
      options: {
        source: "interactive",
        streamingBehavior: "queue",
      },
    });
  });

  test("uses live session phase when the cockpit projection has not caught up", async () => {
    const effects: ShellEffect[] = [];
    const state = {
      composer: {
        text: "Queue behind the active stream.",
        parts: [],
      },
      cockpit: {
        projection: {
          composerPolicy: "active",
        },
      },
    };

    const handler = new ShellSessionHandler({
      cwd: "/tmp",
      getState: () => state as never,
      getBundle: () =>
        ({
          session: {
            model: "test-model",
          },
        }) as never,
      getSessionPort: () =>
        ({
          getSessionId: () => "session-1",
          listModels: async () => [{ id: "test-model" }],
          recordRewindCheckpoint: async () => {},
        }) as never,
      getSessionPhase: () => ({
        kind: "model_streaming",
        modelCallId: "model-call:1",
        turn: 1,
      }),
      getSessionGeneration: () => 1,
      getUi: () =>
        ({
          notify() {},
        }) as never,
      promptMemory: {
        appendHistory() {},
      },
      transcriptProjector: {
        clearRewindMarker() {},
        appendMessage() {},
        setRewindMarker() {},
        refreshFromSession() {},
      },
      modelSelection: {
        async openModelsDialog() {},
      },
      providerAuth: {
        async openConnectDialog() {},
      },
      commit: (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return;
        }
        if ((input as { type?: string }).type === "composer.setText") {
          state.composer.text = (input as { text: string }).text;
        }
      },
      runShellEffects: async (nextEffects) => {
        effects.push(...nextEffects);
      },
      handleShellCommand: async () => false,
      getShortcutLabel: () => undefined,
      buildSessionStatusActions: () => [],
      dismissPendingInteractiveQuestionRequests() {},
      mountSession() {},
      initializeState() {},
      refreshOperatorSnapshot: async () => {},
      notifyInteractiveUserPromptCommitted() {},
    });

    await handler.submitComposer();

    const promptEffect = effects.find((effect) => effect.type === "session.prompt");
    expect(promptEffect).toMatchObject({
      type: "session.prompt",
      options: {
        source: "interactive",
        streamingBehavior: "queue",
      },
    });
  });
});
