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
    steps: [{ id: "step-1", skill: "planning", consumes: [], produces: ["execution_steps"] }],
    cursor: 0,
    status,
    unresolvedConsumes: [],
    createdAt: now,
    updatedAt: now,
    retries: 0,
  };
}

describe("skill cascade source policy", () => {
  test("replaces when no existing intent", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose", "dispatch"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "dispatch",
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("no_existing_intent");
  });

  test("keeps explicit intent when explicit source is not configured", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose", "dispatch"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "compose",
      existingIntent: buildIntent("explicit", "running"),
    });
    expect(decision.replace).toBe(false);
    expect(decision.reason).toBe("explicit_source_locked");
  });

  test("replaces explicit intent when explicit is configured and incoming has higher priority", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose", "explicit", "dispatch"],
      sourcePriority: ["compose", "explicit", "dispatch"],
      incomingSource: "compose",
      existingIntent: buildIntent("explicit", "running"),
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("incoming_higher_or_equal_priority");
  });

  test("keeps existing intent when incoming source has lower priority", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose", "dispatch"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("compose", "running"),
    });
    expect(decision.replace).toBe(false);
    expect(decision.reason).toBe("incoming_lower_priority");
  });

  test("replaces terminal intent regardless of source rank", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose", "dispatch"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "dispatch",
      existingIntent: buildIntent("compose", "completed"),
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("existing_terminal");
  });

  test("rejects incoming source when source is disabled", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "dispatch",
    });
    expect(decision.replace).toBe(false);
    expect(decision.reason).toBe("incoming_source_disabled");
  });

  test("replaces existing non-explicit intent when existing source is disabled", () => {
    const decision = evaluateSkillCascadeSourceDecision({
      enabledSources: ["compose"],
      sourcePriority: ["compose", "dispatch"],
      incomingSource: "compose",
      existingIntent: buildIntent("dispatch", "running"),
    });
    expect(decision.replace).toBe(true);
    expect(decision.reason).toBe("existing_source_disabled");
  });
});
