import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE,
  SUBAGENT_SLOT_REJECTED_EVENT_TYPE,
  SUBAGENT_SLOT_RELEASED_EVENT_TYPE,
  SUBAGENT_SLOT_WAITING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import type { ParallelSlotEventPayload } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";
import {
  createParallelAdmissionController,
  type ParallelAdmissionDeps,
} from "../../../packages/brewva-gateway/src/delegation/parallel-admission.js";

const SESSION = "session-1";

interface EmittedReceipt {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: ParallelSlotEventPayload;
}

interface Harness {
  readonly controller: ReturnType<typeof createParallelAdmissionController>;
  readonly receipts: EmittedReceipt[];
  setEvents(events: BrewvaEventRecord[]): void;
  setLeases(leases: ResourceLeaseRecord[]): void;
  setNow(now: number): void;
  receiptTypes(): string[];
}

function spawnEvent(runId: string, index: number): BrewvaEventRecord {
  return {
    id: `evt-spawn-${runId}-${index}`,
    sessionId: SESSION,
    type: SUBAGENT_SPAWNED_EVENT_TYPE,
    timestamp: 1_000 + index,
    payload: { runId },
  };
}

function terminalEvent(runId: string, index: number): BrewvaEventRecord {
  return {
    id: `evt-done-${runId}-${index}`,
    sessionId: SESSION,
    type: SUBAGENT_COMPLETED_EVENT_TYPE,
    timestamp: 2_000 + index,
    payload: { runId },
  };
}

function activeLease(
  maxParallel: number,
  overrides: Partial<ResourceLeaseRecord> = {},
): ResourceLeaseRecord {
  return {
    id: "lease-1",
    status: "active",
    budget: { maxParallel },
    reason: "burst",
    expiresAt: null,
    expiresAfterTurn: null,
    ...overrides,
  };
}

function createHarness(config: {
  enabled?: boolean;
  maxConcurrent: number;
  maxTotalPerSession: number;
}): Harness {
  let events: BrewvaEventRecord[] = [];
  let leases: ResourceLeaseRecord[] = [];
  let now = 10_000;
  const receipts: EmittedReceipt[] = [];

  const deps: ParallelAdmissionDeps = {
    parallelConfig: () => ({
      enabled: config.enabled ?? true,
      maxConcurrent: config.maxConcurrent,
      maxTotalPerSession: config.maxTotalPerSession,
    }),
    queryEvents: () => events,
    activeLeases: () => leases,
    emit: (sessionId, type, payload) => {
      receipts.push({ sessionId, type, payload });
    },
    now: () => now,
  };

  return {
    controller: createParallelAdmissionController(deps),
    receipts,
    setEvents: (next) => {
      events = next;
    },
    setLeases: (next) => {
      leases = next;
    },
    setNow: (next) => {
      now = next;
    },
    receiptTypes: () => receipts.map((receipt) => receipt.type),
  };
}

