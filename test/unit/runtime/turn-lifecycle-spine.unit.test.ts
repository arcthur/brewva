import { describe, expect, test } from "bun:test";
import {
  compareTurnLifecycleGates,
  getTurnLifecycleFoldPlacements,
  getTurnLifecycleRecoveryPlacement,
  getTurnLifecycleRecoveryPlacements,
  TurnLifecycleSpine,
} from "@brewva/brewva-runtime/session";

describe("turn lifecycle spine", () => {
  test("advances monotonically through the internal turn gates", () => {
    const spine = new TurnLifecycleSpine();
    const turn = spine.startTurn({ sessionId: "session-a", turnId: "turn-1" });

    expect(turn.gate).toBe("ingress_received");
    expect(
      spine.advance({ sessionId: "session-a", turnId: "turn-1", gate: "admission_resolved" }),
    ).toMatchObject({ gate: "admission_resolved" });
    expect(
      spine.advance({ sessionId: "session-a", turnId: "turn-1", gate: "effect_authorized" }),
    ).toMatchObject({ gate: "effect_authorized" });
    expect(
      spine.advance({ sessionId: "session-a", turnId: "turn-1", gate: "terminal_recorded" }),
    ).toMatchObject({ gate: "terminal_recorded" });

    expect(() =>
      spine.advance({ sessionId: "session-a", turnId: "turn-1", gate: "effect_authorized" }),
    ).toThrow("turn_spine_non_monotonic");
  });

  test("allows recovery supersede without mutating the turn identity", () => {
    const spine = new TurnLifecycleSpine();
    spine.startTurn({ sessionId: "session-a", turnId: "turn-2" });
    spine.advance({ sessionId: "session-a", turnId: "turn-2", gate: "effect_authorized" });

    const recovered = spine.supersedeForRecovery({
      sessionId: "session-a",
      turnId: "turn-2",
      gate: "recovery_settled",
      reason: "reasoning_revert_resume",
    });

    expect(recovered).toMatchObject({
      sessionId: "session-a",
      turnId: "turn-2",
      gate: "recovery_settled",
      superseded: true,
      supersedeReason: "reasoning_revert_resume",
    });
  });

  test("rejects recovery supersede that would move a turn backward", () => {
    const spine = new TurnLifecycleSpine();
    spine.startTurn({ sessionId: "session-a", turnId: "turn-3" });
    spine.advance({ sessionId: "session-a", turnId: "turn-3", gate: "terminal_recorded" });

    expect(() =>
      spine.supersedeForRecovery({
        sessionId: "session-a",
        turnId: "turn-3",
        gate: "recovery_settled",
        reason: "wal_recovery_resume",
      }),
    ).toThrow("turn_spine_non_monotonic_supersede");
  });

  test("declares hydration fold placement against spine gates", () => {
    const placements = getTurnLifecycleFoldPlacements();
    const foldIds = placements.map((placement) => placement.foldId);

    expect(new Set(foldIds).size).toBe(foldIds.length);
    expect(foldIds).toEqual([
      "session_hydration_cost",
      "session_hydration_ledger",
      "session_hydration_resource_lease",
      "session_hydration_skill",
      "session_hydration_tool_lifecycle",
      "session_hydration_verification",
      "session_integrity",
      "task_watchdog",
    ]);
    for (const placement of placements) {
      expect(placement.source).toStartWith("packages/brewva-runtime/src/");
      expect(placement.observes.length).toBeGreaterThan(0);
      for (const gate of placement.observes) {
        expect(compareTurnLifecycleGates(gate, gate)).toBe(0);
      }
    }
  });

  test("declares recovery placement without legacy status-specific reasons", () => {
    const placements = getTurnLifecycleRecoveryPlacements();

    expect(placements.map((placement) => placement.reason)).toEqual([
      "wal_recovery_resume",
      "reasoning_revert_resume",
      "compaction_retry",
      "provider_fallback_retry",
      "max_output_recovery",
      "rollback_receipt",
      "session_shutdown",
    ]);
    expect(getTurnLifecycleRecoveryPlacement("wal_recovery_resume")).toMatchObject({
      trustedGate: "ingress_received",
      resumeGate: "recovery_settled",
      supersedeGate: "recovery_settled",
      receiptEventTypes: ["session_turn_transition", "recovery_wal_recovery_completed"],
    });
    expect(getTurnLifecycleRecoveryPlacement("reasoning_revert_resume")).toMatchObject({
      receiptEventTypes: ["session_turn_transition", "reasoning_revert"],
    });
    expect(getTurnLifecycleRecoveryPlacement("rollback_receipt")).toMatchObject({
      receiptEventTypes: [
        "rollback",
        "reversible_mutation_rolled_back",
        "brewva.session.rewind.v1",
      ],
    });
    expect(getTurnLifecycleRecoveryPlacement("wal_recovery_failed")).toBeUndefined();
    expect(getTurnLifecycleRecoveryPlacement("wal_recovery_completed")).toBeUndefined();
  });
});
