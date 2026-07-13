import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveTapeFilePath } from "@brewva/brewva-runtime";
import { createWorkspaceWorldStore } from "@brewva/brewva-tools/world-store";
import { resolveHarnessCandidateLedgerPath } from "../../../packages/brewva-gateway/src/harness/internal/candidate-ledger.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

setDefaultTimeout(60_000);

// Recovery status honesty: the hosted hydration/integrity surfaces are
// evidence-derived projections (RFC WS1), never the optimistic `ready`/`healthy`
// stubs that overstated evidence on `main`. An empty session is `cold`, not
// `ready`. Integrity now folds EVERY durability dimension — event tape, recovery
// WAL, candidate ledger, and world artifacts — so a clean session is honestly
// `healthy`, a damaged tape or a corrupt WAL/ledger degrades with a
// domain-attributed issue, and `inconclusive` is reserved for the genuinely
// unknown (no durable tape substrate to verify at all).
describe("hosted recovery status honesty (RFC WS1)", () => {
  function freshAdapter() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-ws1-")) });
  }

  function validRecord(
    adapterSessionId: string,
    id: string,
    type = "turn.started",
    payload: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      id,
      sessionId: adapterSessionId,
      type,
      timestamp: 1,
      payload,
    });
  }

  function writeTape(
    adapter: ReturnType<typeof createHostedRuntimeAdapter>,
    sessionId: string,
    contents: string,
  ): void {
    const path = resolveTapeFilePath(
      adapter.identity.workspaceRoot,
      adapter.config.tape.dir,
      sessionId,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  function recordWorldCheckpoint(
    adapter: ReturnType<typeof createHostedRuntimeAdapter>,
    sessionId: string,
  ): { store: ReturnType<typeof createWorkspaceWorldStore>; worldId: string } {
    writeFileSync(
      join(adapter.identity.workspaceRoot, "artifact.txt"),
      "artifact contents\n",
      "utf8",
    );
    adapter.ops.session.rewind.recordCheckpoint(sessionId, { leafEntryId: "artifact-leaf" });
    const checkpoint = adapter.ops.session.rewind.listTargets(sessionId).at(-1);
    if (checkpoint?.world.status !== "captured") {
      throw new Error("expected captured world checkpoint");
    }
    return {
      store: createWorkspaceWorldStore({
        workspaceRoot: adapter.identity.workspaceRoot,
        dir: adapter.config.worlds.dir,
        retainPerSession: adapter.config.worlds.retainPerSession,
      }),
      worldId: checkpoint.world.worldId,
    };
  }

  test("an empty session hydrates cold (evidence-bearing), never optimistic ready", () => {
    const hydration = freshAdapter().ops.session.lifecycle.getHydration("empty-session");

    expect(hydration.status).toBe("cold");
    if (hydration.status === "unavailable") throw new Error("expected an evidence-bearing status");
    expect(hydration.cursor.eventCount).toBe(0);
    expect(hydration.cursor.latestEventId).toBeNull();
    expect(hydration.reason).toBeNull();
    expect(hydration.issues).toEqual([]);
  });

  test("integrity of a clean session is healthy once every durability dimension verifies", () => {
    // Tape clean (empty), no WAL rows, no candidate ledger, no world artifacts:
    // every dimension is verified clean, so the aggregate is honestly healthy —
    // the RFC WS1 caveat ("must not claim full health") is retired now that the
    // checks it deferred to actually run.
    const integrity = freshAdapter().ops.session.lifecycle.getIntegrity("empty-session");

    expect(integrity.status).toBe("healthy");
    if (integrity.status !== "healthy") throw new Error("expected healthy");
    expect(integrity.cursor).toEqual({ latestEventId: null, eventCount: 0 });
    expect(integrity.reason).toBeNull();
    expect(integrity.issues).toEqual([]);
  });

  test("a quarantined recovery-WAL row degrades integrity with a wal-domain issue", () => {
    const adapter = freshAdapter();
    // Write a malformed row into the workspace runtime WAL the integrity probe
    // reads (the same file `brewva inspect` reads). A complete-but-unparseable
    // interior line is a quarantined row, not a recoverable torn tail.
    const walPath = resolve(
      adapter.identity.workspaceRoot,
      adapter.config.infrastructure.recoveryWal.dir,
      "runtime.jsonl",
    );
    mkdirSync(dirname(walPath), { recursive: true });
    writeFileSync(walPath, "this is not a valid wal row\n", "utf8");

    const integrity = adapter.ops.session.lifecycle.getIntegrity("any-session");
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues.some((issue) => issue.domain === "wal")).toBe(true);
  });

  test("integrity reads a session's bootstrap-pinned recovery WAL directory", () => {
    const adapter = freshAdapter();
    const sessionId = "legacy-wal-session";
    const legacyWalDir = ".orchestrator/legacy-recovery-wal";
    adapter.ops.session.lifecycle.bootstrap({
      sessionId,
      payload: { runtimeConfig: { artifactRoots: { recoveryWalDir: legacyWalDir } } },
    });
    const walPath = resolve(adapter.identity.workspaceRoot, legacyWalDir, "runtime.jsonl");
    mkdirSync(dirname(walPath), { recursive: true });
    writeFileSync(walPath, "this is not a valid wal row\n", "utf8");

    const integrity = adapter.ops.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues.some((issue) => issue.domain === "wal")).toBe(true);
  });

  test("a corrupt candidate-ledger line degrades integrity with a ledger-domain issue", () => {
    const adapter = freshAdapter();
    const ledgerPath = resolveHarnessCandidateLedgerPath(adapter.identity.workspaceRoot);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    // A corrupt interior line (followed by a valid one, so it is not a torn tail).
    writeFileSync(ledgerPath, `{"schema":"x"}\n{ broken json\n{"schema":"y"}\n`, "utf8");

    const integrity = adapter.ops.session.lifecycle.getIntegrity("any-session");
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues.some((issue) => issue.domain === "ledger")).toBe(true);
  });

  test("a tape-referenced world missing after its refs sidecar is lost degrades integrity", () => {
    const adapter = freshAdapter();
    const sessionId = "artifact-refs-missing";
    const { store } = recordWorldCheckpoint(adapter, sessionId);

    rmSync(join(store.rootDir, "refs"), { recursive: true, force: true });
    rmSync(join(store.rootDir, "objects"), { recursive: true, force: true });

    const integrity = adapter.ops.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues.some((issue) => issue.domain === "artifact")).toBe(true);
  });

  test("a content-corrupted referenced world blob degrades integrity", () => {
    const adapter = freshAdapter();
    const sessionId = "artifact-blob-corrupt";
    const { store, worldId } = recordWorldCheckpoint(adapter, sessionId);
    const blob = store.readManifest(worldId)?.files[0]?.blob;
    if (!blob) throw new Error("expected captured world blob");
    const blobHex = blob.slice("sha256:".length);
    writeFileSync(join(store.rootDir, "objects", blobHex.slice(0, 2), blobHex), "tampered", "utf8");

    const integrity = adapter.ops.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues.some((issue) => issue.domain === "artifact")).toBe(true);
  });

  test("a valid tape hydrates ready with a cursor bound to the last event", () => {
    const adapter = freshAdapter();
    const sessionId = "valid-session";
    writeTape(
      adapter,
      sessionId,
      `${validRecord(sessionId, "e1")}\n${validRecord(sessionId, "e2")}\n`,
    );

    const hydration = adapter.ops.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("ready");
    if (hydration.status === "unavailable") throw new Error("expected ready");
    expect(hydration.cursor.eventCount).toBe(2);
    expect(hydration.cursor.latestEventId).toBe("e2");
  });

  test("a damaged tape degrades with explicit event_tape issues, not empty-but-healthy", () => {
    const adapter = freshAdapter();
    const sessionId = "damaged-session";
    // A valid record followed by a malformed one: the strict reader would throw,
    // but the forensic-derived projection localizes the damage instead.
    writeTape(adapter, sessionId, `${validRecord(sessionId, "e1")}\n{ not json\n`);

    const hydration = adapter.ops.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    if (hydration.status === "unavailable") throw new Error("expected degraded");
    expect(hydration.cursor.eventCount).toBe(1);
    expect(hydration.cursor.latestEventId).toBe("e1");
    expect(hydration.issues).toHaveLength(1);
    expect(hydration.issues[0]?.domain).toBe("event_tape");

    const integrity = adapter.ops.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues[0]?.domain).toBe("event_tape");
  });

  test("rewind/redo report capability-specific unavailability on an empty session", () => {
    const ops = freshAdapter().ops.session.rewind;
    const rewind = ops.rewind("any-session", { mode: "both", summary: "carry" });
    expect(rewind.ok).toBe(false);
    if (rewind.ok) throw new Error("expected rewind to fail");
    expect(rewind.reason).toBe("no_checkpoint");

    const redo = ops.redo("any-session");
    expect(redo.ok).toBe(false);
    if (redo.ok) throw new Error("expected redo to fail");
    expect(redo.reason).toBe("no_redo");
  });
});
