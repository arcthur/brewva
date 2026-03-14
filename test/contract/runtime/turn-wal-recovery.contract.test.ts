import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { TurnWALRecovery, TurnWALStore, type TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createTestWorkspace } from "../../helpers/workspace.js";

function envelopeFor(input: { turnId: string; sessionId: string; channel: string }): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: input.sessionId,
    turnId: input.turnId,
    channel: input.channel,
    conversationId: input.sessionId,
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: `prompt ${input.turnId}` }],
  };
}

describe("turn wal recovery", () => {
  test("retries gateway/channel handlers and allows handler-owned completion transitions", async () => {
    const workspace = createTestWorkspace("turn-wal-recovery-retry");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "gateway",
    });
    const row = store.appendPending(
      envelopeFor({
        turnId: "turn-gateway-1",
        sessionId: "session-gateway-1",
        channel: "gateway",
      }),
      "gateway",
    );

    const retried: string[] = [];
    const recovery = new TurnWALRecovery({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      handlers: {
        gateway: ({ record, store: targetStore }) => {
          retried.push(record.walId);
          targetStore.markInflight(record.walId);
          targetStore.markDone(record.walId);
        },
      },
    });

    const summary = await recovery.recover();
    expect(summary.scanned).toBe(1);
    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.expired).toBe(0);
    expect(retried).toEqual([row.walId]);
    expect(store.listPending()).toHaveLength(0);
  });

  test("expires stale rows and fails exhausted retries", async () => {
    const workspace = createTestWorkspace("turn-wal-recovery-classify");
    let nowMs = 1_000;
    const config = {
      ...DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      defaultTtlMs: 50,
      maxRetries: 1,
    };
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config,
      scope: "channel-telegram",
      now: () => nowMs,
    });

    const stale = store.appendPending(
      envelopeFor({
        turnId: "turn-stale",
        sessionId: "session-stale",
        channel: "telegram",
      }),
      "channel",
      { ttlMs: 20 },
    );
    const exhausted = store.appendPending(
      envelopeFor({
        turnId: "turn-retry",
        sessionId: "session-retry",
        channel: "telegram",
      }),
      "channel",
      { ttlMs: 5_000 },
    );
    store.markInflight(exhausted.walId);

    nowMs += 200;
    const recovery = new TurnWALRecovery({
      workspaceRoot: workspace,
      config,
      now: () => nowMs,
    });
    const summary = await recovery.recover();

    expect(summary.scanned).toBe(2);
    expect(summary.expired).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    expect(summary.skipped).toBe(0);
    const current = store.listCurrent();
    const staleStatus = current.find((row) => row.walId === stale.walId)?.status;
    const exhaustedStatus = current.find((row) => row.walId === exhausted.walId)?.status;
    expect(staleStatus).toBe("expired");
    expect(exhaustedStatus).toBe("failed");
  });

  test("repeated recover is idempotent once a handler-owned retry has already completed", async () => {
    const workspace = createTestWorkspace("turn-wal-recovery-idempotent");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "gateway",
    });
    const row = store.appendPending(
      envelopeFor({
        turnId: "turn-gateway-idempotent",
        sessionId: "session-gateway-idempotent",
        channel: "gateway",
      }),
      "gateway",
    );

    const retried: string[] = [];
    const recovery = new TurnWALRecovery({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      handlers: {
        gateway: ({ record, store: targetStore }) => {
          retried.push(record.walId);
          targetStore.markInflight(record.walId);
          targetStore.markDone(record.walId);
        },
      },
    });

    const first = await recovery.recover();
    const second = await recovery.recover();

    expect(first.scanned).toBe(1);
    expect(first.retried).toBe(1);
    expect(second.scanned).toBe(0);
    expect(second.retried).toBe(0);
    expect(second.failed).toBe(0);
    expect(retried).toEqual([row.walId]);
    expect(store.listPending()).toHaveLength(0);
  });

  test("handler exceptions mark rows failed once and later recover calls do not retry them again", async () => {
    const workspace = createTestWorkspace("turn-wal-recovery-handler-error");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "gateway",
    });
    const row = store.appendPending(
      envelopeFor({
        turnId: "turn-gateway-handler-error",
        sessionId: "session-gateway-handler-error",
        channel: "gateway",
      }),
      "gateway",
    );

    let attempts = 0;
    const recovery = new TurnWALRecovery({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      handlers: {
        gateway: () => {
          attempts += 1;
          throw new Error("gateway_resume_failed");
        },
      },
    });

    const first = await recovery.recover();
    const second = await recovery.recover();

    expect(first.scanned).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.retried).toBe(0);
    expect(second.scanned).toBe(0);
    expect(second.failed).toBe(0);
    expect(attempts).toBe(1);
    const current = store.listCurrent();
    expect(current.find((entry) => entry.walId === row.walId)).toEqual(
      expect.objectContaining({
        walId: row.walId,
        status: "failed",
        error: "recovery_retry_failed:gateway_resume_failed",
      }),
    );
  });
});
