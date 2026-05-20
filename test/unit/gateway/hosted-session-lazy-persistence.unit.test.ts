import { describe, expect, test } from "bun:test";
import { createHostedSession } from "../../../packages/brewva-gateway/src/hosted/api.js";
import { installHostedMcpBundleDisposal } from "../../../packages/brewva-gateway/src/hosted/internal/session/init/mcp-lifecycle.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("hosted session lazy persistence", () => {
  test("does not persist a new session before the first prompt", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-empty");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const result = await createHostedSession({
      cwd: workspace,
      runtime,
      deferPersistenceUntilPrompt: true,
    });
    const sessionId = result.session.sessionManager.getSessionId();

    expect(runtime.ops.events.records.list(sessionId)).toEqual([]);
    expect(runtime.ops.events.replay.listSessions()).toEqual([]);

    result.session.dispose();

    expect(runtime.ops.events.records.list(sessionId)).toEqual([]);
    expect(runtime.ops.events.replay.listSessions()).toEqual([]);
  });

  test("persists deferred startup receipts when initial persistence is requested", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-flush");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
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

    expect(runtime.ops.events.records.list(sessionId).map((event) => event.type)).toEqual([
      "session.lineage.node.created",
      "model_preset_select",
      "thinking_level_select",
      "session_started",
      "session_bootstrap",
    ]);

    result.session.dispose();
  });

  test("does not persist MCP disposal failures before initial persistence", async () => {
    const workspace = createTestWorkspace("hosted-session-lazy-mcp-dispose");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
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
    expect(runtime.ops.events.records.list(sessionId)).toEqual([]);
    expect(runtime.ops.events.replay.listSessions()).toEqual([]);
  });
});
