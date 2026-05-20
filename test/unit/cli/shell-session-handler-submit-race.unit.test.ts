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
        await Bun.sleep(5);
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

    await Promise.all([handler.submitComposer(), handler.submitComposer()]);

    expect(checkpointCount).toBe(1);
    expect(effects.filter((effect) => effect.type === "session.prompt")).toHaveLength(1);
  });
});
