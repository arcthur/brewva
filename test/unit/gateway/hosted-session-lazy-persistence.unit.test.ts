import { describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createHostedSession } from "../../../packages/brewva-gateway/src/hosted/api.js";
import { installHostedMcpBundleDisposal } from "../../../packages/brewva-gateway/src/hosted/internal/session/init/mcp-lifecycle.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("hosted session lazy persistence", () => {
  test("does not persist a new session before the first prompt", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-empty");
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const result = await createHostedSession({
      cwd: workspace,
      runtime,
      deferPersistenceUntilPrompt: true,
    });
    const sessionId = result.session.sessionManager.getSessionId();

    expect(runtime.inspect.events.records.list(sessionId)).toEqual([]);
    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([]);

    result.session.dispose();

    expect(runtime.inspect.events.records.list(sessionId)).toEqual([]);
    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([]);
  });

  test("persists deferred startup receipts when initial persistence is requested", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-flush");
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const result = await createHostedSession({
      cwd: workspace,
      runtime,
      deferPersistenceUntilPrompt: true,
    });
    const sessionId = result.session.sessionManager.getSessionId();

    await (
      result.session as typeof result.session & {
        ensureInitialPersistence(): Promise<void>;
      }
    ).ensureInitialPersistence();

    expect(
      runtime.inspect.events.records.list(sessionId).map((event) => String(event.type)),
    ).toEqual([
      "brewva.session.lineage.node_created.v1",
      "model_preset_select",
      "thinking_level_select",
      "session_start",
      "session_bootstrap",
    ]);

    result.session.dispose();
  });

  test("does not persist MCP disposal failures before initial persistence", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-mcp-dispose");
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const sessionId = "session-lazy-mcp-dispose";
    let disposed = false;
    const session = {
      dispose() {
        disposed = true;
      },
    } as Parameters<typeof installHostedMcpBundleDisposal>[0];
    const wrapped = installHostedMcpBundleDisposal(
      session,
      runtime,
      sessionId,
      {
        tools: [],
        dispose: () => Promise.reject(new Error("dispose failed")),
      },
      { shouldRecordDisposeFailure: () => false },
    );

    wrapped.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(disposed).toBe(true);
    expect(runtime.inspect.events.records.list(sessionId)).toEqual([]);
    expect(runtime.inspect.events.log.listReplaySessions()).toEqual([]);
  });
});
