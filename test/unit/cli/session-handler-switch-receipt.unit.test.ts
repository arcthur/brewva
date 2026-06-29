import { describe, expect, test } from "bun:test";
import { ShellSessionHandler } from "../../../packages/brewva-cli/src/shell/controller/handlers/session-handler.js";

const OUTGOING_SESSION_ID = "outgoing-session";

function makeSwitchHarness(input: { outgoingEventCount: number }): {
  handler: ShellSessionHandler;
  shutdownCalls: string[];
} {
  const shutdownCalls: string[] = [];
  const runtime = {
    ops: {
      events: {
        records: {
          // Idempotency probe inside recordSessionShutdownIfMissing: no prior receipt.
          query: () => [],
        },
      },
      session: {
        lifecycle: {
          shutdown: (event: { sessionId: string }) => {
            shutdownCalls.push(event.sessionId);
            return undefined;
          },
        },
      },
    },
  };
  const bundle = {
    session: { dispose() {} },
    runtime,
    inspect: {
      events: {
        query: () =>
          Array.from({ length: input.outgoingEventCount }, (_value, index) => ({
            id: `evt-${index}`,
          })),
      },
    },
  };
  const state = { composer: { text: "", parts: [] } };
  const handler = new ShellSessionHandler({
    cwd: "/tmp",
    getState: () => state as never,
    getBundle: () => bundle as never,
    getSessionPort: () =>
      ({
        getSessionId: () => OUTGOING_SESSION_ID,
        getModelLabel: () => "test-model",
      }) as never,
    getSessionPhase: () => ({ kind: "idle" }) as never,
    getSessionGeneration: () => 1,
    getModelAvailabilityMemory: () => ({}) as never,
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
    runShellEffects: async () => {},
    handleShellCommand: async () => false,
    getShortcutLabel: () => undefined,
    buildSessionStatusActions: () => [],
    dismissPendingInteractiveQuestionRequests() {},
    mountSession() {},
    initializeState() {},
    refreshOperatorSnapshot: async () => {},
    notifyInteractiveUserPromptCommitted() {},
  } as never);
  return { handler, shutdownCalls };
}

describe("ShellSessionHandler switch shutdown receipt", () => {
  test("skips the switch receipt for a never-persisted outgoing session", async () => {
    const { handler, shutdownCalls } = makeSwitchHarness({ outgoingEventCount: 0 });

    await handler.switchBundle({} as never);

    // A deferred session navigated away from before its first prompt must not be
    // stamped with a lone shutdown receipt, which would leave a rootless tape that
    // can no longer be reopened (session_lineage_root_missing).
    expect(shutdownCalls).toEqual([]);
  });

  test("records the switch receipt for an outgoing session with persisted events", async () => {
    const { handler, shutdownCalls } = makeSwitchHarness({ outgoingEventCount: 3 });

    await handler.switchBundle({} as never);

    expect(shutdownCalls).toEqual([OUTGOING_SESSION_ID]);
  });
});
