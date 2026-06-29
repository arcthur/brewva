import { describe, expect, test } from "bun:test";
import {
  buildHarnessManifest,
  HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
  HARNESS_MANIFEST_SCHEMA,
} from "@brewva/brewva-vocabulary/harness";
import {
  createHostedSession,
  createRuntimeLineageNode,
} from "../../../packages/brewva-gateway/src/hosted/api.js";
import { installHostedMcpBundleDisposal } from "../../../packages/brewva-gateway/src/hosted/internal/session/init/mcp-lifecycle.js";
import { MANAGED_AGENT_SESSION_TEST_ONLY } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.js";
import { recordSessionShutdownIfMissing } from "../../../packages/brewva-gateway/src/utils/runtime.js";
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

  test("recovers a deferred session poisoned by a lone switch shutdown receipt", async () => {
    const workspace = createTestWorkspace("hosted-session-lineage-recovery");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const first = await createHostedSession({
      cwd: workspace,
      runtime,
      deferPersistenceUntilPrompt: true,
    });
    const sessionId = first.session.sessionManager.getSessionId();
    first.session.dispose();

    // Reproduce the poison: the CLI session-switch terminal receipt lands on a
    // never-prompted (deferred, unpersisted) session, so its only event becomes a
    // session_shutdown with no lineage root.
    recordSessionShutdownIfMissing(runtime, {
      sessionId,
      reason: "cli_shell_session_switch",
      source: "cli_shell_runtime",
    });
    expect(runtime.ops.events.records.list(sessionId).map((event) => event.type)).toEqual([
      "session_shutdown",
    ]);

    // Reopening must heal (seed the main lineage root) instead of throwing
    // session_lineage_root_missing.
    const reopened = await createHostedSession({
      cwd: workspace,
      runtime,
      sessionId,
      deferPersistenceUntilPrompt: true,
    });
    expect(runtime.ops.events.records.list(sessionId).map((event) => event.type)).toContain(
      "session.lineage.node.created",
    );
    reopened.session.dispose();
  });

  test("still fails closed when a rootless tape carries real lineage history", async () => {
    const workspace = createTestWorkspace("hosted-session-lineage-corruption");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sessionId = "session-rootless-with-history";

    // Genuine corruption: a real lineage node with no reachable root (not main, and
    // its parent is absent). Re-rooting would orphan history, so reopening must
    // surface the error rather than silently heal.
    createRuntimeLineageNode(runtime, sessionId, {
      lineageNodeId: "lineage:orphan-branch",
      parentLineageNodeId: "lineage:absent-parent",
      kind: "branch",
      forkPoint: { kind: "session_root" },
      createdBy: "corruption-fixture",
    });

    expect(
      createHostedSession({
        cwd: workspace,
        runtime,
        sessionId,
        deferPersistenceUntilPrompt: true,
      }),
    ).rejects.toThrow("session_lineage_root_missing");
  });

  test("still fails closed when a rootless tape carries lineage selection state", async () => {
    const workspace = createTestWorkspace("hosted-session-lineage-selection-corruption");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sessionId = "session-rootless-with-selection";

    runtime.ops.session.lineage.recordSelection(sessionId, {
      selectionId: "selection-orphan",
      channelId: "cli",
      lineageNodeId: "lineage:missing",
      reason: "corruption-fixture",
    });

    expect(
      createHostedSession({
        cwd: workspace,
        runtime,
        sessionId,
        deferPersistenceUntilPrompt: true,
      }),
    ).rejects.toThrow("session_lineage_root_missing");
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

  test("records a redacted Harness manifest advisory custom event", () => {
    const workspace = createTestWorkspace("hosted-session-harness-manifest");
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const sessionId = "session-harness-manifest";
    const manifest = buildHarnessManifest({
      sessionId,
      turn: MANAGED_AGENT_SESSION_TEST_ONLY.turnNumberFromTurnId("turn-0"),
      turnId: "turn-0",
      attempt: 1,
      provider: {
        provider: "faux-harness-manifest",
        api: "faux-harness-manifest",
        model: "faux-harness-manifest-model",
        status: "prepared",
      },
    });

    MANAGED_AGENT_SESSION_TEST_ONLY.recordRuntimeHarnessManifest({
      runtime,
      manifest,
      turnId: "turn-0",
    });

    const manifestEvent = runtime.runtime.tape.list(sessionId).find((event) => {
      const payload = event.payload as { kind?: unknown } | undefined;
      return event.type === "custom" && payload?.kind === HARNESS_MANIFEST_RECORDED_EVENT_TYPE;
    });
    const envelope = manifestEvent?.payload as
      | {
          kind?: string;
          authority?: string;
          payload?: Record<string, unknown>;
        }
      | undefined;

    expect(envelope).toMatchObject({
      kind: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
      authority: "advisory",
    });
    expect(envelope?.payload).toMatchObject({
      schema: HARNESS_MANIFEST_SCHEMA,
      eventType: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
      sessionId,
      turn: 0,
      turnId: "turn-0",
      attempt: 1,
      provider: {
        provider: "faux-harness-manifest",
        api: "faux-harness-manifest",
        model: "faux-harness-manifest-model",
        status: "prepared",
      },
    });
  });

  test("scopes Harness provider attempt sequence to a turn id", () => {
    let currentTurnKey: string | undefined;
    let currentSequence = 0;
    const next = (turnId: string) =>
      MANAGED_AGENT_SESSION_TEST_ONLY.nextHarnessProviderAttemptSequence({
        turnId,
        currentTurnKey,
        currentSequence,
        update(value) {
          currentTurnKey = value.turnKey;
          currentSequence = value.sequence;
        },
      });

    expect(next("turn-0")).toBe(1);
    expect(next("turn-0")).toBe(2);
    expect(next("turn-1")).toBe(1);
  });
});
