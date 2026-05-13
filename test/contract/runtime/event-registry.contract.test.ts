import { describe, expect, test } from "bun:test";
import {
  BREWVA_EVENT_DURABILITY_BY_TYPE,
  BREWVA_REGISTERED_EVENT_TYPES,
  getBrewvaEventDurabilityClass,
  isBrewvaRegisteredEventType,
} from "@brewva/brewva-runtime/events";

describe("runtime event registry", () => {
  test("registers session_turn_transition and drops legacy hosted lifecycle event names", () => {
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("session_turn_transition");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("turn_input_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("turn_render_committed");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("gateway_session_bound");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("tool_attempt_binding_missing");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("skill_refresh_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("effect_authority_decided");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("tool_effect_gate_selected");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("workbench_note_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("workbench_eviction_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("workbench_eviction_undone");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("workbench_baseline_committed");
    expect(isBrewvaRegisteredEventType("session_turn_transition")).toBe(true);
    expect(isBrewvaRegisteredEventType("turn_input_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("turn_render_committed")).toBe(true);
    expect(isBrewvaRegisteredEventType("gateway_session_bound")).toBe(true);
    expect(isBrewvaRegisteredEventType("tool_attempt_binding_missing")).toBe(true);
    expect(isBrewvaRegisteredEventType("skill_refresh_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("effect_authority_decided")).toBe(true);
    expect(isBrewvaRegisteredEventType("tool_effect_gate_selected")).toBe(true);
    expect(isBrewvaRegisteredEventType("workbench_note_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("workbench_eviction_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("workbench_eviction_undone")).toBe(true);
    expect(isBrewvaRegisteredEventType("workbench_baseline_committed")).toBe(true);

    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_interrupted");
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_turn_compaction_resume_requested");
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain(
      "session_turn_compaction_resume_dispatched",
    );
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_turn_compaction_resume_failed");

    expect(isBrewvaRegisteredEventType("session_interrupted")).toBe(false);
    expect(isBrewvaRegisteredEventType("session_turn_compaction_resume_requested")).toBe(false);
  });

  test("assigns an explicit durability class to every registered event family", () => {
    expect(
      BREWVA_REGISTERED_EVENT_TYPES.every(
        (type) => BREWVA_EVENT_DURABILITY_BY_TYPE[type] !== undefined,
      ),
    ).toBe(true);

    expect(getBrewvaEventDurabilityClass("turn_input_recorded")).toBe("source_of_truth");
    expect(getBrewvaEventDurabilityClass("effect_commitment_approval_requested")).toBe(
      "source_of_truth",
    );
    expect(getBrewvaEventDurabilityClass("tool_effect_gate_selected")).toBe("source_of_truth");
    expect(getBrewvaEventDurabilityClass("recall_results_surfaced")).toBe("durable_evidence");
    expect(getBrewvaEventDurabilityClass("workbench_note_recorded")).toBe("durable_evidence");
    expect(getBrewvaEventDurabilityClass("workbench_baseline_committed")).toBe("durable_evidence");
    expect(getBrewvaEventDurabilityClass("projection_refreshed")).toBe("rebuildable_signal");
    expect(getBrewvaEventDurabilityClass("tool_parallel_read")).toBe("session_local");
    expect(getBrewvaEventDurabilityClass("not_a_runtime_event")).toBe(undefined);
  });
});
