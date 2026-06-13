import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { projectDelegationInspectionState } from "@brewva/brewva-session-index";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { createRuntimeInstanceFixture } from "../helpers/runtime.js";
import type { HostedRuntimeAdapterPort } from "../helpers/runtime.js";

/**
 * Claims-vs-enforcement guard (RFC: delegation-plane hardening, WS4).
 *
 * The `## Enforced Claims` section of
 * docs/journeys/operator/background-and-parallelism.md tags authority-bearing
 * claims with stable ids. Each id has an enforcement test here that exercises
 * the real wiring and fails if the behavior regresses to a stub/no-op. The
 * final drift guard asserts the doc's claim list and this registry stay
 * identical, so a claim can never be documented without enforcement (or
 * enforcement removed while the claim still reads as guaranteed). Design
 * axiom 14: documented authority must match wired authority.
 */

const JOURNEY_DOC = join(
  import.meta.dir,
  "../../docs/journeys/operator/background-and-parallelism.md",
);

function makeRuntime(parallel: {
  maxConcurrent: number;
  maxTotalPerSession: number;
}): HostedRuntimeAdapterPort {
  const workspace = mkdtempSync(join(tmpdir(), "delegation-claims-"));
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.parallel.enabled = true;
  config.parallel.maxConcurrent = parallel.maxConcurrent;
  config.parallel.maxTotalPerSession = parallel.maxTotalPerSession;
  return createRuntimeInstanceFixture({ cwd: workspace, config });
}

/** Record a durable `subagent_spawned` tape event, as a real delegation would. */
function recordSpawn(runtime: HostedRuntimeAdapterPort, sessionId: string, runId: string): void {
  runtime.ops.delegation.lifecycle.spawned({ sessionId, payload: { runId } });
}

function workerPatchRecords(sessionId: string): BrewvaEventRecord[] {
  const payload = (status: "pending" | "completed", updatedAt: number) => ({
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    runId: "worker-1",
    agent: "worker",
    targetName: "worker",
    delegate: "worker",
    label: "Implement fix",
    depth: 1,
    forkTurns: "none",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    visibility: "public",
    isolationStrategy: "snapshot",
    lifecycleReason: "none",
    retention: "live",
    createdAt: 1_000,
    updatedAt,
    kind: "patch",
    status,
    summary: "Prepared a patch.",
    resultData: { kind: "patch", patches: { id: "patch-worker-1", changes: [] } },
    patches: { id: "patch-worker-1", changes: [] },
  });
  return [
    {
      id: "evt-spawn",
      sessionId,
      turn: 1,
      type: SUBAGENT_SPAWNED_EVENT_TYPE,
      timestamp: 1_000,
      payload: payload("pending", 1_000),
    },
    {
      id: "evt-done",
      sessionId,
      turn: 1,
      type: SUBAGENT_COMPLETED_EVENT_TYPE,
      timestamp: 1_100,
      payload: payload("completed", 1_100),
    },
  ];
}

interface EnforcedClaim {
  readonly id: string;
  readonly enforce: () => void;
}

const CLAIMS: readonly EnforcedClaim[] = [
  {
    // "insufficient parallel budget causes immediate rejection; the session
    //  concurrency limit is never silently overrun."
    id: "parallel-budget-rejection",
    enforce() {
      const runtime = makeRuntime({ maxConcurrent: 2, maxTotalPerSession: 50 });
      const parallel = runtime.ops.tools.parallel;
      const session = "claim-budget";
      expect(parallel.acquire(session, "r1", { kind: "delegation" }).accepted).toBe(true);
      expect(parallel.acquire(session, "r2", { kind: "delegation" }).accepted).toBe(true);

      const rejected = parallel.acquire(session, "r3", { kind: "delegation" });
      expect(rejected.accepted).toBe(false);
      if (!rejected.accepted) {
        expect(rejected.reason).toBe("max_concurrent_reached");
      }
      // Releasing frees a slot, proving release is effectful (not a no-op stub).
      parallel.release(session, "r1");
      expect(parallel.acquire(session, "r3", { kind: "delegation" }).accepted).toBe(true);
    },
  },
  {
    // "the per-session lifetime delegation cap is enforced from durable tape."
    id: "parallel-lifetime-cap",
    enforce() {
      const runtime = makeRuntime({ maxConcurrent: 50, maxTotalPerSession: 2 });
      const session = "claim-lifetime";
      // Two lifetime starts recorded on the tape (the orchestrator records a
      // spawn after each accepted acquire); the lifetime cap counts starts.
      recordSpawn(runtime, session, "started-1");
      recordSpawn(runtime, session, "started-2");

      const rejected = runtime.ops.tools.parallel.acquire(session, "started-3", {
        kind: "delegation",
      });
      expect(rejected.accepted).toBe(false);
      if (!rejected.accepted) {
        expect(rejected.reason).toBe("session_total_exhausted");
      }
    },
  },
  {
    // "after restart, active concurrency is reconstructed from durable tape so
    //  slots are not over-issued."
    id: "slot-ledger-restart-recovery",
    enforce() {
      const runtime = makeRuntime({ maxConcurrent: 2, maxTotalPerSession: 50 });
      const session = "claim-restart";
      // Simulate runs that started before this process: their spawns are on the
      // durable tape, but this process never called acquire for them (no
      // in-memory reservation). A stub or in-memory-only ledger would report
      // zero active and over-issue; tape-derived admission must still reject.
      recordSpawn(runtime, session, "prior-1");
      recordSpawn(runtime, session, "prior-2");

      const rejected = runtime.ops.tools.parallel.acquire(session, "fresh", {
        kind: "delegation",
      });
      expect(rejected.accepted).toBe(false);
      if (!rejected.accepted) {
        expect(rejected.reason).toBe("max_concurrent_reached");
      }
    },
  },
  {
    // "the runtime does not auto-apply child work; a completed worker patch
    //  stays pending an explicit parent adoption decision."
    id: "no-auto-apply",
    enforce() {
      const session = "claim-no-auto-apply";
      // A worker completes with a patch and NO apply event is recorded.
      const inspection = projectDelegationInspectionState({
        sessionId: session,
        records: workerPatchRecords(session),
      });
      const card = inspection.runCards.find((entry) => entry.runId === "worker-1");
      // The patch must not be auto-applied; it stays pending an explicit decision.
      expect(card?.disposition).toBe("pending_apply");

      const adoption = inspection.adoptionBoard.adoptionItems.find(
        (item) => item.runId === "worker-1",
      );
      expect(adoption?.kind).toBe("worker_patch");
      expect(adoption?.resolutions.map((resolution) => resolution.tool)).toEqual([
        "worker_results_apply",
        "worker_results_reject",
      ]);
    },
  },
];

describe("delegation claims enforcement (fitness)", () => {
  for (const claim of CLAIMS) {
    test(claim.id, claim.enforce);
  }

  test("journey doc enumerates exactly the enforced claims (drift guard)", () => {
    const doc = readFileSync(JOURNEY_DOC, "utf8");
    const sectionMatch = doc.match(/## Enforced Claims\n([\s\S]*?)(?:\n## |\n*$)/);
    expect(sectionMatch).not.toBeNull();
    const section = sectionMatch?.[1] ?? "";
    const docClaimIds = [...section.matchAll(/^- `([a-z0-9-]+)`/gm)]
      .map((match) => match[1] as string)
      .toSorted();
    const registryIds = CLAIMS.map((claim) => claim.id).toSorted();
    expect(docClaimIds).toEqual(registryIds);
  });
});
