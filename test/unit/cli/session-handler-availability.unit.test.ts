import { describe, expect, test } from "bun:test";
import { ShellSessionHandler } from "../../../packages/brewva-cli/src/shell/controller/handlers/session-handler.js";
import {
  createModelAvailabilityMemory,
  type ModelAvailabilityMemory,
} from "../../../packages/brewva-cli/src/shell/domain/model-availability-memory.js";

const MODEL = { provider: "openai-codex", id: "gpt-5.1-codex-max" };

type TurnOutcome = { kind: "success" } | { kind: "failure"; error: unknown };

// Mirror the production effect runner: a failed turn only propagates to the
// caller when it opts into errorMode:"throw". With the default ("notify") the
// runner reports and SWALLOWS the error, so a handler that forgets
// errorMode:"throw" sees the failure resolve as a success — which is exactly the
// bug this suite guards. A naive `() => { throw }` mock hid it for months.
function runShellEffectsFor(
  outcome: TurnOutcome,
): (effects: unknown, options?: { errorMode?: "notify" | "throw" }) => Promise<void> {
  return (_effects, options) => {
    if (outcome.kind === "success" || options?.errorMode !== "throw") {
      return Promise.resolve();
    }
    return Promise.reject(outcome.error);
  };
}

function makeHandler(input: {
  memory: ModelAvailabilityMemory;
  outcome: TurnOutcome;
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
    runShellEffects: runShellEffectsFor(input.outcome),
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
      outcome: {
        kind: "failure",
        error: Object.assign(new Error("model not supported with your account"), {
          retryable: false,
        }),
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
    const handler = makeHandler({ memory, outcome: { kind: "success" } });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe(undefined);
  });

  test("does not mark the model for an ordinary transient failure", async () => {
    const memory = createModelAvailabilityMemory();
    const handler = makeHandler({
      memory,
      outcome: {
        kind: "failure",
        error: Object.assign(new Error("service unavailable"), { retryable: true }),
      },
    });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe(undefined);
  });

  test("a failed turn must not clear the submitted model's existing mark (failure is not success)", async () => {
    // Before the fix, a swallowed failure resolved and ran onPromptSuccess, which
    // CLEARED the mark of the model that had just failed — the worst outcome.
    const memory = createModelAvailabilityMemory();
    memory.markUnavailable(MODEL.provider, MODEL.id, "prior mark");
    const handler = makeHandler({
      memory,
      outcome: {
        kind: "failure",
        error: Object.assign(new Error("service unavailable"), { retryable: true }),
      },
    });

    await handler.submitComposer();

    expect(memory.getUnavailableReason(MODEL.provider, MODEL.id)).toBe("prior mark");
  });
});
