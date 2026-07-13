import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TapeForensicScan } from "@brewva/brewva-runtime";
import type { RuntimeSessionIssue } from "@brewva/brewva-tools/contracts";
import { createWorkspaceWorldStore } from "@brewva/brewva-tools/world-store";
import { HARNESS_CANDIDATE_LIFECYCLE_SCHEMA } from "@brewva/brewva-vocabulary/harness";
import {
  resolveHarnessCandidateLedgerPath,
  verifyHarnessCandidateLedgerIntegrity,
} from "../../../packages/brewva-gateway/src/harness/internal/candidate-ledger.js";
import { artifactIntegrityIssues } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/durability-integrity.js";
import {
  type DurabilityProbes,
  projectIntegrity,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/runtime-ops-projections.js";

// The artifact suite does real world capture (filesystem enumeration + hashing),
// which can exceed the bare `bun test` 5s default on a cold run.
setDefaultTimeout(60_000);

// The candidate ledger is an append-only JSONL sidecar. "Chain verification"
// degrades on genuine byte-level corruption (an interior line that does not
// parse) while tolerating the two states the on-disk reader already tolerates:
// a crash-torn tail (self-healed on the owner's next append) and a well-formed
// but unknown-schema line (a newer writer / forward-compat record).
describe("verifyHarnessCandidateLedgerIntegrity (RFC WS1 ledger dimension)", () => {
  function freshWorkspace(): string {
    return mkdtempSync(join(tmpdir(), "brewva-ledger-integrity-"));
  }

  function writeLedger(root: string, contents: string): void {
    const path = resolveHarnessCandidateLedgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  const validRow = (candidateId: string): string =>
    JSON.stringify({
      schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
      candidateId,
      action: "accepted",
      at: "2026-07-12T00:00:00.000Z",
      actor: "cli_invocation",
      reason: "ok",
    });

  test("an absent ledger is clean (nothing to corrupt)", () => {
    const result = verifyHarnessCandidateLedgerIntegrity(freshWorkspace());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("a well-formed ledger is clean", () => {
    const root = freshWorkspace();
    writeLedger(root, `${validRow("cand-a")}\n${validRow("cand-b")}\n`);
    const result = verifyHarnessCandidateLedgerIntegrity(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("an interior line that does not parse is corruption (broken chain)", () => {
    const root = freshWorkspace();
    // Valid, then a corrupt interior line, then valid: the corruption is not a
    // torn tail (it has a following record) so it must be reported.
    writeLedger(root, `${validRow("cand-a")}\n{ not json\n${validRow("cand-b")}\n`);
    const result = verifyHarnessCandidateLedgerIntegrity(root);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(":2:");
    expect(result.issues[0]).toContain("invalid_json");
  });

  test("a current-schema row with invalid fields is corruption", () => {
    const root = freshWorkspace();
    writeLedger(
      root,
      `${validRow("cand-a")}\n${JSON.stringify({
        schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
        candidateId: "cand-b",
        action: "not-a-real-action",
      })}\n${validRow("cand-c")}\n`,
    );

    const result = verifyHarnessCandidateLedgerIntegrity(root);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.stringContaining("invalid_schema")]);
  });

  test("a crash-torn final line is tolerated (self-heals on the owner's next append)", () => {
    const root = freshWorkspace();
    // A final line with no terminating newline is a torn write, not corruption.
    writeLedger(root, `${validRow("cand-a")}\n{ torn tail no newline`);
    const result = verifyHarnessCandidateLedgerIntegrity(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("a well-formed but unknown-schema interior line is tolerated (forward-compat)", () => {
    const root = freshWorkspace();
    // Parses as JSON but is not a lifecycle record: a newer writer's row, which
    // the on-disk reader skips rather than treating as damage.
    writeLedger(
      root,
      `${validRow("cand-a")}\n{"schema":"future.v2","x":1}\n${validRow("cand-b")}\n`,
    );
    const result = verifyHarnessCandidateLedgerIntegrity(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

// The artifact dimension enumerates the worlds a session referenced (rewind
// checkpoints) and verifies every referenced world's blobs are still on disk.
// A referenced world whose manifest or blobs were removed by retention or damage
// is a durability failure the session's recoverability depends on.
describe("artifactIntegrityIssues (RFC WS1 artifact dimension)", () => {
  const sessionId = "artifact-session";
  const worldsDir = ".brewva/worlds";

  function capturedWorkspace(): string {
    // No git init: the world store falls back to walk enumeration for a non-git
    // workspace, so the capture stays hermetic (no host subprocess) per the unit
    // hermeticity guard while still producing a real manifest, blobs, and ref.
    const root = mkdtempSync(join(tmpdir(), "brewva-artifact-integrity-"));
    writeFileSync(join(root, "alpha.txt"), "alpha contents\n", "utf8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "beta.ts"), "export const beta = 2;\n", "utf8");
    return root;
  }

  function makeStore(root: string) {
    return createWorkspaceWorldStore({ workspaceRoot: root, dir: worldsDir, retainPerSession: 64 });
  }

  test("a session with no referenced worlds is clean", () => {
    const store = makeStore(capturedWorkspace());
    expect(artifactIntegrityIssues(store, sessionId, [])).toEqual([]);
  });

  test("verifies all referenced worlds through one batched store read", () => {
    const requested: string[][] = [];
    const issues = artifactIntegrityIssues(
      {
        verifyWorlds(worldIds) {
          requested.push([...worldIds]);
          return worldIds.map((worldId) => ({
            worldId,
            present: worldId === "world-clean",
            fileCount: 1,
            missingBlobCount: worldId === "world-missing" ? 1 : 0,
          }));
        },
      },
      sessionId,
      ["world-clean", "world-missing"],
    );

    expect(requested).toEqual([["world-clean", "world-missing"]]);
    expect(issues).toEqual([
      expect.objectContaining({
        domain: "artifact",
        reason: expect.stringContaining("world-missing"),
      }),
    ]);
  });

  test("a referenced world with all blobs present is clean", () => {
    const store = makeStore(capturedWorkspace());
    const captured = store.capture({ sessionId, turn: 1 });
    if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
    expect(store.verifyWorld(captured.worldId).present).toBe(true);
    expect(artifactIntegrityIssues(store, sessionId, [captured.worldId])).toEqual([]);
  });

  test("a referenced world with missing blobs degrades with an artifact issue", () => {
    const root = capturedWorkspace();
    const store = makeStore(root);
    const captured = store.capture({ sessionId, turn: 1 });
    if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
    // Retention/damage removed the content-addressed blobs; the manifest and the
    // session's ref still point at the now-unmaterializable world.
    rmSync(join(root, worldsDir, "objects"), { recursive: true, force: true });

    const issues = artifactIntegrityIssues(store, sessionId, [captured.worldId]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.domain).toBe("artifact");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.sessionId).toBe(sessionId);
    expect(issues[0]?.reason).toContain(captured.worldId);
    expect(issues[0]?.reason).toContain("blob");
  });

  test("a referenced world with a missing manifest degrades with an artifact issue", () => {
    const root = capturedWorkspace();
    const store = makeStore(root);
    const captured = store.capture({ sessionId, turn: 1 });
    if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
    rmSync(join(root, worldsDir, "manifests"), { recursive: true, force: true });

    const issues = artifactIntegrityIssues(store, sessionId, [captured.worldId]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.domain).toBe("artifact");
    expect(issues[0]?.reason).toContain("manifest");
  });

  test("a referenced world with a manifest digest mismatch degrades with an artifact issue", () => {
    const root = capturedWorkspace();
    const store = makeStore(root);
    const captured = store.capture({ sessionId, turn: 1 });
    if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
    const worldHex = captured.worldId.slice("sha256:".length);
    writeFileSync(
      join(root, worldsDir, "manifests", `${worldHex}.json`),
      `${JSON.stringify({ schema: "brewva.world.manifest.v1", files: [] })}\n`,
      "utf8",
    );

    const issues = artifactIntegrityIssues(store, sessionId, [captured.worldId]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.domain).toBe("artifact");
    expect(issues[0]?.reason).toContain("manifest digest mismatch");
  });
});

// The aggregation itself: it folds every durability dimension into one honest
// verdict. Degraded when ANY dimension is unhealthy (with every dimension's
// issues surfaced), healthy only when ALL are verified clean, and inconclusive
// only when no dimension found damage but a required check cannot complete.
describe("projectIntegrity aggregation (RFC WS1)", () => {
  const walIssue: RuntimeSessionIssue = {
    domain: "wal",
    severity: "error",
    reason: "wal quarantine",
  };
  const ledgerIssue: RuntimeSessionIssue = {
    domain: "ledger",
    severity: "error",
    reason: "broken chain",
  };
  const artifactIssue: RuntimeSessionIssue = {
    domain: "artifact",
    severity: "error",
    reason: "world missing",
  };

  function cleanTapeScan(overrides: Partial<TapeForensicScan> = {}): TapeForensicScan {
    return {
      sessionId: "s",
      filePath: "",
      exists: true,
      totalRecords: 0,
      validRecords: 0,
      lastValidEventId: null,
      tornTail: false,
      issues: [],
      ...overrides,
    };
  }

  function probes(overrides: Partial<DurabilityProbes> = {}): DurabilityProbes {
    return {
      scanTape: () => cleanTapeScan({ validRecords: 2, lastValidEventId: "e2" }),
      tapeEnabled: true,
      walIssues: () => [],
      ledgerIssues: () => [],
      artifactIssues: () => [],
      ...overrides,
    };
  }

  test("every dimension clean and tape enabled → healthy, bound to the tape cursor", () => {
    const integrity = projectIntegrity(probes(), "s");
    expect(integrity.status).toBe("healthy");
    if (integrity.status !== "healthy") throw new Error("expected healthy");
    expect(integrity.cursor).toEqual({ latestEventId: "e2", eventCount: 2 });
    expect(integrity.reason).toBeNull();
    expect(integrity.issues).toEqual([]);
  });

  test("a quarantined WAL row degrades with a wal-domain issue", () => {
    const integrity = projectIntegrity(probes({ walIssues: () => [walIssue] }), "s");
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues).toHaveLength(1);
    expect(integrity.issues[0]?.domain).toBe("wal");
    // Degraded stays evidence-bound to the tape cursor even when the damage is elsewhere.
    expect(integrity.cursor).toEqual({ latestEventId: "e2", eventCount: 2 });
  });

  test("a broken ledger chain degrades with a ledger-domain issue", () => {
    const integrity = projectIntegrity(probes({ ledgerIssues: () => [ledgerIssue] }), "s");
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues[0]?.domain).toBe("ledger");
  });

  test("a missing referenced artifact degrades with an artifact-domain issue", () => {
    const integrity = projectIntegrity(probes({ artifactIssues: () => [artifactIssue] }), "s");
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues[0]?.domain).toBe("artifact");
  });

  test("multiple unhealthy dimensions surface every issue so inspect can attribute each", () => {
    const integrity = projectIntegrity(
      probes({ walIssues: () => [walIssue], ledgerIssues: () => [ledgerIssue] }),
      "s",
    );
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(
      integrity.issues.map((issue) => issue.domain).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["ledger", "wal"]);
  });

  test("all dimensions clean but the tape disabled → inconclusive, never falsely healthy", () => {
    const integrity = projectIntegrity(
      probes({ tapeEnabled: false, scanTape: () => cleanTapeScan({ exists: false }) }),
      "s",
    );
    expect(integrity.status).toBe("inconclusive");
    if (integrity.status !== "inconclusive") throw new Error("expected inconclusive");
    expect(integrity.cursor).toBeNull();
    expect(integrity.reason.length).toBeGreaterThan(0);
    expect(integrity.issues).toEqual([]);
  });

  test("a durability probe that cannot complete is inconclusive, not healthy or thrown", () => {
    const integrity = projectIntegrity(
      probes({
        walIssues: () => {
          throw new Error("recovery WAL unreadable");
        },
      }),
      "s",
    );

    expect(integrity.status).toBe("inconclusive");
    if (integrity.status !== "inconclusive") throw new Error("expected inconclusive");
    expect(integrity.cursor).toBeNull();
    expect(integrity.reason).toContain("recovery WAL");
    expect(integrity.issues).toEqual([]);
  });

  test("confirmed WAL damage degrades even when the tape scan cannot complete", () => {
    const integrity = projectIntegrity(
      probes({
        scanTape: () => {
          throw new Error("tape unreadable");
        },
        walIssues: () => [walIssue],
      }),
      "s",
    );

    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.cursor).toBeNull();
    expect(integrity.reason).toContain("event tape integrity check did not complete");
    expect(integrity.issues).toEqual([walIssue]);
  });

  test("a positive damage finding degrades even when the tape substrate is disabled", () => {
    // Damage found in another dimension trumps inconclusive: we have real evidence
    // of a durability failure regardless of whether the tape is verifiable.
    const integrity = projectIntegrity(
      probes({ tapeEnabled: false, walIssues: () => [walIssue] }),
      "s",
    );
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.cursor).toBeNull();
    expect(integrity.reason).toContain("event tape disabled");
    expect(integrity.issues).toEqual([walIssue]);
  });
});
