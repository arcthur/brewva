import { describe, expect, test } from "bun:test";
import { BREWVA_REGISTERED_EVENT_TYPES, isBrewvaRegisteredEventType } from "@brewva/brewva-runtime";

describe("runtime event registry", () => {
  test("registers session_turn_transition and drops legacy hosted lifecycle event names", () => {
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("session_turn_transition");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("turn_input_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("turn_render_committed");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("gateway_session_bound");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("tool_attempt_binding_missing");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("skill_refresh_recorded");
    expect(BREWVA_REGISTERED_EVENT_TYPES).toContain("skill_recommendation_derived");
    expect(isBrewvaRegisteredEventType("session_turn_transition")).toBe(true);
    expect(isBrewvaRegisteredEventType("turn_input_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("turn_render_committed")).toBe(true);
    expect(isBrewvaRegisteredEventType("gateway_session_bound")).toBe(true);
    expect(isBrewvaRegisteredEventType("tool_attempt_binding_missing")).toBe(true);
    expect(isBrewvaRegisteredEventType("skill_refresh_recorded")).toBe(true);
    expect(isBrewvaRegisteredEventType("skill_recommendation_derived")).toBe(true);

    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_interrupted");
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_turn_compaction_resume_requested");
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain(
      "session_turn_compaction_resume_dispatched",
    );
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain("session_turn_compaction_resume_failed");

    expect(isBrewvaRegisteredEventType("session_interrupted")).toBe(false);
    expect(isBrewvaRegisteredEventType("session_turn_compaction_resume_requested")).toBe(false);
  });
});
