import { createFourPortLifecycleRuntimeOps } from "@brewva/brewva-tools/runtime-port";

export interface FourPortLifecycleScenario {
  readonly active?: boolean;
  readonly lastEventType?: string | null;
  readonly lastCause?: string | null;
  readonly causes?: readonly string[];
}

/**
 * Builds the four-port lifecycle ops over a fake tape that returns the given turn-state
 * scenario, driving the REAL producer (`createFourPortLifecycleRuntimeOps`). The producer
 * reads only the `turn_state`, `recovery_history`, and `tool_commitments` projections, so
 * a hand-shaped projection is enough to exercise posture derivation without a live
 * runtime — and, crucially, the resulting snapshot comes from the producer rather than a
 * hand-built literal that could silently drift from it. Call `.getSnapshot(sessionId)` on
 * the result to read the snapshot.
 */
export function createLifecycleOps(scenario: FourPortLifecycleScenario) {
  const causes = scenario.causes ?? (scenario.lastCause ? [scenario.lastCause] : []);
  const lastEvent =
    scenario.lastEventType == null
      ? null
      : { id: "evt-last", type: scenario.lastEventType, timestamp: 1, sessionId: "s1" };
  const project = (sessionId: string, name: string): unknown => {
    switch (name) {
      case "turn_state":
        return {
          sessionId,
          active: scenario.active ?? false,
          lastCause: scenario.lastCause ?? null,
          lastEvent,
        };
      case "recovery_history":
        return { sessionId, causes };
      case "tool_commitments":
        return { sessionId, proposed: [], committed: [], aborted: [] };
      default:
        throw new Error(`unexpected tape view: ${name}`);
    }
  };
  const context = { runtime: { tape: { project } } } as unknown as Parameters<
    typeof createFourPortLifecycleRuntimeOps
  >[0];
  return createFourPortLifecycleRuntimeOps(context);
}
