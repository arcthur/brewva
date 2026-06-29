import { describe, expect, test } from "bun:test";
import { ShellSessionHandler } from "../../../packages/brewva-cli/src/shell/controller/handlers/session-handler.js";
import {
  createModelAvailabilityMemory,
  type ModelAvailabilityMemory,
} from "../../../packages/brewva-cli/src/shell/domain/model-availability-memory.js";

const MODEL = { provider: "openai-codex", id: "gpt-5.1-codex-max" };

function makeHandler(input: {
  memory: ModelAvailabilityMemory;
  runShellEffects: () => Promise<void>;
}): ShellSessionHandler {
  const state = { composer: { text: "design a chess game", parts: [] } };
  return new ShellSessionHandler({
    cwd: "/tmp",
    getState: () => state as never,
    getBundle: () => ({ session: { model: MODEL } }) as never,
    getSessionPort: () =>
      ({
        getSessionId: () => "session-1",
        recordRewindCheckpoint: async () => {},
      }) as never,
    getSessionPhase: () => ({ kind: "idle" }) as never,
    getSessionGeneration: () => 1,
    getModelAvailabilityMemory: () => input.memory,
    getUi: () => ({ notify() {} }) as never,
    promptMemory: { appendHistory() {} } as never,
    transcriptProjector: {
      clearRewindMarker() {},
      appendMessage() {},
      setRewindMarker() {},
      refreshFromSession() {},
    } as never,
    modelSelection: { async openModelsDialog() {} } as never,
    providerAuth: { async openConnectDialog() {} } as never,
    commit: () => {},
    runShellEffects: input.runShellEffects,
    handleShellCommand: async () => false,
    getShortcutLabel: () => undefined,
    buildSessionStatusActions: () => [],
    dismissPendingInteractiveQuestionRequests() {},
    mountSession() {},
    initializeState() {},
    refreshOperatorSnapshot: async () => {},
    notifyInteractiveUserPromptCommitted() {},
  } as never);
}

describe("ShellSessionHandler model availability wiring", () => {
  test("marks the submitted model unavailable when the turn fails with a permanent provider error", async () => {
    const memory = createModelAvailabilityMemory();
    const handler = makeHandler({
      memory,
      runShellEffects: async () => {
        throw Object.assign(new Error("model not supported with your account"), {
          retryable: false,
        });
      },
    });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe(
      "not available with your current credentials",
    );
  });

  test("clears the submitted model's mark when the turn succeeds", async () => {
    const memory = createModelAvailabilityMemory();
    memory.markUnavailable(MODEL.provider, MODEL.id, "stale mark");
    const handler = makeHandler({ memory, runShellEffects: async () => {} });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe(undefined);
  });

  test("does not mark the model for an ordinary transient failure", async () => {
    const memory = createModelAvailabilityMemory();
    const handler = makeHandler({
      memory,
      runShellEffects: async () => {
        throw Object.assign(new Error("service unavailable"), { retryable: true });
      },
    });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe(undefined);
  });
});
