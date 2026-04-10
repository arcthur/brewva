import { describe, expect, test } from "bun:test";

describe("runtime internal entrypoint", () => {
  test("keeps skill validation assembly primitives runtime-owned", async () => {
    const internal = await import("@brewva/brewva-runtime/internal");

    expect("SkillValidationContextBuilder" in internal).toBe(false);
    expect("SkillOutputValidationPipeline" in internal).toBe(false);
    expect("ContractValidator" in internal).toBe(false);
    expect("PlanningOutputValidator" in internal).toBe(false);
    expect("ImplementationOutputValidator" in internal).toBe(false);
    expect("ReviewOutputValidator" in internal).toBe(false);
    expect("QaOutputValidator" in internal).toBe(false);
  });
});