describe("parallel admission gate", () => {
  test("accepts a delegation under the concurrency ceiling and emits an acquired receipt", () => {
    const h = createHarness({ maxConcurrent: 3, maxTotalPerSession: 10 });
    const decision = h.controller.acquire(SESSION, "run-1", { kind: "delegation" });
    expect(decision).toEqual({ accepted: true });
    expect(h.receiptTypes()).toEqual([SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE]);
    expect(h.receipts[0]?.payload.activeCount).toBe(0);
    expect(h.receipts[0]?.payload.ceiling).toBe(3);
  });

  test("rejects when in-process reservations reach the concurrency ceiling", () => {
    const h = createHarness({ maxConcurrent: 2, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(true);
    const rejected = h.controller.acquire(SESSION, "run-3", { kind: "delegation" });
    expect(rejected).toEqual({ accepted: false, reason: "max_concurrent_reached" });
    expect(h.receiptTypes().at(-1)).toBe(SUBAGENT_SLOT_REJECTED_EVENT_TYPE);
  });

  test("derives active count from tape so a fresh controller honors prior runs (restart hydration)", () => {
    const h = createHarness({ maxConcurrent: 2, maxTotalPerSession: 10 });
    // Two spawned, no terminal: the tape alone says two slots are occupied,
    // even though this controller instance never reserved them.
    h.setEvents([spawnEvent("prior-1", 0), spawnEvent("prior-2", 1)]);
    const rejected = h.controller.acquire(SESSION, "run-new", { kind: "delegation" });
    expect(rejected).toEqual({ accepted: false, reason: "max_concurrent_reached" });
  });

  test("terminal tape events free the slot", () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    h.setEvents([spawnEvent("prior-1", 0), terminalEvent("prior-1", 0)]);
    expect(h.controller.acquire(SESSION, "run-new", { kind: "delegation" }).accepted).toBe(true);
  });

  test("enforces the session lifetime cap from tape totalStarted", () => {
    const h = createHarness({ maxConcurrent: 5, maxTotalPerSession: 2 });
    // Two lifetime starts already (one still active, one completed): lifetime
    // is exhausted even though only one slot is concurrently occupied.
    h.setEvents([spawnEvent("done-1", 0), terminalEvent("done-1", 0), spawnEvent("active-1", 1)]);
    const rejected = h.controller.acquire(SESSION, "run-new", { kind: "delegation" });
    expect(rejected).toEqual({ accepted: false, reason: "session_total_exhausted" });
  });

  test("an active lease raises the concurrency ceiling", () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
    h.setLeases([activeLease(3)]);
    const accepted = h.controller.acquire(SESSION, "run-2", { kind: "delegation" });
    expect(accepted.accepted).toBe(true);
    expect(h.receipts.at(-1)?.payload.leaseRaisedCeiling).toBe(true);
    expect(h.receipts.at(-1)?.payload.ceiling).toBe(3);
  });

  test("a turn-bounded-only lease does not raise the ceiling (turn expiry is unenforceable)", () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    // ttlTurns with no wall-clock TTL: expiresAt is null, expiresAfterTurn is set.
    // Nothing flips lease status by turn, so honoring it would inflate forever.
    h.setLeases([activeLease(5, { expiresAt: null, expiresAfterTurn: 3 })]);
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
  });

  test("an expired lease does not raise the ceiling", () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    h.setNow(Date.parse("2026-06-13T00:00:00.000Z"));
    h.setLeases([activeLease(5, { expiresAt: "2026-06-12T00:00:00.000Z" })]);
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
  });

  test("transient slots count against concurrency but ignore the lifetime cap", () => {
    const h = createHarness({ maxConcurrent: 2, maxTotalPerSession: 1 });
    // Lifetime cap is 1 and already consumed by a tape spawn; a transient slot
    // is still admitted because the lifetime cap is delegation-only.
    h.setEvents([spawnEvent("active-1", 0)]);
    const transient = h.controller.acquire(SESSION, "read-batch", { kind: "transient" });
    expect(transient.accepted).toBe(true);
    // But a delegation is rejected on the lifetime cap.
    expect(h.controller.acquire(SESSION, "run-new", { kind: "delegation" })).toEqual({
      accepted: false,
      reason: "session_total_exhausted",
    });
  });

  test("release is idempotent and only emits one released receipt", () => {
    const h = createHarness({ maxConcurrent: 2, maxTotalPerSession: 10 });
    h.controller.acquire(SESSION, "run-1", { kind: "delegation" });
    h.controller.release(SESSION, "run-1");
    h.controller.release(SESSION, "run-1");
    h.controller.release(SESSION, "never-acquired");
    const released = h.receiptTypes().filter((type) => type === SUBAGENT_SLOT_RELEASED_EVENT_TYPE);
    expect(released).toHaveLength(1);
  });

  test("releasing frees a slot for the next delegation", () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
    h.controller.release(SESSION, "run-1");
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(true);
  });

  test("a run that completes on tape never leaks a slot, even if release is never delivered", () => {
    // Models a detached/background run: it acquires, its spawn + terminal events
    // land on the parent tape from another process, but the parent never calls
    // release. The reservation must stop counting once the tape has seen the
    // spawn, so the finished run cannot pin the only slot forever.
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "detached-1", { kind: "delegation" }).accepted).toBe(true);
    h.setEvents([spawnEvent("detached-1", 0), terminalEvent("detached-1", 0)]);
    // No release for detached-1. A fresh delegation must still be admitted.
    const next = h.controller.acquire(SESSION, "run-2", { kind: "delegation" });
    expect(next.accepted).toBe(true);
  });

  test("a reservation still bridges the window before its spawn event lands", () => {
    // Before the spawn event reaches the tape, the reservation is the only
    // evidence the slot is taken, so it must count.
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    // Spawn event not yet on tape: the reservation holds the slot.
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
    // Spawn lands: tape is now authoritative, reservation is redundant, count is 1.
    h.setEvents([spawnEvent("run-1", 0)]);
    expect(h.controller.acquire(SESSION, "run-2", { kind: "delegation" }).accepted).toBe(false);
  });

  test("acquireAsync waits and resolves once a peer releases a slot", async () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);

    const pending = h.controller.acquireAsync(SESSION, "read-batch", {
      kind: "transient",
      timeoutMs: 1_000,
    });
    // The waiting receipt is emitted synchronously before the promise settles.
    expect(h.receiptTypes()).toContain(SUBAGENT_SLOT_WAITING_EVENT_TYPE);

    h.controller.release(SESSION, "run-1");
    const decision = await pending;
    expect(decision).toEqual({ accepted: true, waited: true });
  });

  test("acquireAsync resolves on a tape-driven slot free with no local release (poll backstop)", async () => {
    // Models a detached run completing in its own process: its terminal lands on
    // the durable tape, but no in-process release() is ever called. The waiter's
    // periodic re-evaluation must still pick up the freed slot.
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    h.setEvents([spawnEvent("detached-1", 0)]); // one active run on the tape
    const pending = h.controller.acquireAsync(SESSION, "run-2", {
      kind: "delegation",
      timeoutMs: 2_000, // > poll interval (1s) so the poll fires before timeout
    });
    expect(h.receiptTypes()).toContain(SUBAGENT_SLOT_WAITING_EVENT_TYPE);

    // The detached run finishes on the tape; no release() is called.
    h.setEvents([spawnEvent("detached-1", 0), terminalEvent("detached-1", 0)]);
    const decision = await pending;
    expect(decision).toEqual({ accepted: true, waited: true });
  });

  test("acquireAsync does not wait on a non-waitable lifetime rejection", async () => {
    const h = createHarness({ maxConcurrent: 5, maxTotalPerSession: 1 });
    h.setEvents([spawnEvent("active-1", 0)]);
    const decision = await h.controller.acquireAsync(SESSION, "run-new", { kind: "delegation" });
    expect(decision).toEqual({ accepted: false, reason: "session_total_exhausted" });
    expect(h.receiptTypes()).not.toContain(SUBAGENT_SLOT_WAITING_EVENT_TYPE);
  });

  test("acquireAsync times out when no slot frees", async () => {
    const h = createHarness({ maxConcurrent: 1, maxTotalPerSession: 10 });
    expect(h.controller.acquire(SESSION, "run-1", { kind: "delegation" }).accepted).toBe(true);
    const decision = await h.controller.acquireAsync(SESSION, "read-batch", {
      kind: "transient",
      timeoutMs: 20,
    });
    expect(decision).toEqual({ accepted: false, reason: "wait_timeout", waited: true });
  });

  test("the gate is permissive when parallelism is disabled", () => {
    const h = createHarness({ enabled: false, maxConcurrent: 1, maxTotalPerSession: 1 });
    h.setEvents([spawnEvent("active-1", 0), spawnEvent("active-2", 1)]);
    expect(h.controller.acquire(SESSION, "run-new", { kind: "delegation" }).accepted).toBe(true);
  });
});
