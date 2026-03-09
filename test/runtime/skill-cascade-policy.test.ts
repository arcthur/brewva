import { describe, expect, test } from "bun:test";
import type { SkillChainIntent } from "@brewva/brewva-runtime";
import { evaluateSkillCascadeSourceDecision } from "../../packages/brewva-runtime/src/services/skill-cascade-policy.js";

function buildIntent(
  source: SkillChainIntent["source"],
  status: SkillChainIntent["status"],
): SkillChainIntent {
  const now = Date.now();
  return {
    id: "intent-1",
    source,
    sourceTurn: 1,
    steps: [{ id: "step-1", skill: "design", consumes: [], produces: ["execution_plan"] }],
    cursor: 0,
    status,
    unresolvedConsumes: [],
    createdAt: now,
    updatedAt: now,
    retries: 0,
  };
}

describe("skill cascade source policy", () => {
  test("replaces when there is no existing intent", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["explicit", "dispatch"],
      sourcePriority: ["explicit", "dispatch"],
      incomingSource: "dispatch",
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("no_existing_intent");
  });

  test("keeps explicit intent when explicit source is not configured for replacement", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["dispatch"],
      sourcePriority: ["dispatch", "explicit"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("explicit", "running"),
    });
    expect(decision.replace).toBe(false);
    expect(decision.reason).toBe("explicit_source_locked");
  });

  test("replaces explicit intent when explicit source is configured and lower priority", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["dispatch", "explicit"],
      sourcePriority: ["dispatch", "explicit"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("explicit", "running"),
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("incoming_higher_or_equal_priority");
  });

  test("keeps existing dispatch intent when incoming source is disabled", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["explicit"],
      sourcePriority: ["explicit", "dispatch"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("dispatch", "running"),
    });
    expect(decision.replace).toBe(false);
    expect(decision.reason).toBe("incoming_source_disabled");
  });

  test("replaces terminal intent regardless of source rank", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["explicit", "dispatch"],
      sourcePriority: ["explicit", "dispatch"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("explicit", "completed"),
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("existing_terminal");
  });
});
