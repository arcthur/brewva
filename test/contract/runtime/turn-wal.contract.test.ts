import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { TurnWALStore, type TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createEnvelope(id: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: id,
    channel: "telegram",
    conversationId: "conversation-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: `prompt ${id}` }],
  };
}

describe("turn wal store", () => {
  test("given a new envelope, when appendPending is called, then pending record is created and listed", () => {
    const workspace = createTestWorkspace("turn-wal-status");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "runtime",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    expect(pending.status).toBe("pending");
    expect(pending.attempts).toBe(0);
    expect(store.listPending().map((row) => row.walId)).toEqual([pending.walId]);
  });

  test("given a pending record, when markInflight is called, then status becomes inflight with incremented attempts", () => {
    const workspace = createTestWorkspace("turn-wal-status-inflight");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "runtime",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    const inflight = store.markInflight(pending.walId);
    expect(inflight?.status).toBe("inflight");
    expect(inflight?.attempts).toBe(1);
    expect(store.listPending().map((row) => row.status)).toEqual(["inflight"]);
  });

  test("given an inflight record, when markDone is called, then record becomes done and leaves pending view", () => {
    const workspace = createTestWorkspace("turn-wal-status-done");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "runtime",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    const done = store.markDone(pending.walId);
    expect(done?.status).toBe("done");
    expect(store.listPending()).toHaveLength(0);
  });

  test("given lifecycle transitions, when records are appended and updated, then wal file persists each transition", () => {
    const workspace = createTestWorkspace("turn-wal-status-persist");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "runtime",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    store.markDone(pending.walId);

    const lines = readFileSync(store.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBe(3);
  });

  test("given unknown wal id, when markDone is called, then result is undefined", () => {
    const workspace = createTestWorkspace("turn-wal-unknown-id");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    expect(store.markDone("missing-wal-id")).toBeUndefined();
  });

  test("given a done record, when markInflight is called again, then transition is ignored", () => {
    const workspace = createTestWorkspace("turn-wal-terminal-transition");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const pending = store.appendPending(createEnvelope("turn-1"), "channel");
    store.markInflight(pending.walId);
    store.markDone(pending.walId);

    const transitioned = store.markInflight(pending.walId);
    expect(transitioned).toBeUndefined();
    expect(store.listCurrent().map((row) => row.status)).toEqual(["done"]);
  });

  test("given malformed wal lines, when store reloads, then integrity failure is surfaced", () => {
    const workspace = createTestWorkspace("turn-wal-corrupt-lines");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });
    store.appendPending(createEnvelope("turn-corrupt"), "channel");
    appendFileSync(store.filePath, '\n{"schema":"bad"}\nnot-json\n', "utf8");

    const reloaded = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });
    expect(() => reloaded.listPending()).toThrow("turn_wal_integrity_error");
  });

  test("given terminal records beyond retention window, when compact runs, then stale records are dropped", () => {
    const workspace = createTestWorkspace("turn-wal-compact");
    let nowMs = 10_000;
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
        compactAfterMs: 100,
      },
      scope: "gateway",
      now: () => nowMs,
    });

    const row = store.appendPending(createEnvelope("turn-compact"), "gateway");
    store.markInflight(row.walId);
    store.markDone(row.walId);

    nowMs += 500;
    const compacted = store.compact();
    expect(compacted.scanned).toBe(1);
    expect(compacted.dropped).toBe(1);
    expect(store.listCurrent()).toHaveLength(0);
  });

  test("given burst appends, when appendPending is called concurrently, then wal ids stay unique and rows remain ordered", async () => {
    const workspace = createTestWorkspace("turn-wal-burst");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "burst",
    });

    const rows = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        Promise.resolve().then(() =>
          store.appendPending(createEnvelope(`turn-${index}`), "channel"),
        ),
      ),
    );
    const walIds = rows.map((row) => row.walId);
    expect(new Set(walIds).size).toBe(rows.length);
    expect(store.listPending()).toHaveLength(40);
  });

  test("given a dedupe key, when appendPending is called multiple times, then existing recoverable record is reused", () => {
    const workspace = createTestWorkspace("turn-wal-dedupe");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "channel-telegram",
    });

    const envelope = createEnvelope("turn-dedupe");
    const first = store.appendPending(envelope, "channel", { dedupeKey: "dedupe-1" });
    const second = store.appendPending(envelope, "channel", { dedupeKey: "dedupe-1" });

    expect(second.walId).toBe(first.walId);
    expect(store.listPending()).toHaveLength(1);
    const lines = readFileSync(store.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBe(1);
  });

  test("given a terminal record, when appendPending is called with the same dedupe key, then a new wal record is created", () => {
    const workspace = createTestWorkspace("turn-wal-dedupe-terminal");
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "gateway",
    });

    const envelope = createEnvelope("turn-dedupe-terminal");
    const first = store.appendPending(envelope, "gateway", { dedupeKey: "dedupe-2" });
    store.markDone(first.walId);

    const second = store.appendPending(envelope, "gateway", { dedupeKey: "dedupe-2" });
    expect(second.walId).not.toBe(first.walId);
    expect(store.listPending()).toHaveLength(1);
    expect(store.listCurrent().map((row) => row.walId)).toEqual([first.walId, second.walId]);
  });

  test("given an expired recoverable record, when appendPending is called with the same dedupe key, then prior record is expired and a new record is created", () => {
    const workspace = createTestWorkspace("turn-wal-dedupe-expired");
    let nowMs = 10_000;
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
        defaultTtlMs: 25,
      },
      scope: "channel-telegram",
      now: () => nowMs,
    });

    const envelope = createEnvelope("turn-dedupe-expired");
    const first = store.appendPending(envelope, "channel", { dedupeKey: "dedupe-3" });

    nowMs += 100;
    const second = store.appendPending(envelope, "channel", { dedupeKey: "dedupe-3" });
    expect(second.walId).not.toBe(first.walId);
    const current = store.listCurrent();
    const firstStatus = current.find((row) => row.walId === first.walId)?.status;
    expect(firstStatus).toBe("expired");
    expect(store.listPending().map((row) => row.walId)).toEqual([second.walId]);
  });

  test("runtime turnWal facade marks failed and expired rows directly", () => {
    const workspace = createTestWorkspace("turn-wal-runtime-facade");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const failedRecord = runtime.turnWal.appendPending(
      createEnvelope("turn-runtime-failed"),
      "channel",
    );
    const expiredRecord = runtime.turnWal.appendPending(
      createEnvelope("turn-runtime-expired"),
      "channel",
    );

    const failed = runtime.turnWal.markFailed(failedRecord.walId, "worker_crash");
    const expired = runtime.turnWal.markExpired(expiredRecord.walId);

    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("worker_crash");
    expect(expired?.status).toBe("expired");
    expect(runtime.turnWal.listPending()).toHaveLength(0);
    const store = new TurnWALStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.turnWal,
      scope: "runtime",
    });
    expect(store.listCurrent()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          walId: failedRecord.walId,
          status: "failed",
          error: "worker_crash",
        }),
        expect.objectContaining({
          walId: expiredRecord.walId,
          status: "expired",
        }),
      ]),
    );
  });
});
