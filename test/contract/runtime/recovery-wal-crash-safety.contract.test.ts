import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRecoveryWalStore } from "@brewva/brewva-gateway/daemon";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import * as durableFs from "@brewva/brewva-std/node/fs";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { createTestWorkspace } from "../../helpers/workspace.js";

const config = DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal;

function createEnvelope(id: string, meta?: Record<string, unknown>): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: id,
    channel: "telegram",
    conversationId: "conversation-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: `prompt ${id}` }],
    ...(meta ? { meta } : {}),
  };
}

function walPath(workspace: string, scope: string): string {
  return resolve(workspace, config.dir, `${scope}.jsonl`);
}

describe("Recovery WAL crash-safety", () => {
  test("a torn trailing line is dropped on reload and the store stays healthy", () => {
    const workspace = createTestWorkspace("recovery-wal-torn-tail");
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config,
      scope: "channel-telegram",
    });
    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    // A half-written final line with no trailing newline: the canonical crash artifact.
    appendFileSync(
      walPath(workspace, "channel-telegram"),
      '{"schema":"brewva.recovery-wal.v1","walId":"wal-torn"',
    );

    const reloaded = createRecoveryWalStore({
      workspaceRoot: workspace,
      config,
      scope: "channel-telegram",
    });
    expect(reloaded.listPending().map((row) => row.walId)).toEqual([pending.walId]);
  });

  test("compaction reuses the atomic rewrite path: a stale .tmp does not survive", () => {
    const workspace = createTestWorkspace("recovery-wal-compact-atomic");
    let nowMs = 10_000;
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: { ...config, compactAfterMs: 100 },
      scope: "gateway",
      now: () => nowMs,
    });
    const row = store.appendPending(createEnvelope("turn-1", { ingressSequence: 7 }), "gateway");
    store.markDone(row.walId);

    const path = walPath(workspace, "gateway");
    writeFileSync(`${path}.tmp`, "stale-junk-from-a-prior-crashed-compaction");
    nowMs += 500;
    store.compact();

    expect(existsSync(`${path}.tmp`)).toBe(false);
    const reloaded = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    expect(reloaded.getIngressHighWatermark({ source: "gateway", channel: "telegram" })).toBe(7);
  });

  test("a malformed row is quarantined and surfaced; healthy rows keep recovering", () => {
    const workspace = createTestWorkspace("recovery-wal-quarantine");
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config,
      scope: "channel-telegram",
    });
    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    appendFileSync(walPath(workspace, "channel-telegram"), 'not-json\n{"schema":"unknown"}\n');

    const reloaded = createRecoveryWalStore({
      workspaceRoot: workspace,
      config,
      scope: "channel-telegram",
    });
    // The durable-transient log isolates the bad rows and keeps serving, no throw.
    expect(reloaded.listPending().map((row) => row.walId)).toEqual([pending.walId]);
    // Both bad lines are surfaced (quarantined), never silently dropped.
    expect(reloaded.getIntegrityIssues()).toHaveLength(2);
  });

  test("the store keeps accepting appends while a row is quarantined", () => {
    const workspace = createTestWorkspace("recovery-wal-quarantine-append");
    const store = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    store.appendPending(createEnvelope("turn-1"), "gateway");
    appendFileSync(walPath(workspace, "gateway"), "corrupt-line\n");

    const reloaded = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    reloaded.appendPending(createEnvelope("turn-2"), "gateway"); // must not throw
    expect(reloaded.listPending().map((row) => row.envelope.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(reloaded.getIntegrityIssues()).toHaveLength(1);
  });

  test("quarantined lines survive compaction instead of being silently dropped", () => {
    const workspace = createTestWorkspace("recovery-wal-quarantine-compact");
    let nowMs = 10_000;
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: { ...config, compactAfterMs: 100 },
      scope: "gateway",
      now: () => nowMs,
    });
    const row = store.appendPending(createEnvelope("turn-1"), "gateway");
    store.markDone(row.walId);
    appendFileSync(walPath(workspace, "gateway"), "corrupt-forensic-line\n");

    nowMs += 500;
    const reloaded = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: { ...config, compactAfterMs: 100 },
      scope: "gateway",
      now: () => nowMs,
    });
    reloaded.compact(); // drops the stale terminal row, must preserve the quarantined line

    const afterCompact = createRecoveryWalStore({
      workspaceRoot: workspace,
      config,
      scope: "gateway",
    });
    expect(afterCompact.getIntegrityIssues()).toHaveLength(1);
  });

  test("a corrupt watermark line with no surviving row cold-starts (no offset) and is surfaced", () => {
    const workspace = createTestWorkspace("recovery-wal-watermark-corrupt");
    const path = walPath(workspace, "gateway");
    mkdirSync(dirname(path), { recursive: true });
    // A corrupt watermark snapshot and no rows: nothing carries an ingressSequence,
    // so the watermark genuinely cold-starts (undefined) and upstream re-derives it.
    writeFileSync(
      path,
      '{"schema":"brewva.recovery-wal.watermark.v1","ingressWatermark":"corrupt"}\n',
    );

    const store = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    expect(store.getIngressHighWatermark({ source: "gateway", channel: "telegram" })).toBe(
      undefined,
    );
    expect(store.getIntegrityIssues()).toHaveLength(1);
  });

  test("a corrupt watermark line with a surviving row rebuilds from the row (row-derived), not a blanket cold start", () => {
    const workspace = createTestWorkspace("recovery-wal-watermark-row-derived");
    const path = walPath(workspace, "gateway");
    const store = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    // A healthy row carrying ingressSequence 9, then a corrupt watermark snapshot line.
    store.appendPending(createEnvelope("turn-1", { ingressSequence: 9 }), "gateway");
    appendFileSync(
      path,
      '{"schema":"brewva.recovery-wal.watermark.v1","ingressWatermark":"corrupt"}\n',
    );

    const reloaded = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    // The damaged snapshot is quarantined (its value is never trusted), but the
    // high-watermark is rebuilt from the surviving row's ingressSequence: a precise
    // lower bound that never skips upstream work — at worst the compacted-away done
    // range re-delivers, which at_least_once already tolerates. A blanket cold start
    // would re-derive a weaker offset and repeat strictly more.
    expect(reloaded.getIngressHighWatermark({ source: "gateway", channel: "telegram" })).toBe(9);
    expect(reloaded.getIntegrityIssues()).toHaveLength(1);
  });

  test("a failed durable append leaves no in-memory ghost: a dedupe retry re-persists", () => {
    const workspace = createTestWorkspace("recovery-wal-append-fault");
    const store = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    // Seed one durable row so the WAL file already exists: resetIfWalFileWasRemoved
    // (which clears in-memory state when the file is gone) must not be what masks the
    // ghost — only the commit-point ordering should.
    store.appendPending(createEnvelope("seed"), "gateway");

    // The next durable append fails the way ENOSPC/EIO would — file present, write
    // rejected — so the row never reaches disk.
    const spy = spyOn(durableFs, "appendFileDurable").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    try {
      expect(() =>
        store.appendPending(createEnvelope("turn-1"), "gateway", { dedupeKey: "k" }),
      ).toThrow(/ENOSPC/u);
    } finally {
      spy.mockRestore();
    }

    // Retry with the SAME dedupe key. The commit point is the durable append, so the
    // failed attempt must have left no in-memory row to dedupe-hit: the retry has to
    // persist a fresh row, never return a ghost that never reached disk.
    const row = store.appendPending(createEnvelope("turn-2"), "gateway", { dedupeKey: "k" });

    const reloaded = createRecoveryWalStore({ workspaceRoot: workspace, config, scope: "gateway" });
    const persisted = reloaded.listCurrent().map((entry) => entry.walId);
    expect(persisted).toContain(row.walId);
    // seed + the retried row, and crucially no unpersisted ghost.
    expect(persisted).toHaveLength(2);
  });
});
