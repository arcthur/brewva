import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import { resolveHostedRuntimeTurnRuntime } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-turn-runtime.js";

/**
 * WS1 behavior lock: a hosted session must resolve to exactly one runtime
 * instance across its lifecycle, and that instance must be the one the adapter
 * exposes. This pins the invariant the WS1 single-runtime refactor must preserve
 * (it holds today via the SESSION_RUNTIMES cache + runtimeTarget replacement; it
 * must keep holding once the noop shell + mutable createRuntime are removed).
 */
function createExecutionPortSession(): never {
  return {
    getRegisteredTools() {
      return [];
    },
    getRuntimeModelCatalog() {
      return {
        async getApiKeyAndHeaders() {
          return { ok: true as const };
        },
      };
    },
    createRuntimeToolContext() {
      return {
        getSystemPrompt() {
          return "";
        },
      };
    },
  } as never;
}

describe("hosted single-runtime invariant (WS1 lock)", () => {
  test("a hosted session resolves to one runtime instance, shared with the adapter", async () => {
    const adapter = createHostedRuntimeAdapter({
      cwd: mkdtempSync(join(tmpdir(), "brewva-ws1-single-runtime-")),
    });
    const session = createExecutionPortSession();

    const first = await resolveHostedRuntimeTurnRuntime({
      sessionId: "ws1-single",
      session,
      runtime: adapter,
    });
    const second = await resolveHostedRuntimeTurnRuntime({
      sessionId: "ws1-single",
      session,
      runtime: adapter,
    });

    // One session -> one runtime instance: no observable second instance per turn.
    expect(second).toBe(first);
    // The resolved turn runtime is the same instance the adapter exposes downstream.
    expect(adapter.runtime).toBe(first);
    // ... and they share a single tape (one source of truth, not two).
    expect(adapter.runtime.tape).toBe(first.tape);
  });
});
