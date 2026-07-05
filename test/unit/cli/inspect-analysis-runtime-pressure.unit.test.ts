import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE } from "@brewva/brewva-vocabulary/context";
import {
  RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  type BrewvaEventRecord,
} from "@brewva/brewva-vocabulary/events";
import { buildRuntimePressureFinding } from "../../../packages/brewva-cli/src/operator/inspect-analysis.js";

// The runtime_pressure finding explains that the model was constrained by the
// RUNTIME (context budget), not by its own capability. Compaction-gate pressure
// must surface on BOTH execution modes: the durable
// `context.compaction.gate.armed` receipt on the hosted managed-session path
// (which the old detection missed entirely — it read a runtime-ops annotation
// the hosted path never emits), and the `tool.invocation.started` allowed:false
// annotation on the in-process path.
function event(type: string, payload: Record<string, unknown>, id: string): BrewvaEventRecord {
  return { id, sessionId: "s", turnId: "turn-0", type, timestamp: 1, payload } as BrewvaEventRecord;
}

describe("buildRuntimePressureFinding — compaction-gate pressure on both execution modes", () => {
  test("HOSTED: a durable context.compaction.gate.armed receipt raises an error-severity finding with the gate reason (the repoint that ran dead before)", () => {
    const finding = buildRuntimePressureFinding([
      event(
        CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE,
        { reason: "hard_limit_reached", usagePercent: 0.97, hardLimitPercent: 0.95 },
        "evt-gate-armed-1",
      ),
    ]);
    expect(finding?.code).toBe("runtime_pressure");
    expect(finding?.severity).toBe("error");
    // The gate reason surfaces so the operator sees WHY the runtime constrained
    // the model, and the durable event type is named in the summary.
    expect(finding?.summary).toContain("hard_limit_reached");
    expect(finding?.summary).toContain(CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE);
    expect(finding?.evidenceRefs).toContain("event:evt-gate-armed-1");
  });

  test("IN-PROCESS: the tool.invocation.started allowed:false + gate-reason annotation still raises the finding (no regression)", () => {
    const finding = buildRuntimePressureFinding([
      event(
        RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
        { allowed: false, reason: "context_compaction_gate_required" },
        "evt-inproc-block-1",
      ),
    ]);
    expect(finding?.code).toBe("runtime_pressure");
    expect(finding?.severity).toBe("error");
    expect(finding?.evidenceRefs).toContain("event:evt-inproc-block-1");
  });

  test("an ALLOWED in-process invocation is not pressure, and unrelated events yield no finding", () => {
    const finding = buildRuntimePressureFinding([
      event(RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND, { allowed: true }, "evt-allowed"),
      event("turn.started", { prompt: "go" }, "evt-turn"),
      event("tool.committed", { call: { toolName: "write" } }, "evt-commit"),
    ]);
    expect(finding).toBeNull();
  });

  test("no events at all → no finding", () => {
    expect(buildRuntimePressureFinding([])).toBeNull();
  });
});
