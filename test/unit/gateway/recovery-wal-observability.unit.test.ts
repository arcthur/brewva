import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { isSessionIndexTextIndexedEventType } from "@brewva/brewva-session-index/evidence";
import {
  RECOVERY_WAL_APPENDED_EVENT_TYPE,
  RECOVERY_WAL_COMPACTED_EVENT_TYPE,
  RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
  RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { recordChannelRecoveryWalEvent } from "../../../packages/brewva-gateway/src/channels/recovery-events.js";
import {
  createRecoveryWalRecovery,
  createRecoveryWalStore,
} from "../../../packages/brewva-gateway/src/daemon/recovery.js";
import { createTestWorkspace } from "../../helpers/workspace.js";
import { createRuntimeFixture } from "./hosted-behavior/fixtures/runtime.js";

function createEnvelope(turnId: string, sessionId = "wal-obs-1"): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId,
    turnId,
    channel: "telegram",
    conversationId: "conversation-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: `prompt ${turnId}` }],
  };
}

describe("Recovery WAL observability seam", () => {
  test("store transitions reach the tape as the vocabulary recovery.wal.* types (producer seam)", async () => {
    const runtime = createRuntimeFixture();
    const workspace = createTestWorkspace("recovery-wal-observability");
    // Drive the store off an injected clock so compaction is deterministic. With
    // `compactAfterMs: 0` a real clock can land markDone and compact in the SAME
    // millisecond, leaving `at - updatedAt === 0`, which the `> compactAfterMs`
    // gate does not remove — CI is fast enough to hit this while a slower local
    // run is not, which is exactly the observed flake.
    let clock = 1_700_000_000_000;
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: { ...DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal, compactAfterMs: 0 },
      scope: "runtime",
      now: () => clock,
      // The exact wiring the channel host uses: store lifecycle -> bridge ->
      // channel recovery verbs. This chain was declared but never invoked
      // before the contract-liveness audit.
      recordEvent: (event) => {
        recordChannelRecoveryWalEvent(runtime, event);
      },
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markDone(pending.walId);
    clock += 1; // advance past the done timestamp so compaction sees a positive age
    store.compact();

    const appended = runtime.ops.events.records.query("wal-obs-1", {
      type: RECOVERY_WAL_APPENDED_EVENT_TYPE,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toMatchObject({
      walId: pending.walId,
      scope: "runtime",
      source: "channel",
      status: "pending",
    });

    const statusChanged = runtime.ops.events.records.query("wal-obs-1", {
      type: RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE,
    });
    expect(statusChanged.map((event) => (event.payload as { status?: string }).status)).toEqual([
      "done",
    ]);

    // Compaction is store-wide, not session-scoped; it lands on the default
    // session like other out-of-session receipts.
    const compacted = runtime.ops.events.records.query("default", {
      type: RECOVERY_WAL_COMPACTED_EVENT_TYPE,
    });
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.payload).toMatchObject({ scope: "runtime", removed: 1 });

    const recovery = createRecoveryWalRecovery({
      store,
      recordEvent: (event) => {
        recordChannelRecoveryWalEvent(runtime, event);
      },
    });
    await recovery.recover();
    const completed = runtime.ops.events.records.query("default", {
      type: RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ scanned: 0 });

    // Consumer side of the contract: the appended receipt is one of the types
    // session-index ingests for full-text search.
    expect(isSessionIndexTextIndexedEventType(RECOVERY_WAL_APPENDED_EVENT_TYPE)).toBe(true);
  });
});
