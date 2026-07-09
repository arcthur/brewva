import { describe, expect, test } from "bun:test";
import {
  buildWorkerResultsSettlementPayload,
  projectSessionForks,
} from "@brewva/brewva-vocabulary/delegation";

// projectSessionForks folds the tape's worker-results adoption events into the /worlds
// Forks view's settlement lanes (rfc-worlds-operator-panel Phase 3): one lane per
// applied / apply_failed / rejected event, with its workers, applied-path count, conflict
// paths, and settlement reason, in tape order.
//
// FIXTURE FIDELITY: every payload is built through the SAME
// `buildWorkerResultsSettlementPayload` the emit sites use, so a fixture can never drift
// from the real recorded shape. Hand-written fixtures previously read keys the emitter
// never wrote (appliedPaths absent, conflicts vs failedPaths), passing green while the
// projection was structurally broken — exactly the emit/projection key drift this shared
// builder now forecloses.

type Event = {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  payload?: object;
};

function forks(events: readonly Event[]) {
  return projectSessionForks(events as never);
}

describe("projectSessionForks", () => {
  test("projects applied / rejected / apply_failed lanes in tape order", () => {
    const lanes = forks([
      {
        id: "e1",
        sessionId: "s",
        type: "worker.results.applied",
        timestamp: 1,
        payload: buildWorkerResultsSettlementPayload({
          workerIds: ["w1", "w2"],
          appliedPaths: ["a.ts", "b.ts"],
        }),
      },
      { id: "e2", sessionId: "s", type: "turn.started", timestamp: 2 },
      {
        id: "e3",
        sessionId: "s",
        type: "worker.results.rejected",
        timestamp: 3,
        payload: buildWorkerResultsSettlementPayload({
          workerIds: ["w3"],
          reason: "user_rejected",
        }),
      },
      {
        id: "e4",
        sessionId: "s",
        type: "worker.results.apply_failed",
        timestamp: 4,
        // A basis conflict is an apply_failure carrying the diverged paths — NOT a
        // rejection. The emitter writes them under `failedPaths`; the projection reads
        // the same key into `conflictPaths`.
        payload: buildWorkerResultsSettlementPayload({
          workerIds: ["w4"],
          failedPaths: ["c.ts", "d.ts"],
          reason: "basis_conflict",
        }),
      },
    ]);
    expect(lanes.map((lane) => lane.outcome)).toEqual(["applied", "rejected", "apply_failed"]);
    expect(lanes[0]).toEqual({
      eventId: "e1",
      timestamp: 1,
      outcome: "applied",
      workerIds: ["w1", "w2"],
      appliedPathCount: 2,
      conflictPaths: [],
      reason: null,
    });
    expect(lanes[1]).toEqual({
      eventId: "e3",
      timestamp: 3,
      outcome: "rejected",
      workerIds: ["w3"],
      appliedPathCount: 0,
      conflictPaths: [],
      reason: "user_rejected",
    });
    expect(lanes[2]?.conflictPaths).toEqual(["c.ts", "d.ts"]);
    expect(lanes[2]?.reason).toBe("basis_conflict");
    expect(lanes[2]?.appliedPathCount).toBe(0);
  });

  test("surfaces the no-op (already-applied) settlement reason as a lane", () => {
    // A provable no-op adoption records an `applied` event with zero applied paths and the
    // `already_applied` reason — the tape-derivable "no-op" badge the Forks view renders.
    const lanes = forks([
      {
        id: "e1",
        sessionId: "s",
        type: "worker.results.applied",
        timestamp: 1,
        payload: buildWorkerResultsSettlementPayload({
          workerIds: ["w1"],
          appliedPaths: [],
          reason: "already_applied",
        }),
      },
    ]);
    expect(lanes[0]?.appliedPathCount).toBe(0);
    expect(lanes[0]?.reason).toBe("already_applied");
  });

  test("ignores non-worker-results events and tolerates malformed payloads", () => {
    const lanes = forks([
      {
        id: "e1",
        sessionId: "s",
        type: "subagent_spawned",
        timestamp: 1,
        payload: { runId: "r1" },
      },
      { id: "e2", sessionId: "s", type: "worker.results.applied", timestamp: 2, payload: {} },
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual({
      eventId: "e2",
      timestamp: 2,
      outcome: "applied",
      workerIds: [],
      appliedPathCount: 0,
      conflictPaths: [],
      reason: null,
    });
  });

  test("returns no lanes for a session with no worker-results adoption", () => {
    expect(forks([{ id: "e1", sessionId: "s", type: "turn.started", timestamp: 1 }])).toEqual([]);
  });
});
