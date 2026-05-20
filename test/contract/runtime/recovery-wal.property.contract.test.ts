import { describe, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRecoveryWalRecovery, createRecoveryWalStore } from "@brewva/brewva-gateway/daemon";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/protocol";
import type { RecoveryWalRecord, RecoveryWalSource } from "@brewva/brewva-runtime/protocol";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

type WalTransition = "none" | "inflight" | "done" | "failed" | "expired";

interface WalAppendCase {
  source: RecoveryWalSource;
  turnId: string;
  sessionId: string;
  channel: string;
  transition: WalTransition;
}

const sourceArbitrary = fc.constantFrom<RecoveryWalSource>(
  "channel",
  "schedule",
  "gateway",
  "heartbeat",
  "tool",
);
const safeIdArbitrary = fc
  .tuple(
    fc.constantFrom("a", "b", "c", "d", "e"),
    fc.array(fc.constantFrom("a", "b", "c", "d", "e", "0", "1", "2", "_", "-"), {
      maxLength: 14,
    }),
  )
  .map(([head, tail]) => `${head}${tail.join("")}`);
const appendCaseArbitrary: fc.Arbitrary<WalAppendCase> = fc.record({
  source: sourceArbitrary,
  turnId: safeIdArbitrary.map((value) => `turn-${value}`),
  sessionId: safeIdArbitrary.map((value) => `session-${value}`),
  channel: fc.constantFrom("telegram", "gateway", "tool_lifecycle"),
  transition: fc.constantFrom("none", "inflight", "done", "failed", "expired"),
});

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

function normalizeRows(rows: readonly RecoveryWalRecord[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    walId: row.walId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    channel: row.channel,
    conversationId: row.conversationId,
    status: row.status,
    attempts: row.attempts,
    source: row.source,
    error: row.error ?? null,
    ttlMs: row.ttlMs ?? null,
    dedupeKey: row.dedupeKey ?? null,
    envelope: row.envelope,
  }));
}

function recoveryWalFilePath(workspace: string, scope: string): string {
  return resolve(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal.dir, `${scope}.jsonl`);
}

describe("recovery WAL properties", () => {
  propertyTest("WAL append and status transitions survive store reload", {
    propertyId: "runtime.recovery-wal.reload-preserves-current-view",
    layer: "contract",
    timeoutMs: 1_000,
    arbitraries: [fc.array(appendCaseArbitrary, { minLength: 1, maxLength: 8 })],
    predicate: (cases) => {
      const workspace = createTestWorkspace("recovery-wal-property-reload");
      let nowMs = 1_700_000_000_000;
      const store = createRecoveryWalStore({
        workspaceRoot: workspace,
        config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
        scope: "property",
        now: () => nowMs,
      });

      try {
        for (const input of cases) {
          nowMs += 1;
          const row = store.appendPending(
            envelopeFor({
              turnId: input.turnId,
              sessionId: input.sessionId,
              channel: input.channel,
            }),
            input.source,
          );
          nowMs += 1;
          if (input.transition === "inflight") store.markInflight(row.walId);
          if (input.transition === "done") store.markDone(row.walId);
          if (input.transition === "failed") store.markFailed(row.walId, "generated_failure");
          if (input.transition === "expired") store.markExpired(row.walId);
        }

        const reloaded = createRecoveryWalStore({
          workspaceRoot: workspace,
          config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
          scope: "property",
          now: () => nowMs,
        });

        expect(normalizeRows(reloaded.listCurrent())).toEqual(normalizeRows(store.listCurrent()));
        expect(
          reloaded
            .listPending()
            .every((row) => row.status === "pending" || row.status === "inflight"),
        ).toBe(true);
      } finally {
        cleanupWorkspace(workspace);
      }
    },
  });

  propertyTest("WAL dedupe key returns existing recoverable row before expiry", {
    propertyId: "runtime.recovery-wal.dedupe-key-reuses-recoverable-row",
    layer: "contract",
    timeoutMs: 1_000,
    arbitraries: [safeIdArbitrary, sourceArbitrary],
    predicate: (dedupeKey, source) => {
      const workspace = createTestWorkspace("recovery-wal-property-dedupe");
      const store = createRecoveryWalStore({
        workspaceRoot: workspace,
        config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
        scope: "property-dedupe",
        now: () => 1_700_000_000_000,
      });

      try {
        const first = store.appendPending(
          envelopeFor({
            turnId: "turn-dedupe-1",
            sessionId: "session-dedupe",
            channel: "telegram",
          }),
          source,
          { dedupeKey },
        );
        const second = store.appendPending(
          envelopeFor({
            turnId: "turn-dedupe-2",
            sessionId: "session-dedupe",
            channel: "telegram",
          }),
          source,
          { dedupeKey },
        );

        expect(second.walId).toBe(first.walId);
        expect(store.listCurrent()).toHaveLength(1);
      } finally {
        cleanupWorkspace(workspace);
      }
    },
  });

  propertyTest("WAL recovery is idempotent after handler-owned completion", {
    propertyId: "runtime.recovery-wal.recover-idempotent-after-handler-completion",
    layer: "contract",
    timeoutMs: 1_000,
    arbitraries: [fc.array(safeIdArbitrary, { minLength: 1, maxLength: 5 })],
    predicate: async (turnIds) => {
      const workspace = createTestWorkspace("recovery-wal-property-recovery");
      const store = createRecoveryWalStore({
        workspaceRoot: workspace,
        config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
        scope: "gateway",
      });
      try {
        for (const turnId of turnIds) {
          store.appendPending(
            envelopeFor({
              turnId,
              sessionId: `session-${turnId}`,
              channel: "gateway",
            }),
            "gateway",
          );
        }

        const retried: string[] = [];
        const recovery = createRecoveryWalRecovery({
          workspaceRoot: workspace,
          config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
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

        expect(first.scanned).toBe(turnIds.length);
        expect(first.retried).toBe(turnIds.length);
        expect(second.scanned).toBe(0);
        expect(second.retried).toBe(0);
        expect(retried).toHaveLength(turnIds.length);
        expect(store.listPending()).toEqual([]);
      } finally {
        cleanupWorkspace(workspace);
      }
    },
  });

  propertyTest("WAL malformed complete rows surface integrity errors", {
    propertyId: "runtime.recovery-wal.malformed-row-integrity-error",
    layer: "contract",
    timeoutMs: 1_000,
    arbitraries: [fc.string({ minLength: 1, maxLength: 40 })],
    predicate: (badLine) => {
      const workspace = createTestWorkspace("recovery-wal-property-corrupt");
      const store = createRecoveryWalStore({
        workspaceRoot: workspace,
        config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
        scope: "corrupt",
      });
      try {
        store.appendPending(
          envelopeFor({
            turnId: "turn-corrupt",
            sessionId: "session-corrupt",
            channel: "telegram",
          }),
          "channel",
        );

        appendFileSync(
          recoveryWalFilePath(workspace, "corrupt"),
          `\n${JSON.stringify({ schema: "bad" })}\n${badLine.trim() || "not-json"}\n`,
          "utf8",
        );

        const reloaded = createRecoveryWalStore({
          workspaceRoot: workspace,
          config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
          scope: "corrupt",
        });

        expect(() => reloaded.listPending()).toThrow("recovery_wal_integrity_error");
      } finally {
        cleanupWorkspace(workspace);
      }
    },
  });
});
