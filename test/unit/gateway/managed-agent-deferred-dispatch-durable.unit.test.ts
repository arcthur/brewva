import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrewvaPromptText } from "@brewva/brewva-substrate/prompt";
import {
  drainDeferredPromptQueue,
  ManagedSessionDeferredTurnState,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/deferred-dispatch.js";
import { createSteeringSidecarStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/steering-sidecar.js";

const SESSION = "sess-1";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-steer-int-"));
}

function stateWithStore(cwd: string): ManagedSessionDeferredTurnState {
  return new ManagedSessionDeferredTurnState({
    store: createSteeringSidecarStore({ cwd, sessionId: SESSION }),
    queueMode: "all",
    followUpMode: "all",
  });
}

// A fresh state over the same workspace models a process restart.
function restartAndRestore(cwd: string): ManagedSessionDeferredTurnState {
  const restored = stateWithStore(cwd);
  restored.restoreFromSidecar();
  return restored;
}

describe("managed-agent deferred dispatch durability (steering sidecar)", () => {
  test("an enqueued user prompt is persisted to the sidecar", () => {
    const cwd = workspace();
    stateWithStore(cwd).enqueueStreamingUserPrompt([{ type: "text", text: "hi" }], "queue");

    const pending = createSteeringSidecarStore({ cwd, sessionId: SESSION }).loadPending();
    expect(pending.map((r) => r.channel)).toEqual(["queue"]);
    expect(pending[0]?.payload).toEqual([{ type: "text", text: "hi" }]);
  });

  test("restoreFromSidecar rebuilds queued and follow-up prompts after a restart", () => {
    const cwd = workspace();
    const state = stateWithStore(cwd);
    state.enqueueStreamingUserPrompt([{ type: "text", text: "q1" }], "queue");
    state.enqueueStreamingUserPrompt([{ type: "text", text: "f1" }], "followUp");

    const restored = restartAndRestore(cwd);
    expect(restored.getQueuedPromptViews().map((v) => v.text)).toEqual(["q1", "f1"]);
    // The rebuilt entry must keep its stable id so consume/remove still address it.
    expect(restored.consumeNextPromptBatch().map((e) => e.view.text)).toEqual(["q1"]);
  });

  test("markPromptConsumed tombstones the prompt so a restart skips it", () => {
    const cwd = workspace();
    const state = stateWithStore(cwd);
    const entry = state.enqueueStreamingUserPrompt([{ type: "text", text: "x" }], "queue");
    state.markPromptConsumed(entry.view.promptId);

    expect(restartAndRestore(cwd).getQueuedPromptViews()).toEqual([]);
  });

  test("consumeNextPromptBatch does NOT tombstone: an unfinished turn re-enqueues on restart", () => {
    // The at_least_once invariant: draining into memory is not durable consumption.
    // markConsumed fires only after the turn succeeds, so a crash between drain and
    // success re-enqueues the prompt rather than losing it.
    const cwd = workspace();
    const state = stateWithStore(cwd);
    state.enqueueStreamingUserPrompt([{ type: "text", text: "x" }], "queue");
    state.consumeNextPromptBatch(); // drained in memory, but not durably consumed

    expect(
      restartAndRestore(cwd)
        .getQueuedPromptViews()
        .map((v) => v.text),
    ).toEqual(["x"]);
  });

  test("removeQueuedPrompt tombstones the prompt durably", () => {
    const cwd = workspace();
    const state = stateWithStore(cwd);
    const entry = state.enqueueStreamingUserPrompt([{ type: "text", text: "x" }], "queue");
    expect(state.removeQueuedPrompt(entry.view.promptId)).toBe(true);

    expect(restartAndRestore(cwd).getQueuedPromptViews()).toEqual([]);
  });

  test("next-turn custom messages are transient: a restart does not restore them", () => {
    // Next-turn messages are advisory turn context, not user input, so they are
    // held in memory only. A restart restores queued user prompts but not these.
    const cwd = workspace();
    const state = stateWithStore(cwd);
    state.enqueueStreamingUserPrompt([{ type: "text", text: "user-steer" }], "queue");
    state.pushNextTurnMessage({
      role: "custom",
      customType: "note",
      content: "nt",
      display: true,
      timestamp: 1,
    });

    const restored = restartAndRestore(cwd);
    // The user prompt survives; the next-turn message does not (nothing persisted it).
    expect(restored.getQueuedPromptViews().map((v) => v.text)).toEqual(["user-steer"]);
    expect(restored.consumeNextTurnMessages()).toEqual([]);
  });

  test("with no store injected the state stays purely in-memory (restoreFromSidecar is a no-op)", () => {
    const state = new ManagedSessionDeferredTurnState();
    state.enqueueStreamingUserPrompt([{ type: "text", text: "x" }], "queue");
    state.restoreFromSidecar();
    expect(state.getQueuedPromptViews().map((v) => v.text)).toEqual(["x"]); // not duplicated
  });

  test("restart recovery drains restored prompts with no new dispatch (the startup-drain path)", async () => {
    // The P1 scenario: a turn finished, the user queued a steer, then the process
    // crashed before draining it. On restart there is NO new prompt() to drive the
    // queue — recovery must drain it on its own, or it would hang forever.
    const cwd = workspace();
    stateWithStore(cwd).enqueueStreamingUserPrompt(
      [{ type: "text", text: "restored-steer" }],
      "queue",
    );
    const state = stateWithStore(cwd);
    state.restoreFromSidecar();

    const attempted: string[] = [];
    await drainDeferredPromptQueue(
      {
        deferredTurnState: state,
        isStreaming: () => false,
        runAttempt: async (parts) => {
          attempted.push(buildBrewvaPromptText(parts));
          return "completed";
        },
        onQueueChanged: () => {},
        restoreUnattempted: (entries) => state.restoreUnattemptedPromptBatch(entries),
      },
      undefined,
    );

    // The restored prompt ran without any new dispatch, and is durably retired so a
    // second restart does not re-drive it.
    expect(attempted).toEqual(["restored-steer"]);
    expect(restartAndRestore(cwd).getQueuedPromptViews()).toEqual([]);
  });

  test("a restored prompt is retired only after its attempt returns (at_least_once)", async () => {
    const cwd = workspace();
    stateWithStore(cwd).enqueueStreamingUserPrompt([{ type: "text", text: "x" }], "queue");
    const state = stateWithStore(cwd);
    state.restoreFromSidecar();

    let pendingDuringAttempt = -1;
    await drainDeferredPromptQueue(
      {
        deferredTurnState: state,
        isStreaming: () => false,
        runAttempt: async () => {
          // Mid-attempt, before it returns: still durably pending, so a crash here
          // re-enqueues it on restart rather than losing it.
          pendingDuringAttempt = createSteeringSidecarStore({
            cwd,
            sessionId: SESSION,
          }).loadPending().length;
          return "completed";
        },
        onQueueChanged: () => {},
        restoreUnattempted: (entries) => state.restoreUnattemptedPromptBatch(entries),
      },
      undefined,
    );

    expect(pendingDuringAttempt).toBe(1); // not yet tombstoned during the attempt
    expect(restartAndRestore(cwd).getQueuedPromptViews()).toEqual([]); // retired after
  });
});
